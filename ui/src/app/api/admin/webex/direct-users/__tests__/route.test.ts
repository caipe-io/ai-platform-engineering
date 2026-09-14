/**
 * @jest-environment node
 */

import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/api-middleware";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockGetCollection = jest.fn();
const mockGetRealmUserById = jest.fn();
const mockSearchRealmUsers = jest.fn();
const mockCountRealmUsers = jest.fn();
const mockListRoutesByUserIds = jest.fn();
const mockUpsertRoute = jest.fn();
const mockDeleteRoute = jest.fn();
const mockRequireBot = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class MockApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    ApiError: MockApiError,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    requireRbacPermission: (...args: unknown[]) => mockRequireRbacPermission(...args),
    successResponse: (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status }),
    withErrorHandler: <T>(handler: T) => handler,
    // Minimal reimplementation of the real helper's contract (page/page_size
    // query params, 1-100 range, page >= 1) so route tests don't need to pull
    // in the full api-middleware module graph (next-auth, OpenFGA, etc.).
    getPaginationParams: (request: NextRequest) => {
      const page = parseInt(request.nextUrl.searchParams.get("page") || "1");
      const pageSize = parseInt(request.nextUrl.searchParams.get("page_size") || "20");
      if (page < 1) throw new MockApiError("Page must be >= 1", 400);
      if (pageSize < 1 || pageSize > 100) throw new MockApiError("Page size must be between 1 and 100", 400);
      return { page, pageSize, skip: (page - 1) * pageSize };
    },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  getRealmUserById: (...args: unknown[]) => mockGetRealmUserById(...args),
  searchRealmUsers: (...args: unknown[]) => mockSearchRealmUsers(...args),
  countRealmUsers: (...args: unknown[]) => mockCountRealmUsers(...args),
}));

jest.mock("@/lib/rbac/webex-direct-user-route-store", () => ({
  listWebexDirectUserRoutesByUserIds: (...args: unknown[]) => mockListRoutesByUserIds(...args),
  upsertWebexDirectUserRoute: (...args: unknown[]) => mockUpsertRoute(...args),
  deleteWebexDirectUserRoute: (...args: unknown[]) => mockDeleteRoute(...args),
}));

jest.mock("@/lib/webex-bot-policy", () => ({
  requireAvailableWebexBotPolicy: (...args: unknown[]) => mockRequireBot(...args),
}));

function request(
  method: "GET" | "PUT" | "DELETE",
  body?: Record<string, unknown>,
  query?: Record<string, string>,
): NextRequest {
  const params = new URLSearchParams({ bot_id: "primary", ...(query ?? {}) });
  return new NextRequest(`http://localhost/api/admin/webex/direct-users?${params.toString()}`, {
    method,
    ...(body ? {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    } : {}),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthFromBearerOrSession.mockResolvedValue({
    user: { email: "admin@example.com" },
    session: { sub: "admin-user" },
  });
  mockRequireBot.mockResolvedValue({
    id: "primary",
    name: "Primary bot",
    available: true,
    spaces: {
      accessMode: "allowlist",
      defaultTeamSlug: null,
      defaultAgentId: null,
    },
    directMessages: {
      accessMode: "allowlist",
      defaultAgentId: null,
    },
  });
  mockGetRealmUserById.mockResolvedValue({
    id: "user-1",
    email: "user@example.com",
    enabled: true,
    attributes: {},
  });
  mockGetCollection.mockResolvedValue({
    findOne: jest.fn(async () => ({ _id: "agent-1", enabled: true })),
  });
  mockListRoutesByUserIds.mockResolvedValue(new Map());
  mockSearchRealmUsers.mockResolvedValue([]);
  mockCountRealmUsers.mockResolvedValue(0);
  mockUpsertRoute.mockResolvedValue(undefined);
});

describe("/api/admin/webex/direct-users", () => {
  it.each([
    ["GET", () => request("GET")],
    ["PUT", () => request("PUT", { bot_id: "primary", keycloak_user_id: "user-1", agent_id: "agent-1", enabled: true })],
    ["DELETE", () => request("DELETE", { bot_id: "primary", keycloak_user_id: "user-1" })],
  ] as const)("%s requires admin_ui:admin and rejects when the caller lacks it", async (method, buildRequest) => {
    const handlers = await import("../route");
    const handler = method === "GET" ? handlers.GET : method === "PUT" ? handlers.PUT : handlers.DELETE;

    await handler(buildRequest());
    expect(mockRequireRbacPermission).toHaveBeenCalledWith(
      { sub: "admin-user" },
      "admin_ui",
      "admin",
    );

    mockRequireRbacPermission.mockRejectedValueOnce(new ApiError("Forbidden", 403));
    await expect(handler(buildRequest())).rejects.toMatchObject({ statusCode: 403 });
  });

  it("saves a direct-user route without accepting or resolving a team or an expected Webex email", async () => {
    const { PUT } = await import("../route");

    const response = await PUT(request("PUT", {
      bot_id: "primary",
      keycloak_user_id: "user-1",
      agent_id: "agent-1",
      enabled: true,
      expected_webex_email: "attacker@example.com",
      team_slug: "must-not-be-used",
    }));

    expect(response.status).toBe(200);
    expect(mockGetCollection).toHaveBeenCalledTimes(1);
    expect(mockGetCollection).toHaveBeenCalledWith("dynamic_agents");
    expect(mockUpsertRoute).toHaveBeenCalledWith({
      botId: "primary",
      keycloakUserId: "user-1",
      userEmail: "user@example.com",
      webexUserId: undefined,
      agentId: "agent-1",
      enabled: true,
      actor: "admin@example.com",
    });
  });

  it("returns only the DM default agent for inherited users", async () => {
    mockRequireBot.mockResolvedValue({
      id: "primary",
      name: "Primary bot",
      available: true,
      spaces: {
        accessMode: "all_spaces",
        defaultTeamSlug: "group-team",
        defaultAgentId: "space-agent",
      },
      directMessages: {
        accessMode: "all_users",
        defaultAgentId: "dm-agent",
      },
    });
    mockSearchRealmUsers.mockResolvedValueOnce([{
      id: "user-1",
      email: "user@example.com",
      enabled: true,
      username: "user",
    }]);
    mockCountRealmUsers.mockResolvedValueOnce(1);
    const { GET } = await import("../route");

    const response = await GET(request("GET"));
    const payload = await response.json();

    expect(payload.data.default_agent_id).toBe("dm-agent");
    expect(payload.data).not.toHaveProperty("default_team_slug");
    expect(payload.data.users[0]).toMatchObject({
      agent_id: "dm-agent",
      inherited: true,
    });
    expect(payload.data.users[0]).not.toHaveProperty("team_slug");
  });

  it("reports linked=true when the user has a webex_user_id attribute and linked=false otherwise", async () => {
    mockSearchRealmUsers.mockResolvedValueOnce([
      { id: "user-1", email: "linked@example.com", enabled: true, attributes: { webex_user_id: ["abc"] } },
      { id: "user-2", email: "unlinked@example.com", enabled: true, attributes: {} },
    ]);
    mockCountRealmUsers.mockResolvedValueOnce(2);
    const { GET } = await import("../route");

    const response = await GET(request("GET"));
    const payload = await response.json();

    expect(payload.data.users).toEqual([
      expect.objectContaining({ keycloak_user_id: "user-1", linked: true }),
      expect.objectContaining({ keycloak_user_id: "user-2", linked: false }),
    ]);
  });

  it.each([
    ["allowlist", "active", "allowlisted", true],
    ["allowlist", "disabled", "denied", false],
    ["allowlist", undefined, "not_allowed", false],
    ["all_users", "active", "overridden", true],
    ["all_users", "disabled", "denied", false],
    ["all_users", undefined, "inherited", true],
  ] as const)(
    "classifies accessMode=%s route.status=%s as state=%s",
    async (accessMode, routeStatus, expectedState, expectedEnabled) => {
      mockRequireBot.mockResolvedValue({
        id: "primary",
        name: "Primary bot",
        available: true,
        spaces: { accessMode: "allowlist", defaultTeamSlug: null, defaultAgentId: null },
        directMessages: { accessMode, defaultAgentId: null },
      });
      mockSearchRealmUsers.mockResolvedValueOnce([
        { id: "user-1", email: "user@example.com", enabled: true, attributes: {} },
      ]);
      mockCountRealmUsers.mockResolvedValueOnce(1);
      mockListRoutesByUserIds.mockResolvedValueOnce(
        routeStatus
          ? new Map([["user-1", { keycloak_user_id: "user-1", bot_id: "primary", user_email: "user@example.com", agent_id: "agent-1", status: routeStatus }]])
          : new Map(),
      );
      const { GET } = await import("../route");

      const response = await GET(request("GET"));
      const payload = await response.json();

      expect(payload.data.users[0]).toMatchObject({
        state: expectedState,
        enabled: expectedEnabled,
      });
    },
  );

  it("reports state=disabled when direct messages are disabled for the bot", async () => {
    mockRequireBot.mockResolvedValue({
      id: "primary",
      name: "Primary bot",
      available: true,
      spaces: { accessMode: "allowlist", defaultTeamSlug: null, defaultAgentId: null },
      directMessages: { accessMode: "disabled", defaultAgentId: null },
    });
    mockSearchRealmUsers.mockResolvedValueOnce([
      { id: "user-1", email: "user@example.com", enabled: true, attributes: {} },
    ]);
    mockCountRealmUsers.mockResolvedValueOnce(1);
    const { GET } = await import("../route");

    const response = await GET(request("GET"));
    const payload = await response.json();

    expect(payload.data.users[0]).toMatchObject({ state: "disabled" });
  });

  it("forwards q/page/page_size to searchRealmUsers and countRealmUsers, and only fetches routes for the returned page", async () => {
    mockSearchRealmUsers.mockResolvedValueOnce([
      { id: "user-1", email: "user1@example.com", enabled: true, username: "user1" },
      { id: "user-2", email: "user2@example.com", enabled: true, username: "user2" },
    ]);
    mockCountRealmUsers.mockResolvedValueOnce(42);
    const { GET } = await import("../route");

    const response = await GET(request("GET", undefined, { q: "user", page: "3", page_size: "2" }));
    const payload = await response.json();

    expect(mockSearchRealmUsers).toHaveBeenCalledWith({
      search: "user",
      enabled: true,
      first: 4, // (page 3 - 1) * page_size 2
      max: 2,
    });
    expect(mockCountRealmUsers).toHaveBeenCalledWith({ search: "user", enabled: true });
    expect(mockListRoutesByUserIds).toHaveBeenCalledWith("primary", ["user-1", "user-2"]);
    expect(payload.data.total).toBe(42);
    expect(payload.data.page).toBe(3);
    expect(payload.data.page_size).toBe(2);
    expect(payload.data.has_more).toBe(true); // 3 * 2 = 6 < 42
  });

  it("excludes rows with no usable keycloak_user_id or email", async () => {
    mockSearchRealmUsers.mockResolvedValueOnce([
      { id: "user-1", email: "user@example.com", enabled: true, username: "user" },
      { id: "", email: "", enabled: true, username: "service-account" },
    ]);
    mockCountRealmUsers.mockResolvedValueOnce(2);
    const { GET } = await import("../route");

    const response = await GET(request("GET"));
    const payload = await response.json();

    expect(payload.data.users).toHaveLength(1);
    expect(payload.data.users[0]).toMatchObject({ keycloak_user_id: "user-1" });
  });

  it("omits the search term when q is blank", async () => {
    const { GET } = await import("../route");

    await GET(request("GET", undefined, { q: "   " }));

    expect(mockSearchRealmUsers).toHaveBeenCalledWith(
      expect.objectContaining({ search: undefined }),
    );
    expect(mockCountRealmUsers).toHaveBeenCalledWith(
      expect.objectContaining({ search: undefined }),
    );
  });
});
