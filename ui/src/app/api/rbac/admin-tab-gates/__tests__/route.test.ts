/**
 * @jest-environment node
 */

// assisted-by Codex Codex-sonnet-4-6

import { NextRequest } from "next/server";

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

const mockGetRealmUserByIdOrNull = jest.fn();
jest.mock("@/lib/rbac/keycloak-admin", () => ({
  getRealmUserByIdOrNull: (...args: unknown[]) => mockGetRealmUserByIdOrNull(...args),
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

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

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
    mockGetRealmUserByIdOrNull.mockResolvedValue(null);
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

  it("does not turn effective administrator access into independent baseline grants on reads", async () => {
    mockGetServerSession.mockResolvedValue({ role: "admin", sub: "test-admin", user: { email: "test-admin@example.test" } });
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await GET()).status).toBe(200);
    }
    expect(mockWriteOpenFgaTuples).toHaveBeenCalled();
    for (const [diff] of mockWriteOpenFgaTuples.mock.calls) {
      expect(diff.writes).toContainEqual({ user: "user:test-admin", relation: "member", object: "organization:caipe" });
      expect(diff.writes.some((tuple: { relation: string }) => ["admin", "manager"].includes(tuple.relation))).toBe(false);
      expect(diff.deletes).toEqual([]);
    }
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

  it("can simulate admin tab gates for a real team userset", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "admin",
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    });
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:admin-sub" && tuple.relation === "can_manage" && tuple.object === "organization:caipe" ||
        tuple.user === "team:platform#admin" && tuple.relation === "can_read" && [
          "admin_surface:users",
          "admin_surface:teams",
          "admin_surface:skills",
          "admin_surface:slack",
          "admin_surface:webex",
          "admin_surface:feedback",
          "admin_surface:stats",
          "admin_surface:health",
        ].includes(tuple.object) ||
        tuple.user === "team:platform#admin" && tuple.relation === "can_manage" && tuple.object === "admin_surface:slack",
    }));

    const res = await GET(
      request("/api/rbac/admin-tab-gates?simulate_type=team&simulate_id=platform&simulate_relation=admin")
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.simulation).toMatchObject({
      active: true,
      readonly: true,
      subject: {
        type: "team",
        id: "platform",
        relation: "admin",
        openfga_user: "team:platform#admin",
      },
    });
    expect(body.gates).toMatchObject({
      users: true,
      teams: true,
      skills: true,
      stats: true,
      feedback: true,
      metrics: false,
      health: true,
      slack: true,
      webex: true,
      openfga: false,
      migrations: false,
    });
    expect(body.integration_panel_modes).toEqual({
      slack: "full",
      webex: "self_service",
    });
  });

  it("shows a simulated user's baseline tabs, identity, and resource-scoped integrations", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "admin",
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    });
    mockGetRealmUserByIdOrNull.mockResolvedValue({
      id: "target-sub",
      username: "target.user",
      email: "target@example.com",
      firstName: "Target",
      lastName: "User",
    });
    mockGetCollection.mockImplementation((name: string) => {
      if (name === "openfga_baseline_profiles") {
        throw new Error("use default baseline");
      }
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
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: {
      user: string;
      relation: string;
      object: string;
    }) => ({
      allowed:
        (tuple.user === "user:admin-sub" &&
          tuple.relation === "can_manage" &&
          tuple.object === "organization:caipe") ||
        (tuple.user === "user:target-sub" &&
          tuple.relation === "can_read" &&
          tuple.object === "slack_channel:T123--C123"),
    }));

    const res = await GET(
      request("/api/rbac/admin-tab-gates?simulate_type=user&simulate_id=target-sub")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.simulation.subject).toMatchObject({
      id: "target-sub",
      openfga_user: "user:target-sub",
      display_name: "Target User",
      email: "target@example.com",
    });
    expect(body.gates).toMatchObject({
      users: true,
      teams: true,
      skills: true,
      stats: true,
      feedback: true,
      metrics: false,
      health: true,
      slack: true,
      webex: true,
      openfga: false,
      migrations: false,
    });
    expect(body.integration_panel_modes).toEqual({
      slack: "self_service",
      webex: "self_service",
    });
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("returns a simulated organization admin's admin settings and full integration modes", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "admin",
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    });
    mockGetRealmUserByIdOrNull.mockResolvedValue({
      id: "target-admin-sub",
      username: "target.admin",
      email: "target.admin@example.com",
      firstName: "Target",
      lastName: "Admin",
    });
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: {
      user: string;
      relation: string;
      object: string;
    }) => ({
      allowed:
        (tuple.user === "user:admin-sub" &&
          tuple.relation === "can_manage" &&
          tuple.object === "organization:caipe") ||
        (tuple.user === "user:target-admin-sub" &&
          tuple.relation === "can_manage" &&
          [
            "organization:caipe",
            "admin_surface:slack",
            "admin_surface:webex",
          ].includes(tuple.object)),
    }));

    const res = await GET(
      request("/api/rbac/admin-tab-gates?simulate_type=user&simulate_id=target-admin-sub"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.simulation.subject).toMatchObject({
      id: "target-admin-sub",
      display_name: "Target Admin",
      organization_admin: true,
    });
    expect(body.gates).toMatchObject({
      credentials: true,
      service_accounts: true,
      slack: true,
      webex: true,
    });
    expect(body.integration_panel_modes).toEqual({
      slack: "full",
      webex: "full",
    });
  });

  it("rejects simulation requests from non-admin actors", async () => {
    mockGetServerSession.mockResolvedValue({
      role: "user",
      sub: "user-sub",
      user: { email: "user@example.com" },
    });
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });

    const res = await GET(
      request("/api/rbac/admin-tab-gates?simulate_type=user&simulate_id=target-sub")
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Simulation requires organization admin access");
  });
});
