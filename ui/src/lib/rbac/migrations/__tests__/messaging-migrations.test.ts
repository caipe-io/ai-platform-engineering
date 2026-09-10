jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));
jest.mock("@/lib/rbac/openfga", () => ({ writeOpenFgaTuples: jest.fn() }));

import {
  deriveMessagingIndexPlan,
  deriveMessagingRebacPlan,
  deriveMessagingTeamMappingPlan,
  deriveMessagingTeamVisibilityPlan,
} from "../registry";

describe("messaging RBAC migration derivation", () => {
  it("deduplicates Slack grant and route tuples and records provenance relationships", () => {
    const plan = deriveMessagingRebacPlan({
      surface: {
        migrationId: "slack_channel_rebac_backfill_v1",
        schemaArea: "slack_channel_rebac",
        confirmation: "MIGRATE slack_channel_rebac TO v2",
        subjectType: "slack_channel",
        idField: "channel_id",
        routeIdField: "channel_id",
      },
      grants: [
        {
          workspace_id: "T123",
          channel_id: "C123",
          resource: { type: "agent", id: "agent-1" },
          actions: ["use"],
          status: "active",
        },
      ],
      routes: [
        { workspace_id: "T123", channel_id: "C123", agent_id: "agent-1", status: "active" },
      ],
    });

    expect(plan.tuples).toEqual([
      { user: "slack_channel:T123--C123", relation: "user", object: "agent:agent-1" },
    ]);
    expect(plan.counts).toMatchObject({
      grants_scanned: 1,
      routes_scanned: 1,
      tuples_planned: 1,
      relationships_planned: 2,
    });
    expect(plan.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: { type: "slack_channel", id: "T123--C123" },
          action: "use",
          resource: { type: "agent", id: "agent-1" },
        }),
      ]),
    );
  });

  it("skips invalid Webex identifiers and unsupported actions", () => {
    const plan = deriveMessagingRebacPlan({
      surface: {
        migrationId: "webex_space_rebac_backfill_v1",
        schemaArea: "webex_space_rebac",
        confirmation: "MIGRATE webex_space_rebac TO v2",
        subjectType: "webex_space",
        idField: "space_id",
        routeIdField: "space_id",
        botScopedAgentRoutes: true,
      },
      grants: [
        {
          workspace_id: "WEBEX",
          space_id: "space-1",
          resource: { type: "knowledge_base", id: "kb-1" },
          actions: ["read", "unsupported"],
          status: "active",
        },
        {
          workspace_id: "WEBEX",
          space_id: "bad id",
          resource: { type: "agent", id: "agent-1" },
          actions: ["use"],
          status: "active",
        },
      ],
      routes: [{ workspace_id: "WEBEX", space_id: "space-2", agent_id: "", status: "active" }],
    });

    expect(plan.tuples).toEqual([
      { user: "webex_space:WEBEX--space-1", relation: "reader", object: "knowledge_base:kb-1" },
    ]);
    expect(plan.counts).toMatchObject({
      invalid_identifiers: 2,
      unsupported_actions: 1,
      tuples_planned: 1,
    });
  });

  it("backfills Webex agent routes through a bot-scoped installation", () => {
    const plan = deriveMessagingRebacPlan({
      surface: {
        migrationId: "webex_space_rebac_backfill_v1",
        schemaArea: "webex_space_rebac",
        confirmation: "MIGRATE webex_space_rebac TO v2",
        subjectType: "webex_space",
        idField: "space_id",
        routeIdField: "space_id",
        botScopedAgentRoutes: true,
      },
      grants: [],
      routes: [
        {
          bot_id: "bot-primary",
          workspace_id: "WEBEX",
          space_id: "space-1",
          agent_id: "agent-1",
          status: "active",
        },
      ],
    });

    expect(plan.tuples).toEqual([
      {
        user: "webex_bot:bot-primary",
        relation: "bot",
        object: "webex_bot_installation:bot-primary--WEBEX--space-1",
      },
      {
        user: "webex_space:WEBEX--space-1",
        relation: "space",
        object: "webex_bot_installation:bot-primary--WEBEX--space-1",
      },
      {
        user: "webex_bot_installation:bot-primary--WEBEX--space-1",
        relation: "user",
        object: "agent:agent-1",
      },
    ]);
    expect(plan.relationships).toEqual([
      expect.objectContaining({
        subject: {
          type: "webex_bot_installation",
          id: "bot-primary--WEBEX--space-1",
        },
        action: "use",
        resource: { type: "agent", id: "agent-1" },
      }),
    ]);
  });

  it("does not guess a bot for legacy Webex routes", () => {
    const plan = deriveMessagingRebacPlan({
      surface: {
        migrationId: "webex_space_rebac_backfill_v1",
        schemaArea: "webex_space_rebac",
        confirmation: "MIGRATE webex_space_rebac TO v2",
        subjectType: "webex_space",
        idField: "space_id",
        routeIdField: "space_id",
        botScopedAgentRoutes: true,
      },
      grants: [],
      routes: [
        {
          workspace_id: "WEBEX",
          space_id: "space-1",
          agent_id: "agent-1",
          status: "active",
        },
      ],
    });

    expect(plan.tuples).toEqual([]);
    expect(plan.counts).toMatchObject({ legacy_routes_requiring_bot_assignment: 1 });
    expect(plan.warnings).toEqual([
      expect.stringContaining("set bot_id on the route to migrate it"),
    ]);
  });

  it("returns an empty plan for empty messaging inputs", () => {
    const plan = deriveMessagingRebacPlan({
      surface: {
        migrationId: "slack_channel_rebac_backfill_v1",
        schemaArea: "slack_channel_rebac",
        confirmation: "MIGRATE slack_channel_rebac TO v2",
        subjectType: "slack_channel",
        idField: "channel_id",
        routeIdField: "channel_id",
      },
      grants: [],
      routes: [],
    });

    expect(plan.tuples).toEqual([]);
    expect(plan.counts).toMatchObject({
      grants_scanned: 0,
      routes_scanned: 0,
      tuples_planned: 0,
      relationships_planned: 0,
    });
  });

  it("plans Slack and Webex team mapping repairs", () => {
    const plan = deriveMessagingTeamMappingPlan({
      teams: [{ _id: "team-1", slug: "platform" }],
      slackMappings: [
        {
          slack_workspace_id: "T123",
          slack_channel_id: "C123",
          channel_name: "incidents",
          team_slug: "platform",
          status: "active",
        },
      ],
      webexMappings: [
        {
          workspace_id: "WEBEX",
          space_id: "space-1",
          space_name: "War Room",
          team_id: "team-1",
          status: "active",
        },
      ],
    });

    expect(plan.teamMappingRepairs).toEqual([
      {
        team_id: "team-1",
        slack_channel: {
          slack_channel_id: "C123",
          channel_name: "incidents",
          slack_workspace_id: "T123",
        },
      },
      {
        team_id: "team-1",
        webex_space: {
          space_id: "space-1",
          space_name: "War Room",
          workspace_id: "WEBEX",
        },
      },
    ]);
  });

  it("plans Webex messaging indexes", () => {
    const plan = deriveMessagingIndexPlan();

    expect(plan.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ collection: "webex_space_team_mappings" }),
        expect.objectContaining({ collection: "webex_space_agent_routes" }),
        expect.objectContaining({ collection: "webex_space_grants" }),
      ]),
    );
  });

  // assisted-by Cursor Claude:claude-opus-4-7
  describe("deriveMessagingTeamVisibilityPlan", () => {
    it("emits member use/manage and admin manage tuples per Slack channel mapping", () => {
      const plan = deriveMessagingTeamVisibilityPlan({
        teams: [{ _id: "team-1", slug: "platform" }],
        slackMappings: [
          {
            slack_workspace_id: "CAIPE",
            slack_channel_id: "C0B4QFN4Q21",
            channel_name: "grid-test-4",
            team_slug: "platform",
            active: true,
          },
        ],
        webexMappings: [],
      });

      expect(plan.tuples).toEqual(
        expect.arrayContaining([
          {
            user: "team:platform#admin",
            relation: "manager",
            object: "slack_channel:CAIPE--C0B4QFN4Q21",
          },
          {
            user: "team:platform#member",
            relation: "user",
            object: "slack_channel:CAIPE--C0B4QFN4Q21",
          },
          {
            user: "team:platform#member",
            relation: "manager",
            object: "slack_channel:CAIPE--C0B4QFN4Q21",
          },
        ]),
      );
      expect(plan.tuples).toHaveLength(3);
      expect(plan.counts).toMatchObject({
        slack_channels_scanned: 1,
        webex_spaces_scanned: 0,
        relationships_planned: 3,
        tuples_planned: 3,
        missing_teams: 0,
        tuple_writes_planned: 3,
      });
    });

    it("emits parallel tuples for Webex space mappings", () => {
      const plan = deriveMessagingTeamVisibilityPlan({
        teams: [{ _id: "team-1", slug: "platform" }],
        slackMappings: [],
        webexMappings: [
          {
            workspace_id: "WEBEX",
            space_id: "space-1",
            team_id: "team-1",
            active: true,
          },
        ],
      });

      expect(plan.tuples).toEqual(
        expect.arrayContaining([
          {
            user: "team:platform#admin",
            relation: "manager",
            object: "webex_space:WEBEX--space-1",
          },
          {
            user: "team:platform#member",
            relation: "user",
            object: "webex_space:WEBEX--space-1",
          },
        ]),
      );
      expect(plan.tuples).toHaveLength(2);
    });

    it("resolves team_slug via team_id when team_slug is missing on the mapping", () => {
      const plan = deriveMessagingTeamVisibilityPlan({
        teams: [{ _id: "team-1", slug: "platform" }],
        slackMappings: [
          {
            slack_workspace_id: "CAIPE",
            slack_channel_id: "C0AV2F7N2BX",
            team_id: "team-1",
          },
        ],
        webexMappings: [],
      });

      expect(plan.counts.missing_teams).toBe(0);
      expect(plan.tuples).toHaveLength(3);
      expect(plan.tuples?.[0].object).toBe("slack_channel:CAIPE--C0AV2F7N2BX");
    });

    it("skips mappings without a resolvable team and records the warning", () => {
      const plan = deriveMessagingTeamVisibilityPlan({
        teams: [{ _id: "team-1", slug: "platform" }],
        slackMappings: [
          {
            slack_workspace_id: "CAIPE",
            slack_channel_id: "C0XYZ",
          },
        ],
        webexMappings: [],
      });

      expect(plan.tuples).toEqual([]);
      expect(plan.counts).toMatchObject({
        slack_channels_scanned: 1,
        missing_teams: 1,
        tuples_planned: 0,
      });
      expect(plan.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Skipping Slack channel C0XYZ"),
        ]),
      );
    });

    it("skips mappings with missing workspace or channel identifiers", () => {
      const plan = deriveMessagingTeamVisibilityPlan({
        teams: [{ _id: "team-1", slug: "platform" }],
        slackMappings: [
          {
            slack_workspace_id: "",
            slack_channel_id: "C0XYZ",
            team_slug: "platform",
          },
        ],
        webexMappings: [
          {
            workspace_id: "WEBEX",
            space_id: "",
            team_slug: "platform",
          },
        ],
      });

      expect(plan.tuples).toEqual([]);
      expect(plan.counts).toMatchObject({
        invalid_identifiers: 2,
      });
    });

    it("skips mappings explicitly marked inactive", () => {
      const plan = deriveMessagingTeamVisibilityPlan({
        teams: [{ _id: "team-1", slug: "platform" }],
        slackMappings: [
          {
            slack_workspace_id: "CAIPE",
            slack_channel_id: "C0OLD",
            team_slug: "platform",
            active: false,
          },
          {
            slack_workspace_id: "CAIPE",
            slack_channel_id: "C0REVOKED",
            team_slug: "platform",
            status: "revoked",
          },
        ],
        webexMappings: [],
      });

      expect(plan.tuples).toEqual([]);
      expect(plan.counts.slack_channels_scanned).toBe(0);
    });

    it("deduplicates duplicate mappings", () => {
      const plan = deriveMessagingTeamVisibilityPlan({
        teams: [{ _id: "team-1", slug: "platform" }],
        slackMappings: [
          {
            slack_workspace_id: "CAIPE",
            slack_channel_id: "C0DUP",
            team_slug: "platform",
            active: true,
          },
          {
            slack_workspace_id: "CAIPE",
            slack_channel_id: "C0DUP",
            team_slug: "platform",
            active: true,
          },
        ],
        webexMappings: [],
      });

      expect(plan.tuples).toHaveLength(3);
    });

    it("uses the correct migration identifiers", () => {
      const plan = deriveMessagingTeamVisibilityPlan({
        teams: [],
        slackMappings: [],
        webexMappings: [],
      });

      expect(plan.migration_id).toBe("messaging_team_visibility_v1");
      expect(plan.schema_area).toBe("messaging_team_visibility");
      expect(plan.confirmation).toBe("MIGRATE messaging_team_visibility TO v2");
      expect(plan.from_version).toBe(1);
      expect(plan.to_version).toBe(2);
    });
  });
});
