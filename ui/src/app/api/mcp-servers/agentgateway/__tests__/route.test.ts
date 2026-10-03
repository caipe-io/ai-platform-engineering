/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockGetCollection = jest.fn();
const mockReconcileConfigDrivenMcpServerRelationships = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T,>(handler: (request: NextRequest) => Promise<T>) =>
      (request: NextRequest) =>
        handler(request),
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileConfigDrivenMcpServerRelationships: (...args: unknown[]) =>
    mockReconcileConfigDrivenMcpServerRelationships(...args),
}));

const agentGatewayConfig = {
  binds: [
    {
      listeners: [
        {
          routes: [
            {
              backends: [
                {
                  mcp: {
                    targets: [
                      { name: "rag", mcp: { host: "http://rag-server:9446/mcp" } },
                      { name: "jira", mcp: { host: "http://mcp-jira:8000/mcp" } },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function request(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthFromBearerOrSession.mockResolvedValue({ session: { sub: "admin-sub", role: "admin" } });
  mockRequireResourcePermission.mockResolvedValue(undefined);
  mockReconcileConfigDrivenMcpServerRelationships.mockResolvedValue({ enabled: true, writes: 4, deletes: 0 });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => agentGatewayConfig,
  }) as unknown as typeof fetch;
});

describe("AgentGateway MCP server discovery API", () => {
  it("discovers AgentGateway MCP targets and marks direct registrations as legacy migrations", async () => {
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            _id: "jira",
            name: "Jira",
            transport: "http",
            endpoint: "http://mcp-jira:8000/mcp",
            enabled: true,
          },
        ]),
      }),
    });
    const { GET } = await import("../discover/route");

    const response = await GET(request("/api/mcp-servers/agentgateway/discover"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "admin-sub", role: "admin" },
      { type: "mcp_server", id: "agentgateway", action: "discover" },
    );
    expect(body.data.targets).toEqual([
      expect.objectContaining({ id: "rag", status: "new" }),
      expect.objectContaining({
        id: "jira",
        endpoint: "http://agentgateway:4000/mcp",
        target_endpoint: "http://mcp-jira:8000/mcp",
        status: "legacy",
        existing_endpoint: "http://mcp-jira:8000/mcp",
      }),
    ]);
  });

  it("auto-imports new AgentGateway MCP targets and migrates legacy direct registrations", async () => {
    const insertOne = jest.fn();
    const updateOne = jest.fn();
    const findOne = jest.fn().mockResolvedValue({
      _id: "jira",
      name: "Jira",
      transport: "http",
      endpoint: "http://mcp-jira:8000/mcp",
      enabled: true,
    });
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            _id: "jira",
            name: "Jira",
            transport: "http",
            endpoint: "http://mcp-jira:8000/mcp",
            enabled: true,
          },
        ]),
      }),
      insertOne,
      updateOne,
      findOne,
    });
    const { POST } = await import("../sync/route");

    const response = await POST(
      request("/api/mcp-servers/agentgateway/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "admin-sub", role: "admin" },
      { type: "mcp_server", id: "agentgateway", action: "admin" },
    );
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "rag",
        name: "RAG",
        transport: "http",
        endpoint: "http://agentgateway:4000/mcp",
        enabled: true,
        source: "agentgateway",
        agentgateway_discovered: true,
        agentgateway_target_endpoint: "http://rag-server:9446/mcp",
      }),
    );
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "jira" },
      {
        $set: expect.objectContaining({
          _id: "jira",
          endpoint: "http://agentgateway:4000/mcp",
          source: "agentgateway",
          agentgateway_discovered: true,
          agentgateway_target_endpoint: "http://mcp-jira:8000/mcp",
        }),
      },
    );
    expect(mockReconcileConfigDrivenMcpServerRelationships).toHaveBeenCalledWith({
      serverId: "rag",
      organizationId: "caipe",
    });
    expect(mockReconcileConfigDrivenMcpServerRelationships).toHaveBeenCalledWith({
      serverId: "jira",
      organizationId: "caipe",
    });
    const reconcileOrder = mockReconcileConfigDrivenMcpServerRelationships.mock.invocationCallOrder[0];
    const insertOrder = insertOne.mock.invocationCallOrder[0];
    const updateOrder = updateOne.mock.invocationCallOrder[0];
    expect(reconcileOrder).toBeLessThan(insertOrder);
    expect(reconcileOrder).toBeLessThan(updateOrder);
    expect(body.data).toMatchObject({
      added: ["rag"],
      migrated: ["jira"],
      summary: {
        added: 1,
        existing: 0,
        migrated: 1,
        conflicts: 0,
        skipped: 0,
      },
      conflicts: [],
      migration_warnings: [],
    });
  });

  it("preserves existing credential sources when migrating a legacy direct registration", async () => {
    const insertOne = jest.fn();
    const updateOne = jest.fn();
    const existingCredentialSources = [
      {
        kind: "secret_ref",
        target: "header",
        name: "Authorization",
        secret_ref: "jira-existing-token",
      },
    ];
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            _id: "jira",
            name: "Jira",
            transport: "http",
            endpoint: "http://mcp-jira:8000/mcp",
            enabled: true,
            credential_sources: existingCredentialSources,
          },
        ]),
      }),
      insertOne,
      updateOne,
      findOne: jest.fn().mockResolvedValue({
        _id: "jira",
        credential_sources: existingCredentialSources,
      }),
    });
    const { POST } = await import("../sync/route");

    const response = await POST(
      request("/api/mcp-servers/agentgateway/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["jira"] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "jira" },
      {
        $set: expect.objectContaining({
          source: "agentgateway",
          agentgateway_target_endpoint: "http://mcp-jira:8000/mcp",
          credential_sources: existingCredentialSources,
        }),
      },
    );
    expect(insertOne).not.toHaveBeenCalled();
  });

  it("repairs OpenFGA grants for existing AgentGateway-managed MCP servers during sync", async () => {
    const insertOne = jest.fn();
    const updateOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            _id: "rag",
            name: "RAG",
            transport: "http",
            endpoint: "http://agentgateway:4000/mcp",
            enabled: true,
            source: "agentgateway",
            agentgateway_discovered: true,
          },
          {
            _id: "jira",
            name: "Jira",
            transport: "http",
            endpoint: "http://agentgateway:4000/mcp",
            enabled: true,
            source: "agentgateway",
            agentgateway_discovered: true,
          },
        ]),
      }),
      insertOne,
      updateOne,
    });
    const { POST } = await import("../sync/route");

    const response = await POST(
      request("/api/mcp-servers/agentgateway/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(insertOne).not.toHaveBeenCalled();
    // "existing" still persists agentgateway_discovered (and the endpoint
    // fields) on every sync, not just on first discovery — seed's
    // full-document replaceOne wipes agentgateway_discovered back to
    // undefined on every restart, so a confirmed-live route must be
    // re-persisted here or dynamic-agents tool wiring treats it as pending.
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "rag" },
      {
        $set: {
          agentgateway_discovered: true,
          agentgateway_endpoint: "http://agentgateway:4000/mcp",
          agentgateway_target_endpoint: expect.any(String),
          updated_at: expect.any(String),
        },
      },
    );
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "jira" },
      {
        $set: {
          agentgateway_discovered: true,
          agentgateway_endpoint: "http://agentgateway:4000/mcp",
          agentgateway_target_endpoint: expect.any(String),
          updated_at: expect.any(String),
        },
      },
    );
    expect(mockReconcileConfigDrivenMcpServerRelationships).toHaveBeenCalledWith({
      serverId: "rag",
      organizationId: "caipe",
    });
    expect(mockReconcileConfigDrivenMcpServerRelationships).toHaveBeenCalledWith({
      serverId: "jira",
      organizationId: "caipe",
    });
    expect(body.data).toMatchObject({
      added: [],
      migrated: [],
      refreshed: ["rag", "jira"],
      summary: {
        added: 0,
        existing: 2,
        migrated: 0,
        refreshed: 2,
        conflicts: 0,
        skipped: 0,
      },
    });
  });

  it("denies admin discovery when OpenFGA denies the AgentGateway object grant", async () => {
    mockRequireResourcePermission.mockRejectedValue(new Error("no discovery"));
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
    });
    const { GET } = await import("../discover/route");

    await expect(GET(request("/api/mcp-servers/agentgateway/discover"))).rejects.toThrow("no discovery");
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "admin-sub", role: "admin" },
      { type: "mcp_server", id: "agentgateway", action: "discover" },
    );
  });

  it("does not persist Mongo when OpenFGA reconcile fails during sync", async () => {
    const insertOne = jest.fn();
    const updateOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            _id: "jira",
            name: "Jira",
            transport: "http",
            endpoint: "http://mcp-jira:8000/mcp",
            enabled: true,
          },
        ]),
      }),
      insertOne,
      updateOne,
    });
    mockReconcileConfigDrivenMcpServerRelationships.mockRejectedValueOnce(
      new Error("OpenFGA reconcile failed"),
    );
    const { POST } = await import("../sync/route");

    await expect(
      POST(
        request("/api/mcp-servers/agentgateway/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      ),
    ).rejects.toThrow("OpenFGA reconcile failed");

    expect(insertOne).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("denies admin sync when OpenFGA denies the AgentGateway object grant", async () => {
    const insertOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
      insertOne,
    });
    mockRequireResourcePermission.mockRejectedValue(new Error("no manage"));
    const { POST } = await import("../sync/route");

    await expect(
      POST(
        request("/api/mcp-servers/agentgateway/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      ),
    ).rejects.toThrow("no manage");
    expect(insertOne).not.toHaveBeenCalled();
  });

  it("validates selected target ids after the manage gate when ids are provided", async () => {
    const { POST } = await import("../sync/route");

    await expect(
      POST(
        request("/api/mcp-servers/agentgateway/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: ["rag", 123] }),
        }),
      ),
    ).rejects.toThrow("ids must be an array");

    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "admin-sub", role: "admin" },
      { type: "mcp_server", id: "agentgateway", action: "admin" },
    );
  });
});
