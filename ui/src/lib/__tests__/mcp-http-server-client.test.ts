/** @jest-environment node */
import { NextRequest } from "next/server";
import { callHttpMcpTool, listDirectHttpMcpTools, listHttpMcpTools } from "../mcp-http-server-client";
import { resolveMcpHeaderCredentials } from "@/lib/mcp-credential-headers";

jest.mock("@/lib/api-middleware", () => ({ ApiError: jest.requireActual("@/lib/api-error").ApiError }));
jest.mock("@/lib/mcp-credential-headers", () => ({
  resolveMcpHeaderCredentials: jest.fn(async () => ({ headers: { Authorization: "Bearer example-user-token" } })),
  isMcpCredentialUnavailableError: (error: unknown) => error instanceof Error && error.message === "MCP_CREDENTIAL_UNAVAILABLE",
}));
jest.mock("@/lib/rbac/openfga", () => ({ writeOpenFgaTuples: jest.fn() }));

const originalFetch = global.fetch;
const originalSecret = process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET;
const fetchMock = jest.fn();
const input = {
  request: new NextRequest("https://example.test/api/harness-engine/runs/run-example/tools"),
  session: { sub: "test-user", accessToken: "example-user-token" },
  server: { _id: "example", name: "Example", transport: "http", enabled: true, source: "agentgateway", endpoint: "http://gateway.example.test/mcp/example" } as const,
  serverId: "example", agentId: "agent-example", toolName: "lookup", args: {},
};

it("keeps direct health catalog probes independent of caller-authorized discovery", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ result: { tools: [{ name: "lookup" }] } }, { headers: { "mcp-session-id": "direct-session" } }));
  const catalog = await listDirectHttpMcpTools({ endpoint: "https://health.example.test/mcp" });
  expect(catalog).toMatchObject({ tools: [{ name: "lookup" }], sessionId: "direct-session" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const headers = fetchMock.mock.calls[0][1].headers;
  expect(headers).not.toHaveProperty("Authorization");
  expect(headers).not.toHaveProperty("X-CAIPE-Agent-Context");
});

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock;
  process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = "example-signing-secret";
});

afterAll(() => {
  global.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET;
  else process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = originalSecret;
});

it.each([0, 1, 2].flatMap(stage => [401, 403].map(status => ({ stage, status }))))(
  "preserves HTTP $status at MCP stage $stage without dispatching or retrying later stages",
  async ({ stage, status }) => {
    fetchMock.mockImplementation(async () => {
      const step = fetchMock.mock.calls.length - 1;
      if (step === stage) return Response.json({ error: "private-upstream-detail" }, { status });
      if (step === 0) return Response.json({ jsonrpc: "2.0", result: { protocolVersion: "2024-11-05" } });
      return new Response(null, { status: 202 });
    });
    await expect(callHttpMcpTool(input)).rejects.toMatchObject({
      statusCode: status, code: status === 403 ? "MCP_TOOL_ACCESS_DENIED" : "MCP_AUTH_REQUIRED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(stage + 1);
  },
);

it("reports a missing caller provider connection before making any upstream request", async () => {
  jest.mocked(resolveMcpHeaderCredentials).mockRejectedValueOnce(new Error("MCP_CREDENTIAL_UNAVAILABLE"));
  await expect(listHttpMcpTools(input)).rejects.toMatchObject({ statusCode: 401, code: "MCP_CREDENTIAL_UNAVAILABLE" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([401, 403].flatMap(status => ["", "not-json"].map(body => ({ status, body }))))(
  "preserves HTTP $status with an invalid JSON error body '$body'",
  async ({ status, body }) => {
    fetchMock.mockImplementation(async () => new Response(body, {
      status, headers: { "content-type": "application/json" },
    }));
    const expected = { statusCode: status, code: status === 403 ? "MCP_TOOL_ACCESS_DENIED" : "MCP_AUTH_REQUIRED" };
    await expect(listHttpMcpTools(input)).rejects.toMatchObject(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await expect(callHttpMcpTool(input)).rejects.toMatchObject(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

it("keeps an upstream failure ambiguous, sanitizes its body and never repeats the call", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", result: {} }))
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ error: "private-upstream-detail" }, { status: 502 }));
  await expect(callHttpMcpTool(input)).rejects.toMatchObject({
    statusCode: 502, code: "MCP_CALL_FAILED", message: "MCP tool invocation failed; the request was not retried",
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it.each([0, 1, 2, 3].flatMap(stage => [401, 403].map(status => ({ stage, status }))))(
  "preserves catalog HTTP $status at stage $stage without retrying authentication",
  async ({ stage, status }) => {
    fetchMock.mockImplementation(async () => {
      const step = fetchMock.mock.calls.length - 1;
      if (step === stage) return Response.json({ error: "private-upstream-detail" }, { status });
      if (step === 0) return new Response(null, { status: 422 });
      return Response.json({ result: {} }, { headers: { "mcp-session-id": "example-session" } });
    });
    await expect(listHttpMcpTools(input)).rejects.toMatchObject({
      statusCode: status, code: status === 403 ? "MCP_TOOL_ACCESS_DENIED" : "MCP_AUTH_REQUIRED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(stage + 1);
  },
);

it.each([undefined, "application/json"])("initializes a strict catalog session with an empty %s notification response", async contentType => {
  let ready = false;
  fetchMock.mockImplementation(async (_url, options: RequestInit) => {
    const payload = JSON.parse(options.body as string);
    const headers = options.headers as Record<string, string>;
    if (payload.method === "initialize") return Response.json({ result: { protocolVersion: "2024-11-05" } }, { headers: { "mcp-session-id": "catalog-session" } });
    if (payload.method === "notifications/initialized") {
      expect(headers["mcp-session-id"]).toBe("catalog-session");
      expect(headers.Authorization).toBe("Bearer example-user-token");
      expect(payload).not.toHaveProperty("id");
      ready = true;
      return new Response(null, { status: 202, headers: contentType ? { "content-type": contentType } : undefined });
    }
    if (!headers["mcp-session-id"]) return new Response(null, { status: 400 });
    expect(ready).toBe(true);
    expect(headers["mcp-session-id"]).toBe("catalog-session");
    return Response.json({ result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] } });
  });
  expect(await listHttpMcpTools(input)).toMatchObject({ tools: [{ name: "lookup" }], sessionId: "catalog-session" });
  expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).method)).toEqual([
    "tools/list", "initialize", "notifications/initialized", "tools/list",
  ]);
});

it.each([false, true])("reads all tools/list pages through the session fallback (%s)", async fallback => {
  const seen: string[] = [];
  fetchMock.mockImplementation(async (_url, options: RequestInit) => {
    const payload = JSON.parse(options.body as string);
    const headers = options.headers as Record<string, string>;
    seen.push(payload.method);
    if (fallback && seen.length === 1) return new Response(null, { status: 400 });
    if (payload.method === "initialize") return Response.json({ result: {} }, { headers: { "mcp-session-id": "paged-session" } });
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202, headers: { "content-type": "application/json" } });
    expect(payload.method).toBe("tools/list");
    if (fallback || payload.params.cursor) expect(headers["mcp-session-id"]).toBe("paged-session");
    expect(headers.Authorization).toBe("Bearer example-user-token");
    const cursor = payload.params.cursor;
    const result = !cursor ? { tools: [{ name: "first" }], nextCursor: "second-page" }
      : cursor === "second-page" ? { tools: [{ name: "second" }], nextCursor: "final-page" } : { tools: [{ name: "lookup" }] };
    return Response.json({ result }, { headers: { "mcp-session-id": "paged-session" } });
  });
  const catalog = await listHttpMcpTools(input);
  expect(catalog.tools.map(tool => tool.name)).toEqual(["first", "second", "lookup"]);
  expect(catalog.sessionId).toBe("paged-session");
  expect(seen.filter(method => method === "tools/list")).toHaveLength(fallback ? 4 : 3);
  const cursors = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body))
    .filter(payload => payload.method === "tools/list").map(payload => payload.params.cursor);
  expect(cursors).toEqual(fallback ? [undefined, undefined, "second-page", "final-page"] : [undefined, "second-page", "final-page"]);
  expect(seen).not.toContain("tools/call");
});

it("rejects a repeated catalog cursor without retrying or returning a partial list", async () => {
  fetchMock.mockImplementation(async () => Response.json({ result: { tools: [{ name: "lookup" }], nextCursor: "same-cursor" } }));
  await expect(listHttpMcpTools(input)).rejects.toMatchObject({ code: "MCP_LIST_INVALID" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([401, 403])("preserves authorization failure on a later catalog page (HTTP %s)", async status => {
  fetchMock.mockResolvedValueOnce(Response.json({ result: { tools: [], nextCursor: "next-page" } }))
    .mockResolvedValueOnce(new Response(null, { status, headers: { "content-type": "application/json" } }));
  await expect(listHttpMcpTools(input)).rejects.toMatchObject({ code: status === 401 ? "MCP_AUTH_REQUIRED" : "MCP_TOOL_ACCESS_DENIED" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("keeps the caller's cancellation budget across catalog pages", async () => {
  const caller = new AbortController();
  let started: () => void = () => {};
  const pageStarted = new Promise<void>(resolve => { started = resolve; });
  fetchMock.mockResolvedValueOnce(Response.json({ result: { tools: [], nextCursor: "next-page" } }))
    .mockImplementationOnce((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("page-aborted")), { once: true });
      started();
    }));
  const rejected = expect(listHttpMcpTools({ ...input, signal: caller.signal })).rejects.toThrow("page-aborted");
  await pageStarted;
  caller.abort();
  await rejected;
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([500, 200])("stops catalog discovery when its initialized notification fails with HTTP %s", async status => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ result: {} }, { headers: { "mcp-session-id": "catalog-session" } }))
    .mockResolvedValueOnce(Response.json({ error: { message: "private-upstream-detail" } }, { status }));
  await expect(listHttpMcpTools(input)).rejects.toMatchObject({ code: "MCP_INIT_FAILED" });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it.each(["caller", "deadline"])("cancels an initialized notification on its %s abort boundary", async boundary => {
  jest.useFakeTimers();
  try {
    const caller = new AbortController();
    let started: () => void = () => {};
    const notificationStarted = new Promise<void>(resolve => { started = resolve; });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ result: {} }, { headers: { "mcp-session-id": "catalog-session" } }))
      .mockImplementationOnce((_url, options: RequestInit) => new Promise((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(new Error("request-aborted")), { once: true });
        started();
      }));
    const rejection = expect(listHttpMcpTools({ ...input, signal: caller.signal })).rejects.toThrow("request-aborted");
    await notificationStarted;
    if (boundary === "caller") caller.abort();
    else await jest.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally { jest.useRealTimers(); }
});
