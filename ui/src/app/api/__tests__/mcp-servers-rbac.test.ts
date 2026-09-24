/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetCollection = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockResolveMcpServerListPermissions = jest.fn();
const mockReconcileMcpServerRelationships = jest.fn();
const mockDeleteAllMcpServerRelationshipTuples = jest.fn();
const mockSyncSelectedAgentGatewayMcpServers = jest.fn();
let mockSession = { sub: "alice-sub", role: "user", user: { email: "alice@example.com" } };
let mockPagination = { page: 1, pageSize: 20, skip: 0 };

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
    getAuthFromBearerOrSession: async () => ({ session: mockSession, user: mockSession.user }),
    getPaginationParams: () => mockPagination,
    paginatedResponse: (items: unknown[], total: number, page: number, pageSize: number) =>
      Response.json({ success: true, data: { items, pagination: { total, page, pageSize } } }),
    requireRbacPermission: (...args: unknown[]) => mockRequireRbacPermission(...args),
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
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
  resolveMcpServerListPermissions: (...args: unknown[]) => mockResolveMcpServerListPermissions(...args),
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileMcpServerRelationships: (...args: unknown[]) => mockReconcileMcpServerRelationships(...args),
  deleteAllMcpServerRelationshipTuples: (...args: unknown[]) => mockDeleteAllMcpServerRelationshipTuples(...args),
}));

jest.mock("../mcp-servers/agentgateway/_lib", () => ({
  syncSelectedAgentGatewayMcpServers: (...args: unknown[]) => mockSyncSelectedAgentGatewayMcpServers(...args),
}));

function request(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

describe("MCP server per-resource RBAC", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { sub: "alice-sub", role: "user", user: { email: "alice@example.com" } };
    mockPagination = { page: 1, pageSize: 20, skip: 0 };
    mockRequireRbacPermission.mockResolvedValue(undefined);
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockFilterResourcesByPermission.mockImplementation(async (_session, items) =>
      items.filter((item: { _id: string }) => item._id === "mcp-visible"),
    );
    mockResolveMcpServerListPermissions.mockImplementation(async (_session, ids: string[]) => ({
      rows: new Map(ids.map((id) => [id, { can_manage: true, can_invoke: true, can_discover: true }])),
      capabilities: { repair_agentgateway: false },
    }));
    mockReconcileMcpServerRelationships.mockResolvedValue({ enabled: true, writes: 3, deletes: 0 });
    mockDeleteAllMcpServerRelationshipTuples.mockResolvedValue({ enabled: true, writes: 0, deletes: 3 });
    mockSyncSelectedAgentGatewayMcpServers.mockResolvedValue({ summary: { added: 0, migrated: 0 } });
  });

  it("filters listed MCP servers through mcp_server#read", async () => {
    const items = [
      { _id: "mcp-visible", name: "Visible" },
      { _id: "mcp-hidden", name: "Hidden" },
    ];
    const toArray = jest.fn().mockResolvedValue(items);
    const sort = jest.fn().mockReturnValue({ toArray });
    mockGetCollection.mockResolvedValue({
      countDocuments: jest.fn().mockResolvedValue(1),
      find: jest.fn().mockReturnValue({ sort }),
    });
    const { GET } = await import("../mcp-servers/route");

    const response = await GET(request("/api/mcp-servers"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub", role: "user" }),
      items,
      { type: "mcp_server", action: "read", id: expect.any(Function) },
      { bypassForOrgAdmin: true },
    );
    expect(body.data.items).toEqual([
      {
        _id: "mcp-visible",
        name: "Visible",
        permissions: { can_manage: true, can_invoke: true, can_discover: true },
      },
    ]);
    expect(body.data.capabilities).toEqual({ repair_agentgateway: false });
    expect(mockResolveMcpServerListPermissions).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub", role: "user" }),
      ["mcp-visible"],
      { bypassForOrgAdmin: true },
    );
  });

  it("filters admin MCP server lists through OpenFGA instead of role bypassing", async () => {
    mockSession = { sub: "admin-sub", role: "admin", user: { email: "admin@example.com" } };
    const items = [
      { _id: "jira", name: "Jira", endpoint: "http://mcp-jira:8000/mcp" },
      { _id: "mcp-visible", name: "Visible", endpoint: "http://mcp-visible:8000/mcp" },
    ];
    const toArray = jest.fn().mockResolvedValue(items);
    const sort = jest.fn().mockReturnValue({ toArray });
    mockGetCollection.mockResolvedValue({
      countDocuments: jest.fn().mockResolvedValue(1),
      find: jest.fn().mockReturnValue({ sort }),
    });
    const { GET } = await import("../mcp-servers/route");

    const response = await GET(request("/api/mcp-servers"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "admin-sub", role: "admin" }),
      items,
      { type: "mcp_server", action: "read", id: expect.any(Function) },
      { bypassForOrgAdmin: true },
    );
    expect(body.data.items).toEqual([
      {
        _id: "mcp-visible",
        name: "Visible",
        endpoint: "http://mcp-visible:8000/mcp",
        permissions: { can_manage: true, can_invoke: true, can_discover: true },
      },
    ]);
  });

  it("authorizes the full catalog before paginating visible MCP servers", async () => {
    const allServers = Array.from({ length: 25 }, (_, index) => ({
      _id: `mcp-server-${index}`,
      name: `Server ${index}`,
    }));

    mockFilterResourcesByPermission.mockImplementation(async (_session, items) =>
      items.filter((item: { _id: string }) => {
        const index = Number(item._id.replace("mcp-server-", ""));
        return index < 15;
      }),
    );
    mockPagination = { page: 2, pageSize: 10, skip: 10 };

    const toArray = jest.fn().mockResolvedValue(allServers);
    const sort = jest.fn().mockReturnValue({ toArray });
    mockGetCollection.mockResolvedValue({
      countDocuments: jest.fn().mockResolvedValue(1),
      find: jest.fn().mockReturnValue({ sort }),
    });

    const { GET } = await import("../mcp-servers/route");
    const response = await GET(request("/api/mcp-servers?page=2&page_size=10"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      expect.anything(),
      allServers,
      expect.objectContaining({ type: "mcp_server", action: "read" }),
      { bypassForOrgAdmin: true },
    );
    expect(body.data.items).toHaveLength(5);
    expect(body.data.items[0]).toEqual({
      _id: "mcp-server-10",
      name: "Server 10",
      permissions: { can_manage: true, can_invoke: true, can_discover: true },
    });
    expect(body.data.total).toBe(15);
    expect(body.data.page).toBe(2);
    expect(body.data.page_size).toBe(10);
    expect(sort).toHaveBeenCalledWith({ name: 1 });
    expect(toArray).toHaveBeenCalledTimes(1);
  });

  it("keeps MCP list reads side-effect free when no discovered rows exist", async () => {
    const items = [{ _id: "knowledge-base", name: "Knowledge Base" }];
    mockFilterResourcesByPermission.mockResolvedValue(items);
    const toArray = jest.fn().mockResolvedValue(items);
    const sort = jest.fn().mockReturnValue({ toArray });
    const countDocuments = jest.fn().mockResolvedValue(0);
    mockGetCollection.mockResolvedValue({
      countDocuments,
      find: jest.fn().mockReturnValue({ sort }),
    });
    const { GET } = await import("../mcp-servers/route");

    const response = await GET(request("/api/mcp-servers"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(countDocuments).not.toHaveBeenCalled();
    expect(mockSyncSelectedAgentGatewayMcpServers).not.toHaveBeenCalled();
    expect(body.data.items).toEqual([
      {
        _id: "knowledge-base",
        name: "Knowledge Base",
        permissions: { can_manage: true, can_invoke: true, can_discover: true },
      },
    ]);
  });

  it("lets a service account create an MCP server with service_account owner tuples", async () => {
    mockSession = {
      sub: "bot-client-id",
      isServiceAccount: true,
      role: "user",
      user: { email: "bot@example.com" },
    };
    const insertOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      insertOne,
    });
    const { POST } = await import("../mcp-servers/route");

    const response = await POST(
      request("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "bot-tools",
          name: "Bot Tools",
          transport: "http",
          endpoint: "https://mcp.example.test/mcp",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockReconcileMcpServerRelationships).toHaveBeenCalledWith(
      {
        serverId: "mcp-bot-tools",
        ownerSubject: "bot-client-id",
        ownerSubjectKind: "service_account",
        ownerTeamSlug: null,
      },
      {
        caller: { type: "service_account", id: "bot-client-id" },
        source: "mcp_server_create",
      },
    );
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_subject: "bot-client-id",
      }),
    );
  });

  it("does not persist Mongo when MCP ownership reconciliation fails", async () => {
    const insertOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      insertOne,
    });
    mockReconcileMcpServerRelationships.mockRejectedValue(
      new Error("OpenFGA reconciliation is required for this mutation"),
    );
    const { POST } = await import("../mcp-servers/route");

    const response = await POST(
      request("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "ops-tools",
          name: "Ops Tools",
          transport: "http",
          endpoint: "https://mcp.example.test/mcp",
        }),
      }),
    );

    expect(response.status).toBe(500);
    expect(insertOne).not.toHaveBeenCalled();
  });

  it("does not delete Mongo when tuple cleanup fails", async () => {
    const server = { _id: "jira", name: "Jira", config_driven: false };
    const deleteOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(server),
      deleteOne,
    });
    mockDeleteAllMcpServerRelationshipTuples.mockRejectedValue(new Error("OpenFGA unavailable"));
    const { DELETE } = await import("../mcp-servers/route");

    const response = await DELETE(request("/api/mcp-servers?id=jira", { method: "DELETE" }));

    expect(response.status).toBe(500);
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it("lets a non-admin create a private MCP server and writes owner tuples", async () => {
    const insertOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      insertOne,
    });
    const { POST } = await import("../mcp-servers/route");

    const response = await POST(
      request("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "ops-tools",
          name: "Ops Tools",
          transport: "http",
          endpoint: "https://mcp.example.test/mcp",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub", role: "user" }),
      { type: "organization", id: "caipe", action: "use" },
      { bypassForOrgAdmin: true },
    );
    expect(mockRequireRbacPermission).not.toHaveBeenCalledWith(
      expect.anything(),
      "mcp_server",
      "manage",
    );
    expect(mockReconcileMcpServerRelationships).toHaveBeenCalledWith(
      {
        serverId: "mcp-ops-tools",
        ownerSubject: "alice-sub",
        ownerSubjectKind: "user",
        ownerTeamSlug: null,
      },
      {
        caller: { type: "user", id: "alice-sub" },
        source: "mcp_server_create",
      },
    );
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "mcp-ops-tools",
        owner_id: "alice@example.com",
        owner_subject: "alice-sub",
        owner_team_slug: undefined,
      }),
    );
  });

  it("requires a stable subject before writing MCP ownership tuples", async () => {
    mockSession = { sub: "", role: "user", user: { email: "alice@example.com" } };
    const insertOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      insertOne,
    });
    const { POST } = await import("../mcp-servers/route");

    const response = await POST(
      request("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "ops-tools",
          name: "Ops Tools",
          transport: "http",
          endpoint: "https://mcp.example.test/mcp",
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(mockReconcileMcpServerRelationships).not.toHaveBeenCalled();
    expect(insertOne).not.toHaveBeenCalled();
  });

  it("requires team membership before creating a team-owned MCP server", async () => {
    const insertOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      insertOne,
    });
    const { POST } = await import("../mcp-servers/route");

    const response = await POST(
      request("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "team-tools",
          name: "Team Tools",
          transport: "http",
          endpoint: "https://mcp.example.test/mcp",
          owner_team_slug: "platform",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      mockSession,
      { type: "team", id: "platform", action: "use" },
    );
    expect(mockReconcileMcpServerRelationships).toHaveBeenCalledWith(
      {
        serverId: "mcp-team-tools",
        ownerSubject: "alice-sub",
        ownerSubjectKind: "user",
        ownerTeamSlug: "platform",
      },
      {
        caller: { type: "user", id: "alice-sub" },
        source: "mcp_server_create",
      },
    );
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_team_slug: "platform",
      }),
    );
  });

  it("requires mcp_server#manage before updating a server", async () => {
    const server = { _id: "mcp-visible", name: "Visible", config_driven: false };
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(server),
      findOneAndUpdate: jest.fn().mockResolvedValue({ ...server, name: "Updated" }),
    });
    const { PUT } = await import("../mcp-servers/route");

    const response = await PUT(
      request("/api/mcp-servers?id=mcp-visible", {
        method: "PUT",
        body: JSON.stringify({ name: "Updated" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub", role: "user" }),
      { type: "mcp_server", id: "mcp-visible", action: "manage" },
    );
  });

  it("requires OpenFGA delete access and cleans MCP tuples before deletion", async () => {
    mockSession = { sub: "admin-sub", role: "admin", user: { email: "admin@example.com" } };
    const server = { _id: "jira", name: "Jira", config_driven: false };
    const deleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(server),
      deleteOne,
    });
    const { DELETE } = await import("../mcp-servers/route");

    const response = await DELETE(request("/api/mcp-servers?id=jira", { method: "DELETE" }));

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "admin-sub", role: "admin" }),
      { type: "mcp_server", id: "jira", action: "delete" },
    );
    expect(mockDeleteAllMcpServerRelationshipTuples).toHaveBeenCalledWith(
      "jira",
      expect.objectContaining({
        source: "mcp_server_delete",
        caller: { type: "user", id: "admin-sub" },
      }),
    );
    expect(deleteOne).toHaveBeenCalledWith({ _id: "jira" });
  });
});
