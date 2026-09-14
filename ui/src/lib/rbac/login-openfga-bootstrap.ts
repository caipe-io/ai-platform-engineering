import { getCollection } from "@/lib/mongodb";
import {
  baselineMemberTuples,
  effectiveBaselineBootstrapTuples,
  getBaselineFgaProfile,
  getBaselineFgaProfileBundle,
  type TeamBaselineProfileOverride,
} from "@/lib/rbac/baseline-access";
import { getRbacCollection } from "@/lib/rbac/mongo-collections";
import { writeOpenFgaTuples, type OpenFgaTupleKey } from "@/lib/rbac/openfga";
import { SUPER_ADMINS_TEAM_SLUG } from "@/lib/rbac/super-admins-team";
import {
  writeTeamMembershipTuples,
  mongoRoleToOpenFgaRelations,
} from "@/lib/rbac/team-membership-sync";
import { upsertTeamMembershipSource } from "@/lib/rbac/team-membership-source-store";
import type { TeamMembershipSource } from "@/types/identity-group-sync";

export type LoginOpenFgaBootstrapStatus = "skipped" | "completed" | "failed";

export interface LoginOpenFgaBootstrapResult {
  status: LoginOpenFgaBootstrapStatus;
  tuple_write_count: number;
  warning?: string;
}

export interface LoginOpenFgaBootstrapInput {
  subject?: string;
  email?: string;
  isAuthorized: boolean;
  isAdmin: boolean;
}

const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

function normalizeDefaultAgentId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && OPENFGA_ID_PATTERN.test(trimmed) ? trimmed : null;
}

async function defaultAgentTuple(): Promise<OpenFgaTupleKey[]> {
  try {
    const config = await getCollection<{ default_agent_id?: unknown }>("platform_config");
    const doc = await config.findOne({ _id: "platform_settings" } as never);
    const defaultAgentId =
      normalizeDefaultAgentId(doc?.default_agent_id) ?? normalizeDefaultAgentId(process.env.DEFAULT_AGENT_ID);
    return defaultAgentId ? [{ user: "user:*", relation: "user", object: `agent:${defaultAgentId}` }] : [];
  } catch {
    const defaultAgentId = normalizeDefaultAgentId(process.env.DEFAULT_AGENT_ID);
    return defaultAgentId ? [{ user: "user:*", relation: "user", object: `agent:${defaultAgentId}` }] : [];
  }
}

interface TeamDoc {
  slug?: string;
  name?: string;
  baseline_profile_overrides?: {
    member_profile_id?: string;
    admin_profile_id?: string;
  };
}

/**
 * Build the per-team baseline-profile overrides for a logging-in user.
 *
 * Pre-2026-05-26 this iterated every team in Mongo and read
 * `team.members[]` to find the user. That code path was the second-to-
 * last reader of the embedded array (see
 * docs/docs/security/rbac/architecture.md).
 *
 * Now: query the canonical `team_membership_sources` collection by
 * the user's email/subject to get the candidate team slugs in one
 * round-trip, then fetch only those team docs (so we still have
 * baseline_profile_overrides metadata, which is *not* in the source
 * store — that lives on the team doc itself).
 *
 * Role normalization: the source store uses `"member" | "admin"`. The
 * legacy embedded array also had `"owner"`, which the consumer
 * (effectiveBaselineBootstrapTuples) treats identically to `"admin"`.
 * Collapsing them is behavior-preserving.
 */
async function teamOverridesForLogin(email: string | undefined): Promise<TeamBaselineProfileOverride[]> {
  if (!email) return [];
  try {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return [];

    const sources = await getRbacCollection<TeamMembershipSource>("teamMembershipSources");
    const rows = await sources
      .find({ status: "active", user_email: normalizedEmail })
      .toArray();
    if (rows.length === 0) return [];

    // Dedupe by team_slug; escalate role to admin if any active row has admin.
    const byTeam = new Map<string, "member" | "admin">();
    for (const row of rows) {
      if (!row.team_slug) continue;
      const current = byTeam.get(row.team_slug);
      if (current === "admin") continue;
      byTeam.set(row.team_slug, row.relationship === "admin" ? "admin" : "member");
    }
    if (byTeam.size === 0) return [];

    const teams = await getCollection<TeamDoc>("teams");
    const teamDocs = await teams.find({ slug: { $in: Array.from(byTeam.keys()) } }).toArray();

    const overrides: TeamBaselineProfileOverride[] = [];
    for (const team of teamDocs) {
      if (!team.slug) continue;
      const role = byTeam.get(team.slug);
      if (!role) continue;
      const memberProfileId = team.baseline_profile_overrides?.member_profile_id;
      const adminProfileId = team.baseline_profile_overrides?.admin_profile_id;
      if (!memberProfileId && !adminProfileId) continue;
      overrides.push({
        team_slug: team.slug,
        team_name: team.name,
        role,
        member_profile_id: memberProfileId,
        admin_profile_id: adminProfileId,
      });
    }
    return overrides;
  } catch {
    return [];
  }
}

async function ensureSuperAdminTeamMembership(subject: string, email: string | undefined): Promise<void> {
  try {
    await writeTeamMembershipTuples(subject, SUPER_ADMINS_TEAM_SLUG, mongoRoleToOpenFgaRelations("admin"), "assign");

    const teams = await getCollection<{ _id: unknown; created_at?: Date }>("teams");
    const team = await teams.findOne({ slug: SUPER_ADMINS_TEAM_SLUG } as never);
    const teamId = team?._id ? String(team._id) : SUPER_ADMINS_TEAM_SLUG;
    const now = new Date().toISOString();
    const normalizedEmail = email?.trim().toLowerCase() ?? "";

    const source: TeamMembershipSource = {
      team_id: teamId,
      team_slug: SUPER_ADMINS_TEAM_SLUG,
      user_email: normalizedEmail,
      user_subject: subject,
      source_type: "manual",
      relationship: "admin",
      managed: false,
      status: "active",
      created_by: "login-bootstrap",
      created_at: now,
      first_seen_at: now,
      last_seen_at: now,
      last_applied_at: now,
    };
    await upsertTeamMembershipSource(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[LoginOpenFGA] Failed to add ${email ?? subject} to super-admins team: ${message}`);
  }
}

export async function reconcileLoginOpenFgaAccess(
  input: LoginOpenFgaBootstrapInput
): Promise<LoginOpenFgaBootstrapResult> {
  const subject = input.subject?.trim();
  if (!input.isAuthorized || !subject) {
    return { status: "skipped", tuple_write_count: 0 };
  }

  const bundle = await getBaselineFgaProfileBundle();
  const writes = effectiveBaselineBootstrapTuples({
    subject,
    isAdmin: input.isAdmin,
    bundle,
    teamOverrides: await teamOverridesForLogin(input.email),
  });
  writes.push(...(await defaultAgentTuple()));

  if (input.isAdmin) {
    await ensureSuperAdminTeamMembership(subject, input.email);
  }

  try {
    const result = await writeOpenFgaTuples({ writes, deletes: [] });
    return { status: "completed", tuple_write_count: result.writes };
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    console.warn(
      `[LoginOpenFGA] Failed to bootstrap OpenFGA access for ${input.email ?? subject}: ${warning}`
    );
    return { status: "failed", tuple_write_count: 0, warning };
  }
}

export interface SyncedBaselineBootstrapResult {
  status: LoginOpenFgaBootstrapStatus;
  subject_count: number;
  tuple_write_count: number;
  warning?: string;
}

/**
 * Grant the global org-member baseline (the same grants an interactive web
 * login writes via `reconcileLoginOpenFgaAccess`, incl. the `mcp-gateway-call`
 * grant `user:<sub> caller mcp_gateway:list`) to a set of subjects resolved by
 * a background directory sync.
 *
 * Why this exists: the directory-sync path only ever writes team-membership
 * tuples (`user:<sub> <relation> team:<slug>`). It never wrote the member
 * baseline, so a user who was provisioned purely by Okta sync — and never
 * interactively signed into the web UI — held team tuples but lacked the
 * `mcp_gateway:list` caller tuple that AgentGateway's coarse ext_authz gate
 * requires. Those users passed auth, minted OBO tokens, then got
 * `DENY_NO_CAPABILITY` at the gateway and saw zero MCP tools. This closes that
 * gap so RBAC is granted before the person ever logs into CAIPE.
 *
 * Scope: member baseline only. Org-admin status is not derivable from a
 * directory sync (there is no trustworthy admin signal in a group membership),
 * so admin baselines remain owned by the interactive-login / bootstrap-admin
 * paths. Team profile overrides likewise stay a login-time concern; this writes
 * the global member baseline so every synced user clears the coarse gate.
 *
 * Idempotent + self-healing: `writeOpenFgaTuples` reads each candidate tuple
 * back and drops the ones already stored, so re-emitting the baseline for every
 * resolved subject on every sync run performs zero writes in steady state while
 * still backfilling any user who is missing it. This is what lets a routine
 * sync of already-synced users repair the entire affected population.
 *
 * Best-effort: never throws. Callers (the sync runner) treat baseline bootstrap
 * as non-fatal so a bootstrap hiccup can't fail the membership reconcile that
 * already committed.
 */
export async function reconcileSyncedUsersBaselineAccess(
  subjects: Iterable<string>
): Promise<SyncedBaselineBootstrapResult> {
  const uniqueSubjects: string[] = [];
  const seen = new Set<string>();
  for (const raw of subjects) {
    const subject = raw?.trim();
    if (!subject || seen.has(subject)) continue;
    seen.add(subject);
    uniqueSubjects.push(subject);
  }

  if (uniqueSubjects.length === 0) {
    return { status: "skipped", subject_count: 0, tuple_write_count: 0 };
  }

  try {
    const profile = await getBaselineFgaProfile();
    const writes = uniqueSubjects.flatMap((subject) => baselineMemberTuples(subject, profile));
    if (writes.length === 0) {
      return { status: "skipped", subject_count: uniqueSubjects.length, tuple_write_count: 0 };
    }
    const result = await writeOpenFgaTuples({ writes, deletes: [] });
    return {
      status: "completed",
      subject_count: uniqueSubjects.length,
      tuple_write_count: result.writes,
    };
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    console.warn(
      `[LoginOpenFGA] Failed to bootstrap baseline OpenFGA access for ${uniqueSubjects.length} synced user(s): ${warning}`
    );
    return {
      status: "failed",
      subject_count: uniqueSubjects.length,
      tuple_write_count: 0,
      warning,
    };
  }
}
