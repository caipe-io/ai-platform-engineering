jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(),
}));

const mockReadOpenFgaTuples = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();

jest.mock("@/lib/rbac/openfga", () => ({
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

import {
  CREATOR_FROM_OWNER_BACKFILL_MIGRATION_ID,
  DATA_SOURCE_GRANTS_BACKFILL_MIGRATION_ID,
  PARENT_KB_INHERITANCE_BACKFILL_MIGRATION_ID,
  deriveAdminSurfaceRagDatasourcesAdminGrantPlan,
  deriveAdminSurfaceSlackAdminGrantPlan,
  deriveAgentOrganizationInheritancePlan,
  deriveAgentSharedTeamGrantsPlan,
  deriveCreatorFromOwnerBackfillPlan,
  deriveDataSourceGrantsBackfillPlan,
  deriveKnowledgeBaseSharedTeamGrantsPlan,
  deriveMcpToolGrantsBackfillPlan,
  deriveOrganizationMembershipPlan,
  deriveParentKbInheritanceBackfillPlan,
  deriveSkillHubTeamGrantPlan,
  planMigration,
} from "../registry";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("agent organization inheritance migration", () => {
  it("plans organization-admin manager tuples for existing dynamic agents", () => {
    const plan = deriveAgentOrganizationInheritancePlan([
      { _id: "agent-one" },
      { id: "agent-two" },
      { _id: "bad id" },
    ]);

    expect(plan.counts).toMatchObject({
      agents_scanned: 3,
      tuples_planned: 2,
      invalid_identifiers: 1,
    });
    expect(plan.tuple_writes_planned).toBe(2);
    expect(plan.sample_diffs).toEqual([
      {
        collection: "openfga_tuples",
        id: "agent_org_admin_inheritance_v1:0",
        before: {},
        after: { user: "organization:caipe#admin", relation: "manager", object: "agent:agent-one" },
      },
      {
        collection: "openfga_tuples",
        id: "agent_org_admin_inheritance_v1:1",
        before: {},
        after: { user: "organization:caipe#admin", relation: "manager", object: "agent:agent-two" },
      },
    ]);
  });
});

describe("organization membership migration", () => {
  it("plans organization member tuples for existing users with stable subjects", () => {
    const plan = deriveOrganizationMembershipPlan(
      [
        { email: "alice@example.com", keycloak_sub: "alice-sub" },
        { email: "bob@example.com", metadata: { keycloak_sub: "bob-sub" } },
        { email: "bad@example.com", keycloak_sub: "bad subject" },
        { email: "missing@example.com" },
      ],
      "caipe",
    );

    expect(plan.counts).toMatchObject({
      users_scanned: 4,
      users_with_subjects: 2,
      tuples_planned: 2,
      invalid_subjects: 1,
      missing_subjects: 1,
    });
    expect(plan.tuple_writes_planned).toBe(2);
    expect(plan.sample_diffs).toEqual([
      {
        collection: "openfga_tuples",
        id: "organization_membership_backfill_v1:0",
        before: {},
        after: { user: "user:alice-sub", relation: "member", object: "organization:caipe" },
      },
      {
        collection: "openfga_tuples",
        id: "organization_membership_backfill_v1:1",
        before: {},
        after: { user: "user:bob-sub", relation: "member", object: "organization:caipe" },
      },
    ]);
  });
});

// assisted-by Cursor Claude:claude-opus-4-7
//
// Regression test for the May-27-2026 silent-shared-team-grant bug:
// before this migration, the dynamic_agents.shared_with_teams field
// was Mongo-only — no canonical OpenFGA `team:<slug>#member can_use
// agent:<id>` tuples were written. The backfill walks every existing
// agent, resolves shared entries (legacy _id OR slug) against the
// teams collection, and writes the two-tuple pair per shared team.
describe("agent shared team grants migration", () => {
  it("writes member+admin tuples for every resolved shared team and skips the owner-team duplicate", () => {
    const plan = deriveAgentSharedTeamGrantsPlan(
      [
        {
          _id: "agent-deploy-helper",
          owner_team_slug: "platform",
          // Mixed legacy + modern + duplicate + bogus entries — only
          // sre + ops should produce tuples (platform is owner,
          // "missing-team" doesn't exist).
          shared_with_teams: [
            "507f1f77bcf86cd799439011", // → sre via _id
            "ops", // → ops via slug
            "platform", // owner — must be filtered
            "missing-team", // unresolved — warning only
          ],
        },
        {
          _id: "agent-noop",
          owner_team_slug: "platform",
          shared_with_teams: [],
        },
        {
          _id: "bad id",
          owner_team_slug: "platform",
          shared_with_teams: ["sre"],
        },
      ],
      [
        { _id: "507f1f77bcf86cd799439011", slug: "sre" },
        { slug: "ops" },
        { slug: "platform" },
      ],
    );

    expect(plan.counts).toMatchObject({
      agents_scanned: 3,
      agents_with_shared_teams: 1,
      shared_slugs_resolved: 2,
      unresolved_entries: 1,
      teams_scanned: 3,
      tuples_planned: 4,
    });
    expect(plan.tuple_writes_planned).toBe(4);
    expect(plan.sample_diffs).toEqual([
      {
        collection: "openfga_tuples",
        id: "agent_shared_team_grants_backfill_v1:0",
        before: {},
        after: { user: "team:sre#member", relation: "user", object: "agent:agent-deploy-helper" },
      },
      {
        collection: "openfga_tuples",
        id: "agent_shared_team_grants_backfill_v1:1",
        before: {},
        after: { user: "team:sre#admin", relation: "manager", object: "agent:agent-deploy-helper" },
      },
      {
        collection: "openfga_tuples",
        id: "agent_shared_team_grants_backfill_v1:2",
        before: {},
        after: { user: "team:ops#member", relation: "user", object: "agent:agent-deploy-helper" },
      },
      {
        collection: "openfga_tuples",
        id: "agent_shared_team_grants_backfill_v1:3",
        before: {},
        after: { user: "team:ops#admin", relation: "manager", object: "agent:agent-deploy-helper" },
      },
    ]);
    // Warnings exist for the bad agent id and the unresolved team
    // reference — the migration must surface these instead of silently
    // dropping them, so admins know exactly what wasn't backfilled.
    expect(plan.warnings.some((w: string) => w.includes("missing-team"))).toBe(true);
    expect(plan.warnings.some((w: string) => w.includes("bad id"))).toBe(true);
  });
});

describe("skill hub team grant migration", () => {
  it("plans team member skill user tuples for already-crawled hub skills", () => {
    const plan = deriveSkillHubTeamGrantPlan({
      hubs: [
        { id: "hub-one", shared_with_teams: ["507f1f77bcf86cd799439011", "sre"] },
        { id: "hub-two", shared_with_teams: [] },
      ],
      hubSkills: [
        { hub_id: "hub-one", skill_id: "deploy" },
        { hub_id: "hub-one", skill_id: "debug" },
        { hub_id: "hub-two", skill_id: "ignored" },
      ],
      teams: [
        { _id: "507f1f77bcf86cd799439011", slug: "platform" },
        { slug: "sre" },
      ],
    });

    expect(plan.counts).toMatchObject({
      hubs_scanned: 2,
      hubs_with_team_grants: 1,
      hub_skills_scanned: 3,
      tuples_planned: 4,
    });
    expect(plan.tuple_writes_planned).toBe(4);
    expect(plan.sample_diffs).toEqual([
      {
        collection: "openfga_tuples",
        id: "skill_hub_team_grants_backfill_v1:0",
        before: {},
        after: { user: "team:platform#member", relation: "user", object: "skill:hub-hub-one-deploy" },
      },
      {
        collection: "openfga_tuples",
        id: "skill_hub_team_grants_backfill_v1:1",
        before: {},
        after: { user: "team:platform#member", relation: "user", object: "skill:hub-hub-one-debug" },
      },
      {
        collection: "openfga_tuples",
        id: "skill_hub_team_grants_backfill_v1:2",
        before: {},
        after: { user: "team:sre#member", relation: "user", object: "skill:hub-hub-one-deploy" },
      },
      {
        collection: "openfga_tuples",
        id: "skill_hub_team_grants_backfill_v1:3",
        before: {},
        after: { user: "team:sre#member", relation: "user", object: "skill:hub-hub-one-debug" },
      },
    ]);
  });
});

// assisted-by Cursor Claude:claude-opus-4-7
//
// Backfill `user:<sub> manager admin_surface:rag_datasources` for every
// org admin so the org-admin super-grant on KB / Search / Data Sources /
// Graph / MCP Tools no longer relies solely on OpenFGA model inheritance
// from `organization#admin`.
describe("admin_surface:rag_datasources admin grant migration", () => {
  it("writes manager tuples for every org admin and dedupes repeated subjects", () => {
    const plan = deriveAdminSurfaceRagDatasourcesAdminGrantPlan([
      "admin-one",
      "admin-two",
      "admin-one", // duplicate
      "  admin-three  ", // whitespace
    ]);

    expect(plan.counts).toMatchObject({
      admins_scanned: 4,
      admins_resolved: 3,
      tuples_planned: 3,
      invalid_subjects: 0,
    });
    expect(plan.tuple_writes_planned).toBe(3);
    expect(plan.sample_diffs).toEqual([
      {
        collection: "openfga_tuples",
        id: "admin_surface_rag_datasources_admin_grant_v1:0",
        before: {},
        after: {
          user: "user:admin-one",
          relation: "manager",
          object: "admin_surface:rag_datasources",
        },
      },
      {
        collection: "openfga_tuples",
        id: "admin_surface_rag_datasources_admin_grant_v1:1",
        before: {},
        after: {
          user: "user:admin-two",
          relation: "manager",
          object: "admin_surface:rag_datasources",
        },
      },
      {
        collection: "openfga_tuples",
        id: "admin_surface_rag_datasources_admin_grant_v1:2",
        before: {},
        after: {
          user: "user:admin-three",
          relation: "manager",
          object: "admin_surface:rag_datasources",
        },
      },
    ]);
  });

  it("warns and skips subjects that fail OpenFGA id validation", () => {
    const plan = deriveAdminSurfaceRagDatasourcesAdminGrantPlan([
      "valid-sub",
      "bad sub with space",
      "",
    ]);

    expect(plan.counts).toMatchObject({
      admins_scanned: 3,
      admins_resolved: 1,
      tuples_planned: 1,
      invalid_subjects: 1,
    });
    expect(plan.warnings.some((w: string) => w.includes("bad sub with space"))).toBe(true);
  });
});

// assisted-by Cursor Claude:claude-opus-4-8
//
// Regression test for #1513: org admins bootstrapped before the
// admin_surface:slack seed (and who never re-logged-in) lacked the
// `user:<sub> manager admin_surface:slack` tuple and saw "You do not
// have permission" on the Slack Channels admin panel. The backfill
// writes the manager tuple for every existing org admin, mirroring the
// rag_datasources fix.
describe("admin_surface:slack admin grant migration", () => {
  it("writes manager tuples for every org admin and dedupes repeated subjects", () => {
    const plan = deriveAdminSurfaceSlackAdminGrantPlan([
      "admin-one",
      "admin-two",
      "admin-one", // duplicate
      "  admin-three  ", // whitespace
    ]);

    expect(plan.counts).toMatchObject({
      admins_scanned: 4,
      admins_resolved: 3,
      tuples_planned: 3,
      invalid_subjects: 0,
    });
    expect(plan.tuple_writes_planned).toBe(3);
    expect(plan.confirmation).toBe("MIGRATE admin_surfaces TO v3");
    expect(plan.sample_diffs).toEqual([
      {
        collection: "openfga_tuples",
        id: "admin_surface_slack_admin_grant_v1:0",
        before: {},
        after: {
          user: "user:admin-one",
          relation: "manager",
          object: "admin_surface:slack",
        },
      },
      {
        collection: "openfga_tuples",
        id: "admin_surface_slack_admin_grant_v1:1",
        before: {},
        after: {
          user: "user:admin-two",
          relation: "manager",
          object: "admin_surface:slack",
        },
      },
      {
        collection: "openfga_tuples",
        id: "admin_surface_slack_admin_grant_v1:2",
        before: {},
        after: {
          user: "user:admin-three",
          relation: "manager",
          object: "admin_surface:slack",
        },
      },
    ]);
  });

  it("warns and skips subjects that fail OpenFGA id validation", () => {
    const plan = deriveAdminSurfaceSlackAdminGrantPlan([
      "valid-sub",
      "bad sub with space",
      "",
    ]);

    expect(plan.counts).toMatchObject({
      admins_scanned: 3,
      admins_resolved: 1,
      tuples_planned: 1,
      invalid_subjects: 1,
    });
    expect(plan.warnings.some((w: string) => w.includes("bad sub with space"))).toBe(true);
  });

  it("emits an empty plan when no admins exist", () => {
    const plan = deriveAdminSurfaceSlackAdminGrantPlan([]);
    expect(plan.tuple_writes_planned).toBe(0);
    expect(plan.tuples).toEqual([]);
  });
});

describe("knowledge_base shared-team grants migration", () => {
  it("plans reader+manager tuples for every (team, kb_id) row", () => {
    const teamSlugByMongoId = new Map<string, string>([
      ["team-1", "platform"],
      ["team-2", "data-eng"],
    ]);
    const plan = deriveKnowledgeBaseSharedTeamGrantsPlan(
      [
        { team_id: "team-1", kb_ids: ["kb-alpha", "kb-beta"] },
        { team_id: "team-2", kb_ids: ["kb-alpha"] },
      ],
      teamSlugByMongoId,
    );

    expect(plan.counts).toMatchObject({
      ownership_rows_scanned: 2,
      ownership_rows_resolved: 2,
      teams_touched: 2,
      tuples_planned: 9,
    });
    expect(plan.tuple_writes_planned).toBe(9);
    expect(plan.tuples).toEqual(
      expect.arrayContaining([
        { user: "team:platform#member", relation: "reader", object: "knowledge_base:kb-alpha" },
        { user: "team:platform#member", relation: "ingestor", object: "knowledge_base:kb-alpha" },
        { user: "team:platform#member", relation: "manager", object: "knowledge_base:kb-alpha" },
        { user: "team:platform#member", relation: "reader", object: "knowledge_base:kb-beta" },
        { user: "team:platform#member", relation: "ingestor", object: "knowledge_base:kb-beta" },
        { user: "team:platform#member", relation: "manager", object: "knowledge_base:kb-beta" },
        { user: "team:data-eng#member", relation: "reader", object: "knowledge_base:kb-alpha" },
        { user: "team:data-eng#member", relation: "ingestor", object: "knowledge_base:kb-alpha" },
        { user: "team:data-eng#member", relation: "manager", object: "knowledge_base:kb-alpha" },
      ]),
    );
  });

  it("dedupes when two ownership rows reference the same (team, kb_id)", () => {
    const plan = deriveKnowledgeBaseSharedTeamGrantsPlan(
      [
        { team_id: "team-1", kb_ids: ["kb-alpha"] },
        { team_id: "team-1", kb_ids: ["kb-alpha"] },
      ],
      new Map([["team-1", "platform"]]),
    );
    expect(plan.tuple_writes_planned).toBe(3);
  });

  it("warns and skips rows whose team_id cannot be resolved to a slug", () => {
    const plan = deriveKnowledgeBaseSharedTeamGrantsPlan(
      [
        { team_id: "team-1", kb_ids: ["kb-alpha"] },
        { team_id: "unknown-team", kb_ids: ["kb-beta"] },
      ],
      new Map([["team-1", "platform"]]),
    );

    expect(plan.counts).toMatchObject({
      ownership_rows_scanned: 2,
      ownership_rows_resolved: 1,
      teams_touched: 1,
      unresolved_teams: 1,
    });
    expect(plan.warnings.some((w: string) => w.includes("unknown-team"))).toBe(true);
  });

  it("skips invalid kb_ids with a warning, keeping the remaining rows", () => {
    const plan = deriveKnowledgeBaseSharedTeamGrantsPlan(
      [{ team_id: "team-1", kb_ids: ["kb-good", "bad id with spaces"] }],
      new Map([["team-1", "platform"]]),
    );
    expect(plan.counts).toMatchObject({
      ownership_rows_resolved: 1,
      invalid_kb_ids: 1,
      tuples_planned: 3,
    });
    expect(plan.warnings.some((w: string) => w.includes("bad id with spaces"))).toBe(true);
  });

  it("emits an empty plan when no rows exist", () => {
    const plan = deriveKnowledgeBaseSharedTeamGrantsPlan([], new Map());
    expect(plan.tuple_writes_planned).toBe(0);
    expect(plan.tuples).toEqual([]);
  });
});

describe("data_source grants backfill migration", () => {
  it("plans from paginated OpenFGA reads without sending an invalid knowledge_base prefix filter", async () => {
    mockReadOpenFgaTuples.mockResolvedValueOnce({
      tuples: [
        {
          key: {
            user: "team:platform#member",
            relation: "reader",
            object: "knowledge_base:kb-alpha",
          },
        },
        {
          key: {
            user: "team:platform#member",
            relation: "reader",
            object: "agent:agent-1",
          },
        },
      ],
      continuationToken: undefined,
    });

    const plan = await planMigration(DATA_SOURCE_GRANTS_BACKFILL_MIGRATION_ID);

    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith({ pageSize: 100 });
    expect(plan.tuples).toEqual([
      { user: "team:platform#member", relation: "reader", object: "data_source:kb-alpha" },
    ]);
  });

  it("mirrors every knowledge_base tuple as a data_source tuple", () => {
    const plan = deriveDataSourceGrantsBackfillPlan([
      { user: "team:platform#member", relation: "reader", object: "knowledge_base:kb-alpha" },
      { user: "team:platform#admin", relation: "manager", object: "knowledge_base:kb-alpha" },
      { user: "team:data-eng#member", relation: "ingestor", object: "knowledge_base:kb-beta" },
    ]);

    expect(plan.counts).toMatchObject({
      tuples_scanned: 3,
      tuples_mirrored: 3,
      tuples_planned: 3,
    });
    expect(plan.tuples).toEqual([
      { user: "team:platform#member", relation: "reader", object: "data_source:kb-alpha" },
      { user: "team:platform#admin", relation: "manager", object: "data_source:kb-alpha" },
      { user: "team:data-eng#member", relation: "ingestor", object: "data_source:kb-beta" },
    ]);
  });

  it("skips tuples whose relation is not in the mirrorable allow-list", () => {
    const plan = deriveDataSourceGrantsBackfillPlan([
      { user: "team:foo#member", relation: "reader", object: "knowledge_base:kb-1" },
      { user: "team:foo#member", relation: "can_read", object: "knowledge_base:kb-1" },
      { user: "team:foo#member", relation: "auditor", object: "knowledge_base:kb-1" },
    ]);
    expect(plan.counts).toMatchObject({
      tuples_scanned: 3,
      tuples_mirrored: 1,
    });
  });

  it("ignores tuples on other object types", () => {
    const plan = deriveDataSourceGrantsBackfillPlan([
      { user: "team:foo#member", relation: "reader", object: "agent:agent-1" },
      { user: "team:foo#member", relation: "reader", object: "knowledge_base:kb-1" },
    ]);
    expect(plan.counts).toMatchObject({ tuples_mirrored: 1 });
    expect(plan.tuples).toEqual([
      { user: "team:foo#member", relation: "reader", object: "data_source:kb-1" },
    ]);
  });

  it("warns on knowledge_base ids that are not OpenFGA-safe", () => {
    const plan = deriveDataSourceGrantsBackfillPlan([
      { user: "team:foo#member", relation: "reader", object: "knowledge_base:bad id" },
    ]);
    expect(plan.counts).toMatchObject({ tuples_mirrored: 0 });
    expect(plan.warnings.some((w: string) => w.includes("bad id"))).toBe(true);
  });

  it("dedupes identical tuples (idempotent re-runs)", () => {
    const plan = deriveDataSourceGrantsBackfillPlan([
      { user: "team:foo#member", relation: "reader", object: "knowledge_base:kb-1" },
      { user: "team:foo#member", relation: "reader", object: "knowledge_base:kb-1" },
    ]);
    expect(plan.tuple_writes_planned).toBe(1);
  });
});

describe("mcp_tool grants backfill migration", () => {
  it("emits reader, user, caller, AND manager tuples per (team, tool_id) row", () => {
    const plan = deriveMcpToolGrantsBackfillPlan(
      [
        { team_id: "team-1", tool_ids: ["search", "infra-search"] },
        { team_id: "team-2", tool_ids: ["custom-tool"] },
      ],
      new Map([
        ["team-1", "platform"],
        ["team-2", "data-eng"],
      ]),
    );

    expect(plan.counts).toMatchObject({
      ownership_rows_scanned: 2,
      ownership_rows_resolved: 2,
      teams_touched: 2,
      tuples_planned: 12, // 3 tools × 4 relations each (reader, user, caller, manager)
    });
    expect(plan.tuples).toEqual(
      expect.arrayContaining([
        { user: "team:platform#member", relation: "reader", object: "mcp_tool:search" },
        { user: "team:platform#member", relation: "user", object: "mcp_tool:search" },
        { user: "team:platform#member", relation: "caller", object: "mcp_tool:search" },
        { user: "team:platform#member", relation: "manager", object: "mcp_tool:search" },
        { user: "team:platform#member", relation: "reader", object: "mcp_tool:infra-search" },
        { user: "team:data-eng#member", relation: "caller", object: "mcp_tool:custom-tool" },
      ]),
    );
  });

  it("warns and skips rows whose team_id cannot be resolved to a slug", () => {
    const plan = deriveMcpToolGrantsBackfillPlan(
      [
        { team_id: "team-1", tool_ids: ["search"] },
        { team_id: "ghost", tool_ids: ["custom"] },
      ],
      new Map([["team-1", "platform"]]),
    );
    expect(plan.counts).toMatchObject({
      ownership_rows_resolved: 1,
      unresolved_teams: 1,
    });
    expect(plan.warnings.some((w: string) => w.includes("ghost"))).toBe(true);
  });

  it("skips invalid tool_ids with a warning", () => {
    const plan = deriveMcpToolGrantsBackfillPlan(
      [{ team_id: "team-1", tool_ids: ["good", "bad id with spaces"] }],
      new Map([["team-1", "platform"]]),
    );
    expect(plan.counts).toMatchObject({
      invalid_tool_ids: 1,
      tuples_planned: 4,
    });
    expect(plan.warnings.some((w: string) => w.includes("bad id with spaces"))).toBe(true);
  });

  it("emits an empty plan when no rows exist", () => {
    const plan = deriveMcpToolGrantsBackfillPlan([], new Map());
    expect(plan.tuple_writes_planned).toBe(0);
    expect(plan.tuples).toEqual([]);
  });
});

describe("parent_kb inheritance backfill migration (US4)", () => {
  it("writes one parent_kb edge per distinct datasource id, no per-team mirror", () => {
    const plan = deriveParentKbInheritanceBackfillPlan([
      { user: "team:platform#member", relation: "reader", object: "knowledge_base:kb-alpha" },
      { user: "team:platform#admin", relation: "manager", object: "knowledge_base:kb-alpha" },
      { user: "team:data-eng#member", relation: "ingestor", object: "knowledge_base:kb-beta" },
      // Non-KB tuples are ignored.
      { user: "team:x#member", relation: "reader", object: "agent:a-1" },
    ]);
    // kb-alpha appears twice but yields ONE edge; kb-beta yields one.
    expect(plan.tuples).toEqual([
      { user: "knowledge_base:kb-alpha", relation: "parent_kb", object: "data_source:kb-alpha" },
      { user: "knowledge_base:kb-beta", relation: "parent_kb", object: "data_source:kb-beta" },
    ]);
    expect(plan.counts).toMatchObject({ datasources: 2, tuples_planned: 2 });
    // No team:*#member tuples on data_source (the retired mirror approach).
    expect(plan.tuples.some((t) => t.user.startsWith("team:"))).toBe(false);
  });

  it("skips knowledge_base ids that are not OpenFGA-safe", () => {
    const plan = deriveParentKbInheritanceBackfillPlan([
      { user: "team:x#member", relation: "reader", object: "knowledge_base:bad id" },
    ]);
    expect(plan.tuples).toEqual([]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it("plans from paginated OpenFGA reads via planMigration", async () => {
    mockReadOpenFgaTuples.mockResolvedValueOnce({
      tuples: [
        { key: { user: "team:platform#member", relation: "reader", object: "knowledge_base:kb-1" } },
      ],
      continuationToken: undefined,
    });
    const plan = await planMigration(PARENT_KB_INHERITANCE_BACKFILL_MIGRATION_ID);
    expect(plan.tuples).toEqual([
      { user: "knowledge_base:kb-1", relation: "parent_kb", object: "data_source:kb-1" },
    ]);
  });
});

describe("creator-from-owner backfill migration (US2)", () => {
  it("writes a creator tuple for each personal owner on a shareable type, retaining owner", () => {
    const plan = deriveCreatorFromOwnerBackfillPlan([
      { user: "user:alice", relation: "owner", object: "agent:a-1" },
      { user: "user:bob", relation: "owner", object: "knowledge_base:kb-1" },
      { user: "user:carol", relation: "owner", object: "data_source:ds-1" },
      { user: "user:dave", relation: "owner", object: "mcp_tool:t-1" },
      // service_account owners are skipped (creator is [user]).
      { user: "service_account:svc", relation: "owner", object: "agent:a-2" },
      // owner on a non-shareable type is ignored.
      { user: "user:eve", relation: "owner", object: "document:d-1" },
      // non-owner relations are ignored.
      { user: "user:frank", relation: "reader", object: "agent:a-1" },
    ]);
    expect(plan.tuples).toEqual([
      { user: "user:alice", relation: "creator", object: "agent:a-1" },
      { user: "user:bob", relation: "creator", object: "knowledge_base:kb-1" },
      { user: "user:carol", relation: "creator", object: "data_source:ds-1" },
      { user: "user:dave", relation: "creator", object: "mcp_tool:t-1" },
    ]);
    // Plan never deletes — it only writes creator (owner is retained in the store).
    expect(plan.tuples.every((t) => t.relation === "creator")).toBe(true);
  });

  it("emits an empty plan when there are no personal owners", () => {
    const plan = deriveCreatorFromOwnerBackfillPlan([
      { user: "service_account:svc", relation: "owner", object: "agent:a-2" },
    ]);
    expect(plan.tuple_writes_planned).toBe(0);
    expect(plan.tuples).toEqual([]);
  });

  it("plans from a full paginated OpenFGA read via planMigration", async () => {
    mockReadOpenFgaTuples.mockResolvedValueOnce({
      tuples: [
        { key: { user: "user:alice", relation: "owner", object: "agent:a-1" } },
        { key: { user: "user:alice", relation: "reader", object: "agent:a-1" } },
      ],
      continuationToken: undefined,
    });
    const plan = await planMigration(CREATOR_FROM_OWNER_BACKFILL_MIGRATION_ID);
    expect(plan.tuples).toEqual([
      { user: "user:alice", relation: "creator", object: "agent:a-1" },
    ]);
  });
});
