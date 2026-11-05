/**
 * @jest-environment node
 */
/**
 * Drop the legacy `team.resources` array. The migration backfills every
 * array-only grant as its canonical OpenFGA tuple (belt-and-suspenders on top of
 * the universal backfill) and then `$unset`s the field. Key properties:
 *   - grant→tuple mapping mirrors deriveUniversalRebacPlan,
 *   - `tool_wildcard` survives as the `tool:__all_mcp_servers_intent__` intent sentinel,
 *   - invalid ids are skipped + warned, slugless teams unset without backfill,
 *   - re-run (no `resources` fields left) is a no-op.
 */

import {
  applyDropTeamResourcesArrayMigration,
  computeDropTeamResourcesRewrites,
  DROP_TEAM_RESOURCES_ARRAY_CONFIRMATION,
  DROP_TEAM_RESOURCES_ARRAY_MIGRATION_ID,
  planDropTeamResourcesArrayMigration,
  type TeamResourcesDoc,
} from "../drop-team-resources-array";

describe("computeDropTeamResourcesRewrites", () => {
  it("maps each grant kind to its canonical tuple, incl. the tool_wildcard sentinel", () => {
    const teams: TeamResourcesDoc[] = [
      {
        _id: "team-platform",
        slug: "platform",
        resources: {
          agents: ["github"],
          agent_admins: ["github"],
          tools: ["jira/*"],
          knowledge_bases: ["runbooks"],
          skills: ["triage"],
          tasks: ["nightly-sync"],
          tool_wildcard: true,
        },
      },
    ];

    const r = computeDropTeamResourcesRewrites(teams);

    expect(r.teamsWithResources).toBe(1);
    expect(r.teamIdsToUnset).toEqual(["team-platform"]);
    expect(r.invalidIdentifiers).toBe(0);
    expect(r.tupleWrites).toEqual([
      { user: "team:platform#member", relation: "user", object: "agent:github" },
      { user: "team:platform#admin", relation: "manager", object: "agent:github" },
      { user: "team:platform#member", relation: "caller", object: "tool:jira/*" },
      { user: "team:platform#member", relation: "reader", object: "knowledge_base:runbooks" },
      { user: "team:platform#member", relation: "user", object: "skill:triage" },
      { user: "team:platform#member", relation: "user", object: "task:nightly-sync" },
      { user: "team:platform#member", relation: "caller", object: "tool:__all_mcp_servers_intent__" },
    ]);
  });

  it("unsets teams with an empty resources object but writes no tuples", () => {
    const r = computeDropTeamResourcesRewrites([
      { _id: "t", slug: "t", resources: {} },
    ]);
    expect(r.teamsWithResources).toBe(1);
    expect(r.teamIdsToUnset).toEqual(["t"]);
    expect(r.tupleWrites).toEqual([]);
  });

  it("skips invalid grant ids with a warning but still backfills the valid ones", () => {
    const r = computeDropTeamResourcesRewrites([
      {
        _id: "team-sre",
        slug: "sre",
        resources: { agents: ["good-agent", "bad agent id"] },
      },
    ]);
    expect(r.invalidIdentifiers).toBe(1);
    expect(r.tupleWrites).toEqual([
      { user: "team:sre#member", relation: "user", object: "agent:good-agent" },
    ]);
    expect(r.warnings.some((w) => w.includes("bad agent id"))).toBe(true);
  });

  it("unsets a slugless/invalid-slug team without backfill and warns", () => {
    const r = computeDropTeamResourcesRewrites([
      { _id: "team-noslug", resources: { agents: ["github"] } },
    ]);
    expect(r.teamIdsToUnset).toEqual(["team-noslug"]);
    expect(r.tupleWrites).toEqual([]);
    expect(r.warnings.some((w) => w.includes("invalid slug"))).toBe(true);
  });

  it("ignores teams that no longer carry the resources field (idempotent re-run)", () => {
    const r = computeDropTeamResourcesRewrites([
      { _id: "already-migrated", slug: "done" },
    ]);
    expect(r.teamsWithResources).toBe(0);
    expect(r.teamIdsToUnset).toEqual([]);
    expect(r.tupleWrites).toEqual([]);
  });

  it("dedupes identical tuples across teams", () => {
    const r = computeDropTeamResourcesRewrites([
      { _id: "a", slug: "shared", resources: { agents: ["github"] } },
      { _id: "b", slug: "shared", resources: { agents: ["github"] } },
    ]);
    expect(r.tupleWrites).toEqual([
      { user: "team:shared#member", relation: "user", object: "agent:github" },
    ]);
  });
});

describe("planDropTeamResourcesArrayMigration", () => {
  it("reports counts, confirmation, and sample diffs", () => {
    const plan = planDropTeamResourcesArrayMigration([
      { _id: "t1", slug: "t1", resources: { agents: ["a"] } },
      { _id: "t2", slug: "t2" },
    ]);
    expect(plan.migration_id).toBe(DROP_TEAM_RESOURCES_ARRAY_MIGRATION_ID);
    expect(plan.release).toBe("0.6.0");
    expect(plan.confirmation).toBe(DROP_TEAM_RESOURCES_ARRAY_CONFIRMATION);
    expect(plan.counts.teams_total).toBe(2);
    expect(plan.counts.teams_with_resources).toBe(1);
    expect(plan.counts.tuple_writes_planned).toBe(1);
    expect(plan.tuple_writes_planned).toBe(1);
    expect(plan.sample_diffs).toEqual([
      { collection: "teams", id: "t1", before: { resources: "<present>" }, after: { resources: "<unset>" } },
    ]);
  });
});

describe("applyDropTeamResourcesArrayMigration", () => {
  it("writes backfill tuples first, then unsets resources, reporting actual writer counts", async () => {
    const teams: TeamResourcesDoc[] = [
      { _id: "team-platform", slug: "platform", resources: { agents: ["github"], tool_wildcard: true } },
    ];
    // Writer reports fewer writes than planned (some were already present) — the
    // result must reflect the WRITER, not the planned length.
    const writeTuples = jest.fn().mockResolvedValue({ writes: 1 });
    const updateOne = jest.fn().mockResolvedValue({});

    const result = await applyDropTeamResourcesArrayMigration({
      teams,
      actor: "admin@example.com",
      now: "2026-06-25T00:00:00.000Z",
      writeTuples,
      teamsCollection: { updateOne },
    });

    expect(writeTuples).toHaveBeenCalledWith([
      { user: "team:platform#member", relation: "user", object: "agent:github" },
      { user: "team:platform#member", relation: "caller", object: "tool:__all_mcp_servers_intent__" },
    ]);
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "team-platform" });
    expect((update as { $unset: Record<string, unknown> }).$unset).toEqual({ resources: "" });

    expect(result.applied_counts).toEqual({
      teams_updated: 1,
      tuple_writes_applied: 1,
    });
    expect(result.applied_by).toBe("admin@example.com");
    expect(result.applied_at).toBe("2026-06-25T00:00:00.000Z");
  });

  it("does not call the tuple writer when there is nothing to backfill", async () => {
    const writeTuples = jest.fn();
    const updateOne = jest.fn().mockResolvedValue({});

    const result = await applyDropTeamResourcesArrayMigration({
      teams: [{ _id: "t", slug: "t", resources: {} }],
      actor: "admin@example.com",
      now: "2026-06-25T00:00:00.000Z",
      writeTuples,
      teamsCollection: { updateOne },
    });

    expect(writeTuples).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(result.applied_counts.tuple_writes_applied).toBe(0);
    expect(result.applied_counts.teams_updated).toBe(1);
  });

  it("re-run is a no-op once the field is gone", async () => {
    const writeTuples = jest.fn();
    const updateOne = jest.fn();

    const result = await applyDropTeamResourcesArrayMigration({
      teams: [{ _id: "already-migrated", slug: "done" }],
      actor: "admin@example.com",
      now: "2026-06-25T00:00:00.000Z",
      writeTuples,
      teamsCollection: { updateOne },
    });

    expect(writeTuples).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(result.applied_counts).toEqual({ teams_updated: 0, tuple_writes_applied: 0 });
  });
});
