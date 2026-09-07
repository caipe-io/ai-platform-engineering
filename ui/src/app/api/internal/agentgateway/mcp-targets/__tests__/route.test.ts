/**
 * @jest-environment node
 */

// assisted-by Codex Codex-sonnet-4-6

import { NextRequest } from "next/server";

const mockGetCollection = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

function request(init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL("/api/internal/agentgateway/mcp-targets", "http://localhost:3000"),
    init,
  );
}

describe("internal AgentGateway MCP targets API", () => {
  const previousToken = process.env.AGENTGATEWAY_TARGETS_TOKEN;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.AGENTGATEWAY_TARGETS_TOKEN = "bridge-token";
  });

  afterAll(() => {
    if (previousToken === undefined) {
      delete process.env.AGENTGATEWAY_TARGETS_TOKEN;
    } else {
      process.env.AGENTGATEWAY_TARGETS_TOKEN = previousToken;
    }
  });

  it("returns enabled AgentGateway targets for an internal bridge caller", async () => {
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            _id: "knowledge-base",
            enabled: true,
            transport: "http",
            source: "agentgateway",
            agentgateway_target_endpoint: "http://rag-server:9446/mcp",
            credential_sources: [
              {
                kind: "caller_token",
                target: "header",
                name: "X-CAIPE-Provider-Token",
              },
            ],
          },
          {
            _id: "manual-target",
            enabled: true,
            transport: "http",
            source: "manual",
            agentgateway_target_endpoint: "http://manual:8000/mcp",
          },
          {
            _id: "manual-endpoint-target",
            enabled: true,
            transport: "http",
            source: "manual",
            endpoint: "http://mcp-manual-endpoint:8000/mcp/",
          },
          {
            _id: "gateway-loop",
            enabled: true,
            transport: "http",
            source: "manual",
            endpoint: "http://agentgateway:4000/mcp/gateway-loop",
          },
          {
            _id: "stdio-target",
            enabled: true,
            transport: "stdio",
            source: "manual",
            command: "node",
          },
          {
            _id: "disabled-target",
            enabled: false,
            transport: "http",
            source: "agentgateway",
            agentgateway_target_endpoint: "http://disabled:8000/mcp",
          },
          {
            _id: "bad target",
            enabled: true,
            transport: "http",
            source: "agentgateway",
            agentgateway_target_endpoint: "http://bad:8000/mcp",
          },
        ]),
      }),
    });
    const { GET } = await import("../route");

    const response = await GET(
      request({
        headers: { authorization: "Bearer bridge-token" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetCollection).toHaveBeenCalledWith("mcp_servers");
    expect(body).toEqual({
      targets: [
        {
          id: "knowledge-base",
          target_endpoint: "http://rag-server:9446/mcp",
          credential_sources: [
            {
              kind: "caller_token",
              target: "header",
              name: "X-CAIPE-Provider-Token",
            },
          ],
        },
        {
          id: "manual-target",
          target_endpoint: "http://manual:8000/mcp",
          credential_sources: [],
        },
        {
          id: "manual-endpoint-target",
          target_endpoint: "http://mcp-manual-endpoint:8000/mcp",
          credential_sources: [],
        },
      ],
    });
  });

  it("removes a trailing slash from AgentGateway upstream MCP endpoints", async () => {
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            _id: "configured-target",
            enabled: true,
            transport: "http",
            source: "agentgateway",
            agentgateway_target_endpoint: "https://mcp.example.test/mcp/?tenant=primary",
          },
        ]),
      }),
    });
    const { GET } = await import("../route");

    const response = await GET(
      request({
        headers: { authorization: "Bearer bridge-token" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      targets: [
        {
          id: "configured-target",
          target_endpoint: "https://mcp.example.test/mcp?tenant=primary",
          credential_sources: [],
        },
      ],
    });
  });

  it("rejects callers without the bridge token", async () => {
    const { GET } = await import("../route");

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("returns an explicit empty credential_sources array for operator-cleared servers", async () => {
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            _id: "jira",
            enabled: true,
            transport: "http",
            source: "agentgateway",
            agentgateway_target_endpoint: "http://mcp-jira:8000/mcp",
            credential_sources: [],
          },
        ]),
      }),
    });
    const { GET } = await import("../route");

    const response = await GET(
      request({
        headers: { authorization: "Bearer bridge-token" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      targets: [
        {
          id: "jira",
          target_endpoint: "http://mcp-jira:8000/mcp",
          credential_sources: [],
        },
      ],
    });
  });
});
