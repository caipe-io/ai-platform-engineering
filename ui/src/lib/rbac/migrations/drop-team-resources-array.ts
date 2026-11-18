import { teamToolWildcardSentinelTuple, type OpenFgaTupleKey } from "@/lib/rbac/openfga";
import type { MigrationApplyResult, MigrationPlanResult, MigrationSampleDiff } from "./types";

/**
 * Drop the legacy `team.resources` array — OpenFGA is now the single source of
 * truth for team↔resource grants.
 *
 * BACKGROUND. Until the OpenFGA-read refactor, the admin Teams/Users views read
 * agents/tools/skills/etc. from a hand-curated `team.resources` array on the
 * `teams` doc. That array drifted from the OpenFGA tuples the create/share write
 * paths actually wrote (the documented Zanzibar dual-store anti-pattern): an
 * agent shared with a team appeared nowhere until an admin re-selected it by
 * hand. The reads now come from OpenFGA `list-objects`, so the array is dead
 * weight that can only re-introduce drift.
 *
 * WHAT THIS DOES. For every team doc still carrying a `resources` field:
 *   1. Backfill any grant present in `resources.*` but (possibly) missing in
 *      OpenFGA as the canonical tuple — strictly additive, idempotent (the
 *      writer no-ops identical writes). This is belt-and-suspenders on top of
 *      `universal_rebac_relationship_backfill_v1` (declared as a dependency),
 *      so no grant is lost if that backfill predates a later array edit.
 *   2. `$unset: { resources }` the field.
 *
 * Mirrors the grant→tuple mapping in `deriveUniversalRebacPlan` so reads and
 * this final backfill can never disagree:
 *   - agents        → team#member user   agent:<id>
 *   - agent_admins  → team#admin  manager agent:<id>
 *   - tools         → team#member caller  tool:<id>
 *   - knowledge_bases → team#member reader knowledge_base:<id>
 *   - skills        → team#member user   skill:<id>
 *   - tasks         → team#member user   task:<id>   (workflows)
 *   - tool_wildcard → team#member caller  tool:__all_mcp_servers_intent__  (intent sentinel — lets the
 *                     MCP-server reconciler keep auto-granting future servers
 *                     once the boolean flag is gone)
 *
 * Idempotent: a re-run finds no `resources` fields and is a no-op.
 */

export const DROP_TEAM_RESOURCES_ARRAY_MIGRATION_ID = "drop_team_resources_array_v1";
export const DROP_TEAM_RESOURCES_ARRAY_CONFIRMATION = "DROP team.resources array";

/** OpenFGA id charset guard (same as registry.ts). */
const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

function isOpenFgaId(value: unknown): value is string {
  return typeof value === "string" && OPENFGA_ID_PATTERN.test(value);
}

/** Team doc shape (only the fields this migration reads). */
export interface TeamResourcesDoc {
  _id: unknown;
  slug?: string;
  resources?: {
    agents?: string[];
    agent_admins?: string[];
    tools?: string[];
    knowledge_bases?: string[];
    skills?: string[];
    tasks?: string[];
    tool_wildcard?: boolean;
  } | null;
}

interface GrantSpec {
  ids?: string[];
  subjectRelation: "member" | "admin";
  tupleRelation: string;
  resourceType: "agent" | "tool" | "knowledge_base" | "skill" | "task";
}

export interface DropTeamResourcesRewrites {
  /** Tuples to (re)write so no array-only grant is lost before the unset. */
  tupleWrites: OpenFgaTupleKey[];
  /** Team _ids whose `resources` field will be `$unset`. */
  teamIdsToUnset: unknown[];
  /** Diagnostics surfaced in the plan. */
  warnings: string[];
  teamsWithResources: number;
  invalidIdentifiers: number;
}

function dedupeTuples(tuples: OpenFgaTupleKey[]): OpenFgaTupleKey[] {
  const seen = new Set<string>();
  const out: OpenFgaTupleKey[] = [];
  for (const tuple of tuples) {
    const key = `${tuple.user}\n${tuple.relation}\n${tuple.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tuple);
  }
  return out;
}

/** Pure: compute the backfill tuples + the set of teams to unset. No I/O. */
export function computeDropTeamResourcesRewrites(
  teams: TeamResourcesDoc[],
): DropTeamResourcesRewrites {
  const tuples: OpenFgaTupleKey[] = [];
  const teamIdsToUnset: unknown[] = [];
  const warnings: string[] = [];
  let teamsWithResources = 0;
  let invalidIdentifiers = 0;

  for (const team of teams) {
    // Only teams that still physically carry the field need touching.
    if (!Object.prototype.hasOwnProperty.call(team, "resources")) continue;
    teamsWithResources += 1;
    teamIdsToUnset.push(team._id);

    const resources = team.resources;
    const slug = typeof team.slug === "string" ? team.slug.trim() : "";
    // Only backfill tuples when we have a usable slug; a slugless team still
    // gets its dead array unset (there is nothing to lose — no tuple could ever
    // have been written for it).
    if (!resources || !slug || !isOpenFgaId(slug)) {
      if (resources && (!slug || !isOpenFgaId(slug))) {
        warnings.push(`Team ${String(team._id)} has resources but an invalid slug; unsetting without backfill.`);
      }
      continue;
    }

    const grants: GrantSpec[] = [
      { ids: resources.agents, subjectRelation: "member", tupleRelation: "user", resourceType: "agent" },
      { ids: resources.agent_admins, subjectRelation: "admin", tupleRelation: "manager", resourceType: "agent" },
      { ids: resources.tools, subjectRelation: "member", tupleRelation: "caller", resourceType: "tool" },
      { ids: resources.knowledge_bases, subjectRelation: "member", tupleRelation: "reader", resourceType: "knowledge_base" },
      { ids: resources.skills, subjectRelation: "member", tupleRelation: "user", resourceType: "skill" },
      { ids: resources.tasks, subjectRelation: "member", tupleRelation: "user", resourceType: "task" },
    ];

    for (const grant of grants) {
      for (const rawId of grant.ids ?? []) {
        const id = typeof rawId === "string" ? rawId.trim() : "";
        if (!id || !isOpenFgaId(id)) {
          invalidIdentifiers += 1;
          warnings.push(`Skipping ${grant.resourceType} grant for team ${slug}: invalid id ${String(rawId)}`);
          continue;
        }
        tuples.push({
          user: `team:${slug}#${grant.subjectRelation}`,
          relation: grant.tupleRelation,
          object: `${grant.resourceType}:${id}`,
        });
      }
    }

    // The `tool_wildcard` boolean has no per-resource id; preserve its intent as
    // the `tool:__all_mcp_servers_intent__` sentinel so the MCP-server reconciler keeps auto-granting
    // future servers to this team.
    if (resources.tool_wildcard === true) {
      tuples.push(teamToolWildcardSentinelTuple(slug));
    }
  }

  return {
    tupleWrites: dedupeTuples(tuples),
    teamIdsToUnset,
    warnings,
    teamsWithResources,
    invalidIdentifiers,
  };
}

export function planDropTeamResourcesArrayMigration(
  teams: TeamResourcesDoc[],
): MigrationPlanResult {
  const rewrites = computeDropTeamResourcesRewrites(teams);

  const sampleDiffs: MigrationSampleDiff[] = [];
  for (const id of rewrites.teamIdsToUnset) {
    if (sampleDiffs.length >= 10) break;
    sampleDiffs.push({
      collection: "teams",
      id: String(id),
      before: { resources: "<present>" },
      after: { resources: "<unset>" },
    });
  }

  return {
    migration_id: DROP_TEAM_RESOURCES_ARRAY_MIGRATION_ID,
    release: "0.6.0",
    schema_area: "team_resources",
    kind: "explicit",
    from_version: 2,
    to_version: 3,
    counts: {
      teams_total: teams.length,
      teams_with_resources: rewrites.teamsWithResources,
      tuple_writes_planned: rewrites.tupleWrites.length,
      invalid_identifiers: rewrites.invalidIdentifiers,
    },
    warnings: rewrites.warnings,
    sample_diffs: sampleDiffs,
    tuple_writes_planned: rewrites.tupleWrites.length,
    confirmation: DROP_TEAM_RESOURCES_ARRAY_CONFIRMATION,
  };
}

export interface ApplyDropTeamResourcesArrayInput {
  teams: TeamResourcesDoc[];
  actor: string;
  now: string;
  /** Writes the backfill tuples; returns the ACTUAL count written. */
  writeTuples: (writes: OpenFgaTupleKey[]) => Promise<{ writes: number }>;
  teamsCollection: {
    updateOne: (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => Promise<unknown>;
  };
}

export async function applyDropTeamResourcesArrayMigration(
  input: ApplyDropTeamResourcesArrayInput,
): Promise<MigrationApplyResult> {
  const plan = planDropTeamResourcesArrayMigration(input.teams);
  const rewrites = computeDropTeamResourcesRewrites(input.teams);

  // Tuples first: ensure every array-only grant exists in OpenFGA BEFORE the
  // array is dropped, so a crash between the two steps leaves access intact
  // (the array would just be re-unset on re-run).
  let tupleWrites = 0;
  if (rewrites.tupleWrites.length > 0) {
    const result = await input.writeTuples(rewrites.tupleWrites);
    tupleWrites = result.writes;
  }

  let teamsUpdated = 0;
  for (const teamId of rewrites.teamIdsToUnset) {
    await input.teamsCollection.updateOne(
      { _id: teamId },
      {
        $unset: { resources: "" },
        $set: {
          "metadata.drop_team_resources_array_migration": {
            migration_id: DROP_TEAM_RESOURCES_ARRAY_MIGRATION_ID,
            migrated_at: input.now,
            migrated_by: input.actor,
          },
        },
      },
    );
    teamsUpdated += 1;
  }

  return {
    ...plan,
    applied_counts: {
      teams_updated: teamsUpdated,
      tuple_writes_applied: tupleWrites,
    },
    applied_at: input.now,
    applied_by: input.actor,
  };
}
