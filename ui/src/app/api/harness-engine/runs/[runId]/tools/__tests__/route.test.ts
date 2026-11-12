/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";

const authorize = jest.fn();
const getCollection = jest.fn();
const proxy = jest.fn();
const permitted = jest.fn();
const list = jest.fn();
const call = jest.fn();
jest.mock("@/app/api/harness-engine/_run-authz", () => ({ authorizeHarnessRunAccess: (...args: unknown[]) => authorize(...args) }));
jest.mock("@/lib/mongodb", () => ({ getCollection: (...args: unknown[]) => getCollection(...args) }));
jest.mock("@/lib/harness-engine-proxy", () => ({ proxyHarnessEngine: (...args: unknown[]) => proxy(...args) }));
jest.mock("@/lib/rbac/resource-authz", () => ({ filterResourcesByPermission: (...args: unknown[]) => permitted(...args) }));
jest.mock("@/lib/mcp-http-server-client", () => ({ listHttpMcpTools: (...args: unknown[]) => list(...args), callHttpMcpTool: (...args: unknown[]) => call(...args) }));
import { POST } from "../route";

const run = { run_id: "run-example", agent_id: "agent-example", agent_version: 7, status: "running", harness_id: "claude_agent_sdk" };
const agent = { _id: "agent-example", enabled: true, allowed_tools: { example: ["lookup"] } };
const server = { _id: "example", name: "Example provider", enabled: true, transport: "http", endpoint: "http://upstream.example.test/mcp" };
const session = { sub: "test-user", accessToken: "caller-token" };
const request = (body: unknown) => new NextRequest("http://example.test/api/harness-engine/runs/run-example/tools", { method: "POST", body: JSON.stringify(body) });
const params = { params: Promise.resolve({ runId: "run-example" }) };

beforeEach(() => {
  jest.resetAllMocks();
  process.env.AGENT_GATEWAY_URL = "http://gateway.example.test:4000";
  authorize.mockImplementation(async () => ({ auth: { authenticatedUser: { session } }, config: {}, response: Response.json({ data: run }) }));
  proxy.mockImplementation(async () => Response.json({ data: { version: { blueprint: { id: run.agent_id, tools: { bindings: [{ tool_id: "example.lookup" }], approval_policy: "never" } } } } }));
  getCollection.mockImplementation(async (name: string) => name === "dynamic_agents" ? { findOne: async () => agent } : { find: () => ({ toArray: async () => [server] }) });
  permitted.mockResolvedValue([server]);
  list.mockResolvedValue({ tools: [{ name: "lookup", description: "Example lookup", inputSchema: { type: "object" } }, { name: "delete", inputSchema: {} }] });
  call.mockResolvedValue({ content: [{ type: "text", text: "example result" }] });
});

it("lists only pinned tools, routing through the gateway under the real agent context", async () => {
  const response = await POST(request({ operation: "list" }), params);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true, data: { tools: [{ tool_id: "example.lookup", description: "Example lookup", input_schema: { type: "object" } }] } });
  expect(proxy).toHaveBeenCalledWith({}, expect.anything(), "/api/v1/agents/agent-example?version=7");
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ session, agentId: "agent-example", serverId: "example", server: expect.objectContaining({ endpoint: "http://gateway.example.test:4000/mcp/example" }) }));
  expect(authorize).toHaveBeenCalledWith(expect.anything(), "run-example", "write");
});

it("invokes an allowed tool once and passes only its structured result", async () => {
  const response = await POST(request({ operation: "call", tool_id: "example.lookup", arguments: { value: "example" } }), params);
  expect(response.status).toBe(200);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-example", toolName: "lookup", args: { value: "example" } }));
  expect(list).not.toHaveBeenCalled();
});

it.each(["MCP_AUTH_REQUIRED", "MCP_CREDENTIAL_UNAVAILABLE"])(
  "keeps the pinned catalog usable when one caller connection needs authentication (%s)",
  async code => {
    const available = { ...server, _id: "connected", name: "Connected provider" };
    proxy.mockResolvedValue(Response.json({ data: { version: { blueprint: { id: run.agent_id, tools: {
      bindings: [{ tool_id: "example.lookup" }, { tool_id: "connected.lookup" }, { tool_id: "example.search" }],
      approval_policy: "never",
    } } } } }));
    getCollection.mockImplementation(async (name: string) => name === "dynamic_agents"
      ? { findOne: async () => ({ ...agent, allowed_tools: { example: ["lookup", "search"], connected: ["lookup"] } }) }
      : { find: () => ({ toArray: async () => [server, available] }) });
    permitted.mockResolvedValue([server, available]);
    list.mockImplementation(async ({ serverId }: { serverId: string }) => {
      if (serverId === "example") throw new ApiError("private-upstream-detail", 401, code);
      return { tools: [{ name: "lookup", description: "Connected lookup", inputSchema: { type: "object" } }] };
    });
    const response = await POST(request({ operation: "list" }), params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.tools.map((tool: { tool_id: string }) => tool.tool_id)).toEqual([
      "example.lookup", "connected.lookup", "example.search",
    ]);
    expect(body.data.tools[0]).toMatchObject({ description: expect.stringContaining("Connect or reconnect your own provider account"),
      input_schema: { type: "object", properties: {}, additionalProperties: false } });
    expect(body.data.tools[1].description).toBe("Connected lookup");
    expect(body.data.tools[2].description).toBe(body.data.tools[0].description);
    expect(JSON.stringify(body)).not.toContain("private-upstream-detail");
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ session, agentId: run.agent_id, serverId: "connected" }));
    expect(call).not.toHaveBeenCalled();
  },
);

it("returns a confirmed credential rejection as an MCP tool error without retry or identity fallback", async () => {
  call.mockRejectedValue(new ApiError("private-upstream-detail", 401, "MCP_AUTH_REQUIRED"));
  const response = await POST(request({ operation: "call", tool_id: "example.lookup", arguments: {} }), params);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ success: true, data: { isError: true, content: [{ type: "text", text: expect.stringContaining("This tool has not executed") }] } });
  expect(JSON.stringify(body)).not.toContain("private-upstream-detail");
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ session }));
  expect(list).not.toHaveBeenCalled();
});

it.each([[502, "MCP_INIT_FAILED"], [503, "AGENT_CONTEXT_UNAVAILABLE"]])(
  "keeps non-credential catalog failures fail-closed (HTTP %s)", async (status, code) => {
    list.mockRejectedValue(new ApiError("example failure", status as number, code as string));
    expect((await POST(request({ operation: "list" }), params)).status).toBe(status);
    expect(call).not.toHaveBeenCalled();
  },
);

it("does not convert an upstream tool authorization denial into a credential fallback", async () => {
  call.mockRejectedValue(new ApiError("denied", 403, "MCP_TOOL_ACCESS_DENIED"));
  expect((await POST(request({ operation: "call", tool_id: "example.lookup", arguments: {} }), params)).status).toBe(403);
  expect(call).toHaveBeenCalledTimes(1);
});

it("rejects an unselected tool before invoking any MCP server", async () => {
  const response = await POST(request({ operation: "call", tool_id: "example.delete", arguments: {} }), params);
  expect(response.status).toBe(403);
  expect(call).not.toHaveBeenCalled();
});

it("honors run ownership and conversation authorization denials", async () => {
  authorize.mockResolvedValue(NextResponse.json({ error: "denied" }, { status: 403 }));
  expect((await POST(request({ operation: "list" }), params)).status).toBe(403);
  expect(proxy).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});

it("permits text-only chat without server grants while keeping tool invocation denied", async () => {
  permitted.mockResolvedValue([]);
  const response = await POST(request({ operation: "list" }), params);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { tools: [{ tool_id: "example.lookup",
    description: expect.stringContaining("not permitted for your account") }] } });
  expect((await POST(request({ operation: "call", tool_id: "example.lookup", arguments: {} }), params)).status).toBe(403);
  expect(list).not.toHaveBeenCalled();
  expect(call).not.toHaveBeenCalled();
});

it("keeps an accessible tool callable when another selected server is forbidden", async () => {
  const forbidden = { ...server, _id: "restricted", name: "Restricted provider" };
  proxy.mockImplementation(async () => Response.json({ data: { version: { blueprint: { id: run.agent_id, tools: {
    bindings: [{ tool_id: "restricted.lookup" }, { tool_id: "example.lookup" }], approval_policy: "never",
  } } } } }));
  getCollection.mockImplementation(async (name: string) => name === "dynamic_agents"
    ? { findOne: async () => ({ ...agent, allowed_tools: { example: ["lookup"], restricted: ["lookup"] } }) }
    : { find: () => ({ toArray: async () => [server, forbidden] }) });
  const response = await POST(request({ operation: "list" }), params);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.data.tools[0].description).toContain("not permitted for your account");
  expect(body.data.tools[1].description).toBe("Example lookup");
  expect(list).toHaveBeenCalledTimes(1);
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ serverId: "example" }));
  expect((await POST(request({ operation: "call", tool_id: "restricted.lookup", arguments: {} }), params)).status).toBe(403);
  expect(call).not.toHaveBeenCalled();
  expect((await POST(request({ operation: "call", tool_id: "example.lookup", arguments: {} }), params)).status).toBe(200);
  expect(call).toHaveBeenCalledTimes(1);
});

it("describes upstream catalog denials without querying or invoking an alternate identity", async () => {
  list.mockRejectedValue(new ApiError("private-upstream-detail", 403, "MCP_TOOL_ACCESS_DENIED"));
  const response = await POST(request({ operation: "list" }), params);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.data.tools[0].description).toContain("not permitted for your account");
  expect(JSON.stringify(body)).not.toContain("private-upstream-detail");
  expect(list).toHaveBeenCalledTimes(1);
  expect(call).not.toHaveBeenCalled();
});

it("rejects a tool removed from the current agent policy", async () => {
  getCollection.mockImplementation(async (name: string) => name === "dynamic_agents" ? { findOne: async () => ({ ...agent, allowed_tools: {} }) } : { find: () => ({ toArray: async () => [server] }) });
  expect((await POST(request({ operation: "call", tool_id: "example.lookup", arguments: {} }), params)).status).toBe(403);
  expect(call).not.toHaveBeenCalled();
});

it.each(["completed", "cancelled", "failed"])("does not execute tools for a %s run", async status => {
  authorize.mockResolvedValue({ auth: { authenticatedUser: { session } }, config: {}, response: Response.json({ data: { ...run, status } }) });
  expect((await POST(request({ operation: "call", tool_id: "example.lookup", arguments: {} }), params)).status).toBe(409);
  expect(call).not.toHaveBeenCalled();
});

it("rejects new tools after Stop is recorded while the producer is still draining", async () => {
  authorize.mockResolvedValue({ auth: { authenticatedUser: { session } }, config: {},
    response: Response.json({ data: { ...run, status: "running", cancellation_requested: true } }) });
  expect((await POST(request({ operation: "call", tool_id: "example.lookup", arguments: {} }), params)).status).toBe(409);
  expect(call).not.toHaveBeenCalled();
  expect(proxy).not.toHaveBeenCalled();
});

it("rejects unavailable approval semantics instead of silently downgrading them", async () => {
  proxy.mockResolvedValue(Response.json({ data: { version: { blueprint: { id: run.agent_id, tools: { bindings: [{ tool_id: "example.lookup" }], approval_policy: "always" } } } } }));
  expect((await POST(request({ operation: "list" }), params)).status).toBe(409);
  expect(list).not.toHaveBeenCalled();
});

it("accepts a legacy agent without an enabled field", async () => {
  getCollection.mockImplementation(async (name: string) => name === "dynamic_agents" ? { findOne: async () => ({ ...agent, enabled: undefined }) } : { find: () => ({ toArray: async () => [server] }) });
  expect((await POST(request({ operation: "list" }), params)).status).toBe(200);
});

it.each([["missing", null], ["disabled", { ...agent, enabled: false }]])("rejects a %s agent", async (_name, record) => {
  getCollection.mockImplementation(async (name: string) => name === "dynamic_agents" ? { findOne: async () => record } : { find: () => ({ toArray: async () => [server] }) });
  expect((await POST(request({ operation: "call", tool_id: "example.lookup", arguments: {} }), params)).status).toBe(403);
  expect(call).not.toHaveBeenCalled();
});

it("includes legacy MCP servers without an enabled field", async () => {
  const find = jest.fn(() => ({ toArray: async () => [{ ...server, enabled: undefined }] }));
  getCollection.mockImplementation(async (name: string) => name === "dynamic_agents" ? { findOne: async () => agent } : { find });
  expect((await POST(request({ operation: "list" }), params)).status).toBe(200);
  expect(find).toHaveBeenCalledWith({ enabled: { $ne: false } });
});


it.each(["claude_code_acp", "claude_code_cli_acp"])("authorizes %s tools through the same caller-scoped AgentGateway path", async harnessId => {
  authorize.mockResolvedValue({ auth: { subject: "test-user", authenticatedUser: { session } }, config: {},
    response: NextResponse.json({ success: true, data: { ...run, harness_id: harnessId } }) });
  const response = await POST(request({ operation: "call", tool_id: "example.lookup", arguments: { query: "example" } }), params);
  expect(response.status).toBe(200);
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-example", session,
    server: expect.objectContaining({ source: "agentgateway" }) }));
});
