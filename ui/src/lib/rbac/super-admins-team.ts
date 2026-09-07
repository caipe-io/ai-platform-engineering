// Idempotently bootstrap the "Super Admins" team that backs the platform
// default-team selector.
//
// On UI startup (after `reconcileBootstrapAdmins` resolves the bootstrap
// admin emails to Keycloak user subjects) we materialise a team called
// "Super Admins" with slug `super-admins` whose membership mirrors
// `RBAC_BOOTSTRAP_ADMIN_EMAILS`/`BOOTSTRAP_ADMIN_EMAILS`:
//
//   - First listed email -> Mongo role=owner, OpenFGA `team:super-admins#admin`
//   - All others         -> Mongo role=admin, OpenFGA `team:super-admins#admin`
//
// The model already implies `member` from `admin` (Option C fix), so we
// only need to write the admin tuple.
//
// The team is marked `source: "system"` and `is_system_managed: true` so the
// generic team APIs (PATCH/DELETE) can refuse rename/delete and the UI can
// show a "managed by platform" badge.
//
// assisted-by Cursor claude-opus-4-7

import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { writeOpenFgaTuples } from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";
import { SUPER_ADMINS_TEAM_SLUG } from "@/lib/rbac/reserved-teams";
import { upsertTeamMembershipSource } from "@/lib/rbac/team-membership-source-store";
import { loadActiveTeamMembers } from "@/lib/rbac/team-membership-store";
import {
mongoRoleToOpenFgaRelations,
resolveKeycloakUserSubject,
writeTeamMembershipTuples,
} from "@/lib/rbac/team-membership-sync";
import type { TeamMembershipSource } from "@/types/identity-group-sync";

export { SUPER_ADMINS_TEAM_SLUG } from "@/lib/rbac/reserved-teams";
export const SUPER_ADMINS_TEAM_NAME = "Super Admins";

/**
 * Write the connector tuple `team:super-admins#admin admin organization:<key>`.
 * This makes anyone with the `admin` relation on the super-admins team an org
 * admin, so BOOTSTRAP_ADMIN_EMAILS is only needed for break-glass access before
 * this tuple is seeded. Safe to call multiple times (OpenFGA write is idempotent).
 */
async function ensureSuperAdminsOrgAdminTuple(warnings: string[]): Promise<void> {
  try {
    await writeOpenFgaTuples({
      writes: [
        {
          user: `team:${SUPER_ADMINS_TEAM_SLUG}#admin`,
          relation: "admin",
          object: organizationObjectId(),
        },
      ],
      deletes: [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`super-admins org connector tuple: ${message}`);
  }
}

export interface SuperAdminsBootstrapMember {
  email: string;
  /** Resolved Keycloak `sub`. Undefined when the user hasn't been provisioned yet. */
  userSubject?: string;
}

export interface SuperAdminsBootstrapInput {
  /** Normalised, lowercase, deduped bootstrap admin emails, in priority order. */
  members: SuperAdminsBootstrapMember[];
  /** Who is initiating the bootstrap (e.g. `keycloak-rbac-startup`). */
  actor: string;
  /** Override the current time, useful for tests. */
  now?: Date;
}

export type SuperAdminsBootstrapStatus =
  | "created"
  | "updated"
  | "noop"
  | "skipped";

export interface SuperAdminsBootstrapResult {
  status: SuperAdminsBootstrapStatus;
  team_slug: string;
  members_added: number;
  members_already_present: number;
  members_unresolved: number;
  warnings: string[];
}

interface TeamMemberDoc {
  user_id: string;
  role: "owner" | "admin" | "member";
  added_at: Date;
  added_by: string;
}

// `_id` is intentionally omitted here so the doc is a valid
// `OptionalId<TeamDoc>` for `teams.insertOne(team)`. `findOne` results are
// automatically widened to `WithId<TeamDoc>` by the MongoDB driver, which
// supplies `_id: ObjectId` when we read `existing._id` below.
interface TeamDoc {
  name: string;
  slug: string;
  description?: string;
  source?: string;
  is_system_managed?: boolean;
  status?: string;
  owner_id?: string;
  created_by?: string;
  updated_by?: string;
  created_at?: Date;
  updated_at?: Date;
  members?: TeamMemberDoc[];
}

/**
 * Idempotently grant every admin of the Super Admins team organization-admin
 * rights by writing the userset tuple
 * `team:super-admins#admin -> admin -> organization:<key>`.
 *
 * The OpenFGA model already declares `organization#admin: [..., team#admin]`,
 * so this single tuple makes membership in `super-admins` confer full
 * org-admin (which `can_manage organization` resolves through). Because the
 * team model implies `member` from `admin`, and the bootstrap seeds every
 * Super Admin as `team#admin`, this covers all members of the team.
 *
 * `writeOpenFgaTuples` filters out tuples that already exist, so this is a
 * cheap no-op on every subsequent startup. Failures are captured into the
 * caller's `warnings` array rather than thrown, matching the
 * never-throw contract of the surrounding bootstrap.
 */
async function ensureSuperAdminsOrgAdminLink(warnings: string[]): Promise<void> {
  try {
    await writeOpenFgaTuples({
      writes: [
        {
          user: `team:${SUPER_ADMINS_TEAM_SLUG}#admin`,
          relation: "admin",
          object: organizationObjectId(),
        },
      ],
      deletes: [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`super-admins org-admin linkage: failed to write OpenFGA tuple: ${message}`);
  }
}

function emptySkipped(reason: string): SuperAdminsBootstrapResult {
  return {
    status: "skipped",
    team_slug: SUPER_ADMINS_TEAM_SLUG,
    members_added: 0,
    members_already_present: 0,
    members_unresolved: 0,
    warnings: [reason],
  };
}

/**
 * Idempotently ensure the Super Admins team exists with the supplied members.
 *
 * - If no bootstrap admins are configured, returns `skipped` and does nothing.
 * - If the team is missing, creates it and writes membership tuples.
 * - If the team exists but is missing one or more bootstrap admins, adds the
 *   missing rows in both Mongo and OpenFGA. Never demotes or removes anyone.
 * - Never throws: per-member failures are captured in `warnings` so the
 *   surrounding startup migration can finish.
 */
export async function ensureSuperAdminsTeam(
  input: SuperAdminsBootstrapInput,
): Promise<SuperAdminsBootstrapResult> {
  if (!isMongoDBConfigured) {
    return emptySkipped("MongoDB not configured; super-admins bootstrap skipped");
  }
  if (input.members.length === 0) {
    return emptySkipped("No bootstrap admins configured; super-admins bootstrap skipped");
  }

  const now = input.now ?? new Date();
  const actor = input.actor.trim() || "system";
  const warnings: string[] = [];
  const teams = await getCollection<TeamDoc>("teams");

  // Make membership in the Super Admins team confer organization-admin. This
  // is independent of the Mongo team document, so we do it up front and it
  // applies whether we create the team below or top up an existing one.
  await ensureSuperAdminsOrgAdminLink(warnings);

  // Resolve missing Keycloak subjects on the fly so the helper is callable
  // outside of `reconcileBootstrapAdmins` too (e.g. from a test or admin
  // tool). When `userSubject` is already populated we trust it.
  const resolvedMembers = await Promise.all(
    input.members.map(async (member) => {
      const email = member.email.trim().toLowerCase();
      let userSubject = member.userSubject;
      if (!userSubject) {
        try {
          userSubject = await resolveKeycloakUserSubject(email, SUPER_ADMINS_TEAM_SLUG);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`${email}: ${message}`);
        }
      }
      return { email, userSubject };
    }),
  );

  let membersAdded = 0;
  let membersAlreadyPresent = 0;
  let membersUnresolved = 0;

  const existing = await teams.findOne({ slug: SUPER_ADMINS_TEAM_SLUG });

  if (!existing) {
    // Commit 6/8 of the canonical-team-membership refactor (spec
    // 2026-05-26-canonical-team-membership): we no longer seed
    // `members: [...]` onto the new super-admins team document. The
    // upsertTeamMembershipSource loop below is the sole record of
    // who's on this team.
    const team: TeamDoc = {
      name: SUPER_ADMINS_TEAM_NAME,
      slug: SUPER_ADMINS_TEAM_SLUG,
      description:
        "Platform-managed team seeded from RBAC_BOOTSTRAP_ADMIN_EMAILS. " +
        "Used as the default onboarding team for Slack/Webex channels until an admin picks one explicitly.",
      source: "system",
      is_system_managed: true,
      status: "active",
      owner_id: resolvedMembers[0]?.email ?? actor,
      created_by: actor,
      updated_by: actor,
      created_at: now,
      updated_at: now,
    };
    const insertResult = await teams.insertOne(team);
    const teamId = String(insertResult.insertedId);
    const createdAt = now.toISOString();
    const sourceBase = {
      team_id: teamId,
      team_slug: SUPER_ADMINS_TEAM_SLUG,
      source_type: "manual" as const,
      managed: true,
      status: "active" as const,
      created_by: actor,
      created_at: createdAt,
      first_seen_at: createdAt,
      last_seen_at: createdAt,
      last_applied_at: createdAt,
    };
    for (let i = 0; i < resolvedMembers.length; i += 1) {
      const member = resolvedMembers[i];
      const role: TeamMemberDoc["role"] = i === 0 ? "owner" : "admin";
      if (!member.userSubject) {
        membersUnresolved += 1;
        warnings.push(
          `${member.email}: no Keycloak subject; persisted membership source for later repair`,
        );
      } else {
        try {
          await writeTeamMembershipTuples(
            member.userSubject,
            SUPER_ADMINS_TEAM_SLUG,
            mongoRoleToOpenFgaRelations(role),
            "assign",
          );
          membersAdded += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`${member.email}: failed to write OpenFGA tuple: ${message}`);
        }
      }
      const source: TeamMembershipSource = {
        ...sourceBase,
        user_email: member.email,
        user_subject: member.userSubject,
        relationship: role === "owner" ? "admin" : role,
      };
      try {
        await upsertTeamMembershipSource(source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`${member.email}: failed to record membership source: ${message}`);
      }
    }
    await ensureSuperAdminsOrgAdminTuple(warnings);
    return {
      status: "created",
      team_slug: SUPER_ADMINS_TEAM_SLUG,
      members_added: membersAdded,
      members_already_present: 0,
      members_unresolved: membersUnresolved,
      warnings,
    };
  }

  // Team already exists. Top up missing bootstrap admins; never demote or
  // remove anyone -- this preserves manual edits an admin may have made.
  //
  // Commit 6/8 of the canonical-team-membership refactor (spec
  // 2026-05-26-canonical-team-membership): "who's already on the team"
  // comes from the canonical `team_membership_sources` store, NOT from
  // the now-defunct `existing.members[]` array.
  const existingMembers = await loadActiveTeamMembers(SUPER_ADMINS_TEAM_SLUG);
  const existingMemberEmails = new Set(
    existingMembers
      .map((m) => (typeof m.user_email === "string" ? m.user_email.toLowerCase() : ""))
      .filter((email): email is string => email.length > 0),
  );
  const teamId = existing._id ? String(existing._id) : SUPER_ADMINS_TEAM_SLUG;
  const createdAt = (existing.created_at ?? now).toISOString();
  const sourceBase = {
    team_id: teamId,
    team_slug: SUPER_ADMINS_TEAM_SLUG,
    source_type: "manual" as const,
    managed: true,
    status: "active" as const,
    created_by: existing.created_by ?? actor,
    created_at: createdAt,
    first_seen_at: createdAt,
    last_seen_at: now.toISOString(),
    last_applied_at: now.toISOString(),
  };
  // Commit 6/8 of the canonical-team-membership refactor: the old
  // `newMemberDocs[]` collector existed only to build the $push payload
  // into teams.members[]. With that write gone we just need a count so
  // we can report status: "updated" vs "noop" to the caller.
  let newMemberCount = 0;
  for (const member of resolvedMembers) {
    if (existingMemberEmails.has(member.email)) {
      membersAlreadyPresent += 1;
      continue;
    }
    newMemberCount += 1;
    if (!member.userSubject) {
      membersUnresolved += 1;
      warnings.push(
        `${member.email}: no Keycloak subject; persisted membership source for later repair`,
      );
    } else {
      try {
        await writeTeamMembershipTuples(
          member.userSubject,
          SUPER_ADMINS_TEAM_SLUG,
          mongoRoleToOpenFgaRelations("admin"),
          "assign",
        );
        membersAdded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`${member.email}: failed to write OpenFGA tuple: ${message}`);
      }
    }
    const source: TeamMembershipSource = {
      ...sourceBase,
      user_email: member.email,
      user_subject: member.userSubject,
      relationship: "admin",
    };
    try {
      await upsertTeamMembershipSource(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${member.email}: failed to record membership source: ${message}`);
    }
  }

  // Always make sure the system-managed marker is set on the team doc --
  // upgrades from a hand-created `super-admins` team should inherit it.
  //
  // Commit 6/8 of the canonical-team-membership refactor (spec
  // 2026-05-26-canonical-team-membership): we no longer $push into
  // teams.members[]. Membership lives exclusively in
  // team_membership_sources (the upsert loop above), so we only need
  // to refresh the system-managed marker and mutation timestamps here.
  const setOps: Record<string, unknown> = {
    is_system_managed: true,
    source: existing.source ?? "system",
    updated_at: now,
    updated_by: actor,
  };
  await teams.updateOne({ slug: SUPER_ADMINS_TEAM_SLUG }, { $set: setOps });

  await ensureSuperAdminsOrgAdminTuple(warnings);
  return {
    status: newMemberCount > 0 ? "updated" : "noop",
    team_slug: SUPER_ADMINS_TEAM_SLUG,
    members_added: membersAdded,
    members_already_present: membersAlreadyPresent,
    members_unresolved: membersUnresolved,
    warnings,
  };
}
