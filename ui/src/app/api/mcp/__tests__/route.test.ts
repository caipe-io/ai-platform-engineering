/**
 * @jest-environment node
 *
 * CAIPE Platform MCP transport — Phase 1 (see the "CAIPE Platform/Admin
 * MCP server" proposal): JSON-RPC 2.0 skeleton, feature gate, RFC 9728
 * discovery pointer, and the two forwarding tools that prove the pattern
 * (`caipe_agent_list`, `caipe_agent_get`) plus `caipe_whoami`.
 *
 * Every forwarding tool re-enters an existing BFF route with the caller's
 * own credentials — these tests assert that forwarding, not a parallel
 * authorization path.
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockIsPlatformMcpEnabled = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: (...args: unknown[]) =>
    mockGetAuthFromBearerOrSession(...args),
}));

jest.mock("@/lib/mcp/guard", () => ({
  isPlatformMcpEnabled: () => mockIsPlatformMcpEnabled(),
}));

function jsonRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL("/api/mcp", "http://localhost:3000"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const user = { email: "dana@example.com", name: "Dana", role: "user" };
const session = { sub: "dana-sub", authMethod: "bearer", principalType: "oidc_user" };

describe("POST /api/mcp", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsPlatformMcpEnabled.mockReturnValue(true);
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user, session });
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  it("404s without a WWW-Authenticate hint when the feature is disabled", async () => {
    mockIsPlatformMcpEnabled.mockReturnValue(false);
    const { POST } = await import("../route");

    const response = await POST(jsonRequest({ jsonrpc: "2.0", id: 1, method: "ping" }));

    expect(response.status).toBe(404);
    expect(mockGetAuthFromBearerOrSession).not.toHaveBeenCalled();
  });

  it("401s with an RFC 9728 resource_metadata pointer when unauthenticated", async () => {
    mockGetAuthFromBearerOrSession.mockRejectedValue(new Error("no session"));
    const { POST } = await import("../route");

    const response = await POST(jsonRequest({ jsonrpc: "2.0", id: 1, method: "ping" }));

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata=\"http://localhost:3000/.well-known/oauth-protected-resource/api/mcp\"",
    );
  });

  it("answers initialize with protocol version, tools capability, and server info", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      jsonRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );
    const body = await response.json();

    expect(body.result).toMatchObject({
      protocolVersion: expect.any(String),
      capabilities: { tools: {} },
      serverInfo: { name: "caipe" },
    });
  });

  it("lists exactly the Phase 1 tools", async () => {
    const { POST } = await import("../route");

    const response = await POST(jsonRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const body = await response.json();

    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "caipe_whoami",
      "caipe_agent_list",
      "caipe_agent_get",
    ]);
  });

  it("caipe_whoami reports the authenticated caller without a forwarded call", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      jsonRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "caipe_whoami", arguments: {} },
      }),
    );
    const body = await response.json();
    const identity = JSON.parse(body.result.content[0].text);

    expect(identity).toMatchObject({ email: "dana@example.com", is_admin: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("caipe_agent_list forwards to GET /api/dynamic-agents with the caller's Authorization header", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 200,
      text: async () =>
        JSON.stringify({ success: true, data: { items: [{ _id: "a1", name: "SRE Agent" }] } }),
    });
    const { POST } = await import("../route");

    const response = await POST(
      jsonRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "caipe_agent_list", arguments: {} },
        },
        { Authorization: "Bearer dana-token" },
      ),
    );
    const body = await response.json();

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/dynamic-agents",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer dana-token" }),
      }),
    );
    expect(JSON.parse(body.result.content[0].text)).toEqual({
      items: [{ _id: "a1", name: "SRE Agent" }],
    });
  });

  it("caipe_agent_get surfaces a forwarded 403 as an MCP tool error, not a protocol error", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 403,
      text: async () => JSON.stringify({ success: false, error: "Agent not found" }),
    });
    const { POST } = await import("../route");

    const response = await POST(
      jsonRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "caipe_agent_get", arguments: { agent_id: "a1" } },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Agent not found");
  });

  it("rejects an unknown tool with a JSON-RPC error, not a 500", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      jsonRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "caipe_delete_everything", arguments: {} },
      }),
    );
    const body = await response.json();

    expect(body.error).toMatchObject({ code: -32602 });
  });

  it("rejects an unknown method with -32601", async () => {
    const { POST } = await import("../route");

    const response = await POST(jsonRequest({ jsonrpc: "2.0", id: 1, method: "resources/list" }));
    const body = await response.json();

    expect(body.error).toMatchObject({ code: -32601 });
  });

  it("answers a JSON-RPC batch and drops notifications (requests with no id)", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      jsonRequest([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]),
    );
    const body = await response.json();

    expect(Array.isArray(body)).toBe(true);
    expect(body.map((r: { id: number }) => r.id)).toEqual([1, 2]);
  });
});
