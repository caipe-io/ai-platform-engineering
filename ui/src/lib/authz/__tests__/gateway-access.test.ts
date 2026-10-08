/** @jest-environment node */
import { createHmac } from "crypto";
import { NextRequest } from "next/server";
import { POST, GET, DELETE, HEAD, OPTIONS } from "@/app/api/access/gateway/check/route";
import { getAuditBackend } from "@/lib/audit";
import { authorizeGateway, signGatewayContext } from "../index";
import { verifyGatewayContext } from "../gateway-context";
import { __resetAdapterStateForTests } from "../engines/openfga";
import { flushAllowRollups } from "../audit";
import type { Subject } from "../contract";

jest.mock("@/lib/audit", () => ({ getAuditBackend: jest.fn(() => ({ write: jest.fn() })) }));

const caller: Subject = { type: "user", id: "test-user" };
const credential = "test-gateway-credential-with-32-characters";
const secret = "test-execution-context-key-with-32-characters";
const originalFetch = global.fetch;
const originalEnv = { ...process.env };
const keys = ["OPENFGA_HTTP", "OPENFGA_STORE_ID", "CAIPE_GATEWAY_AUTHZ_TOKEN", "CAIPE_AGENT_CONTEXT_HMAC_SECRET",
  "CAIPE_AGENT_CONTEXT_PREVIOUS_HMAC_SECRET", "CAIPE_RESTRICTED_MCP_SERVERS", "CAIPE_ORG_KEY", "AUDIT_FULL_FIDELITY_ALLOWS"];
const graphCalls: Array<{ user: string; relation: string; object: string }> = [];
let graphAllows: (key: typeof graphCalls[number]) => boolean;
const writeAudit = jest.fn();

function request(body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_status" } },
  headers: Record<string, string> = {}, method = "POST") {
  const context = signGatewayContext(caller, "example-agent");
  return new NextRequest("https://example.test/api/access/gateway/check", {
    method, headers: {
      authorization: `Bearer ${credential}`, "x-caipe-caller-sub": caller.id,
      "x-caipe-mcp-path": "/mcp/example", "x-caipe-agent-context": context.encoded,
      "x-caipe-agent-context-signature": context.signature, ...headers,
    }, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  process.env.OPENFGA_HTTP = "http://openfga.example.test:8080";
  process.env.OPENFGA_STORE_ID = "test-store";
  process.env.CAIPE_GATEWAY_AUTHZ_TOKEN = credential;
  process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = secret;
  process.env.AUDIT_FULL_FIDELITY_ALLOWS = "true";
  delete process.env.CAIPE_AGENT_CONTEXT_PREVIOUS_HMAC_SECRET;
  delete process.env.CAIPE_RESTRICTED_MCP_SERVERS;
  delete process.env.CAIPE_ORG_KEY;
  __resetAdapterStateForTests();
  jest.clearAllMocks();
  jest.mocked(getAuditBackend).mockReturnValue({ write: writeAudit } as ReturnType<typeof getAuditBackend>);
  graphCalls.length = 0;
  graphAllows = () => true;
  global.fetch = jest.fn(async (_url, init) => {
    const body = JSON.parse(init?.body as string);
    expect(body.consistency).toBe("HIGHER_CONSISTENCY");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    graphCalls.push(body.tuple_key);
    return new Response(JSON.stringify({ allowed: graphAllows(body.tuple_key) }));
  }) as typeof fetch;
});
afterEach(() => {
  flushAllowRollups();
  global.fetch = originalFetch;
  for (const key of keys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  __resetAdapterStateForTests();
});

it("asks all four gates through real CAS and emits one aggregate decision", async () => {
  const response = await POST(request());
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(result).toMatchObject({ decision: "ALLOW", ttl_seconds: 0, agent_id: "example-agent" });
  expect(graphCalls).toEqual([
    { user: "user:test-user", relation: "can_call", object: "mcp_gateway:list" },
    { user: "user:test-user", relation: "can_use", object: "agent:example-agent" },
    { user: "agent:example-agent", relation: "can_call", object: "tool:example/get_status" },
    { user: "user:test-user", relation: "can_call", object: "tool:example/get_status" },
  ]);
  expect(writeAudit).toHaveBeenCalledTimes(1);
  expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
    subject_ref: "user:test-user", actor_ref: "workload:agentgateway", agent_ref: "agent:example-agent",
    resource_ref: "tool:example/get_status", decision_id: result.decision_id,
  }));
  expect(JSON.stringify(writeAudit.mock.calls)).not.toContain(secret);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-caipe-decision-id")).toBe(result.decision_id);
});

it.each([
  ["gateway", "mcp_gateway:list", undefined],
  ["agent", "agent:example-agent", undefined],
  ["agent_tool", "tool:example/", "agent:example-agent"],
  ["caller_tool", "tool:example/", "user:test-user"],
])("returns non-2xx with the failed %s gate", async (gate, object, subject) => {
  graphAllows = (key) => !(key.object.startsWith(object) && (!subject || key.user === subject));
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ decision: "DENY", failed_gate: gate, retriable: false });
  expect(writeAudit).toHaveBeenCalledTimes(1);
});

it("requires configured server access independently of tool access", async () => {
  process.env.CAIPE_RESTRICTED_MCP_SERVERS = "example";
  graphAllows = (key) => key.object !== "mcp_server:example";
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ failed_gate: "server" });
});

it("uses exact/wildcard tool grants for agent and caller independently", async () => {
  graphAllows = (key) => !key.object.endsWith("/get_status");
  expect((await POST(request())).status).toBe(200);
  expect(graphCalls.filter((key) => key.object.endsWith("/*")).map((key) => key.user))
    .toEqual(["agent:example-agent", "user:test-user"]);
});

it("never tries wildcard or another authority after a graph outage", async () => {
  global.fetch = jest.fn(async () => new Response("{}", { status: 503 }));
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ reason: "AUTHZ_UNAVAILABLE", retriable: true });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it("does not reuse a prior ALLOW after revocation", async () => {
  expect((await POST(request())).status).toBe(200);
  graphAllows = (key) => key.object !== "agent:example-agent";
  expect((await POST(request())).status).toBe(403);
});

it("keeps direct clients explicit and still checks caller tools", async () => {
  const context = signGatewayContext(caller);
  graphAllows = (key) => key.object !== "tool:example/get_status" && key.object !== "tool:example/*";
  const response = await POST(request(undefined, { "x-caipe-agent-context": context.encoded,
    "x-caipe-agent-context-signature": context.signature }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ failed_gate: "caller_tool" });
  expect(graphCalls.some((key) => key.user.startsWith("agent:") || key.object.startsWith("agent:"))).toBe(false);
});

it("keeps service-account caller and agent subjects distinct", async () => {
  const subject: Subject = { type: "service_account", id: "test-service" };
  const signed = signGatewayContext(subject, "example-agent");
  const response = await POST(request(undefined, { "x-caipe-caller-sub": subject.id,
    "x-caipe-caller-username": "service-account-example", "x-caipe-agent-context": signed.encoded,
    "x-caipe-agent-context-signature": signed.signature }));
  expect(response.status).toBe(200);
  expect(graphCalls.map((key) => key.user)).toEqual([
    "service_account:test-service", "service_account:test-service", "agent:example-agent", "service_account:test-service",
  ]);
});

it("preserves Search policy without treating agent access as caller Search access", async () => {
  graphAllows = (key) => key.relation !== "can_search";
  const response = await POST(request(undefined, { "x-caipe-mcp-path": "/mcp/knowledge-base" }));
  expect(response.status).toBe(403);
  expect(graphCalls.at(-1)).toMatchObject({ user: "user:test-user", relation: "can_search", object: "organization:caipe" });
});

it.each(["initialize", "tools/list", "ping", "notifications/initialized"])("treats %s as setup, not permission to execute", async (method) => {
  expect((await POST(request({ jsonrpc: "2.0", method }, { "x-caipe-agent-context": "", "x-caipe-agent-context-signature": "" }))).status).toBe(200);
  expect(graphCalls).toHaveLength(1);
  expect((await POST(request(undefined, { "x-caipe-agent-context": "", "x-caipe-agent-context-signature": "" }))).status).toBe(403);
});

it.each([GET, DELETE])("checks transport requests using the forwarded HTTP method", async (handler) => {
  expect((await handler(request(undefined, {}, handler === GET ? "GET" : "DELETE"))).status).toBe(200);
  expect(graphCalls).toHaveLength(1);
});
it.each([HEAD, OPTIONS])("never emits automatic successful responses for unsupported methods", async (handler) => {
  expect((await handler(request(undefined, {}, handler === HEAD ? "HEAD" : "OPTIONS"))).status).toBe(405);
});

it.each(["", "Bearer ordinary-user-token", "Bearer wrong-secret", "Basic example", `Bearer ${credential} extra`])(
  "rejects untrusted workload authentication %s before graph access", async (authorization) => {
    const response = await POST(request(undefined, { authorization, cookie: "next-auth.session-token=example" }));
    expect(response.status).toBe(401);
    expect(graphCalls).toHaveLength(0);
  },
);
it("fails unavailable when workload credentials are not configured", async () => {
  delete process.env.CAIPE_GATEWAY_AUTHZ_TOKEN;
  expect((await POST(request())).status).toBe(503);
});

it.each(["CAIPE_AGENT_CONTEXT_HMAC_SECRET", "CAIPE_RESTRICTED_MCP_SERVERS", "CAIPE_ORG_KEY"])(
  "fails unavailable instead of blaming the caller for invalid %s configuration", async (key) => {
    const req = request();
    process.env[key] = "invalid:configuration";
    expect((await POST(req)).status).toBe(503);
    expect(graphCalls).toHaveLength(0);
  },
);
it("never interprets a malformed OpenFGA reply as permission", async () => {
  global.fetch = jest.fn(async () => new Response('{"allowed":"true"}'));
  expect((await POST(request())).status).toBe(503);
});
it("rejects a tampered signature", async () => {
  expect((await POST(request(undefined, { "x-caipe-agent-context-signature": "0".repeat(64) }))).status).toBe(403);
  expect(graphCalls).toHaveLength(0);
});

it.each(["", "{", "null", "[]", '{}', JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", method: "resources/read" }),
  JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "*" } }),
])("rejects incomplete/unsupported MCP body %s instead of falling back to coarse access", async (body) => {
  expect((await POST(request(body))).status).toBe(400);
  expect(graphCalls).toHaveLength(0);
});
it("bounds body reads even without Content-Length", async () => {
  expect((await POST(request(" ".repeat(65537)))).status).toBe(413);
});

it.each(["/mcp/example/extra", "/mcp/example?tool=secondary", "/mcp/example%2fsecondary", "/mcp/*", ""])(
  "rejects an ambiguous or missing MCP route %s", async (path) => {
    expect((await POST(request(undefined, { "x-caipe-mcp-path": path }))).status).toBe(400);
  },
);

it("never accepts the old unbound context or defaults missing context to direct mode", async () => {
  const encoded = Buffer.from(JSON.stringify({ agent_id: "example-agent", iat: 1, exp: 9999999999 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("hex");
  expect((await POST(request(undefined, { "x-caipe-agent-context": encoded, "x-caipe-agent-context-signature": signature }))).status).toBe(403);
  expect((await POST(request(undefined, { "x-caipe-agent-context": "", "x-caipe-agent-context-signature": "" }))).status).toBe(403);
  expect(graphCalls).toHaveLength(0);
});

it.each([
  { audience: "other-service" }, { version: 2 }, { caller: { type: "user", id: "secondary" } },
  { caller: { type: "service_account", id: "test-user" } }, { exp: 1 }, { iat: 9999999999, exp: 10000000000 },
  { iat: 1, exp: 9999999999 }, { kind: "direct", agent_id: "example-agent" },
])("rejects a signed but incorrectly bound context %j", async (overrides) => {
  const good = signGatewayContext(caller, "example-agent");
  const payload = { ...JSON.parse(Buffer.from(good.encoded, "base64url").toString()), ...overrides };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("hex");
  expect((await POST(request(undefined, { "x-caipe-agent-context": encoded, "x-caipe-agent-context-signature": signature }))).status).toBe(403);
  expect(graphCalls).toHaveLength(0);
});

it("allows bounded signing-key rotation without accepting unbound contexts", () => {
  const signed = signGatewayContext(caller, "example-agent");
  process.env.CAIPE_AGENT_CONTEXT_PREVIOUS_HMAC_SECRET = secret;
  process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = "secondary-context-key-with-32-characters";
  expect(verifyGatewayContext(signed, caller)).toMatchObject({ agent_id: "example-agent" });
  delete process.env.CAIPE_AGENT_CONTEXT_PREVIOUS_HMAC_SECRET;
  expect(verifyGatewayContext(signed, caller)).toBeNull();
});

it("removes individual decision receipts from aggregated allow audit rows", async () => {
  process.env.AUDIT_FULL_FIDELITY_ALLOWS = "false";
  await authorizeGateway({ caller, serverId: "example", operation: "tools/call", toolName: "get_status",
    signedContext: signGatewayContext(caller, "example-agent") });
  flushAllowRollups();
  expect(writeAudit.mock.calls[0][0]).toMatchObject({ count: 1, agent_ref: "agent:example-agent" });
  expect(writeAudit.mock.calls[0][0]).not.toHaveProperty("decision_id");
});
