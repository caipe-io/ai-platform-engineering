/**
 * @jest-environment node
 */

// assisted-by Codex Codex-sonnet-4-6

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: (email?: string) => email === "bootstrap@example.com",
}));

const mockGetCollection = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

const mockGetConfig = jest.fn((key: string) =>
  ({
    feedbackEnabled: true,
    auditLogsEnabled: true,
    actionAuditEnabled: true,
    credentialsEnabled: true,
  })[key] ?? false,
);
jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => mockGetConfig(key),
}));

const mockCheckOpenFgaTuple = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();
const mockListOpenFgaObjects = jest.fn();
jest.mock("@/lib/rbac/openfga", () => ({
  batchCheckOpenFgaTuples: async (tuples: unknown[]) => {
    const results = await Promise.all(tuples.map((tuple) => mockCheckOpenFgaTuple(tuple)));
    return results.map((result) => result?.allowed === true);
  },
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

import { GET } from "../route";

describe("GET /api/rbac/admin-tab-gates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockImplementation((key: string) =>
      ({
        feedbackEnabled: true,
        auditLogsEnabled: true,
        actionAuditEnabled: true,
        credentialsEnabled: true,
      })[key] ?? false,
    );
    mockGetCollection.mockImplementation(() => {
      throw new Error("admin_tab_policies should not be read");
    });
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    mockListOpenFgaObjects.mockResolvedValue({ objects: [] });
    mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 0, deletes: 0 });
  });

  it("returns deterministic admin gates without CEL policy storage", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "admin",
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    });
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mockGetCollection).not.toHaveBeenCalledWith("admin_tab_policies");
    expect(body.gates).toMatchObject({
      users: true,
      teams: true,
      skills: true,
      metrics: true,
      health: true,
      credentials: true,
      roles: true,
      identity_group_sync: true,
      slack: true,
      webex: true,
      action_audit: true,
      openfga: true,
      migrations: true,
    });
    expect(body.gates).not.toHaveProperty("policy");
    expect(body.integration_panel_modes).toEqual({
      slack: "full",
      webex: "full",
    });
  });

  it("does not use organization admin alone for privileged tab visibility", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "admin",
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    });
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:admin-sub" &&
        tuple.relation === "can_manage" &&
        tuple.object === "organization:caipe" ||
        tuple.user === "user:admin-sub" &&
        tuple.relation === "can_read" &&
        [
          "admin_surface:users",
          "admin_surface:teams",
          "admin_surface:skills",
          "admin_surface:metrics",
          "admin_surface:health",
        ].includes(tuple.object),
    }));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.gates).toMatchObject({
      users: true,
      teams: true,
      skills: true,
      metrics: false,
      health: true,
      slack: false,
      webex: false,
      openfga: false,
      migrations: false,
    });
  });

  it("allows baseline tabs for non-admin users and hides admin surfaces", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "user",
      sub: "user-sub",
      user: { email: "user@example.com" },
    });
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:user-sub" &&
        tuple.relation === "can_read" &&
        [
          "admin_surface:users",
          "admin_surface:teams",
          "admin_surface:skills",
          "admin_surface:slack",
          "admin_surface:webex",
          "admin_surface:feedback",
          "admin_surface:stats",
          "admin_surface:health",
          "admin_surface:credentials",
        ].includes(tuple.object),
    }));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.gates).toMatchObject({
      users: true,
      teams: true,
      skills: true,
      stats: true,
      feedback: true,
      metrics: false,
      health: true,
      credentials: false,
      roles: false,
      identity_group_sync: false,
      slack: true,
      webex: true,
      action_audit: false,
      openfga: false,
      migrations: false,
    });
    expect(body.integration_panel_modes).toEqual({
      slack: "self_service",
      webex: "self_service",
    });
  });

  it("hides the admin credentials tab when the credentials feature flag is disabled", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "admin",
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    });
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    mockGetConfig.mockImplementation((key: string) => key !== "credentialsEnabled");

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.gates.credentials).toBe(false);
  });

  it("keeps Dynamic Agent Conversations visible for org admins when the Chat Audit tab flag is disabled", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "admin",
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    });
    mockGetConfig.mockImplementation((key: string) => key !== "auditLogsEnabled");
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:admin-sub" &&
        tuple.relation === "can_manage" &&
        tuple.object === "organization:caipe",
    }));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.gates.audit_logs).toBe(false);
    expect(body.gates.dynamic_agent_conversations).toBe(true);
  });

  it("shows Dynamic Agent Conversations for a non-admin with the scoped audit read grant", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "user",
      sub: "user-sub",
      user: { email: "user@example.com" },
    });
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:user-sub" &&
        tuple.relation === "can_read" &&
        tuple.object === "audit_log:dynamic_agent_conversations",
    }));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.gates.audit_logs).toBe(false);
    expect(body.gates.dynamic_agent_conversations).toBe(true);
  });

  it("repairs baseline member tuples before evaluating non-admin tab gates", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "user",
      sub: "user-sub",
      user: { email: "user@example.com" },
    });
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:user-sub" &&
        tuple.relation === "can_read" &&
        tuple.object === "admin_surface:users",
    }));

    const res = await GET();

    expect(res.status).toBe(200);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: "user:user-sub", relation: "member", object: "organization:caipe" },
        { user: "user:user-sub", relation: "reader", object: "admin_surface:users" },
      ]),
      deletes: [],
    });
  });

  it("shows Slack and Webex tabs when a non-admin can manage concrete messaging resources", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "user",
      sub: "user-sub",
      user: { email: "user@example.com" },
    });
    mockGetCollection.mockImplementation((name: string) => {
      if (name === "channel_team_mappings") {
        return {
          find: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue([
              { slack_workspace_id: "T123", slack_channel_id: "C123", active: true },
            ]),
          }),
        };
      }
      if (name === "webex_space_team_mappings") {
        return {
          find: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue([
              { webex_workspace_id: "WX", webex_space_id: "space-1", active: true },
            ]),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:user-sub" &&
        tuple.relation === "can_manage" &&
        ["slack_channel:T123--C123", "webex_space:WX--space-1"].includes(tuple.object),
    }));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.gates).toMatchObject({
      slack: true,
      webex: true,
      openfga: false,
    });
  });

  it("shows Slack tab when a non-admin can read a team-shared Slack channel", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "user",
      sub: "user-sub",
      user: { email: "user@example.com" },
    });
    mockGetCollection.mockImplementation((name: string) => {
      if (name === "channel_team_mappings") {
        return {
          find: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue([
              { slack_workspace_id: "T123", slack_channel_id: "C123", active: true },
            ]),
          }),
        };
      }
      if (name === "webex_space_team_mappings") {
        return {
          find: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue([]),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:user-sub" &&
        tuple.relation === "can_read" &&
        tuple.object === "slack_channel:T123--C123",
    }));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.gates).toMatchObject({
      slack: true,
      webex: false,
      openfga: false,
    });
    expect(body.integration_panel_modes).toEqual({ slack: "self_service" });
  });

});
