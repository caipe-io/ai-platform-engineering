import { getCollection } from "@/lib/mongodb";
import type {
IdentityGroupSyncDryRunResult,
TeamMembershipSource,
} from "@/types/identity-group-sync";

import { stripArchivedTeamResourceGrants } from "./archived-team-grants";
import {
OpenFgaWriteError,
writeOpenFgaTuples,
type OpenFgaTupleKey,
type TeamResourceTupleDiff,
} from "./openfga";
import {
markTeamMembershipSourceRemoved,
upsertTeamMembershipSource,
} from "./team-membership-source-store";

interface IdentitySyncTeam {
  id?: string;
  _id?: unknown;
  slug: string;
  name: string;
}

export interface ApplyIdentityGroupSyncPlanInput {
  plan: IdentityGroupSyncDryRunResult;
  actor: string;
  now: string;
}

export interface ApplyIdentityGroupSyncPlanResult {
  teamsCreated: number;
  membershipSourcesAdded: number;
  membershipSourcesRemoved: number;
  membershipSourcesRefreshed: number;
  tupleWrites: number;
  tupleDeletes: number;
  openFgaEnabled: boolean;
  teamsArchived: number;
  teamsUnarchived: number;
}

/**
 * Apply an identity-group-sync plan to Mongo + OpenFGA with strong
 * consistency guarantees against partial failure.
 *
 * The plan is applied in two transactional phases:
 *
 *  Phase 1 — Team materialization. For each team in `teams_to_create`,
 *  Mongo `insertOne` runs first (because team OpenFGA tuples reference
 *  the freshly-minted ObjectId). If the insert succeeds, the team is
 *  considered "owned by this transaction" and is rolled back (deleted)
 *  if any subsequent step in this same `applyIdentityGroupSyncPlan` call
 *  fails. Teams that already existed by slug are NOT rolled back — they
 *  weren't ours to begin with.
 *
 *  Phase 2 — Membership-source + tuple reconciliation. The membership
 *  source upserts in Mongo happen first (they're cheap to roll back via
 *  `markTeamMembershipSourceRemoved`), then the OpenFGA tuple writes
 *  (and deletes) happen via `writeOpenFgaTuples`, which internally
 *  chunks to OpenFGA's 100-tuples-per-call limit and self-compensates
 *  any chunks that succeeded before a later chunk failed. If the
 *  OpenFGA call still throws after self-compensation, this function
 *  rolls back its own Mongo changes from both phases:
 *    - Phase 2 rollback: mark each newly-upserted membership source as
 *      `removed` (idempotent — re-running reconciliation will re-add).
 *    - Phase 1 rollback: delete the teams we created in this call (the
 *      OpenFGA team tuples are already self-compensated by the
 *      writeOpenFgaTuples helper).
 *
 *  The `membership_sources_to_remove` and `tuple_deletes` paths are
 *  applied in the same Phase 2 transaction. If they fail, the same
 *  rollback discipline applies.
 *
 *  This is a best-effort rollback — if the rollback itself fails (e.g.
 *  Mongo is unreachable mid-rollback), we log loudly and surface the
 *  ORIGINAL error so the caller can react. Callers MUST be prepared for
 *  the rare "rollback failed, system in inconsistent state" case (the
 *  identity-group-sync UI surfaces this via run history; the auth-config
 *  login path catches and warn-logs).
 */
export async function applyIdentityGroupSyncPlan(
  input: ApplyIdentityGroupSyncPlanInput,
): Promise<ApplyIdentityGroupSyncPlanResult> {
  // ─────────────────────────── Phase 1: teams ───────────────────────────
  const phase1 = await ensureIdentitySyncTeams(input);
  const createdTeamSlugsThisCall = phase1.createdTeamSlugsThisCall;
  const teamIdsBySlug = phase1.teamIdsBySlug;

  // ─────────── Phase 2: membership sources + OpenFGA tuples ─────────────
  const upsertedSources: TeamMembershipSource[] = [];
  const removedSources: TeamMembershipSource[] = [];

  try {
    for (const source of input.plan.membership_sources_to_add) {
      const resolved: TeamMembershipSource = {
        ...source,
        team_id: teamIdsBySlug.get(source.team_slug) ?? source.team_id,
        last_applied_at: input.now,
      };
      await upsertTeamMembershipSource(resolved);
      // Commit 6/8 of the canonical-team-membership refactor (spec
      // 2026-05-26-canonical-team-membership): we removed the
      // syncTeamEmbeddedMember() denormalization step. The Admin UI
      // now reads its member-count badge from `team.member_count`
      // (aggregated server-side from team_membership_sources, see
      // commit 4/8), so there is no consumer of `teams.members[]`
      // left to keep in sync.
      upsertedSources.push(resolved);
    }
    for (const source of input.plan.membership_sources_to_refresh ?? []) {
      const resolved = {
        ...source,
        team_id: teamIdsBySlug.get(source.team_slug) ?? source.team_id,
        last_applied_at: input.now,
      };
      await upsertTeamMembershipSource(resolved);
      // Refresh operations are idempotent — do NOT add to upsertedSources
      // so they are excluded from rollback tracking.
    }
    for (const source of input.plan.membership_sources_to_remove) {
      await markTeamMembershipSourceRemoved(source, input.actor, input.now);
      // See above — no longer mirror the removal into teams.members[].
      removedSources.push(source);
    }

    const openFgaResult = await writeOpenFgaTuples({
      writes: input.plan.tuple_writes,
      deletes: input.plan.tuple_deletes,
    });

    // ── Phase 3a: unarchive teams whose Okta group regained membership ─────
    // The planner flags a team in `teams_to_unarchive` when it's currently
    // `status: "archived"` but this run adds/refreshes an active managed
    // member for it. Flipping status back to "active" is what makes the team
    // reappear in the admin teams list (`status: { $ne: "archived" }` filter)
    // and the Slack channel-onboarding picker. Failures here are logged but
    // never thrown — the membership reconcile already succeeded.
    //
    // NOTE: this does NOT restore resource grants (agent/tool/etc. access)
    // that were stripped when the team was archived. Those grants are read
    // live from OpenFGA with no other durable record of what they were
    // (the legacy `team.resources` Mongo array was intentionally dropped —
    // see api/admin/teams/[id]/resources/route.ts), so there is nothing to
    // replay them from. An admin must re-assign resources via the Team
    // Resources UI after an unarchive if the team previously had explicit
    // grants.
    let teamsUnarchived = 0;
    if (input.plan.teams_to_unarchive && input.plan.teams_to_unarchive.length > 0) {
      try {
        teamsUnarchived = await unarchiveSyncTeams({
          slugs: input.plan.teams_to_unarchive,
          actor: input.actor,
          now: input.now,
        });
        if (teamsUnarchived > 0) {
          console.log(
            `[identity-group-sync] unarchived ${teamsUnarchived} team(s) whose Okta group regained ` +
              "active membership (resource grants, if any were stripped at archive time, are not " +
              "automatically restored)",
          );
        }
      } catch (unarchiveErr) {
        console.error(
          "[identity-group-sync] phase 3a team unarchival failed; teams may remain archived",
          unarchiveErr,
        );
      }
    }

    // ── Phase 3b: archive orphaned identity-sync teams ──────────────────────
    // After memberships are removed, any identity_group_sync team that the
    // planner flagged as "orphaned_team_membership" (no remaining managed
    // memberships) gets archived. We only do this for teams the sync owns
    // (source: "identity_group_sync") so manually-created teams are never
    // touched. Failures here are logged but never thrown — the membership
    // reconcile already succeeded; archival is best-effort cleanup.
    const orphanedSlugs = new Set(
      (input.plan.safety_warnings ?? [])
        .filter((w) => w.code === "orphaned_team_membership" && w.team_slug)
        .map((w) => w.team_slug as string),
    );
    let teamsArchived = 0;
    if (orphanedSlugs.size > 0) {
      try {
        teamsArchived = await archiveOrphanedSyncTeams({
          slugs: orphanedSlugs,
          actor: input.actor,
          now: input.now,
        });
        // Archiving the Mongo doc is cosmetic on its own — OpenFGA never
        // consults team.status. Strip the team's resource-grant tuples so an
        // archived team stops granting `team:<slug>#member can_use ...`. Only
        // strips teams we actually archived this run. The membership roster
        // (`user:<sub> member team:<slug>`) is left intact, but the resource
        // grants themselves have no other durable record (see phase 3a above)
        // — re-granting them after an unarchive is a manual, admin-driven
        // step, not something this sync replays automatically. Best-effort:
        // the membership reconcile already committed, and the self-check can
        // repair any grant that survives here.
        if (teamsArchived > 0) {
          const strip = await stripArchivedTeamResourceGrants(orphanedSlugs);
          if (strip.tuplesDeleted > 0) {
            console.log(
              `[identity-group-sync] stripped ${strip.tuplesDeleted} resource-grant tuple(s) ` +
                `from ${orphanedSlugs.size} archived team(s)`,
            );
          }
        }
      } catch (archiveErr) {
        console.error(
          "[identity-group-sync] phase 3 team archival/grant-strip failed; orphaned teams may remain active",
          archiveErr,
        );
      }
    }

    return {
      teamsCreated: phase1.teamsCreated,
      membershipSourcesAdded: input.plan.membership_sources_to_add.length,
      membershipSourcesRemoved: input.plan.membership_sources_to_remove.length,
      membershipSourcesRefreshed: (input.plan.membership_sources_to_refresh ?? []).length,
      tupleWrites: openFgaResult.writes,
      tupleDeletes: openFgaResult.deletes,
      openFgaEnabled: openFgaResult.enabled,
      teamsArchived,
      teamsUnarchived,
    };
  } catch (err) {
    // Best-effort rollback. The Mongo team docs and membership-source
    // rows we wrote in this call are reverted; OpenFGA tuples were
    // already self-compensated by writeOpenFgaTuples on its way out.
    // If rollback throws, log and surface the original error.
    await rollbackPhase2({
      upsertedSources,
      removedSources,
      actor: input.actor,
      now: input.now,
    }).catch((rollbackErr) => {
      console.error(
        "[identity-group-sync] phase 2 rollback failed; system may be in an inconsistent state",
        { rollbackErr, originalError: err },
      );
    });
    await rollbackPhase1({
      createdTeamSlugs: createdTeamSlugsThisCall,
    }).catch((rollbackErr) => {
      console.error(
        "[identity-group-sync] phase 1 rollback failed; ghost team docs may remain",
        { rollbackErr, originalError: err },
      );
    });
    throw err;
  }
}

interface EnsureTeamsResult {
  teamsCreated: number;
  teamIdsBySlug: Map<string, string>;
  // Slugs that THIS call inserted (not pre-existing). Only these are
  // eligible for phase 1 rollback — pre-existing teams aren't ours to
  // delete.
  createdTeamSlugsThisCall: Set<string>;
}

/**
 * Insert any teams in `plan.teams_to_create` that don't already exist by
 * slug. Returns a map of slug → team_id for downstream membership_source
 * resolution, plus the set of slugs we own (created in THIS call) so the
 * caller can roll them back on failure.
 *
 * If a team insert itself throws, we attempt to roll back any teams
 * already inserted in this call before rethrowing, so a Phase 1 failure
 * is also all-or-nothing.
 */
async function ensureIdentitySyncTeams(
  input: ApplyIdentityGroupSyncPlanInput,
): Promise<EnsureTeamsResult> {
  const teamIdsBySlug = new Map<string, string>();
  const createdTeamSlugsThisCall = new Set<string>();
  if (input.plan.teams_to_create.length === 0 && (!input.plan.teams_to_update || input.plan.teams_to_update.length === 0)) {
    return { teamsCreated: 0, teamIdsBySlug, createdTeamSlugsThisCall };
  }

  const teams = await getCollection<IdentitySyncTeam & Record<string, unknown>>("teams");
  const slugs = Array.from(new Set([
    ...input.plan.teams_to_create.map((team) => team.slug),
    ...(input.plan.teams_to_update ?? []).map((team) => team.slug),
  ]));
  const existing = await teams
    .find({ slug: { $in: slugs } })
    .project({ _id: 1, id: 1, slug: 1, name: 1 })
    .toArray();
  for (const team of existing) {
    teamIdsBySlug.set(team.slug, team.id ?? String(team._id ?? team.slug));
  }

  let teamsCreated = 0;
  try {
    for (const team of input.plan.teams_to_create) {
      if (teamIdsBySlug.has(team.slug)) continue;
      const result = await teams.insertOne({
        name: team.name,
        slug: team.slug,
        description: `Created from identity group ${team.source_group_id}`,
        source: "identity_group_sync",
        status: "active",
        source_group_id: team.source_group_id,
        created_by: input.actor,
        updated_by: input.actor,
        created_at: new Date(input.now),
        updated_at: new Date(input.now),
        // Commit 6/8 of the canonical-team-membership refactor (spec
        // 2026-05-26-canonical-team-membership): we no longer seed
        // an empty `members: []` array. team_membership_sources is
        // the only store of truth for who belongs to this team.
      });
      teamIdsBySlug.set(team.slug, String(result.insertedId));
      createdTeamSlugsThisCall.add(team.slug);
      teamsCreated += 1;
    }
    // Update name for teams where Okta's name differs from stored name.
    // This is inside the same try-catch so that if an updateOne throws,
    // any teams inserted earlier in this call are rolled back before
    // rethrowing (Phase 1 all-or-nothing guarantee).
    for (const team of input.plan.teams_to_update ?? []) {
      await teams.updateOne(
        { slug: team.slug },
        { $set: { name: team.name, updated_by: input.actor, updated_at: new Date(input.now) } }
      );
    }
  } catch (err) {
    // Phase 1 self-rollback: a single insert or update failed mid-loop. Delete
    // anything we already inserted in this call before rethrowing.
    await rollbackPhase1({ createdTeamSlugs: createdTeamSlugsThisCall }).catch(
      (rollbackErr) => {
        console.error(
          "[identity-group-sync] phase 1 self-rollback failed; ghost team docs may remain",
          { rollbackErr, originalError: err },
        );
      },
    );
    throw err;
  }

  return { teamsCreated, teamIdsBySlug, createdTeamSlugsThisCall };
}

/**
 * Mark every membership source we upserted in this call as `removed`,
 * and re-upsert any sources we marked removed in this call (idempotent).
 *
 * We use the same store helpers the forward path uses, so the audit
 * trail is consistent. The actor is namespaced (`*-rollback`) so the
 * audit reader can distinguish reverts from normal operations.
 */
async function rollbackPhase2(input: {
  upsertedSources: TeamMembershipSource[];
  removedSources: TeamMembershipSource[];
  actor: string;
  now: string;
}): Promise<void> {
  const rollbackActor = `${input.actor}-rollback`;
  for (const source of input.upsertedSources) {
    await markTeamMembershipSourceRemoved(source, rollbackActor, input.now);
  }
  for (const source of input.removedSources) {
    // Re-upserting a previously-removed source flips it back to active.
    // upsertTeamMembershipSource preserves identity by the natural key.
    await upsertTeamMembershipSource({
      ...source,
      status: "active",
      last_applied_at: input.now,
    });
  }
  // Commit 6/8 of the canonical-team-membership refactor (spec
  // 2026-05-26-canonical-team-membership): the matching
  // syncTeamEmbeddedMember()/unsyncTeamEmbeddedMember() rollback
  // branches were removed along with the helpers themselves; with
  // teams.members[] gone there is nothing to revert outside of the
  // canonical store.
}

/**
 * Delete every team this call inserted. Used both as a self-rollback
 * inside Phase 1 (a single insert failed) and as a cross-phase rollback
 * (Phase 2 failed and we want to undo the whole transaction). Idempotent
 * — `deleteOne` on a missing slug is a no-op.
 */
async function rollbackPhase1(input: {
  createdTeamSlugs: Set<string>;
}): Promise<void> {
  if (input.createdTeamSlugs.size === 0) return;
  const teams = await getCollection<IdentitySyncTeam & Record<string, unknown>>("teams");
  for (const slug of input.createdTeamSlugs) {
    await teams.deleteOne({ slug });
  }
}

/**
 * Unarchive identity_group_sync teams the planner flagged as having regained
 * an active managed membership. Only touches teams with source
 * "identity_group_sync" and currently `status: "archived"`, mirroring
 * `archiveOrphanedSyncTeams` below. Returns the count of teams actually
 * updated. Does not touch OpenFGA — see the phase 3a note above for why
 * stripped resource grants aren't replayed here.
 */
async function unarchiveSyncTeams(input: {
  slugs: string[];
  actor: string;
  now: string;
}): Promise<number> {
  if (input.slugs.length === 0) return 0;
  const teams = await getCollection<IdentitySyncTeam & Record<string, unknown>>("teams");
  const result = await teams.updateMany(
    { slug: { $in: input.slugs }, source: "identity_group_sync", status: "archived" },
    { $set: { status: "active", updated_by: input.actor, updated_at: new Date(input.now) } },
  );
  return result.modifiedCount;
}

/**
 * Archive identity_group_sync teams that have no remaining active managed
 * membership sources. Only touches teams with source "identity_group_sync"
 * so manually-created teams are never auto-archived. Returns the count of
 * teams actually updated.
 */
async function archiveOrphanedSyncTeams(input: {
  slugs: Set<string>;
  actor: string;
  now: string;
}): Promise<number> {
  if (input.slugs.size === 0) return 0;
  const teams = await getCollection<IdentitySyncTeam & Record<string, unknown>>("teams");
  const result = await teams.updateMany(
    { slug: { $in: Array.from(input.slugs) }, source: "identity_group_sync", status: { $ne: "archived" } },
    { $set: { status: "archived", updated_by: input.actor, updated_at: new Date(input.now) } },
  );
  return result.modifiedCount;
}

// Re-export tuple types so callers that build plans don't have to
// double-import from openfga.ts as well as from this module.
export { OpenFgaWriteError };
export type { OpenFgaTupleKey,TeamResourceTupleDiff };
