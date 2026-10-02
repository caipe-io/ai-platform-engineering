jest.mock("@/lib/api-middleware", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public statusCode: number = 500,
      public code?: string,
    ) {
      super(message);
    }
  },
}));

jest.mock("@/lib/mcp-credential-headers", () => ({
  resolveMcpHeaderCredentials: jest.fn(),
}));

import { listHttpMcpTools } from "@/lib/mcp-http-server-client";

function response(input: {
  status: number;
  body: unknown;
  sessionId?: string;
}): Response {
  return {
    ok: input.status >= 200 && input.status < 300,
    status: input.status,
    headers: new Headers({
      "content-type": typeof input.body === "string" ? "text/plain" : "application/json",
      ...(input.sessionId ? { "mcp-session-id": input.sessionId } : {}),
    }),
    json: async () => input.body,
    text: async () => typeof input.body === "string" ? input.body : JSON.stringify(input.body),
  } as Response;
}

describe("listHttpMcpTools", () => {
  const originalFetch = global.fetch;
  const originalGatewayUrl = process.env.AGENT_GATEWAY_URL;

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.AGENT_GATEWAY_URL = originalGatewayUrl;
    jest.restoreAllMocks();
  });

  it("retries a transient AgentGateway route-registration 404", async () => {
    process.env.AGENT_GATEWAY_URL = "http://gateway:4000";
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response({ status: 404, body: "route not found" }))
      .mockResolvedValueOnce(response({
        status: 200,
        sessionId: "session-1",
        body: { jsonrpc: "2.0", id: "initialize", result: { protocolVersion: "2024-11-05" } },
      }))
      .mockResolvedValueOnce(response({
        status: 200,
        sessionId: "session-1",
        body: {
          jsonrpc: "2.0",
          id: "tools-list",
          result: { tools: [{ name: "echo", description: "Harmless test tool" }] },
        },
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await listHttpMcpTools({
      request: {} as never,
      session: { sub: "test-user" },
      server: {
        _id: "example",
        name: "Example",
        transport: "http",
        endpoint: "http://gateway:4000/mcp/example",
        enabled: true,
        source: "agentgateway",
      } as never,
      serverId: "example",
      credentialResolution: {
        headers: { Authorization: "Bearer test-token" },
        sources: [],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.tools).toEqual([
      expect.objectContaining({ name: "echo", namespaced_name: "echo" }),
    ]);
  });

  it("does not retry an AgentGateway authorization denial", async () => {
    process.env.AGENT_GATEWAY_URL = "http://gateway:4000";
    const fetchMock = jest.fn().mockResolvedValue(
      response({ status: 403, body: "forbidden" }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(listHttpMcpTools({
      request: {} as never,
      session: { sub: "test-user" },
      server: {
        _id: "example",
        name: "Example",
        transport: "http",
        endpoint: "http://gateway:4000/mcp/example",
        enabled: true,
        source: "agentgateway",
      } as never,
      serverId: "example",
      credentialResolution: {
        headers: { Authorization: "Bearer test-token" },
        sources: [],
      },
    })).rejects.toMatchObject({
      statusCode: 502,
      code: "MCP_INIT_FAILED",
      message: "MCP initialize failed with HTTP 403",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
