/**
 * @jest-environment node
 *
 * Regression coverage for the saved MCP tool test endpoint.
 */

// assisted-by Codex Codex-sonnet-4-6

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockGetCollection = jest.fn();
const mockGetCredentialRetrievalService = jest.fn();
const mockGetProviderConnectionService = jest.fn();
const mockRetrieve = jest.fn();
const mockRefreshConnection = jest.fn();
const mockListConnections = jest.fn();
const mockIsCredentialFeatureEnabled = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();

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
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T,>(handler: (request: NextRequest) => Promise<T>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (err) {
          const e = err as { status?: number; message: string; code?: string };
          return Response.json(
            { success: false, error: e.message, code: e.code },
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
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

jest.mock("@/lib/credentials/retrieval-service-factory", () => ({
  getCredentialRetrievalService: (...args: unknown[]) => mockGetCredentialRetrievalService(...args),
}));

jest.mock("@/lib/credentials/oauth-service-factory", () => ({
  getProviderConnectionService: (...args: unknown[]) => mockGetProviderConnectionService(...args),
}));

jest.mock("@/lib/feature-flags/credentials", () => ({
  isCredentialFeatureEnabled: (...args: unknown[]) => mockIsCredentialFeatureEnabled(...args),
}));

function request(body: Record<string, unknown>, headers?: HeadersInit): NextRequest {
  return new NextRequest(new URL("/api/mcp-servers/test-tool", "http://localhost:3000"), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const session = {
  sub: "user-sub",
  role: "admin",
  accessToken: "user-keycloak-token",
};

describe("POST /api/mcp-servers/test-tool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENT_GATEWAY_URL = "http://agentgateway:4000";
    process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = "test-agent-context-secret";
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session });
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockGetCredentialRetrievalService.mockResolvedValue({ retrieve: mockRetrieve });
    mockGetProviderConnectionService.mockResolvedValue({
      listConnections: mockListConnections,
      getConnection: jest.fn(),
      refreshConnection: mockRefreshConnection,
    });
    mockIsCredentialFeatureEnabled.mockReturnValue(true);
    mockListConnections.mockResolvedValue([]);
    mockRetrieve.mockResolvedValue({ credential: "argocd-provider-token" });
    mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 2, deletes: 0 });
  });

  afterEach(() => {
    delete process.env.AGENT_GATEWAY_URL;
    delete process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET;
  });

  it("sends user auth to AgentGateway and provider auth as X-CAIPE-Provider-Token", async () => {
    const findOne = jest.fn().mockResolvedValue({
      _id: "mcp-test-argocd",
      name: "Test ArgoCD",
      transport: "http",
      endpoint: "http://agentgateway:4000/mcp/mcp-test-argocd",
      source: "agentgateway",
      enabled: true,
      credential_sources: [
        {
          kind: "secret_ref",
          target: "header",
          name: "Authorization",
          secret_ref: "cred-argocd",
        },
      ],
    });
    mockGetCollection.mockResolvedValue({ findOne });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: "initialize-1", result: {} }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "mcp-session-1",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "tools-call-1",
            result: { content: [{ type: "text", text: "v1.2.3" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ) as unknown as typeof fetch;

    const { POST } = await import("../route");

    const response = await POST(
      request({ serverId: "mcp-test-argocd", toolName: "version", params: {} }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.success).toBe(true);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(session, {
      type: "mcp_server",
      id: "mcp-test-argocd",
      action: "invoke",
    });
    expect(mockRetrieve).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { secret_ref: "cred-argocd", intended_use: "mcp_server" },
      session,
    });

    const initializeHeaders = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    const invokeHeaders = (global.fetch as jest.Mock).mock.calls[1][1].headers;

    expect(initializeHeaders.Authorization).toBe("Bearer user-keycloak-token");
    expect(initializeHeaders["X-CAIPE-Provider-Token"]).toBe("argocd-provider-token");
    expect(initializeHeaders["X-CAIPE-Agent-Context"]).toEqual(expect.any(String));
    expect(initializeHeaders["X-CAIPE-Agent-Context-Signature"]).toEqual(expect.any(String));
    expect(invokeHeaders.Authorization).toBe("Bearer user-keycloak-token");
    expect(invokeHeaders["X-CAIPE-Provider-Token"]).toBe("argocd-provider-token");
    expect(invokeHeaders["X-CAIPE-Agent-Context"]).toBe(initializeHeaders["X-CAIPE-Agent-Context"]);
    expect(invokeHeaders["X-CAIPE-Agent-Context-Signature"]).toBe(
      initializeHeaders["X-CAIPE-Agent-Context-Signature"],
    );
    expect(invokeHeaders["mcp-session-id"]).toBe("mcp-session-1");
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [
        expect.objectContaining({ user: "user:user-sub", relation: "user" }),
        expect.objectContaining({
          user: expect.stringMatching(/^agent:mcp-test-mcp-test-argocd-/),
          relation: "caller",
          object: "tool:mcp-test-argocd/*",
        }),
      ],
      deletes: [],
    });
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [],
      deletes: [
        expect.objectContaining({ user: "user:user-sub", relation: "user" }),
        expect.objectContaining({
          user: expect.stringMatching(/^agent:mcp-test-mcp-test-argocd-/),
          relation: "caller",
          object: "tool:mcp-test-argocd/*",
        }),
      ],
    });
  });

  it("retries tool invocation while a new AgentGateway route is reconciling", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "example-weather",
        name: "Example Weather",
        transport: "http",
        endpoint: "http://agentgateway:4000/mcp/example-weather",
        source: "agentgateway",
        enabled: true,
        credential_sources: [],
      }),
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response("route not found", {
          status: 404,
          headers: { "content-type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: "initialize-2", result: {} }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "mcp-session-2",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "tools-call-1",
            result: { content: [{ type: "text", text: "sunny" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ) as unknown as typeof fetch;

    const { POST } = await import("../route");
    const response = await POST(
      request({ serverId: "example-weather", toolName: "forecast", params: {} }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).method).toBe("initialize");
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body).method).toBe("initialize");
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[2][1].body).method).toBe("tools/call");
  });

  it("strips an accidental Bearer prefix before forwarding provider credentials through AgentGateway", async () => {
    mockRetrieve.mockResolvedValue({ credential: "Bearer argocd-provider-token" });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "mcp-test-argocd",
        name: "Test ArgoCD",
        transport: "http",
        endpoint: "http://agentgateway:4000/mcp/mcp-test-argocd",
        source: "agentgateway",
        enabled: true,
        credential_sources: [
          {
            kind: "secret_ref",
            target: "header",
            name: "X-CAIPE-Token",
            secret_ref: "cred-argocd",
          },
        ],
      }),
    });
    global.fetch = jest.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: "ok", result: {} }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "mcp-session-1",
          },
        }),
    ) as unknown as typeof fetch;

    const { POST } = await import("../route");

    const response = await POST(
      request({ serverId: "mcp-test-argocd", toolName: "version", params: {} }),
    );

    expect(response.status).toBe(200);
    const initializeHeaders = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(initializeHeaders.Authorization).toBe("Bearer user-keycloak-token");
    expect(initializeHeaders["X-CAIPE-Provider-Token"]).toBe("argocd-provider-token");
  });

  it("forwards Atlassian provider_connection tokens for AgentGateway Jira tests", async () => {
    mockListConnections.mockResolvedValue([
      {
        id: "atlassian-conn-1",
        provider: "atlassian",
        status: "connected",
        owner: { type: "user", id: "user-sub" },
      },
    ]);
    mockRefreshConnection.mockResolvedValue({ accessToken: "atlassian-user-token", expiresIn: 3600 });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "jira",
        name: "Jira",
        transport: "http",
        endpoint: "http://agentgateway:4000/mcp/jira",
        source: "agentgateway",
        enabled: true,
        credential_sources: [
          {
            kind: "provider_connection",
            target: "header",
            name: "X-CAIPE-Provider-Token",
            provider: "atlassian",
          },
        ],
      }),
    });

    global.fetch = jest.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "tools-call-1",
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ success: false, error: "Failed to fetch Jira issue" }),
                },
              ],
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "mcp-session-1",
            },
          },
        ),
    ) as unknown as typeof fetch;

    const { POST } = await import("../route");

    const response = await POST(
      request({ serverId: "jira", toolName: "get_issue", params: { issue_key: "SRE-1000" } }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.success).toBe(true);
    expect(body.data.application_success).toBe(false);
    expect(body.data.credential_resolution).toEqual([
      expect.objectContaining({ origin: "provider_connection", provider: "atlassian" }),
    ]);

    const initializeHeaders = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(initializeHeaders["X-CAIPE-Provider-Token"]).toBe("atlassian-user-token");
  });

  it("forwards only caller Authorization when credential_sources is empty", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "jira",
        name: "Jira",
        transport: "http",
        endpoint: "http://agentgateway:4000/mcp/jira",
        source: "agentgateway",
        enabled: true,
        credential_sources: [],
      }),
    });

    global.fetch = jest.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "tools-call-1",
            result: { content: [{ type: "text", text: "account-123" }] },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "mcp-session-1",
            },
          },
        ),
    ) as unknown as typeof fetch;

    const { POST } = await import("../route");

    const response = await POST(
      request({ serverId: "jira", toolName: "get_current_user_account_id", params: {} }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.credential_resolution).toEqual([]);
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockRefreshConnection).not.toHaveBeenCalled();

    const initializeHeaders = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(initializeHeaders.Authorization).toBe("Bearer user-keycloak-token");
    expect(initializeHeaders["X-CAIPE-Provider-Token"]).toBeUndefined();
  });
});
