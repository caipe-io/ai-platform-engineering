/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetUserPreference = jest.fn();
const mockUpdateUserPreferences = jest.fn();
const mockEvaluateAgentAccess = jest.fn();
const mockGetAuth = jest.fn();
const mockGetAgentsCollection = jest.fn();
const mockGetResolvedPlatformDefaultAgentId = jest.fn();
const mockListWebexBotPolicies = jest.fn();
const mockRequireAvailableWebexBotPolicy = jest.fn();
const mockListWebexDirectUserRoutesForUser = jest.fn();
const mockUpsertWebexDirectUserRoute = jest.fn();
const mockDeleteWebexDirectUserRoute = jest.fn();
const mockGetRealmUserByIdOrNull = jest.fn();
const mockAgentsCollection = {
  findOne: jest.fn(),
};

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuth(...args),
  };
});

jest.mock("@/lib/rbac/user-preferences-store", () => ({
  getUserPreference: (...args: unknown[]) => mockGetUserPreference(...args),
  updateUserPreferences: (...args: unknown[]) => mockUpdateUserPreferences(...args),
}));

jest.mock("@/lib/rbac/pdp-shared", () => ({
  evaluateAgentAccess: (...args: unknown[]) => mockEvaluateAgentAccess(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: (...args: unknown[]) => mockGetAgentsCollection(...args),
}));

jest.mock("@/lib/integration-config", () => ({
  getIntegrationAvailability: () => ({ slack: true, webex: false }),
}));

jest.mock("@/lib/platform-default-agent", () => ({
  getResolvedPlatformDefaultAgentId: () =>
    mockGetResolvedPlatformDefaultAgentId(),
}));

jest.mock("@/lib/webex-bot-policy", () => ({
  listWebexBotPolicies: (...args: unknown[]) => mockListWebexBotPolicies(...args),
  requireAvailableWebexBotPolicy: (...args: unknown[]) => mockRequireAvailableWebexBotPolicy(...args),
}));

jest.mock("@/lib/rbac/webex-direct-user-route-store", () => ({
  listWebexDirectUserRoutesForUser: (...args: unknown[]) => mockListWebexDirectUserRoutesForUser(...args),
  upsertWebexDirectUserRoute: (...args: unknown[]) => mockUpsertWebexDirectUserRoute(...args),
  deleteWebexDirectUserRoute: (...args: unknown[]) => mockDeleteWebexDirectUserRoute(...args),
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  getRealmUserByIdOrNull: (...args: unknown[]) => mockGetRealmUserByIdOrNull(...args),
}));

import { GET, PUT } from "../route";

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/user/preferences", {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const authedSession = {
  user: { email: "alice@example.com", name: "Alice", role: "user" },
  session: { sub: "alice-sub", org: "default" },
};

const ALL_USERS_BOT = {
  id: "primary",
  name: "Primary",
  available: true,
  spaces: { accessMode: "disabled", defaultTeamSlug: null, defaultAgentId: null },
  directMessages: { accessMode: "all_users", defaultAgentId: "default" },
};

const ALLOWLIST_BOT = {
  id: "secondary",
  name: "Secondary",
  available: true,
  spaces: { accessMode: "disabled", defaultTeamSlug: null, defaultAgentId: null },
  directMessages: { accessMode: "allowlist", defaultAgentId: "default" },
};

describe("GET /api/user/preferences", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuth.mockResolvedValue(authedSession);
    mockGetAgentsCollection.mockResolvedValue(mockAgentsCollection);
    mockGetResolvedPlatformDefaultAgentId.mockResolvedValue("platform-agent");
    mockListWebexBotPolicies.mockResolvedValue([]);
    mockListWebexDirectUserRoutesForUser.mockResolvedValue(new Map());
  });

  it("returns the user's saved preference", async () => {
    mockGetUserPreference.mockResolvedValue({
      web_default_agent_id: "agent-web",
      slack_default_agent_id: "agent-slack",
    });

    const response = await GET(makeRequest("GET"));

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toMatchObject({
      success: true,
      data: {
        web_default_agent_id: "agent-web",
        slack_default_agent_id: "agent-slack",
        webex_bots: [],
        platform_default_agent_id: "platform-agent",
        integrations: { slack: true, webex: false },
      },
    });
    expect(mockGetUserPreference).toHaveBeenCalledWith({
      tenantId: "default",
      userId: "alice-sub",
    });
  });

  it("returns null when no preference is saved", async () => {
    mockGetUserPreference.mockResolvedValue({
      web_default_agent_id: null,
      slack_default_agent_id: null,
    });

    const response = await GET(makeRequest("GET"));

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toMatchObject({
      success: true,
      data: {
        web_default_agent_id: null,
        slack_default_agent_id: null,
      },
    });
  });

  it("rejects requests without a valid session", async () => {
    mockGetAuth.mockResolvedValue({
      user: { email: "x", name: "y", role: "user" },
      session: {},
    });

    const response = await GET(makeRequest("GET"));

    expect(response.status).toBe(401);
    expect(mockGetUserPreference).not.toHaveBeenCalled();
  });

  it("includes an all_users bot as editable, falling back to the bot default", async () => {
    mockGetUserPreference.mockResolvedValue({ web_default_agent_id: null, slack_default_agent_id: null });
    mockListWebexBotPolicies.mockResolvedValue([ALL_USERS_BOT]);

    const response = await GET(makeRequest("GET"));

    await expect(bodyOf(response)).resolves.toMatchObject({
      data: {
        webex_bots: [
          {
            bot_id: "primary",
            bot_name: "Primary",
            access_mode: "all_users",
            agent_id: "default",
            editable: true,
            denied: false,
          },
        ],
      },
    });
  });

  it("uses the user's own route agent for an all_users bot when one exists", async () => {
    mockGetUserPreference.mockResolvedValue({ web_default_agent_id: null, slack_default_agent_id: null });
    mockListWebexBotPolicies.mockResolvedValue([ALL_USERS_BOT]);
    mockListWebexDirectUserRoutesForUser.mockResolvedValue(
      new Map([["primary", { bot_id: "primary", agent_id: "agent-x", status: "active" }]]),
    );

    const response = await GET(makeRequest("GET"));

    await expect(bodyOf(response)).resolves.toMatchObject({
      data: {
        webex_bots: [expect.objectContaining({ bot_id: "primary", agent_id: "agent-x", editable: true })],
      },
    });
  });

  it("marks an admin-denied all_users bot as not editable", async () => {
    mockGetUserPreference.mockResolvedValue({ web_default_agent_id: null, slack_default_agent_id: null });
    mockListWebexBotPolicies.mockResolvedValue([ALL_USERS_BOT]);
    mockListWebexDirectUserRoutesForUser.mockResolvedValue(
      new Map([["primary", { bot_id: "primary", agent_id: "agent-x", status: "disabled" }]]),
    );

    const response = await GET(makeRequest("GET"));

    await expect(bodyOf(response)).resolves.toMatchObject({
      data: {
        webex_bots: [expect.objectContaining({ bot_id: "primary", editable: false, denied: true })],
      },
    });
  });

  it("hides an allowlist bot the user has no active route for", async () => {
    mockGetUserPreference.mockResolvedValue({ web_default_agent_id: null, slack_default_agent_id: null });
    mockListWebexBotPolicies.mockResolvedValue([ALLOWLIST_BOT]);

    const response = await GET(makeRequest("GET"));

    await expect(bodyOf(response)).resolves.toMatchObject({ data: { webex_bots: [] } });
  });

  it("shows an allowlisted bot read-only with the admin-chosen agent", async () => {
    mockGetUserPreference.mockResolvedValue({ web_default_agent_id: null, slack_default_agent_id: null });
    mockListWebexBotPolicies.mockResolvedValue([ALLOWLIST_BOT]);
    mockListWebexDirectUserRoutesForUser.mockResolvedValue(
      new Map([["secondary", { bot_id: "secondary", agent_id: "agent-y", status: "active" }]]),
    );

    const response = await GET(makeRequest("GET"));

    await expect(bodyOf(response)).resolves.toMatchObject({
      data: {
        webex_bots: [
          {
            bot_id: "secondary",
            bot_name: "Secondary",
            access_mode: "allowlist",
            agent_id: "agent-y",
            editable: false,
            denied: false,
          },
        ],
      },
    });
  });
});

describe("PUT /api/user/preferences", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuth.mockResolvedValue(authedSession);
    mockGetAgentsCollection.mockResolvedValue(mockAgentsCollection);
    mockAgentsCollection.findOne.mockResolvedValue({
      _id: "agent-x",
      name: "Agent X",
      enabled: true,
    });
    mockListWebexDirectUserRoutesForUser.mockResolvedValue(new Map());
    mockGetRealmUserByIdOrNull.mockResolvedValue({ attributes: { webex_user_id: ["webex-1"] } });
  });

  it("saves the Web preference when the user has can_use on the agent", async () => {
    mockEvaluateAgentAccess.mockResolvedValue({
      allowed: true,
      path: "direct_user_grant",
      reasonCode: "ALLOW_DIRECT",
    });

    const response = await PUT(
      makeRequest("PUT", { web_default_agent_id: "agent-x" }),
    );

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toMatchObject({
      success: true,
      data: { web_default_agent_id: "agent-x" },
    });
    expect(mockEvaluateAgentAccess).toHaveBeenCalledWith({
      subject: "alice-sub",
      agentId: "agent-x",
    });
    expect(mockUpdateUserPreferences).toHaveBeenCalledWith({
      tenantId: "default",
      userId: "alice-sub",
      preferences: { web_default_agent_id: "agent-x" },
    });
  });

  it("saves slack_default_agent_id independently", async () => {
    mockEvaluateAgentAccess.mockResolvedValue({
      allowed: true,
      path: "direct_user_grant",
      reasonCode: "ALLOW_DIRECT",
    });

    const response = await PUT(makeRequest("PUT", { slack_default_agent_id: "agent-x" }));

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toMatchObject({
      success: true,
      data: { slack_default_agent_id: "agent-x" },
    });
    expect(mockUpdateUserPreferences).toHaveBeenCalledWith({
      tenantId: "default",
      userId: "alice-sub",
      preferences: { slack_default_agent_id: "agent-x" },
    });
  });

  it("writes multiple validated flat surface defaults in one store update", async () => {
    mockEvaluateAgentAccess.mockResolvedValue({
      allowed: true,
      path: "direct_user_grant",
      reasonCode: "ALLOW_DIRECT",
    });

    const response = await PUT(
      makeRequest("PUT", {
        web_default_agent_id: "agent-x",
        slack_default_agent_id: null,
      }),
    );

    expect(response.status).toBe(200);
    expect(mockUpdateUserPreferences).toHaveBeenCalledTimes(1);
    expect(mockUpdateUserPreferences).toHaveBeenCalledWith({
      tenantId: "default",
      userId: "alice-sub",
      preferences: {
        web_default_agent_id: "agent-x",
        slack_default_agent_id: null,
      },
    });
  });

  it("does not write any flat surface when a later field fails validation", async () => {
    mockEvaluateAgentAccess
      .mockResolvedValueOnce({
        allowed: true,
        path: "direct_user_grant",
        reasonCode: "ALLOW_DIRECT",
      })
      .mockResolvedValueOnce({
        allowed: false,
        path: "denied",
        reasonCode: "DENY_NO_CAPABILITY",
      });

    const response = await PUT(
      makeRequest("PUT", {
        web_default_agent_id: "agent-x",
        slack_default_agent_id: "agent-x",
      }),
    );

    expect(response.status).toBe(403);
    expect(mockUpdateUserPreferences).not.toHaveBeenCalled();
  });

  it("clears only the web default when web_default_agent_id is null", async () => {
    const response = await PUT(
      makeRequest("PUT", { web_default_agent_id: null }),
    );

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toMatchObject({
      success: true,
      data: { web_default_agent_id: null },
    });
    expect(mockUpdateUserPreferences).toHaveBeenCalledWith({
      tenantId: "default",
      userId: "alice-sub",
      preferences: { web_default_agent_id: null },
    });
    expect(mockEvaluateAgentAccess).not.toHaveBeenCalled();
  });

  it("clears only slack_default_agent_id when it is null", async () => {
    const response = await PUT(makeRequest("PUT", { slack_default_agent_id: null }));

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toMatchObject({
      success: true,
      data: { slack_default_agent_id: null },
    });
    expect(mockUpdateUserPreferences).toHaveBeenCalledWith({
      tenantId: "default",
      userId: "alice-sub",
      preferences: { slack_default_agent_id: null },
    });
  });

  it("rejects a request that does not include a supported preference field", async () => {
    const response = await PUT(makeRequest("PUT", { unrelated: "agent-x" }));

    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({
      success: false,
      code: "INVALID_BODY",
    });
    expect(mockUpdateUserPreferences).not.toHaveBeenCalled();
  });

  it("returns 403 when the user does not have can_use on the chosen agent", async () => {
    mockEvaluateAgentAccess.mockResolvedValue({
      allowed: false,
      path: "denied",
      reasonCode: "DENY_NO_CAPABILITY",
    });

    const response = await PUT(
      makeRequest("PUT", { web_default_agent_id: "agent-x" }),
    );

    expect(response.status).toBe(403);
    await expect(bodyOf(response)).resolves.toMatchObject({
      success: false,
      code: "FORBIDDEN_AGENT",
    });
    expect(mockUpdateUserPreferences).not.toHaveBeenCalled();
  });

  it("returns 404 when the chosen agent does not exist", async () => {
    mockAgentsCollection.findOne.mockResolvedValue(null);
    mockEvaluateAgentAccess.mockResolvedValue({
      allowed: true,
      path: "direct_user_grant",
      reasonCode: "ALLOW_DIRECT",
    });

    const response = await PUT(
      makeRequest("PUT", { web_default_agent_id: "agent-x" }),
    );

    expect(response.status).toBe(404);
    await expect(bodyOf(response)).resolves.toMatchObject({
      success: false,
      code: "AGENT_NOT_FOUND",
    });
    expect(mockUpdateUserPreferences).not.toHaveBeenCalled();
  });

  it("returns 400 on a malformed preference (non-string non-null)", async () => {
    const response = await PUT(makeRequest("PUT", { web_default_agent_id: 42 }));

    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({
      success: false,
      code: "INVALID_BODY",
    });
    expect(mockUpdateUserPreferences).not.toHaveBeenCalled();
  });

  it("returns 400 on agent id that fails the OpenFGA-safe pattern", async () => {
    const response = await PUT(
      makeRequest("PUT", { web_default_agent_id: "../bad" }),
    );

    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({
      success: false,
      code: "INVALID_BODY",
    });
    expect(mockUpdateUserPreferences).not.toHaveBeenCalled();
  });

  it("returns 401 when no session subject is available", async () => {
    mockGetAuth.mockResolvedValue({
      user: { email: "x", name: "y", role: "user" },
      session: {},
    });

    const response = await PUT(
      makeRequest("PUT", { web_default_agent_id: "agent-x" }),
    );

    expect(response.status).toBe(401);
    expect(mockUpdateUserPreferences).not.toHaveBeenCalled();
  });

  it("returns 502 if PDP throws unexpectedly", async () => {
    mockEvaluateAgentAccess.mockRejectedValue(new Error("OpenFGA down"));

    const response = await PUT(
      makeRequest("PUT", { web_default_agent_id: "agent-x" }),
    );

    expect(response.status).toBe(502);
    expect(mockUpdateUserPreferences).not.toHaveBeenCalled();
  });

  describe("webex_default_agent_id", () => {
    beforeEach(() => {
      mockEvaluateAgentAccess.mockResolvedValue({
        allowed: true,
        path: "direct_user_grant",
        reasonCode: "ALLOW_DIRECT",
      });
    });

    it("upserts the caller's own route for an all_users bot", async () => {
      mockRequireAvailableWebexBotPolicy.mockResolvedValue(ALL_USERS_BOT);

      const response = await PUT(
        makeRequest("PUT", { webex_default_agent_id: { bot_id: "primary", agent_id: "agent-x" } }),
      );

      expect(response.status).toBe(200);
      await expect(bodyOf(response)).resolves.toMatchObject({
        data: { webex_default_agent_id: { bot_id: "primary", agent_id: "agent-x" } },
      });
      expect(mockUpsertWebexDirectUserRoute).toHaveBeenCalledWith({
        botId: "primary",
        keycloakUserId: "alice-sub",
        userEmail: "alice@example.com",
        webexUserId: "webex-1",
        agentId: "agent-x",
        enabled: true,
        actor: "alice@example.com",
      });
    });

    it("deletes the caller's own route when clearing an all_users bot to null", async () => {
      mockRequireAvailableWebexBotPolicy.mockResolvedValue(ALL_USERS_BOT);

      const response = await PUT(
        makeRequest("PUT", { webex_default_agent_id: { bot_id: "primary", agent_id: null } }),
      );

      expect(response.status).toBe(200);
      expect(mockDeleteWebexDirectUserRoute).toHaveBeenCalledWith("primary", "alice-sub");
      expect(mockUpsertWebexDirectUserRoute).not.toHaveBeenCalled();
    });

    it("rejects setting the agent for an allowlist bot (admin-only)", async () => {
      mockRequireAvailableWebexBotPolicy.mockResolvedValue(ALLOWLIST_BOT);

      const response = await PUT(
        makeRequest("PUT", { webex_default_agent_id: { bot_id: "secondary", agent_id: "agent-x" } }),
      );

      expect(response.status).toBe(403);
      await expect(bodyOf(response)).resolves.toMatchObject({ code: "ADMIN_MANAGED" });
      expect(mockUpsertWebexDirectUserRoute).not.toHaveBeenCalled();
    });

    it("rejects setting the agent when an admin has denied the caller", async () => {
      mockRequireAvailableWebexBotPolicy.mockResolvedValue(ALL_USERS_BOT);
      mockListWebexDirectUserRoutesForUser.mockResolvedValue(
        new Map([["primary", { bot_id: "primary", agent_id: "agent-old", status: "disabled" }]]),
      );

      const response = await PUT(
        makeRequest("PUT", { webex_default_agent_id: { bot_id: "primary", agent_id: "agent-x" } }),
      );

      expect(response.status).toBe(403);
      await expect(bodyOf(response)).resolves.toMatchObject({ code: "ADMIN_DENIED" });
      expect(mockUpsertWebexDirectUserRoute).not.toHaveBeenCalled();
    });

    it("rejects a malformed webex_default_agent_id body", async () => {
      const response = await PUT(makeRequest("PUT", { webex_default_agent_id: "agent-x" }));

      expect(response.status).toBe(400);
      await expect(bodyOf(response)).resolves.toMatchObject({ code: "INVALID_BODY" });
      expect(mockRequireAvailableWebexBotPolicy).not.toHaveBeenCalled();
    });

    it("rejects a missing bot_id", async () => {
      const response = await PUT(
        makeRequest("PUT", { webex_default_agent_id: { agent_id: "agent-x" } }),
      );

      expect(response.status).toBe(400);
      await expect(bodyOf(response)).resolves.toMatchObject({ code: "INVALID_BODY" });
    });
  });
});
