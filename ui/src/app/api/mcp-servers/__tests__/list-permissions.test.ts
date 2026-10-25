/**
 * @jest-environment node
 */

// assisted-by Codex Codex-sonnet-4-6

import { NextRequest } from "next/server";

const mockGetCollection = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockResolveMcpServerListPermissions = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public statusCode = 500,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    getAuthFromBearerOrSession: async () => ({
      session: { sub: "test-user", role: "user", user: { email: "test-user@example.com" } },
    }),
    getPaginationParams: () => ({ page: 1, pageSize: 100, skip: 0 }),
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T,>(handler: (...args: unknown[]) => Promise<T>) =>
      async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (error) {
          return Response.json(
            { success: false, error: error instanceof Error ? error.message : "error" },
            { status: (error as { statusCode?: number }).statusCode ?? 500 },
          );
        }
      },
  };
});

jest.mock("@/lib/rbac/resource-authz", () => ({
  filterResourcesByPermission: (...args: unknown[]) => mockFilterResourcesByPermission(...args),
  mcpServerRowPermissionsOrDefault: (rows: Map<string, { can_manage: boolean; can_invoke: boolean; can_discover: boolean }>, id: string) =>
    rows.get(id) ?? { can_manage: false, can_invoke: false, can_discover: false },
  requireResourcePermission: jest.fn(),
  resolveMcpServerListPermissions: (...args: unknown[]) => mockResolveMcpServerListPermissions(...args),
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileMcpServerRelationships: jest.fn(),
  deleteAllMcpServerRelationshipTuples: jest.fn(),
}));

jest.mock("../agentgateway/_lib", () => ({
  syncSelectedAgentGatewayMcpServers: jest.fn(),
}));

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

describe("GET /api/mcp-servers list permissions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFilterResourcesByPermission.mockImplementation(async (_session, items) => items);
    mockResolveMcpServerListPermissions.mockImplementation(async (_session, ids: string[]) => ({
      rows: new Map(
        ids.map((id) => [
          id,
          {
            can_manage: id === "mcp-managed",
            can_invoke: id !== "mcp-read-only",
            can_discover: id !== "mcp-read-only",
          },
        ]),
      ),
      capabilities: { repair_agentgateway: true },
    }));
  });

  it("attaches per-row permissions and list capabilities from batch OpenFGA resolution", async () => {
    const items = [
      { _id: "mcp-managed", name: "Managed" },
      { _id: "mcp-invoke-only", name: "Invoke Only" },
      { _id: "mcp-read-only", name: "Read Only" },
    ];
    const toArray = jest.fn().mockResolvedValue(items);
    const sort = jest.fn().mockReturnValue({ toArray });
    mockGetCollection.mockResolvedValue({
      countDocuments: jest.fn().mockResolvedValue(items.length),
      find: jest.fn().mockReturnValue({ sort }),
    });

    const { GET } = await import("../route");
    const response = await GET(request("/api/mcp-servers?page_size=100"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockResolveMcpServerListPermissions).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "test-user" }),
      ["mcp-invoke-only", "mcp-managed", "mcp-read-only"],
      {
        bypassForOrgAdmin: true,
        trustedContext: {
          interaction: { source: "web", conversationKind: "personal", verified: false },
        },
      },
    );
    expect(body.data.capabilities).toEqual({ repair_agentgateway: true });
    expect(body.data.items).toEqual([
      {
        _id: "mcp-invoke-only",
        name: "Invoke Only",
        visibility: "global",
        permissions: { can_manage: false, can_invoke: true, can_discover: true },
      },
      {
        _id: "mcp-managed",
        name: "Managed",
        visibility: "global",
        permissions: { can_manage: true, can_invoke: true, can_discover: true },
      },
      {
        _id: "mcp-read-only",
        name: "Read Only",
        visibility: "global",
        permissions: { can_manage: false, can_invoke: false, can_discover: false },
      },
    ]);
  });

  it("returns one exact MCP server with row permissions for a deep link", async () => {
    const server = { _id: "mcp-managed", name: "Managed" };
    const findOne = jest.fn().mockResolvedValue(server);
    mockGetCollection.mockResolvedValue({
      countDocuments: jest.fn().mockResolvedValue(1),
      findOne,
    });

    const { GET } = await import("../route");
    const response = await GET(request("/api/mcp-servers?id=mcp-managed"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(findOne).toHaveBeenCalledWith({ _id: "mcp-managed" });
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "test-user" }),
      [server],
      { type: "mcp_server", action: "read", id: expect.any(Function) },
      {
        bypassForOrgAdmin: true,
        trustedContext: {
          interaction: { source: "web", conversationKind: "personal", verified: false },
        },
      },
    );
    expect(body.data).toEqual({
      ...server,
      visibility: "global",
      permissions: { can_manage: true, can_invoke: true, can_discover: true },
    });
  });

  it("does not disclose another user's private MCP through an exact deep link", async () => {
    const server = {
      _id: "mcp-private-other",
      name: "Private Other",
      visibility: "private",
      owner_subject: "other-sub",
    };
    const findOne = jest.fn().mockResolvedValue(server);
    mockGetCollection.mockResolvedValue({ findOne });

    const { GET } = await import("../route");
    const response = await GET(request("/api/mcp-servers?id=mcp-private-other"));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ success: false, error: "MCP server not found" });
    expect(mockFilterResourcesByPermission).not.toHaveBeenCalled();
    expect(mockResolveMcpServerListPermissions).not.toHaveBeenCalled();
  });

  it("scopes another user's private MCP out before the org-admin list bypass", async () => {
    const items = [
      { _id: "mcp-private-other", name: "Private Other", visibility: "private", owner_subject: "other-sub" },
      { _id: "mcp-private-own", name: "Private Own", visibility: "private", owner_subject: "test-user" },
      { _id: "mcp-global", name: "Global", visibility: "global" },
    ];
    const toArray = jest.fn().mockResolvedValue(items);
    const sort = jest.fn().mockReturnValue({ toArray });
    mockGetCollection.mockResolvedValue({ find: jest.fn().mockReturnValue({ sort }) });

    const { GET } = await import("../route");
    const response = await GET(request("/api/mcp-servers?page_size=100"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "test-user" }),
      [items[1], items[2]],
      { type: "mcp_server", action: "read", id: expect.any(Function) },
      expect.objectContaining({ bypassForOrgAdmin: true }),
    );
    expect(body.data.items.map((item: { _id: string }) => item._id)).toEqual([
      "mcp-global",
      "mcp-private-own",
    ]);
    expect(body.data.total).toBe(2);
  });

  it.each([
    ["name", "desc", ["zeta", "bravo", "alpha"]],
    ["transport", "asc", ["zeta", "bravo", "alpha"]],
    ["endpoint", "asc", ["alpha", "bravo", "zeta"]],
    ["status", "asc", ["alpha", "bravo", "zeta"]],
  ])("sorts the full visible result set by %s %s", async (sortBy, sortOrder, expectedIds) => {
    const items = [
      {
        _id: "zeta",
        name: "Zeta",
        transport: "http",
        endpoint: "https://z.example.test/mcp",
        enabled: true,
      },
      {
        _id: "alpha",
        name: "Alpha",
        transport: "stdio",
        command: "alpha-mcp",
        enabled: false,
      },
      {
        _id: "bravo",
        name: "Bravo",
        transport: "sse",
        endpoint: "https://bravo.example.test/sse",
        enabled: true,
      },
    ];
    const toArray = jest.fn().mockResolvedValue(items);
    const sort = jest.fn().mockReturnValue({ toArray });
    mockGetCollection.mockResolvedValue({
      countDocuments: jest.fn().mockResolvedValue(items.length),
      find: jest.fn().mockReturnValue({ sort }),
    });
    const { GET } = await import("../route");

    const response = await GET(request(
      `/api/mcp-servers?page_size=100&sort_by=${sortBy}&sort_order=${sortOrder}`,
    ));
    const body = await response.json();

    expect(body.data.items.map((server: { _id: string }) => server._id)).toEqual(expectedIds);
  });
});
