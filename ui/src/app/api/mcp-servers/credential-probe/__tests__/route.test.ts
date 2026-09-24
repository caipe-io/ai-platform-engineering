/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockResolveMcpHeaderCredentials = jest.fn();
const mockIsAgentGatewayEndpoint = jest.fn();
const mockListHttpMcpTools = jest.fn();
const mockGetCollection = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    status: number;
    code?: string;

    constructor(message: string, status = 500, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) =>
      Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T,>(handler: (request: NextRequest) => Promise<T>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (error) {
          const typed = error as { status?: number; message: string };
          return Response.json(
            { success: false, error: typed.message },
            { status: typed.status ?? 500 },
          );
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/mcp-credential-headers", () => ({
  isMcpCredentialUnavailableError: () => false,
  resolveMcpHeaderCredentials: (...args: unknown[]) =>
    mockResolveMcpHeaderCredentials(...args),
}));

jest.mock("@/lib/mcp-http-server-client", () => ({
  isAgentGatewayEndpoint: (...args: unknown[]) => mockIsAgentGatewayEndpoint(...args),
  listHttpMcpTools: (...args: unknown[]) => mockListHttpMcpTools(...args),
}));

const savedServer = {
  _id: "mcp-example",
  name: "Example",
  endpoint: "http://agentgateway:4000/mcp/mcp-example",
  agentgateway_target_endpoint: "https://upstream.example.test/mcp",
  source: "agentgateway" as const,
  transport: "http" as const,
  credential_sources: [],
  enabled: true,
  created_at: "2026-08-15T00:00:00.000Z",
  updated_at: "2026-08-15T00:00:00.000Z",
};

function request(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/mcp-servers/credential-probe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      server_id: "mcp-example",
      // A client-supplied URL must never select the probe destination.
      url: "https://untrusted.example.test/mcp",
      credential_sources: [
        {
          kind: "provider_connection",
          target: "header",
          name: "X-CAIPE-Provider-Token",
          provider: "example",
        },
      ],
      ...body,
    }),
  });
}

describe("POST /api/mcp-servers/credential-probe", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      session: { sub: "test-user", accessToken: "caller-token" },
    });
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(savedServer),
    });
    mockIsAgentGatewayEndpoint.mockReturnValue(true);
    mockResolveMcpHeaderCredentials.mockResolvedValue({
      headers: {
        Authorization: "Bearer caller-token",
        "X-CAIPE-Provider-Token": "provider-token",
      },
      sources: [
        {
          name: "X-CAIPE-Provider-Token",
          kind: "provider_connection",
          origin: "provider_connection",
          provider: "example",
        },
      ],
    });
    mockListHttpMcpTools.mockResolvedValue({
      tools: [{ name: "example_search", namespaced_name: "example_search" }],
      sessionId: "session-123",
    });
  });

  it("tests the saved server through its AgentGateway route", async () => {
    const { POST } = await import("../route");

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ ok: true, status: 200, missingCredentials: [] });
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "test-user", accessToken: "caller-token" },
      { type: "mcp_server", id: "mcp-example", action: "manage" },
    );
    expect(mockResolveMcpHeaderCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        viaAgentGateway: true,
        server: expect.objectContaining({
          endpoint: "http://agentgateway:4000/mcp/mcp-example",
          agentgateway_target_endpoint: "https://upstream.example.test/mcp",
          credential_sources: [expect.objectContaining({ provider: "example" })],
        }),
      }),
    );
    expect(mockListHttpMcpTools).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "mcp-example",
        server: expect.objectContaining({
          endpoint: "http://agentgateway:4000/mcp/mcp-example",
        }),
        credentialResolution: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer caller-token" }),
        }),
      }),
    );
  });

  it("requires the server to be saved before testing", async () => {
    const { POST } = await import("../route");

    const response = await POST(request({ server_id: "" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/save the MCP server/i);
    expect(mockGetCollection).not.toHaveBeenCalled();
    expect(mockListHttpMcpTools).not.toHaveBeenCalled();
  });

  it("rejects a saved HTTP server that has no AgentGateway route", async () => {
    mockIsAgentGatewayEndpoint.mockReturnValue(false);
    const { POST } = await import("../route");

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/registered AgentGateway route/i);
    expect(mockResolveMcpHeaderCredentials).not.toHaveBeenCalled();
    expect(mockListHttpMcpTools).not.toHaveBeenCalled();
  });

  it("does not contact AgentGateway when a credential is unresolved", async () => {
    mockResolveMcpHeaderCredentials.mockResolvedValue({
      headers: { Authorization: "Bearer caller-token" },
      sources: [
        {
          name: "X-CAIPE-Provider-Token",
          kind: "provider_connection",
          origin: "none",
          provider: "example",
        },
      ],
    });
    const { POST } = await import("../route");

    const response = await POST(request());
    const body = await response.json();

    expect(body.data).toMatchObject({
      ok: false,
      missingCredentials: ["X-CAIPE-Provider-Token"],
    });
    expect(mockListHttpMcpTools).not.toHaveBeenCalled();
  });
});
