/**
 * @jest-environment node
 *
 * CAIPE Platform MCP transport (see the "CAIPE Platform/Admin MCP server"
 * proposal, discussions #2818): JSON-RPC 2.0 skeleton, feature gate, RFC
 * 9728 discovery pointer, Phase 1's read tools (`caipe_whoami`,
 * `caipe_agent_list`, `caipe_agent_get`), and Phase 2's agent-lifecycle
 * write tools (`caipe_agent_create`, `caipe_agent_update`,
 * `caipe_agent_set_prompt`, `caipe_agent_delete`,
 * `caipe_agent_available_tools`).
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

  it("lists exactly the Phase 1 + Phase 2 tools", async () => {
    const { POST } = await import("../route");

    const response = await POST(jsonRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const body = await response.json();

    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "caipe_whoami",
      "caipe_agent_list",
      "caipe_agent_get",
      "caipe_agent_available_tools",
      "caipe_agent_create",
      "caipe_agent_update",
      "caipe_agent_set_prompt",
      "caipe_agent_delete",
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

  async function callTool(name: string, args: Record<string, unknown>) {
    const { POST } = await import("../route");
    return POST(
      jsonRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    );
  }

  describe("caipe_agent_available_tools", () => {
    it("lists builtin tools only when no agent_id is given", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify({ tools: ["web_search"] }),
      });

      const response = await callTool("caipe_agent_available_tools", {});
      const body = await response.json();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/dynamic-agents/builtin-tools",
        expect.objectContaining({ method: "GET" }),
      );
      const result = JSON.parse(body.result.content[0].text);
      expect(result.builtin_tools).toEqual({ tools: ["web_search"] });
      expect(result.available_subagents).toBeUndefined();
    });

    it("also lists available subagents when agent_id is given", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify({ success: true, data: [] }),
      });

      await callTool("caipe_agent_available_tools", { agent_id: "agent-sre" });

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/dynamic-agents/available-subagents?id=agent-sre",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  describe("caipe_agent_create", () => {
    it("forwards the full arguments as the POST body", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        status: 201,
        text: async () => JSON.stringify({ success: true, data: { _id: "agent-jira-triage" } }),
      });

      const args = {
        name: "Jira Triage",
        system_prompt: "Triage new Jira issues.",
        model: { id: "gpt-4o", provider: "openai" },
        owner_team_slug: "platform",
      };
      const response = await callTool("caipe_agent_create", args);
      const body = await response.json();

      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/dynamic-agents",
        expect.objectContaining({ method: "POST", body: JSON.stringify(args) }),
      );
      expect(JSON.parse(body.result.content[0].text)).toEqual({ _id: "agent-jira-triage" });
    });
  });

  describe("caipe_agent_update", () => {
    it("requires agent_id", async () => {
      const response = await callTool("caipe_agent_update", { name: "New Name" });
      const body = await response.json();

      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("agent_id is required");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("rejects a call with no fields besides agent_id", async () => {
      const response = await callTool("caipe_agent_update", { agent_id: "a1" });
      const body = await response.json();

      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("Nothing to update");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("forwards to PUT ?id=<agent_id> with agent_id stripped from the body", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify({ success: true, data: { _id: "a1", enabled: false } }),
      });

      await callTool("caipe_agent_update", { agent_id: "a1", enabled: false });

      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/dynamic-agents?id=a1",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: false }) }),
      );
    });

    it("surfaces a config-driven rejection as a tool error", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        status: 403,
        text: async () =>
          JSON.stringify({ success: false, error: "Config-driven agents cannot be modified." }),
      });

      const response = await callTool("caipe_agent_update", { agent_id: "a1", enabled: false });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("Config-driven agents cannot be modified");
    });
  });

  describe("caipe_agent_set_prompt", () => {
    it("fetches the current prompt, PUTs the new one, and returns a diff", async () => {
      const fetchMock = global.fetch as jest.Mock;
      fetchMock
        .mockResolvedValueOnce({
          status: 200,
          text: async () =>
            JSON.stringify({ success: true, data: { name: "SRE Agent", system_prompt: "Be terse." } }),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify({ success: true, data: { _id: "a1" } }),
        });

      const response = await callTool("caipe_agent_set_prompt", {
        agent_id: "a1",
        system_prompt: "Be terse and cite sources.",
      });
      const body = await response.json();

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "http://localhost:3000/api/dynamic-agents/agents/a1",
        expect.objectContaining({ method: "GET" }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "http://localhost:3000/api/dynamic-agents?id=a1",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ system_prompt: "Be terse and cite sources." }),
        }),
      );
      const text = body.result.content[0].text;
      expect(text).toContain("Updated SRE Agent's system_prompt.");
      expect(text).toContain("- Be terse.");
      expect(text).toContain("+ Be terse and cite sources.");
    });

    it("skips the write and says so when the prompt is already identical", async () => {
      const fetchMock = global.fetch as jest.Mock;
      fetchMock.mockResolvedValueOnce({
        status: 200,
        text: async () =>
          JSON.stringify({ success: true, data: { name: "SRE Agent", system_prompt: "Be terse." } }),
      });

      const response = await callTool("caipe_agent_set_prompt", {
        agent_id: "a1",
        system_prompt: "Be terse.",
      });
      const body = await response.json();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(body.result.content[0].text).toContain("No change made");
    });
  });

  describe("caipe_agent_delete", () => {
    it("requires agent_id", async () => {
      const response = await callTool("caipe_agent_delete", {});
      const body = await response.json();

      expect(body.result.isError).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("forwards to DELETE ?id=<agent_id>", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify({ success: true, data: { deleted: "a1" } }),
      });

      const response = await callTool("caipe_agent_delete", { agent_id: "a1" });
      const body = await response.json();

      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/dynamic-agents?id=a1",
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(JSON.parse(body.result.content[0].text)).toEqual({ deleted: "a1" });
    });
  });
});
