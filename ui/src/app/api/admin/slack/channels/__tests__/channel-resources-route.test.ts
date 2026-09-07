/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockCheckPermission = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
const mockCheckUniversalRebacRelationship = jest.fn();
const mockReadOpenFgaTuples = jest.fn();
const mockListOpenFgaObjects = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();
const mockAuditQuery = jest.fn();
// Phase 3 (spec 2026-05-24-derive-team-from-channel) removed the
// per-team Keycloak helpers from Slack channel onboarding —
// `ensureTeamClientScope` and `selectAgentGatewayActiveTeamScope`
// are gone, so the related mocks below are no longer needed.
const mockEnsureSlackBotOboPermissions = jest.fn();
// (See Phase 3 comment above the removed mockEnsureTeamClientScope.)
const mockCallSlackBotAdmin = jest.fn();

const mockCollections: Record<string, unknown> = {};

jest.mock("@/lib/rbac/keycloak-authz", () => ({
  checkPermission: (...args: unknown[]) => mockCheckPermission(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  checkUniversalRebacRelationship: (...args: unknown[]) =>
    mockCheckUniversalRebacRelationship(...args),
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: jest.fn(
    async (
      session: { sub?: string; isServiceAccount?: boolean },
      target: { type: string; id: string; action: string },
      options?: { bypassForOrgAdmin?: boolean }
    ) => {
      const prefix = session?.isServiceAccount === true ? "service_account" : "user";
      const user = `${prefix}:${session?.sub ?? ""}`;
      if (options?.bypassForOrgAdmin) {
        const org = await mockCheckOpenFgaTuple({
          user,
          relation: "can_manage",
          object: "organization:caipe",
        });
        if (org.allowed === true) return;
      }
      const relation = target.action === "manage" ? "can_manage" : `can_${target.action}`;
      const result = await mockCheckOpenFgaTuple({
        user,
        relation,
        object: `${target.type}:${target.id}`,
      });
      if (result.allowed === true) return;
      const error = new Error("You do not have permission to access this resource.") as Error & {
        statusCode: number;
        code: string;
      };
      error.statusCode = 403;
      error.code = `${target.type}#${target.action}`;
      throw error;
    }
  ),
  subjectFromSession: jest.fn((session: { sub?: string; isServiceAccount?: boolean }) => {
    if (!session?.sub) return null;
    return `${session.isServiceAccount === true ? "service_account" : "user"}:${session.sub}`;
  }),
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  // Phase 3 (spec 2026-05-24-derive-team-from-channel): per-team
  // scope helpers removed from the Slack channel onboarding flow.
  // Only the team-agnostic OBO permission helper remains.
  ensureSlackBotOboPermissions: (...args: unknown[]) => mockEnsureSlackBotOboPermissions(...args),
}));

jest.mock("@/lib/slack-bot-admin", () => ({
  callSlackBotAdmin: (...args: unknown[]) => mockCallSlackBotAdmin(...args),
}));

jest.mock("@/lib/jwt-validation", () => ({
  validateLocalSkillsJWT: jest.fn(async () => null),
  validateBearerJWT: jest.fn(async () => ({
    sub: "alice-sub",
    email: "alice@example.com",
    name: "Alice Admin",
  })),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(async (name: string) => mockCollections[name] ?? createMockCollection([])),
  isMongoDBConfigured: true,
}));

jest.mock("@/lib/audit/reader", () => ({
  getAuditReader: () => ({ query: (...args: unknown[]) => mockAuditQuery(...args) }),
}));

jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => key === "ssoEnabled",
}));

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: "",
}));

function matchesFilter(row: unknown, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const resolved = key.includes(".")
      ? key.split(".").reduce((acc, part) => acc?.[part], row)
      : row[key];
    if (value && typeof value === "object" && "$ne" in value) return resolved !== value.$ne;
    if (value && typeof value === "object" && "$in" in value) return value.$in.includes(resolved);
    if (value && typeof value === "object" && "$nin" in value) return !value.$nin.includes(resolved);
    if (key.includes(".")) {
      return resolved === value;
    }
    return resolved === value;
  });
}

function createMockCollection(rows: unknown[]) {
  return {
    rows,
    insertOne: jest.fn(async (row: unknown) => {
      rows.push(row);
      return { acknowledged: true };
    }),
    find: jest.fn((filter: Record<string, unknown> = {}) => {
      const matching = rows.filter((row) => matchesFilter(row, filter));
      return {
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue(matching),
      };
    }),
    findOne: jest.fn(async (filter: Record<string, unknown>) =>
      rows.find((row) => matchesFilter(row, filter)) ?? null
    ),
    updateOne: jest.fn(async (filter: Record<string, unknown>, update: unknown, options?: unknown) => {
      const row = rows.find((candidate) => matchesFilter(candidate, filter));
      if (row && update.$set) Object.assign(row, update.$set);
      if (!row && options?.upsert) {
        rows.push({ ...filter, ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) });
      }
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0, upsertedCount: row ? 0 : 1 };
    }),
    updateMany: jest.fn(async (filter: Record<string, unknown>, update: unknown) => {
      const matching = rows.filter((candidate) => matchesFilter(candidate, filter));
      for (const row of matching) {
        if (update.$set) Object.assign(row, update.$set);
      }
      return { matchedCount: matching.length, modifiedCount: matching.length };
    }),
    deleteOne: jest.fn(async (filter: Record<string, unknown>) => {
      const index = rows.findIndex((candidate) => matchesFilter(candidate, filter));
      if (index >= 0) {
        rows.splice(index, 1);
      }
      return { deletedCount: index >= 0 ? 1 : 0 };
    }),
  };
}

function request(path: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    ...init,
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

const workspaceId = "T123456789";
const workspaceAlias = "CAIPE";
const channelId = "C123456789";
const agentGrant = {
  resource: { type: "agent", id: "incident-agent" },
  actions: ["use"],
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.OPENFGA_HTTP = "http://openfga:8080";
  process.env.SLACK_WORKSPACE_ALIAS = workspaceAlias;
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
  mockCheckPermission.mockResolvedValue({ allowed: true, reason: "OK" });
  mockAuditQuery.mockResolvedValue([]);
  mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
  mockCheckUniversalRebacRelationship.mockResolvedValue({ allowed: true });
  mockReadOpenFgaTuples.mockResolvedValue({ tuples: [], continuationToken: undefined });
  mockListOpenFgaObjects.mockResolvedValue({ objects: [] });
  mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
  // Phase 3 (spec 2026-05-24-derive-team-from-channel): no team
  // client-scope mocks to reset — the helpers are gone.
  mockEnsureSlackBotOboPermissions.mockResolvedValue(undefined);
  mockCallSlackBotAdmin.mockImplementation(
    async (path: string, options?: { body?: { channel_id?: string } }) => {
      if (path === "/admin/slack/channels/inspect") {
        const inspectedChannelId = options?.body?.channel_id ?? channelId;
        const channelName =
          inspectedChannelId === "CNEWMISSING"
            ? "new-alerts"
            : inspectedChannelId === "CCHANGED"
              ? "sri-local-test-4"
              : "incidents";
        return {
          workspace_id: workspaceId,
          channel_id: inspectedChannelId,
          channel_name: channelName,
          member_count: 10,
        };
      }
      return { reloaded: "all" };
    },
  );
  process.env.SLACK_DEFAULT_TEAM_SLUG = "platform-engineering";
  process.env.SLACK_DEFAULT_AGENT_ID = "incident-agent";
  mockCollections.channel_team_mappings = createMockCollection([
    {
      slack_workspace_id: workspaceId,
      slack_channel_id: channelId,
      channel_name: "incidents",
      team_slug: "platform-engineering",
      active: true,
    },
  ]);
  mockCollections.slack_channel_grants = createMockCollection([]);
  mockCollections.platform_config = createMockCollection([
    {
      _id: "platform_settings",
      publication_approval: { require_slack_onboarding_approval: false },
    },
  ]);
});

afterEach(() => {
  delete process.env.OPENFGA_HTTP;
  delete process.env.SLACK_WORKSPACE_ALIAS;
  delete process.env.SLACK_DEFAULT_TEAM_SLUG;
  delete process.env.SLACK_DEFAULT_AGENT_ID;
});

describe("Slack channel ReBAC APIs", () => {
  it("returns configured Slack channel association defaults", async () => {
    const { GET } = await import("../defaults/route");

    const response = await GET(request("/api/admin/slack/channels/defaults"));
    const body = await response.json();

    expect(response.status).toBe(200);
    // 2026-05-27 — the defaults route returns the canonical shape
    // produced by `readOnboardingDefaults`, which is a strict
    // superset of the legacy `{team_slug, agent_id, create_routes}`.
    // When nothing is saved in MongoDB and the env vars are set, we
    // still resolve to the env value but tag it `source: "env"` so
    // the admin UI can distinguish "env default" from "saved by Bob
    // at 8am" — the chips and the "Save defaults" button rely on it.
    expect(body.data.defaults).toEqual({
      team_slug: "platform-engineering",
      agent_id: "incident-agent",
      create_routes: true,
      source: "env",
      updated_at: "",
      updated_by: "",
    });
  });

  it("lists configured Slack channels with active grant counts", async () => {
    mockCollections.slack_channel_grants = createMockCollection([
      { workspace_id: workspaceAlias, channel_id: channelId, status: "active", resource: agentGrant.resource },
    ]);
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/slack/channels"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.channels).toEqual([
      expect.objectContaining({
        workspace_id: workspaceAlias,
        channel_id: channelId,
        channel_name: "incidents",
        active_grants: 1,
      }),
    ]);
    expect(body.data.channels[0].health).toBeUndefined();
    expect(mockAuditQuery).not.toHaveBeenCalled();
  });

  it("adds bounded health summaries for the configured Slack channel list when requested", async () => {
    // assisted-by Codex Codex-sonnet-4-6
    mockCollections.channel_team_mappings = createMockCollection([
      {
        slack_workspace_id: workspaceId,
        slack_channel_id: channelId,
        channel_name: "incidents",
        team_slug: "platform-engineering",
        active: true,
      },
      {
        slack_workspace_id: workspaceId,
        slack_channel_id: "CSUPPORT",
        channel_name: "support",
        team_slug: "platform-engineering",
        active: true,
      },
    ]);
    mockAuditQuery.mockResolvedValue([
      {
        ts: "2026-06-25T12:00:00.000Z",
        resource_ref: `slack_channel:${workspaceAlias}--CSUPPORT`,
        reason_code: "OPENFGA_READ_FAILED",
        message: "OpenFGA tuple read failed",
      },
      {
        ts: "2026-06-25T11:00:00.000Z",
        resource_ref: `slack_channel:${workspaceAlias}--CIGNORED`,
        reason_code: "OPENFGA_READ_FAILED",
        message: "Ignored channel",
      },
    ]);
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/slack/channels?health=1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.channels).toHaveLength(2);
    expect(body.data.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel_id: channelId,
          health: expect.objectContaining({
            openfga_reachable: true,
            last_runtime_error_ts: null,
          }),
        }),
        expect.objectContaining({
          channel_id: "CSUPPORT",
          health: expect.objectContaining({
            openfga_reachable: true,
            last_runtime_error_ts: "2026-06-25T12:00:00.000Z",
          }),
        }),
      ])
    );
    expect(mockAuditQuery).toHaveBeenCalledTimes(1);
    const [query] = mockAuditQuery.mock.calls[0];
    const until = query.until as Date;
    const since = query.since as Date;
    expect(query).toMatchObject({
      component: "slack_bot",
      outcome: "error",
      limit: 5000,
      timeoutMs: 2000,
    });
    expect(query.resourceRef).toBeUndefined();
    expect(until.getTime() - since.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("batches audit-service runtime error lookup when listing Slack channel health", async () => {
    const secondChannelId = "C987654321";
    mockCollections.channel_team_mappings = createMockCollection([
      {
        slack_workspace_id: workspaceId,
        slack_channel_id: channelId,
        channel_name: "incidents",
        active: true,
      },
      {
        slack_workspace_id: workspaceId,
        slack_channel_id: secondChannelId,
        channel_name: "triage",
        active: true,
      },
    ]);
    mockAuditQuery.mockResolvedValue([
      {
        component: "slack_bot",
        outcome: "error",
        resource_ref: `slack_channel:${workspaceAlias}--${secondChannelId}`,
        reason_code: "OPENFGA_READ_FAILED",
        ts: "2026-06-25T19:12:00.000Z",
      },
    ]);
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/slack/channels?health=1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockAuditQuery).toHaveBeenCalledTimes(1);
    expect(mockAuditQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "slack_bot",
        outcome: "error",
        limit: 5000,
        timeoutMs: 2000,
      }),
    );
    expect(mockAuditQuery.mock.calls[0][0]).toEqual(
      expect.not.objectContaining({ resourceRef: expect.anything() }),
    );
    const healthByChannel = Object.fromEntries(
      body.data.channels.map((channel: { channel_id: string; health: unknown }) => [
        channel.channel_id,
        channel.health,
      ]),
    );
    expect(healthByChannel[channelId]).toMatchObject({ last_runtime_error_ts: null });
    expect(healthByChannel[secondChannelId]).toMatchObject({
      last_runtime_error_ts: "2026-06-25T19:12:00.000Z",
    });
  });

  it("filters the Slack channel list to concrete channels the caller can read or manage", async () => {
    mockCollections.channel_team_mappings = createMockCollection([
      {
        slack_workspace_id: workspaceId,
        slack_channel_id: channelId,
        channel_name: "incidents",
        active: true,
      },
      {
        slack_workspace_id: workspaceId,
        slack_channel_id: "CNOACCESS",
        channel_name: "private-leadership",
        active: true,
      },
    ]);
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { relation: string; object: string }) => ({
      allowed:
        tuple.object === `slack_channel:${workspaceAlias}--${channelId}` &&
        (tuple.relation === "can_read" || tuple.relation === "can_manage"),
    }));
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/slack/channels"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.channels).toEqual([
      expect.objectContaining({
        channel_id: channelId,
        channel_name: "incidents",
        can_manage: true,
      }),
    ]);
  });

  it("scopes a View As channel list to the simulated user without repairing grants", async () => {
    mockCollections.channel_team_mappings = createMockCollection([
      {
        slack_workspace_id: workspaceId,
        slack_channel_id: channelId,
        channel_name: "incidents",
        team_slug: "platform-engineering",
        active: true,
      },
      {
        slack_workspace_id: workspaceId,
        slack_channel_id: "CNOACCESS",
        channel_name: "private-leadership",
        team_slug: "leadership",
        active: true,
      },
    ]);
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: {
      user: string;
      relation: string;
      object: string;
    }) => ({
      allowed:
        (tuple.user === "user:alice-sub" &&
          tuple.relation === "can_manage" &&
          tuple.object === "organization:caipe") ||
        (tuple.user === "user:target-sub" &&
          tuple.relation === "can_read" &&
          tuple.object === `slack_channel:${workspaceAlias}--${channelId}`),
    }));
    const { GET } = await import("../route");

    const response = await GET(
      request("/api/admin/slack/channels?simulate_type=user&simulate_id=target-sub")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.channels).toEqual([
      expect.objectContaining({
        channel_id: channelId,
        channel_name: "incidents",
        can_manage: false,
      }),
    ]);
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: "user:target-sub",
      relation: "can_read",
      object: `slack_channel:${workspaceAlias}--${channelId}`,
    });
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("rejects View As channel scoping for a non-admin caller", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    const { GET } = await import("../route");

    const response = await GET(
      request("/api/admin/slack/channels?simulate_type=user&simulate_id=target-sub")
    );

    expect(response.status).toBe(403);
  });

  it("repairs stale team-shared Slack channel tuples so team members can edit routes", async () => {
    // Old assignments may have a readable channel tuple but not the newer
    // team-member manage tuple. Listing configured channels should converge
    // that row to the central Slack team-assignment policy so the UI can enable
    // Edit/Add Agent for team members.
    // assisted-by Codex Codex-sonnet-4-6
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { relation: string; object: string }) => {
      if (tuple.object === "organization:caipe") return { allowed: false };
      if (tuple.object !== `slack_channel:${workspaceAlias}--${channelId}`) return { allowed: false };
      if (tuple.relation === "can_read") return { allowed: true };
      if (tuple.relation === "can_manage") {
        return { allowed: mockWriteOpenFgaTuples.mock.calls.length > 0 };
      }
      return { allowed: false };
    });
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/slack/channels"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.channels).toEqual([
      expect.objectContaining({
        channel_id: channelId,
        channel_name: "incidents",
        team_slug: "platform-engineering",
        can_manage: true,
      }),
    ]);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith(
      expect.objectContaining({
        writes: expect.arrayContaining([
          {
            user: "team:platform-engineering#member",
            relation: "manager",
            object: `slack_channel:${workspaceAlias}--${channelId}`,
          },
        ]),
      }),
    );
  });

  it("returns can_manage after a successful stale tuple repair even when OpenFGA read-after-write lags", async () => {
    // Production OpenFGA can accept the new team-member manager tuple and still
    // return the old check result for the immediate follow-up read. The list
    // response should trust the successful repair write for this request so the
    // configured channel UI does not keep Edit disabled until a later refresh.
    // assisted-by Codex Codex-sonnet-4-6
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { relation: string; object: string }) => {
      if (tuple.object === "organization:caipe") return { allowed: false };
      if (tuple.object !== `slack_channel:${workspaceAlias}--${channelId}`) return { allowed: false };
      if (tuple.relation === "can_read") return { allowed: true };
      if (tuple.relation === "can_manage") return { allowed: false };
      return { allowed: false };
    });
    mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/slack/channels"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.channels).toEqual([
      expect.objectContaining({
        channel_id: channelId,
        team_slug: "platform-engineering",
        can_manage: true,
      }),
    ]);
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: "user:alice-sub",
      relation: "can_manage",
      object: `slack_channel:${workspaceAlias}--${channelId}`,
    });
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith(
      expect.objectContaining({
        writes: expect.arrayContaining([
          {
            user: "team:platform-engineering#member",
            relation: "manager",
            object: `slack_channel:${workspaceAlias}--${channelId}`,
          },
        ]),
      }),
    );
  });

  it("replaces channel resource grants and writes channel OpenFGA tuples", async () => {
    // Not an org admin (organization:caipe denied) so the per-channel can_manage
    // check is what authorizes the actor — exercise that path explicitly.
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { relation: string; object: string }) => ({
      allowed: tuple.object === `slack_channel:${workspaceAlias}--${channelId}`,
    }));
    mockReadOpenFgaTuples.mockResolvedValue({
      tuples: [
        {
          key: {
            user: `slack_channel:${workspaceAlias}--${channelId}`,
            relation: "user",
            object: "agent:stale-agent",
          },
        },
      ],
    });
    const { PUT } = await import("../[workspaceId]/[channelId]/resources/route");

    const response = await PUT(
      request(`/api/admin/slack/channels/${workspaceId}/${channelId}/resources`, {
        method: "PUT",
        body: JSON.stringify({ grants: [agentGrant] }),
      }),
      { params: Promise.resolve({ workspaceId, channelId }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: "user:alice-sub",
      relation: "can_manage",
      object: `slack_channel:${workspaceAlias}--${channelId}`,
    });
    expect(body.data.grants).toHaveLength(1);
    expect(mockCollections.slack_channel_grants.updateOne).toHaveBeenCalledWith(
      {
        workspace_id: workspaceAlias,
        channel_id: channelId,
        "resource.type": "agent",
        "resource.id": "incident-agent",
      },
      expect.objectContaining({ $set: expect.objectContaining({ status: "active" }) }),
      { upsert: true }
    );
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [{ user: `slack_channel:${workspaceAlias}--${channelId}`, relation: "user", object: "agent:incident-agent" }],
      deletes: [{ user: `slack_channel:${workspaceAlias}--${channelId}`, relation: "user", object: "agent:stale-agent" }],
    });
  });

  it("does not update Slack channel grants when the actor cannot manage the team-owned channel", async () => {
    // Deny every probe: not an org admin (organization:caipe) AND no per-channel
    // can_manage grant — so the actor is genuinely unauthorized → 403.
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    const { PUT } = await import("../[workspaceId]/[channelId]/resources/route");

    const response = await PUT(
      request(`/api/admin/slack/channels/${workspaceId}/${channelId}/resources`, {
        method: "PUT",
        body: JSON.stringify({ grants: [agentGrant] }),
      }),
      { params: Promise.resolve({ workspaceId, channelId }) }
    );

    expect(response.status).toBe(403);
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: "user:alice-sub",
      relation: "can_manage",
      object: `slack_channel:${workspaceAlias}--${channelId}`,
    });
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
    expect(mockCollections.slack_channel_grants.updateOne).not.toHaveBeenCalled();
  });


  it("saving Slack agent routes writes OpenFGA tuples and route metadata", async () => {
    mockCollections.slack_channel_agent_routes = createMockCollection([]);
    mockReadOpenFgaTuples.mockResolvedValue({
      tuples: [
        {
          key: {
            user: `slack_channel:${workspaceAlias}--${channelId}`,
            relation: "user",
            object: "agent:stale-agent",
          },
        },
      ],
    });
    const { PUT } = await import("../[workspaceId]/[channelId]/routes/route");

    const response = await PUT(
      request(`/api/admin/slack/channels/${workspaceId}/${channelId}/routes`, {
        method: "PUT",
        body: JSON.stringify({
          routes: [
            {
              agent_id: "incident-agent",
              enabled: true,
              priority: 10,
              users: { enabled: true, listen: "mention" },
            },
          ],
        }),
      }),
      { params: Promise.resolve({ workspaceId, channelId }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.routes).toHaveLength(1);
    expect(mockCollections.slack_channel_agent_routes.updateOne).toHaveBeenCalledWith(
      {
        workspace_id: workspaceAlias,
        channel_id: channelId,
        agent_id: "incident-agent",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "active",
          priority: 10,
          users: { enabled: true, listen: "mention" },
        }),
      }),
      { upsert: true }
    );
    expect(mockCollections.slack_channel_grants.updateOne).not.toHaveBeenCalled();
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [
        {
          user: `slack_channel:${workspaceAlias}--${channelId}`,
          relation: "user",
          object: "agent:incident-agent",
        },
      ],
      deletes: [
        {
          user: `slack_channel:${workspaceAlias}--${channelId}`,
          relation: "user",
          object: "agent:stale-agent",
        },
      ],
    });
  });

  it("fails route saves when OpenFGA reconciliation fails", async () => {
    mockCollections.slack_channel_agent_routes = createMockCollection([]);
    mockWriteOpenFgaTuples.mockRejectedValue(new Error("OpenFGA down"));
    const { PUT } = await import("../[workspaceId]/[channelId]/routes/route");

    const response = await PUT(
      request(`/api/admin/slack/channels/${workspaceId}/${channelId}/routes`, {
        method: "PUT",
        body: JSON.stringify({
          routes: [{ agent_id: "incident-agent", enabled: true }],
        }),
      }),
      { params: Promise.resolve({ workspaceId, channelId }) }
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(JSON.stringify(body)).toMatch(/OpenFGA tuple write failed/i);
  });

  it("lists only OpenFGA-backed route associations and joins saved metadata", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({
      tuples: [
        {
          key: {
            user: `slack_channel:${workspaceAlias}--${channelId}`,
            relation: "user",
            object: "agent:incident-agent",
          },
        },
      ],
    });
    mockCollections.slack_channel_agent_routes = createMockCollection([
      {
        workspace_id: workspaceAlias,
        channel_id: channelId,
        agent_id: "incident-agent",
        enabled: true,
        priority: 25,
        status: "active",
        users: { enabled: true, listen: "message" },
      },
      {
        workspace_id: workspaceAlias,
        channel_id: channelId,
        agent_id: "stale-mongo-agent",
        enabled: true,
        priority: 1,
        status: "active",
        users: { enabled: true, listen: "mention" },
      },
    ]);
    const { GET } = await import("../[workspaceId]/[channelId]/routes/route");

    const response = await GET(
      request(`/api/admin/slack/channels/${workspaceId}/${channelId}/routes`),
      { params: Promise.resolve({ workspaceId, channelId }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.routes).toEqual([
      expect.objectContaining({
        agent_id: "incident-agent",
        priority: 25,
        users: { enabled: true, listen: "message" },
      }),
    ]);
    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith({
      pageSize: 100,
      // SEC-6: the read is scoped server-side instead of fetching all tuples and
      // filtering in JS. OpenFGA /read requires an object TYPE in the filter (a
      // user-only or user+relation filter 400s with "object type field is
      // required"), so we scope to the `agent:` object type with the channel as
      // `user`; the agent id is recovered in-memory via agentIdFromObject.
      tuple: { object: "agent:", user: `slack_channel:${workspaceAlias}--${channelId}` },
    });
  });

  it("reports Slack runtime diagnostics for tuple-backed routes and stale metadata", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({
      tuples: [
        {
          key: {
            user: `slack_channel:${workspaceAlias}--${channelId}`,
            relation: "user",
            object: "agent:incident-agent",
          },
        },
      ],
    });
    mockCollections.slack_channel_agent_routes = createMockCollection([
      {
        workspace_id: workspaceAlias,
        channel_id: channelId,
        agent_id: "incident-agent",
        enabled: true,
        priority: 25,
        status: "active",
        users: { enabled: true, listen: "mention" },
      },
      {
        workspace_id: workspaceAlias,
        channel_id: channelId,
        agent_id: "stale-mongo-agent",
        enabled: true,
        priority: 1,
        status: "active",
        users: { enabled: true, listen: "message" },
      },
    ]);
    mockAuditQuery.mockResolvedValue([
      {
        type: "slack_runtime",
        component: "slack_bot",
        outcome: "error",
        action: "slack.route",
        resource_ref: `slack_channel:${workspaceAlias}--${channelId}`,
        reason_code: "OPENFGA_READ_FAILED",
        message: "OpenFGA tuple read failed",
        ts: "2026-05-18T07:50:00.000Z",
      },
    ]);
    const { GET } = await import("../[workspaceId]/[channelId]/diagnostics/route");

    const response = await GET(
      request(`/api/admin/slack/channels/${workspaceId}/${channelId}/diagnostics`),
      { params: Promise.resolve({ workspaceId, channelId }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      openfga: { reachable: true, tuple_count: 1 },
      routes: [
        expect.objectContaining({
          agent_id: "incident-agent",
          openfga_tuple: true,
          route_metadata: true,
          listen: "mention",
          runtime_matches: { mention: true, message: false },
        }),
        expect.objectContaining({
          agent_id: "stale-mongo-agent",
          openfga_tuple: false,
          route_metadata: true,
        }),
      ],
      last_runtime_error: expect.objectContaining({
        reason_code: "OPENFGA_READ_FAILED",
      }),
    });
    expect(body.data.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Stale Mongo Agent has saved routing rules that are inactive/i),
      ])
    );
    expect(body.data.warnings).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/Plain channel messages will be ignored/i)])
    );
  });

  it("reports OpenFGA read failures in Slack runtime diagnostics", async () => {
    mockReadOpenFgaTuples.mockRejectedValue(new Error("OpenFGA tuple read failed: 400"));
    mockCollections.slack_channel_agent_routes = createMockCollection([
      {
        workspace_id: workspaceAlias,
        channel_id: channelId,
        agent_id: "incident-agent",
        enabled: true,
        priority: 25,
        status: "active",
        users: { enabled: true, listen: "mention" },
      },
    ]);
    const { GET } = await import("../[workspaceId]/[channelId]/diagnostics/route");

    const response = await GET(
      request(`/api/admin/slack/channels/${workspaceId}/${channelId}/diagnostics`),
      { params: Promise.resolve({ workspaceId, channelId }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.openfga).toMatchObject({
      reachable: false,
      error: "OpenFGA tuple read failed: 400",
    });
    expect(body.data.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Slack bot could not reach the authorization service/i)])
    );
  });

  it("deletes Slack agent associations from OpenFGA and dependent Mongo route metadata", async () => {
    mockCollections.slack_channel_agent_routes = createMockCollection([
      {
        workspace_id: workspaceAlias,
        channel_id: channelId,
        agent_id: "incident-agent",
        enabled: true,
        priority: 25,
        status: "active",
        users: { enabled: true, listen: "message" },
      },
    ]);
    const { DELETE } = await import("../[workspaceId]/[channelId]/routes/route");

    const response = await DELETE(
      request(`/api/admin/slack/channels/${workspaceId}/${channelId}/routes`, {
        method: "DELETE",
        body: JSON.stringify({ agent_id: "incident-agent" }),
      }),
      { params: Promise.resolve({ workspaceId, channelId }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.deleted).toEqual({
      agent_id: "incident-agent",
      route_metadata_deleted: true,
    });
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [],
      deletes: [
        {
          user: `slack_channel:${workspaceAlias}--${channelId}`,
          relation: "user",
          object: "agent:incident-agent",
        },
      ],
    });
    expect(mockCollections.slack_channel_agent_routes.deleteOne).toHaveBeenCalledWith({
      workspace_id: workspaceAlias,
      channel_id: channelId,
      agent_id: "incident-agent",
    });
  });

  it("applies Slack channel association defaults to Slack channels and default team", async () => {
    mockCollections.channel_team_mappings = createMockCollection([
      {
        slack_workspace_id: workspaceId,
        slack_channel_id: channelId,
        channel_name: "incidents",
        active: true,
      },
      {
        slack_workspace_id: workspaceId,
        slack_channel_id: "C987654321",
        channel_name: "platform",
        team_slug: "existing-team",
        active: true,
      },
    ]);
    mockCollections.teams = createMockCollection([
      {
        _id: "team-1",
        slug: "platform-engineering",
        name: "Platform Engineering",
        resources: { agents: [] },
      },
    ]);
    mockCollections.dynamic_agents = createMockCollection([
      { _id: "incident-agent", name: "Incident Agent", enabled: true },
    ]);
    mockCollections.slack_channel_agent_routes = createMockCollection([]);
    const { POST } = await import("../defaults/route");

    const response = await POST(
      request("/api/admin/slack/channels/defaults", {
        method: "POST",
        body: JSON.stringify({
          team_slug: "platform-engineering",
          agent_id: "incident-agent",
          create_routes: true,
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.summary).toMatchObject({
      channels_seen: 2,
      channels_assigned_team: 1,
      channel_grants_ensured: 2,
      routes_ensured: 2,
      team_grant_ensured: true,
    });
    // Phase 3 (spec 2026-05-24-derive-team-from-channel): Slack
    // channel onboarding no longer touches the Keycloak per-team
    // scope helpers — the `mockEnsureTeamClientScope` and
    // `mockSelectAgentGatewayActiveTeamScope` assertions are gone.
    expect(mockEnsureSlackBotOboPermissions).toHaveBeenCalledTimes(1);
    expect(mockCallSlackBotAdmin).toHaveBeenCalledWith("/admin/slack/routes/reload", {
      method: "POST",
      body: {},
    });
    expect(body.data.runtime_reload).toMatchObject({ attempted: true, ok: true });
    expect(mockCollections.channel_team_mappings.updateOne).toHaveBeenCalledWith(
      { slack_channel_id: channelId },
      expect.objectContaining({
        $set: expect.objectContaining({
          team_id: "team-1",
          team_slug: "platform-engineering",
          updated_by: "alice@example.com",
        }),
      })
    );
    // The team↔agent grant is written to OpenFGA only (asserted below) — the
    // legacy `team.resources` array is gone, so the team doc is not mutated.
    expect(mockCollections.slack_channel_grants.updateOne).toHaveBeenCalledWith(
      {
        workspace_id: workspaceAlias,
        channel_id: channelId,
        "resource.type": "agent",
        "resource.id": "incident-agent",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          source_type: "migration",
          status: "active",
        }),
      }),
      { upsert: true }
    );
    expect(mockCollections.slack_channel_agent_routes.updateOne).toHaveBeenCalledWith(
      {
        workspace_id: workspaceAlias,
        channel_id: channelId,
        agent_id: "incident-agent",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          source_type: "bootstrap",
          status: "active",
          // Bootstrap stamps listen:"mention" so the bot only responds
          // when explicitly @-mentioned when the admin explicitly
          // ran "Setup Slack channel association".
          users: { enabled: true, listen: "mention" },
        }),
      }),
      { upsert: true }
    );
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: `slack_channel:${workspaceAlias}--${channelId}`, relation: "user", object: "agent:incident-agent" },
        { user: `slack_channel:${workspaceAlias}--C987654321`, relation: "user", object: "agent:incident-agent" },
        { user: "team:platform-engineering#member", relation: "user", object: "agent:incident-agent" },
        { user: `team:platform-engineering#member`, relation: "manager", object: `slack_channel:${workspaceAlias}--${channelId}` },
      ]),
      deletes: [],
    });
  });

  it("onboards discovered bot-member channels before applying defaults without overwriting config-synced routes", async () => {
    mockCollections.channel_team_mappings = createMockCollection([
      {
        slack_workspace_id: workspaceAlias,
        slack_channel_id: channelId,
        channel_name: "incidents",
        active: true,
      },
    ]);
    mockCollections.teams = createMockCollection([
      {
        _id: "team-1",
        slug: "platform-engineering",
        name: "Platform Engineering",
        resources: { agents: [] },
      },
    ]);
    mockCollections.dynamic_agents = createMockCollection([
      { _id: "incident-agent", name: "Incident Agent", enabled: true },
    ]);
    mockCollections.slack_channel_agent_routes = createMockCollection([
      {
        workspace_id: workspaceAlias,
        channel_id: "CNEWCONFIG",
        agent_id: "incident-agent",
        enabled: true,
        priority: 25,
        users: { enabled: true, listen: "all" },
        source_type: "config_sync",
        status: "active",
      },
    ]);
    const { POST } = await import("../defaults/route");

    const response = await POST(
      request("/api/admin/slack/channels/defaults", {
        method: "POST",
        body: JSON.stringify({
          team_slug: "platform-engineering",
          agent_id: "incident-agent",
          create_routes: true,
          discovered_channels: [
            { id: "CNEWCONFIG", name: "config-managed" },
            { id: "CNEWMISSING", name: "new-alerts" },
          ],
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.summary).toMatchObject({
      channels_seen: 2,
      channels_discovered: 2,
      channels_onboarded: 2,
      channels_assigned_team: 2,
      channel_grants_ensured: 2,
      routes_ensured: 1,
      routes_preserved: 1,
    });
    expect(mockCollections.channel_team_mappings.updateOne).toHaveBeenCalledWith(
      {
        slack_workspace_id: workspaceAlias,
        slack_channel_id: "CNEWCONFIG",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          channel_name: "config-managed",
          active: true,
        }),
        $setOnInsert: expect.objectContaining({
          slack_channel_id: "CNEWCONFIG",
          slack_workspace_id: workspaceAlias,
        }),
      }),
      { upsert: true }
    );
    expect(mockCollections.slack_channel_agent_routes.updateOne).not.toHaveBeenCalledWith(
      {
        workspace_id: workspaceAlias,
        channel_id: "CNEWCONFIG",
        agent_id: "incident-agent",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          priority: 100,
          users: { enabled: true, listen: "all" },
        }),
      }),
      { upsert: true }
    );
    expect(mockCollections.slack_channel_agent_routes.updateOne).toHaveBeenCalledWith(
      {
        workspace_id: workspaceAlias,
        channel_id: "CNEWMISSING",
        agent_id: "incident-agent",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          priority: 100,
          // Bootstrap-created routes listen mention-only by default — see
          // ui/src/app/api/admin/slack/channels/defaults/route.ts.
          users: { enabled: true, listen: "mention" },
          source_type: "bootstrap",
        }),
      }),
      { upsert: true }
    );
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: `slack_channel:${workspaceAlias}--CNEWCONFIG`, relation: "user", object: "agent:incident-agent" },
        { user: `slack_channel:${workspaceAlias}--CNEWMISSING`, relation: "user", object: "agent:incident-agent" },
        { user: "team:platform-engineering#member", relation: "user", object: "agent:incident-agent" },
        { user: "team:platform-engineering#member", relation: "manager", object: `slack_channel:${workspaceAlias}--CNEWMISSING` },
      ]),
      deletes: [],
    });
  });

  it("returns a friendly setup error when Slack OBO repair fails", async () => {
    mockEnsureSlackBotOboPermissions.mockRejectedValueOnce(new Error("raw Keycloak scope error"));
    mockCollections.teams = createMockCollection([
      {
        _id: "team-1",
        slug: "platform-engineering",
        name: "Platform Engineering",
        resources: { agents: [] },
      },
    ]);
    mockCollections.dynamic_agents = createMockCollection([
      { _id: "incident-agent", name: "Incident Agent", enabled: true },
    ]);
    const { POST } = await import("../defaults/route");

    const response = await POST(
      request("/api/admin/slack/channels/defaults", {
        method: "POST",
        body: JSON.stringify({
          team_slug: "platform-engineering",
          agent_id: "incident-agent",
          channel_defaults: [{ id: "CNEWMISSING", name: "new-alerts" }],
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toContain("couldn't finish preparing Slack access");
    expect(body.error).not.toContain("Keycloak");
    expect(body.error).not.toContain("scope");
    expect(body.error).not.toContain("raw Keycloak scope error");
    expect(mockCollections.channel_team_mappings.updateOne).not.toHaveBeenCalled();
  });

  it("applies per-channel import defaults for selected discovered channels", async () => {
    mockCollections.channel_team_mappings = createMockCollection([]);
    mockCollections.teams = createMockCollection([
      {
        _id: "team-1",
        slug: "platform-engineering",
        name: "Platform Engineering",
        resources: { agents: [] },
      },
      {
        _id: "team-2",
        slug: "security",
        name: "Security",
        resources: { agents: [] },
      },
    ]);
    mockCollections.dynamic_agents = createMockCollection([
      { _id: "incident-agent", name: "Incident Agent", enabled: true },
      { _id: "test-april-2025", name: "Test April 2025", enabled: true },
    ]);
    mockCollections.slack_channel_agent_routes = createMockCollection([]);
    const { POST } = await import("../defaults/route");

    const response = await POST(
      request("/api/admin/slack/channels/defaults", {
        method: "POST",
        body: JSON.stringify({
          team_slug: "platform-engineering",
          agent_id: "incident-agent",
          create_routes: true,
          channel_defaults: [
            {
              id: "CNEWMISSING",
              name: "new-alerts",
              team_slug: "security",
              agent_id: "test-april-2025",
            },
          ],
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.summary).toMatchObject({
      pending: 0,
      onboarded: 1,
    });
    expect(body.data.applied[0].result.summary).toMatchObject({
      channels_seen: 1,
      channels_discovered: 1,
      channels_onboarded: 1,
      channels_assigned_team: 1,
      channel_grants_ensured: 1,
      routes_ensured: 1,
    });
    expect(mockCollections.channel_team_mappings.updateOne).toHaveBeenCalledWith(
      {
        slack_workspace_id: workspaceAlias,
        slack_channel_id: "CNEWMISSING",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          channel_name: "new-alerts",
          team_id: "team-2",
          team_slug: "security",
          active: true,
        }),
      }),
      { upsert: true }
    );
    expect(mockCollections.slack_channel_grants.updateOne).toHaveBeenCalledWith(
      {
        workspace_id: workspaceAlias,
        channel_id: "CNEWMISSING",
        "resource.type": "agent",
        "resource.id": "test-april-2025",
      },
      expect.anything(),
      { upsert: true }
    );
    expect(mockCollections.slack_channel_agent_routes.updateOne).toHaveBeenCalledWith(
      {
        workspace_id: workspaceAlias,
        channel_id: "CNEWMISSING",
        agent_id: "test-april-2025",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          source_type: "bootstrap",
        }),
      }),
      { upsert: true }
    );
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: `slack_channel:${workspaceAlias}--CNEWMISSING`, relation: "user", object: "agent:test-april-2025" },
        { user: "team:security#member", relation: "user", object: "agent:test-april-2025" },
        { user: "team:security#member", relation: "manager", object: `slack_channel:${workspaceAlias}--CNEWMISSING` },
      ]),
      deletes: [],
    });
  });

  it("replaces stale per-channel routes when a discovered channel changes agents", async () => {
    mockCollections.channel_team_mappings = createMockCollection([]);
    mockCollections.teams = createMockCollection([
      {
        _id: "team-1",
        slug: "platform-engineering",
        name: "Platform Engineering",
        resources: { agents: [] },
      },
    ]);
    mockCollections.dynamic_agents = createMockCollection([
      { _id: "foo-bar", name: "Foo Bar", enabled: true },
      { _id: "test-april-2025", name: "Test April 2025", enabled: true },
    ]);
    mockCollections.slack_channel_grants = createMockCollection([
      {
        workspace_id: workspaceAlias,
        channel_id: "CCHANGED",
        resource: { type: "agent", id: "test-april-2025" },
        actions: ["use"],
        status: "active",
      },
    ]);
    mockCollections.slack_channel_agent_routes = createMockCollection([
      {
        workspace_id: workspaceAlias,
        channel_id: "CCHANGED",
        agent_id: "test-april-2025",
        enabled: true,
        priority: 100,
        source_type: "auto",
        status: "active",
        users: { enabled: true, listen: "all" },
      },
    ]);
    const { POST } = await import("../defaults/route");

    const response = await POST(
      request("/api/admin/slack/channels/defaults", {
        method: "POST",
        body: JSON.stringify({
          team_slug: "platform-engineering",
          agent_id: "foo-bar",
          create_routes: true,
          channel_defaults: [
            {
              id: "CCHANGED",
              name: "sri-local-test-4",
              team_slug: "platform-engineering",
              agent_id: "foo-bar",
            },
          ],
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.summary).toMatchObject({
      pending: 0,
      onboarded: 1,
    });
    expect(body.data.applied[0].result.summary).toMatchObject({
      channel_grants_replaced: 1,
      routes_replaced: 1,
    });
    expect(mockCollections.slack_channel_grants.updateMany).toHaveBeenCalledWith(
      {
        workspace_id: workspaceAlias,
        channel_id: "CCHANGED",
        "resource.type": "agent",
        "resource.id": { $ne: "foo-bar" },
        status: "active",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "deleted",
          updated_by: "alice@example.com",
        }),
      })
    );
    expect(mockCollections.slack_channel_agent_routes.updateMany).toHaveBeenCalledWith(
      {
        workspace_id: workspaceAlias,
        channel_id: "CCHANGED",
        agent_id: { $ne: "foo-bar" },
        status: "active",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          enabled: false,
          status: "deleted",
          updated_by: "alice@example.com",
        }),
      })
    );
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: `slack_channel:${workspaceAlias}--CCHANGED`, relation: "user", object: "agent:foo-bar" },
        { user: "team:platform-engineering#member", relation: "user", object: "agent:foo-bar" },
        { user: "team:platform-engineering#member", relation: "manager", object: `slack_channel:${workspaceAlias}--CCHANGED` },
      ]),
      deletes: [
        {
          user: `slack_channel:${workspaceAlias}--CCHANGED`,
          relation: "user",
          object: "agent:test-april-2025",
        },
      ],
    });
  });
});
