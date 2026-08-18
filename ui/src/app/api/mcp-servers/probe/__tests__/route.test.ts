/**
 * @jest-environment node
 *
 * Probe button regression suite.
 *
 * The Create Agent → Tools step Probe button hits this BFF route to list
 * the tools advertised by a configured MCP server. Earlier revisions gated
 * it on OpenFGA ``mcp_server:<id>#can_invoke``, but invocation rights are a
 * strict superset of "can I see what tools exist" — and team members who
 * have a server *shared* with them (read/use, not invoke) were getting
 * 403s on the Probe button despite legitimately needing to render the
 * picker.
 *
 * The new contract:
 *   Probing requires ``mcp_server:<id>#can_discover``. The authorization
 *   model already grants ``can_discover`` to ``organization#member`` and
 *   to anyone the server is shared with via team/channel/group tuples,
 *   while ``organization#admin`` keeps the override via ``can_manage``.
 *   Runtime tool invocation continues to enforce ``can_invoke`` on the
 *   agent execution path; this route only enumerates tool metadata.
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockGetCollection = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockBuildBackendHeaders = jest.fn();
const mockCacheMcpToolCatalog = jest.fn();

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
}));

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  buildBackendHeaders: (...args: unknown[]) => mockBuildBackendHeaders(...args),
}));

jest.mock("@/lib/rbac/mcp-tool-catalog", () => ({
  cacheMcpToolCatalog: (...args: unknown[]) => mockCacheMcpToolCatalog(...args),
}));

function request(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

const session = { sub: "test-user", role: "user", accessToken: "caller-token" };

describe("POST /api/mcp-servers/probe", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET;
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session });
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "argocd",
        name: "Argocd",
        enabled: true,
      }),
    });
    mockAuthenticateRequest.mockResolvedValue({
      subject: "test-user",
      email: "test-user@example.com",
      role: "user",
      bearerToken: "token",
    });
    mockBuildBackendHeaders.mockReturnValue({
      "Content-Type": "application/json",
      Authorization: "Bearer token",
    });
    mockCacheMcpToolCatalog.mockResolvedValue(1);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, tools: [{ name: "ls", description: "list" }] }),
    }) as unknown as typeof fetch;
  });

  it("gates probe with mcp_server#can_discover (not can_invoke) so team-shared and org-member users can render tool lists", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers/probe?id=argocd", { method: "POST" }),
    );

    expect(response.status).toBe(200);
    // The new contract: probing requires discover, not invoke.
    expect(mockRequireResourcePermission).toHaveBeenCalledTimes(1);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(session, {
      type: "mcp_server",
      id: "argocd",
      action: "discover",
    });
    // Sanity: we never sneak in an extra can_invoke check on the probe path.
    for (const call of mockRequireResourcePermission.mock.calls) {
      expect(call[1]).not.toMatchObject({ action: "invoke" });
    }
  });

  it("caches discovered tools after a successful probe", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers/probe?id=argocd", { method: "POST" }),
    );

    expect(response.status).toBe(200);
    expect(mockCacheMcpToolCatalog).toHaveBeenCalledWith({
      serverId: "argocd",
      source: "probe",
      tools: [{ name: "ls", description: "list" }],
    });
  });

  it("lists tools directly from HTTP MCP endpoints and caches the propagated tools", async () => {
    mockGetCollection.mockResolvedValueOnce({
      findOne: jest.fn().mockResolvedValue({
        _id: "mcp-argocd",
        name: "ArgoCD",
        transport: "http",
        endpoint: "http://mcp-argocd:8000/mcp",
        enabled: true,
      }),
    });
    global.fetch = jest.fn().mockResolvedValue(
      Response.json({
        jsonrpc: "2.0",
        id: "tools-list",
        result: {
          tools: [
            {
              name: "argocd_list_apps",
              description: "List ArgoCD applications",
            },
          ],
        },
      }),
    ) as unknown as typeof fetch;
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers/probe?id=mcp-argocd", { method: "POST" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://mcp-argocd:8000/mcp",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"method":"tools/list"'),
      }),
    );
    expect(mockBuildBackendHeaders).not.toHaveBeenCalled();
    expect(mockCacheMcpToolCatalog).toHaveBeenCalledWith({
      serverId: "mcp-argocd",
      source: "probe",
      tools: [
        expect.objectContaining({
          name: "argocd_list_apps",
          namespaced_name: "argocd_list_apps",
          description: "List ArgoCD applications",
        }),
      ],
    });
    expect(body.data).toMatchObject({
      server_id: "mcp-argocd",
      success: true,
      source: "direct",
      tools: [
        {
          name: "argocd_list_apps",
          namespaced_name: "argocd_list_apps",
        },
      ],
    });
  });

  it("only lists tools and never invokes one during discovery", async () => {
    mockGetCollection.mockResolvedValueOnce({
      findOne: jest.fn().mockResolvedValue({
        _id: "mcp-netutils",
        name: "Netutils",
        transport: "http",
        endpoint: "http://mcp-netutils:8000/mcp",
        enabled: true,
      }),
    });
    global.fetch = jest.fn().mockResolvedValueOnce(
      Response.json({
        jsonrpc: "2.0",
        id: "tools-list",
        result: {
          tools: [
            {
              name: "version",
              description: "Return server version",
              inputSchema: { type: "object", properties: {}, required: [] },
            },
          ],
        },
      }),
    ) as unknown as typeof fetch;
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers/probe?id=mcp-netutils", { method: "POST" }),
    );
    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String((global.fetch as jest.Mock).mock.calls[0][1].body)).toContain('"method":"tools/list"');
    expect(String((global.fetch as jest.Mock).mock.calls[0][1].body)).not.toContain('"method":"tools/call"');
  });

  it("discovers managed tools through AgentGateway without calling the upstream endpoint", async () => {
    process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = "internal-test-secret";
    mockGetCollection.mockResolvedValueOnce({
      findOne: jest.fn().mockResolvedValue({
        _id: "mcp-example",
        name: "Example",
        transport: "http",
        endpoint: "http://agentgateway:4000/mcp/mcp-example",
        agentgateway_target_endpoint: "https://example.test/mcp",
        source: "agentgateway",
        agentgateway_discovered: true,
        enabled: true,
      }),
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            jsonrpc: "2.0",
            id: "initialize",
            result: { protocolVersion: "2024-11-05", capabilities: {} },
          },
          { headers: { "mcp-session-id": "session-123" } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          jsonrpc: "2.0",
          id: "tools-list",
          result: { tools: [{ name: "example_search", description: "Search" }] },
        }),
      ) as unknown as typeof fetch;
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers/probe?id=mcp-example", { method: "POST" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "http://agentgateway:4000/mcp/mcp-example",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer caller-token",
          "X-CAIPE-Agent-Context": expect.anything(),
          "X-CAIPE-Agent-Context-Signature": expect.anything(),
        }),
        body: expect.stringContaining('"method":"initialize"'),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://agentgateway:4000/mcp/mcp-example",
      expect.objectContaining({
        headers: expect.objectContaining({ "mcp-session-id": "session-123" }),
        body: expect.stringContaining('"method":"tools/list"'),
      }),
    );
    expect(global.fetch).not.toHaveBeenCalledWith("https://example.test/mcp", expect.anything());
    for (const call of (global.fetch as jest.Mock).mock.calls) {
      expect(String(call[1].body)).not.toContain('"method":"tools/call"');
    }
    expect(body.data).toMatchObject({
      server_id: "mcp-example",
      success: true,
      source: "agentgateway",
      tools: [{ name: "example_search" }],
    });
  });

  it("fails closed when a managed server does not contain an AgentGateway route", async () => {
    mockGetCollection.mockResolvedValueOnce({
      findOne: jest.fn().mockResolvedValue({
        _id: "mcp-example",
        name: "Example",
        transport: "http",
        endpoint: "https://example.test/mcp",
        agentgateway_target_endpoint: "https://example.test/mcp",
        source: "agentgateway",
        enabled: true,
      }),
    });
    global.fetch = jest.fn() as unknown as typeof fetch;
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers/probe?id=mcp-example", { method: "POST" }),
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toMatch(/missing its Gateway route/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("initializes Streamable HTTP MCP sessions before listing tools when required", async () => {
    mockGetCollection.mockResolvedValueOnce({
      findOne: jest.fn().mockResolvedValue({
        _id: "mcp-argocd",
        name: "ArgoCD",
        transport: "http",
        endpoint: "http://mcp-argocd:8000/mcp",
        enabled: true,
      }),
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { jsonrpc: "2.0", id: "server-error", error: { code: -32600, message: "Missing session ID" } },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":"init","result":{"protocolVersion":"2024-11-05"}}\n\n',
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "mcp-session-id": "session-123",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":"tools","result":{"tools":[{"name":"argocd_get_app","description":"Get an app"}]}}\n\n',
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "mcp-session-id": "session-123",
            },
          },
        ),
      ) as unknown as typeof fetch;
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers/probe?id=mcp-argocd", { method: "POST" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://mcp-argocd:8000/mcp",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"method":"initialize"'),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "http://mcp-argocd:8000/mcp",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "mcp-session-id": "session-123" }),
        body: expect.stringContaining('"method":"tools/list"'),
      }),
    );
    expect(mockBuildBackendHeaders).not.toHaveBeenCalled();
    expect(body.data).toMatchObject({
      success: true,
      source: "direct",
      tools: [{ name: "argocd_get_app", namespaced_name: "argocd_get_app" }],
    });
  });

  it("falls back to dynamic-agents probe when direct HTTP tools/list does not return tools", async () => {
    mockGetCollection.mockResolvedValueOnce({
      findOne: jest.fn().mockResolvedValue({
        _id: "mcp-netutils",
        name: "Netutils",
        transport: "http",
        endpoint: "http://mcp-netutils:8000/mcp",
        enabled: true,
      }),
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", result: {} }))
      .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", result: {} }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          tools: [{ name: "netutils_ping", description: "Ping a host" }],
        }),
      ) as unknown as typeof fetch;
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers/probe?id=mcp-netutils", { method: "POST" }),
    );

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "http://mcp-netutils:8000/mcp",
      expect.objectContaining({ method: "POST" }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://mcp-netutils:8000/mcp",
      expect.objectContaining({ method: "POST" }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "http://localhost:8100/api/v1/mcp-servers/mcp-netutils/probe",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockBuildBackendHeaders).toHaveBeenCalled();
    expect(mockCacheMcpToolCatalog).toHaveBeenLastCalledWith({
      serverId: "mcp-netutils",
      source: "probe",
      tools: [{ name: "netutils_ping", description: "Ping a host" }],
    });
  });

  it("returns 403 when OpenFGA denies can_discover on the server", async () => {
    mockRequireResourcePermission.mockRejectedValueOnce(
      Object.assign(new Error("not allowed"), {
        status: 403,
        statusCode: 403,
        code: "mcp_server#discover",
      }),
    );
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/mcp-servers/probe?id=argocd", { method: "POST" }),
    );

    expect(response.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
