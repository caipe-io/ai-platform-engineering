/**
 * @jest-environment node
 *
 * Save-side endpoint normalisation regression.
 *
 * Background: every MCP server routed through AgentGateway must be
 * stored with a target-qualified endpoint
 * (`http://agentgateway:4000/mcp/<server_id>`). A bare
 * `http://agentgateway:4000/mcp` falls through to AgentGateway's `/mcp`
 * route, which is not registered, and returns 404 on every probe and
 * tool call. The class of bug surfaced in production as
 *   "Failed to connect to MCP server: HTTP 404 Not Found from
 *    http://agentgateway:4000/mcp"
 * on the Confluence card.
 *
 * The fix is server-side normalisation on save (POST + PUT) so this
 * class of misconfiguration can never persist again, plus a Python-side
 * read-time normaliser in dynamic-agents (defence in depth for legacy
 * rows). This suite pins the save-side half.
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockReconcileMcpServerRelationships = jest.fn();
const mockDeleteAllMcpServerRelationshipTuples = jest.fn();

const mockInsertOne = jest.fn();
const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockGetCollection = jest.fn();

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
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) =>
      Response.json({ success: true, data }, { status }),
    paginatedResponse: (items: unknown, total: number) =>
      Response.json({ success: true, data: { items, total } }),
    getPaginationParams: () => ({ page: 1, pageSize: 50, skip: 0 }),
    withErrorHandler:
      <T,>(handler: (request: NextRequest) => Promise<T>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (err) {
          const e = err as { status?: number; message: string };
          return Response.json(
            { success: false, error: e.message },
            { status: e.status ?? 500 },
          );
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
  filterResourcesByPermission: (...args: unknown[]) =>
    mockFilterResourcesByPermission(...args),
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileMcpServerRelationships: (...args: unknown[]) =>
    mockReconcileMcpServerRelationships(...args),
  deleteAllMcpServerRelationshipTuples: (...args: unknown[]) =>
    mockDeleteAllMcpServerRelationshipTuples(...args),
}));

function request(path: string, init: RequestInit & { body: string }): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

const session = { sub: "test-user", role: "admin" };
const user = { email: "test-user@example.com", sub: "test-user" };

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  // Force a stable AgentGateway base for these tests. The normaliser
  // reads this via agentGatewayMcpEndpointUrl(), which is also exercised
  // by other test suites — set it here so test order doesn't matter.
  process.env.AGENT_GATEWAY_URL = "http://agentgateway:4000";
  process.env.PRIVATE_RESOURCES_ENABLED = "true";

  mockGetAuthFromBearerOrSession.mockResolvedValue({ session, user });
  mockRequireResourcePermission.mockResolvedValue(undefined);
  mockReconcileMcpServerRelationships.mockResolvedValue(undefined);
  mockDeleteAllMcpServerRelationshipTuples.mockResolvedValue(undefined);

  mockGetCollection.mockResolvedValue({
    insertOne: mockInsertOne,
    findOne: mockFindOne,
    findOneAndUpdate: mockFindOneAndUpdate,
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    countDocuments: jest.fn().mockResolvedValue(0),
  });
});

describe("POST /api/mcp-servers — endpoint normalisation", () => {
  it("rewrites a bare AgentGateway endpoint to /mcp/<server_id> on create", async () => {
    mockFindOne.mockResolvedValue(null);
    mockInsertOne.mockResolvedValue({ acknowledged: true });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          id: "confluence",
          name: "Confluence",
          transport: "http",
          // The exact bad input we see in production:
          endpoint: "http://agentgateway:4000/mcp",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockInsertOne).toHaveBeenCalledTimes(1);
    const persisted = mockInsertOne.mock.calls[0][0];
    // Normaliser must repair to the target-qualified URL.
    expect(persisted.endpoint).toBe(
      "http://agentgateway:4000/mcp/mcp-confluence",
    );
    expect(persisted._id).toBe("mcp-confluence");
  });

  it("stores a direct upstream endpoint behind an AgentGateway route on create", async () => {
    mockFindOne.mockResolvedValue(null);
    mockInsertOne.mockResolvedValue({ acknowledged: true });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          id: "custom-thing",
          name: "Custom Thing",
          transport: "http",
          endpoint: "https://mcp.example.com/mcp",
        }),
      }),
    );

    expect(response.status).toBe(201);
    const persisted = mockInsertOne.mock.calls[0][0];
    expect(persisted.endpoint).toBe("http://agentgateway:4000/mcp/mcp-custom-thing");
    expect(persisted.agentgateway_target_endpoint).toBe("https://mcp.example.com/mcp");
    expect(persisted.source).toBe("agentgateway");
  });

  it("adds /mcp to direct HTTP upstream origins and stores the route on create", async () => {
    mockFindOne.mockResolvedValue(null);
    mockInsertOne.mockResolvedValue({ acknowledged: true });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          id: "test-argocd",
          name: "test-argocd",
          transport: "http",
          endpoint: "http://mcp-argocd:8000",
        }),
      }),
    );

    expect(response.status).toBe(201);
    const persisted = mockInsertOne.mock.calls[0][0];
    expect(persisted.endpoint).toBe("http://agentgateway:4000/mcp/mcp-test-argocd");
    expect(persisted.agentgateway_target_endpoint).toBe("http://mcp-argocd:8000/mcp");
  });

  it("persists upstream when an AgentGateway picker target is selected for a new server id", async () => {
    mockFindOne.mockResolvedValue(null);
    mockInsertOne.mockResolvedValue({ acknowledged: true });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          id: "jira-gu",
          name: "JIRA_GU",
          transport: "http",
          endpoint: "http://agentgateway:4000/mcp/jira",
          agentgateway_target_endpoint: "http://mcp-jira:8000/mcp",
        }),
      }),
    );

    expect(response.status).toBe(201);
    const persisted = mockInsertOne.mock.calls[0][0];
    expect(persisted.endpoint).toBe("http://agentgateway:4000/mcp/mcp-jira-gu");
    expect(persisted.agentgateway_target_endpoint).toBe("http://mcp-jira:8000/mcp");
    expect(persisted.source).toBe("agentgateway");
  });

  it("stores Authorization saved secrets as provider-token gateway headers", async () => {
    mockFindOne.mockResolvedValue(null);
    mockInsertOne.mockResolvedValue({ acknowledged: true });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          id: "test-argocd",
          name: "test-argocd",
          transport: "http",
          endpoint: "http://mcp-argocd:8000/mcp",
          credential_sources: [
            {
              kind: "secret_ref",
              target: "header",
              name: "Authorization",
              secret_ref: "secret-argocd",
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(201);
    const persisted = mockInsertOne.mock.calls[0][0];
    expect(persisted.credential_sources).toEqual([
      {
        kind: "secret_ref",
        target: "header",
        name: "X-CAIPE-Provider-Token",
        secret_ref: "secret-argocd",
      },
    ]);
  });
});

describe("PUT /api/mcp-servers?id=<id> — endpoint normalisation", () => {
  it("keeps an unclassified legacy server global when it is edited", async () => {
    const existing = {
      _id: "mcp-legacy",
      name: "Legacy",
      transport: "stdio",
      command: "example-command",
      config_driven: false,
      owner_subject: "test-user",
    };
    mockFindOne.mockResolvedValue(existing);
    mockFindOneAndUpdate.mockImplementation(async (_filter, update) => ({
      ...existing,
      ...(update as { $set: Record<string, unknown> }).$set,
    }));
    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/mcp-servers?id=mcp-legacy", {
        method: "PUT",
        body: JSON.stringify({ name: "Legacy renamed" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileMcpServerRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "mcp-legacy",
        ownerSubject: "test-user",
        personalOwnerAccess: false,
        previousPersonalOwnerAccess: true,
        globalOrganizationAccess: true,
        previousGlobalOrganizationAccess: true,
      }),
      expect.any(Object),
    );
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: "mcp-legacy" },
      expect.objectContaining({
        $set: expect.objectContaining({ visibility: "global" }),
        $unset: expect.objectContaining({ owner_subject: "" }),
      }),
      { returnDocument: "after" },
    );
  });

  it("repairs a stale bare gateway endpoint when an admin re-saves the row", async () => {
    // Existing legacy row in Mongo with the broken bare endpoint.
    const existing = {
      _id: "mcp-confluence",
      name: "Confluence",
      transport: "http",
      endpoint: "http://agentgateway:4000/mcp",
      config_driven: false,
      visibility: "private",
      owner_subject: "test-user",
    };
    mockFindOne.mockResolvedValue(existing);
    mockFindOneAndUpdate.mockImplementation(async (_filter, update) => ({
      ...existing,
      ...(update as { $set: Record<string, unknown> }).$set,
    }));
    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/mcp-servers?id=mcp-confluence", {
        method: "PUT",
        body: JSON.stringify({
          // Admin re-submits the same value (or any string).
          endpoint: "http://agentgateway:4000/mcp",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const updatePayload = mockFindOneAndUpdate.mock.calls[0][1] as {
      $set: { endpoint: string };
    };
    expect(updatePayload.$set.endpoint).toBe("http://agentgateway:4000/mcp/mcp-confluence");
    expect(updatePayload.$set.agentgateway_target_endpoint).toBeUndefined();
    expect(updatePayload.$set.source).toBe("agentgateway");
  });

  it("does not touch the endpoint when the admin updates other fields", async () => {
    const existing = {
      _id: "mcp-jira",
      name: "Jira",
      transport: "http",
      endpoint: "http://agentgateway:4000/mcp/mcp-jira",
      config_driven: false,
      visibility: "private",
      owner_subject: "test-user",
    };
    mockFindOne.mockResolvedValue(existing);
    mockFindOneAndUpdate.mockImplementation(async (_filter, update) => ({
      ...existing,
      ...(update as { $set: Record<string, unknown> }).$set,
    }));
    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/mcp-servers?id=mcp-jira", {
        method: "PUT",
        body: JSON.stringify({ name: "Jira (renamed)" }),
      }),
    );

    expect(response.status).toBe(200);
    const updatePayload = mockFindOneAndUpdate.mock.calls[0][1] as {
      $set: Record<string, unknown>;
    };
    // Network MCP rows are kept on the AgentGateway path whenever they are saved.
    expect(updatePayload.$set.endpoint).toBe("http://agentgateway:4000/mcp/mcp-jira");
    expect(updatePayload.$set.name).toBe("Jira (renamed)");
  });

  it("repairs a wrong-id suffix (e.g. after a server rename)", async () => {
    const existing = {
      _id: "mcp-confluence",
      name: "Confluence",
      transport: "http",
      endpoint: "http://agentgateway:4000/mcp/atlassian-confluence",
      config_driven: false,
      visibility: "private",
      owner_subject: "test-user",
    };
    mockFindOne.mockResolvedValue(existing);
    mockFindOneAndUpdate.mockImplementation(async (_filter, update) => ({
      ...existing,
      ...(update as { $set: Record<string, unknown> }).$set,
    }));
    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/mcp-servers?id=mcp-confluence", {
        method: "PUT",
        body: JSON.stringify({
          endpoint: "http://agentgateway:4000/mcp/atlassian-confluence",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const updatePayload = mockFindOneAndUpdate.mock.calls[0][1] as {
      $set: { endpoint: string };
    };
    expect(updatePayload.$set.endpoint).toBe("http://agentgateway:4000/mcp/mcp-confluence");
  });
});
