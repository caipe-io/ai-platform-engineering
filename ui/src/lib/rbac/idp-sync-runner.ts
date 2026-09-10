// Shared execution path for IdP directory syncs. Both the manual trigger route
// (POST .../directory-sync/trigger) and the background scheduler use this so a
// scheduled run and a button-click run are byte-for-byte the same work, honor
// the same concurrency guards, and record the same kind of history row — the
// only difference is the `triggered_by` tag.

import { randomUUID } from "crypto";

import { getCollection } from "@/lib/mongodb";
import { planIdentityGroupSync } from "@/lib/rbac/identity-group-sync-planner";
import { applyIdentityGroupSyncPlan } from "@/lib/rbac/identity-group-sync-reconciler";
import { listIdentityGroupSyncRules } from "@/lib/rbac/identity-group-sync-rule-store";
import { fetchExternalGroupsForProvider } from "@/lib/rbac/idp-connectors";
import {
  HEARTBEAT_INTERVAL_MS,
  getIdpSyncSettings,
  heartbeatIdpSyncRun,
  insertIdpSyncRun,
  listRunningIdpSyncRuns,
  reapStaleIdpSyncRuns,
  updateIdpSyncRun,
} from "@/lib/rbac/idp-sync-store";
import { linkFederatedIdentity, provisionShellUser } from "@/lib/rbac/keycloak-admin";
import { reconcileSyncedUsersBaselineAccess } from "@/lib/rbac/login-openfga-bootstrap";
import { mapWithConcurrency } from "@/lib/rbac/openfga";
import { loopYieldEvery, maybeYield } from "@/lib/rbac/event-loop-yield";
import { startStageProgress } from "@/lib/rbac/sync-progress";
import { stripArchivedTeamResourceGrants } from "@/lib/rbac/archived-team-grants";
import { listActiveTeamMembershipSourcesForProvider } from "@/lib/rbac/team-membership-source-store";

import { getRbacCollection } from "./mongo-collections";
import type { IdpSyncRun } from "./mongo-collections";

interface TeamDocument {
  id?: string;
  _id?: unknown;
  slug: string;
  name: string;
  status?: string;
}

// Directory member as returned by a connector, before we resolve its subject.
interface SyncMember {
  email?: string;
  active?: boolean;
  subject?: string;
  display_name?: string;
  okta_user_id?: string;
}

// How many directory members to resolve/provision against Keycloak in parallel.
// The member-resolution phase is the longest part of a large sync (two Keycloak
// admin calls per distinct user), so we fan it out instead of awaiting each in
// series. Bounded so we don't open thousands of simultaneous Keycloak calls;
// tunable via env. Each worker awaits I/O, which also keeps the event loop
// responsive for the pod's k8s health probes (no explicit yield needed).
const DEFAULT_MEMBER_RESOLVE_CONCURRENCY = 16;
function memberResolveConcurrency(): number {
  const fromEnv = Number(process.env.IDENTITY_SYNC_MEMBER_CONCURRENCY);
  if (Number.isFinite(fromEnv) && fromEnv >= 1) return Math.floor(fromEnv);
  return DEFAULT_MEMBER_RESOLVE_CONCURRENCY;
}


async function listExistingTeams(): Promise<
  Array<{ id: string; slug: string; name: string; status?: string }>
> {
  const col = await getCollection<TeamDocument>("teams");
  const teams = await col.find({}).project({ id: 1, slug: 1, name: 1, status: 1 }).toArray();
  return teams.map((t) => ({
    id: t.id ?? String(t._id ?? t.slug),
    slug: t.slug,
    name: t.name,
    status: t.status,
  }));
}

/**
 * Outcome of trying to create a `running` run row. `created` means this caller
 * owns the run and must execute it; `already_running` means another run holds
 * the connector and this caller should back off (the existing run's id is
 * returned so the UI can point at it).
 */
export type CreateSyncRunResult =
  | { status: "created"; runId: string }
  | { status: "already_running"; runId: string };

/**
 * Reserve a sync run for `provider`: reap dead rows, refuse if one is already
 * running, insert a `running` row, then resolve insert races so exactly one
 * run wins. Does NOT execute — the caller schedules `executeSyncRun` (the route
 * via `after()` so it runs post-response; the scheduler directly).
 */
export async function createSyncRun(input: {
  provider: string;
  actor: string;
  triggeredBy: IdpSyncRun["triggered_by"];
}): Promise<CreateSyncRunResult> {
  const { provider, actor, triggeredBy } = input;

  // Clear out any dead `running` rows (e.g. a pod that restarted mid-sync)
  // first, so an orphan never blocks new syncs.
  await reapStaleIdpSyncRuns(provider, Date.now());

  // Guard 1, fast pre-check: refuse if a sync is already running for this
  // connector (double-click, or the scheduler firing mid-manual-run).
  const alreadyRunning = await listRunningIdpSyncRuns(provider);
  if (alreadyRunning.length > 0) {
    return { status: "already_running", runId: alreadyRunning[0].id };
  }

  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  // Record the run as `running` up front so it appears immediately in the
  // Sync History, then do the actual work after this returns.
  await insertIdpSyncRun({
    id: runId,
    provider_id: provider,
    status: "running",
    triggered_by: triggeredBy,
    triggered_by_user: actor,
    started_at: startedAt,
  });

  // Guard 2, race resolution: two creators can both pass the pre-check and
  // insert. There's no unique index to lean on, so we re-read and let the
  // earliest run (by started_at, then id) win; any later one aborts itself.
  const running = await listRunningIdpSyncRuns(provider);
  const winner = running[0];
  if (winner && winner.id !== runId) {
    await updateIdpSyncRun(runId, {
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: "Superseded by a concurrent sync for this connector.",
    });
    return { status: "already_running", runId: winner.id };
  }

  return { status: "created", runId };
}

/**
 * Execute the full directory sync for an already-created `running` run record.
 * In the request path this runs AFTER the HTTP response (via `after()`), so a
 * slow/rate-limited Okta pull (which can take tens of seconds and may 429)
 * never blocks the request or surfaces as a UI error; the outcome is recorded
 * on the run row instead and shows up in the Sync History section. The
 * scheduler invokes it directly (no request to wait on).
 */
export async function executeSyncRun(runId: string, provider: string, actor: string): Promise<void> {
  console.log(`[IdpSync] run ${runId} started (provider=${provider}, by=${actor})`);
  // Heartbeat for the whole run (covers every phase, not just member-scan), so
  // a crash anywhere is detectable. Cleared in `finally`.
  const heartbeat = setInterval(() => {
    void heartbeatIdpSyncRun(runId, Date.now());
  }, HEARTBEAT_INTERVAL_MS);
  try {
    await heartbeatIdpSyncRun(runId, Date.now());
    // Manual and scheduled syncs share this one path, so both honor the same
    // saved group filter from the connector's settings.
    const settings = await getIdpSyncSettings(provider);

    // Throttle progress writes so a large org doesn't do one Mongo write per
    // group, but always persist the first report (so the total shows up
    // immediately) and the final one. Step is capped at 25 so even a
    // thousand-group sync updates the chip frequently.
    let lastWritten = -1;
    const onProgress = (scanned: number, total: number) => {
      const step = Math.min(25, Math.max(1, Math.floor(total / 50)));
      const isFirst = lastWritten < 0;
      if (isFirst || scanned === total || scanned - lastWritten >= step) {
        lastWritten = scanned;
        void updateIdpSyncRun(runId, { progress_scanned: scanned, progress_total: total });
      }
    };

    const groupFilter = settings.group_filter?.trim() || undefined;
    // Record the filter this run used so Sync History can flag scoped runs.
    if (groupFilter) {
      await updateIdpSyncRun(runId, { group_filter: groupFilter });
    }
    const [groups, rules, existingTeams, existingMembershipSources] = await Promise.all([
      fetchExternalGroupsForProvider(provider, { groupFilter, onProgress }),
      listIdentityGroupSyncRules(provider),
      listExistingTeams(),
      listActiveTeamMembershipSourcesForProvider(provider),
    ]);

    // Resolve each active member's email to a Keycloak `sub`, JIT-creating a
    // federated shell user when none exists yet, so RBAC can be granted before
    // the person ever logs into CAIPE. Connectors return members without a
    // subject (they only know the directory identity); without this the planner
    // skips everyone as `missing_subject`. Cached per run so a user appearing in
    // many groups is resolved once.
    //
    // For Okta specifically, also register a real Keycloak federated-identity
    // link using the member's Okta user id — identical to what Keycloak's OIDC
    // broker would write on an actual SSO login (Okta's default `sub` claim is
    // its Users API `id`). Without this, sync-provisioned users have no
    // federatedIdentities entry until they sign in once, which is what makes
    // consumers that gate on "is this user federated" (e.g. the Slack bot's
    // unlinked-fallback check) treat them as unlinked even though the directory
    // sync already vouches for their identity.
    const idpAlias = process.env.IDENTITY_SYNC_OKTA_KEYCLOAK_IDP_ALIAS?.trim() || "okta";

    // Collect one representative member per unique email up front. A user in an
    // org typically appears in many groups; we only want to provision and link
    // them once, so we dedupe by email before doing any Keycloak work. We keep
    // the first active occurrence (its display name / Okta id) as the record to
    // provision from.
    const yieldEvery = loopYieldEvery();
    const totalMemberships = (groups as Array<{ members?: SyncMember[] }>).reduce(
      (sum, group) => sum + (group.members?.length ?? 0),
      0
    );
    console.log(
      `[IdpSync] run ${runId}: fetched ${groups.length} group(s), ${totalMemberships} membership row(s)`
    );

    const dedupeProgress = startStageProgress("dedupe members", totalMemberships);
    const uniqueMembers = new Map<string, SyncMember>();
    let dedupeSeen = 0;
    for (const group of groups as Array<{ members?: SyncMember[] }>) {
      for (const member of group.members ?? []) {
        await maybeYield(++dedupeSeen, yieldEvery);
        dedupeProgress.tick(dedupeSeen);
        const email = member.email?.trim().toLowerCase();
        if (!member.active || !email) continue;
        if (!uniqueMembers.has(email)) uniqueMembers.set(email, member);
      }
    }
    dedupeProgress.done();

    // Resolve each unique member's email to a Keycloak `sub`, JIT-creating a
    // federated shell user when none exists yet, so RBAC can be granted before
    // the person ever logs into CAIPE. Connectors return members without a
    // subject (they only know the directory identity); without this the planner
    // skips everyone as `missing_subject`.
    //
    // For Okta specifically, also register a real Keycloak federated-identity
    // link using the member's Okta user id — identical to what Keycloak's OIDC
    // broker would write on an actual SSO login (Okta's default `sub` claim is
    // its Users API `id`). Without this, sync-provisioned users have no
    // federatedIdentities entry until they sign in once, which is what makes
    // consumers that gate on "is this user federated" (e.g. the Slack bot's
    // unlinked-fallback check) treat them as unlinked even though the directory
    // sync already vouches for their identity.
    //
    // Fanned out across `memberResolveConcurrency()` workers rather than awaited
    // one member at a time — this is the longest phase of a large sync (two
    // Keycloak calls per user). Each worker is I/O-bound, so the pool also keeps
    // the event loop responsive for the pod's k8s health probes without an
    // explicit yield.
    const subCache = new Map<string, string | null>();
    const emails = Array.from(uniqueMembers.keys());
    console.log(
      `[IdpSync] run ${runId}: resolving ${emails.length} unique member(s) ` +
        `at concurrency ${memberResolveConcurrency()}`
    );
    const resolveProgress = startStageProgress("resolve members", emails.length);
    let resolved = 0;
    await mapWithConcurrency(emails, memberResolveConcurrency(), async (email) => {
      const member = uniqueMembers.get(email)!;
      let sub: string | null = null;
      try {
        // Shares the canonical JIT provisioning logic with the BFF
        // `POST /api/admin/users/provision-shell` endpoint the bots call
        // (issue #1781) — in-process, so no self-network hop. The caller's
        // own RBAC gate (route) or trusted context (scheduler) authorizes.
        // Split "First Last" on first space; handles "Mary Jo Smith" → firstName="Mary", lastName="Jo Smith"
        const nameParts = member.display_name?.trim().split(/\s+(.+)/) ?? [];
        const firstName = nameParts[0] || undefined;
        const lastName = nameParts[1] || undefined;
        const resolved = await provisionShellUser({
          email,
          source: `idp-sync:${provider}`,
          firstName,
          lastName,
        });
        sub = resolved.sub;
      } catch (err) {
        console.warn(
          `[IdpSync] run ${runId}: failed to resolve/provision ${email}: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
      subCache.set(email, sub);
      if (provider === "okta" && sub && member.okta_user_id) {
        try {
          await linkFederatedIdentity(sub, idpAlias, {
            userId: member.okta_user_id,
            userName: email,
          });
        } catch (err) {
          // Non-fatal: a federated-identity link failure must not block RBAC
          // provisioning for this sync run. The user simply stays unlinked
          // until the next successful sync or a real SSO login.
          console.warn(
            `[IdpSync] run ${runId}: failed to link federated identity for ${email} (sub=${sub}): ` +
              (err instanceof Error ? err.message : String(err))
          );
        }
      }
      resolveProgress.tick(++resolved);
    });
    resolveProgress.done();

    // Stamp the resolved subject onto every member object in every group so the
    // planner (which reads `member.subject`) sees them. This is a second pass
    // because a user can appear in many groups but is only resolved once above.
    const stampProgress = startStageProgress("stamp subjects", totalMemberships);
    let stampSeen = 0;
    for (const group of groups as Array<{ members?: SyncMember[] }>) {
      for (const member of group.members ?? []) {
        await maybeYield(++stampSeen, yieldEvery);
        stampProgress.tick(stampSeen);
        const email = member.email?.trim().toLowerCase();
        if (!email) continue;
        const sub = subCache.get(email);
        if (sub) member.subject = sub;
      }
    }
    stampProgress.done();

    // Grant the org-member baseline (incl. the `mcp_gateway:list` caller tuple
    // that AgentGateway's coarse ext_authz gate requires) to every user this
    // run resolved to a Keycloak `sub` — BEFORE the slower team-membership
    // reconcile. A user provisioned purely by directory sync, who never
    // interactively logged into the web UI, would otherwise lack the
    // gateway-gate grant and get zero MCP tools. Doing it here means every
    // synced user has working MCP access as early as possible, independent of
    // how long the team-membership plan/apply takes. Running it for the full
    // resolved set (not just newly-added memberships) on every run is
    // idempotent (writeOpenFgaTuples drops already-present tuples) and backfills
    // users provisioned before this fix. Best-effort: never throws, so a
    // bootstrap hiccup can't block the membership reconcile that follows.
    const resolvedSubjects = Array.from(subCache.values()).filter(
      (sub): sub is string => Boolean(sub)
    );
    console.log(
      `[IdpSync] run ${runId}: bootstrapping baseline OpenFGA access for ` +
        `${resolvedSubjects.length} resolved subject(s)`
    );
    const baseline = await reconcileSyncedUsersBaselineAccess(resolvedSubjects);
    if (baseline.status === "failed") {
      console.warn(
        `[IdpSync] run ${runId}: baseline OpenFGA bootstrap failed for ` +
          `${baseline.subject_count} synced user(s): ${baseline.warning ?? "unknown error"}`
      );
    } else if (baseline.tuple_write_count > 0) {
      console.log(
        `[IdpSync] run ${runId}: baseline OpenFGA bootstrap wrote ` +
          `${baseline.tuple_write_count} tuple(s) across ${baseline.subject_count} synced user(s)`
      );
    }

    // A group filter means `groups` is only a subset of the directory, so the
    // plan must scope removals to the fetched groups (never drop memberships
    // for groups we didn't look at). Without a filter it's a full snapshot.
    const partialFetch = Boolean(groupFilter);

    console.log(
      `[IdpSync] run ${runId}: planning group sync over ${groups.length} group(s), ` +
        `${rules.length} rule(s), ${existingMembershipSources.length} existing membership source(s)` +
        (partialFetch ? " (partial fetch)" : "")
    );
    const plan = await planIdentityGroupSync({
      groups,
      rules,
      existingTeams,
      existingMembershipSources,
      now: new Date().toISOString(),
      actor,
      partialFetch,
    });
    console.log(
      `[IdpSync] run ${runId}: plan ready — ${plan.matched_groups?.length ?? 0} matched group(s), ` +
        `+${plan.membership_sources_to_add?.length ?? 0}/-${plan.membership_sources_to_remove?.length ?? 0} membership source(s), ` +
        `${plan.teams_to_create?.length ?? 0} team(s) to create`
    );

    const now = new Date().toISOString();
    console.log(`[IdpSync] run ${runId}: applying plan`);
    const result = await applyIdentityGroupSyncPlan({
      plan,
      actor,
      now,
    });
    console.log(`[IdpSync] run ${runId}: plan applied`);

    // On a full fetch, sweep for already-orphaned identity_group_sync teams
    // that pre-date this fix (their sources were previously removed but the
    // team document was never archived). Phase 3 inside applyIdentityGroupSyncPlan
    // only catches teams whose sources are removed in the current run; this
    // catches everything that slipped through before.
    let sweptArchived = 0;
    if (!partialFetch) {
      try {
        sweptArchived = await archiveAlreadyOrphanedSyncTeams({ provider, actor, now });
      } catch (sweepErr) {
        console.error(
          `[IdpSync] run ${runId}: orphan sweep failed; stale teams may remain active`,
          sweepErr,
        );
      }
    }
    const totalArchived = result.teamsArchived + sweptArchived;

    await updateIdpSyncRun(runId, {
      status: "success",
      completed_at: new Date().toISOString(),
      groups_fetched: groups.length,
      groups_matched: plan.matched_groups.length,
      membership_sources_added: result.membershipSourcesAdded,
      membership_sources_removed: result.membershipSourcesRemoved,
    });
    console.log(
      `[IdpSync] run ${runId} success: ${groups.length} groups, ` +
        `+${result.membershipSourcesAdded}/-${result.membershipSourcesRemoved} memberships, ` +
        `${totalArchived} teams archived (${sweptArchived} from sweep), ` +
        `${result.teamsUnarchived} team(s) unarchived`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surface the failure in the server log too; the run row alone is easy to
    // miss, and `after()` otherwise swallows the error silently.
    console.error(`[IdpSync] run ${runId} failed (provider=${provider}): ${message}`);
    await updateIdpSyncRun(runId, {
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: message,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Sweep for identity_group_sync teams that are already orphaned from previous
 * syncs (their managed membership sources are all removed, but the team doc
 * was never archived because the archival logic didn't exist yet). Only runs
 * on full (non-filtered) fetches so we never archive teams that simply weren't
 * in scope for a scoped sync.
 *
 * Strategy: find all non-archived identity_group_sync teams, then find which
 * ones have at least one active managed membership source for this provider.
 * Any team not in that second set gets archived.
 */
async function archiveAlreadyOrphanedSyncTeams(input: {
  provider: string;
  actor: string;
  now: string;
}): Promise<number> {
  const teamsCol = await getCollection<TeamDocument & Record<string, unknown>>("teams");
  const sourcesCol = await getRbacCollection<Record<string, unknown>>("teamMembershipSources");

  // All non-archived identity_group_sync team slugs.
  const syncTeams = await teamsCol
    .find({ source: "identity_group_sync", status: { $ne: "archived" } })
    .project({ slug: 1 })
    .toArray();
  if (syncTeams.length === 0) return 0;

  const allSlugs = syncTeams.map((t) => t.slug as string).filter(Boolean);

  // Which of those slugs have at least one active managed source for this provider?
  const activeDocs = await sourcesCol
    .distinct("team_slug", {
      team_slug: { $in: allSlugs },
      provider_id: input.provider,
      managed: true,
      status: "active",
    });
  const activeSlugs = new Set(activeDocs);

  const orphanedSlugs = allSlugs.filter((slug) => !activeSlugs.has(slug));
  if (orphanedSlugs.length === 0) return 0;

  // Chunk to stay well under MongoDB's $in limit (MongoDB itself has no hard
  // limit but the Node driver serializes BSON per-doc and large $in arrays
  // can exceed the 16 MB document size limit — 500 is a safe batch size).
  const BATCH_SIZE = 500;
  let totalModified = 0;
  for (let i = 0; i < orphanedSlugs.length; i += BATCH_SIZE) {
    const batch = orphanedSlugs.slice(i, i + BATCH_SIZE);
    const result = await teamsCol.updateMany(
      { slug: { $in: batch }, source: "identity_group_sync", status: { $ne: "archived" } },
      { $set: { status: "archived", updated_by: input.actor, updated_at: new Date(input.now) } },
    );
    totalModified += result.modifiedCount;
  }
  if (totalModified > 0) {
    console.log(`[IdpSync] orphan sweep archived ${totalModified} stale identity_group_sync team(s)`);
    // Revoke the archived teams' resource-grant tuples so archival actually
    // removes access (OpenFGA never checks team.status). Reads the store once
    // and filters to these slugs, so it scales with store size rather than
    // slug count. Best-effort — the self-check repairs anything left behind.
    try {
      const strip = await stripArchivedTeamResourceGrants(orphanedSlugs);
      if (strip.tuplesDeleted > 0) {
        console.log(
          `[IdpSync] orphan sweep stripped ${strip.tuplesDeleted} resource-grant tuple(s) ` +
            `from archived teams`,
        );
      }
    } catch (stripErr) {
      console.error(
        "[IdpSync] orphan sweep grant-strip failed; archived teams may still grant access until self-check repair",
        stripErr,
      );
    }
  }
  return totalModified;
}
