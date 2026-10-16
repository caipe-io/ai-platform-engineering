/** @jest-environment node */
import { NextRequest } from "next/server";
import { POST } from "../route";

jest.mock("@/lib/da-proxy", () => ({ getDynamicAgentsConfig: () => ({ dynamicAgentsUrl: "https://runtime.example.test/base" }) }));
const runId = "11111111-2222-4333-8444-555555555555";
const capability = "c".repeat(43);
const context = (id = runId) => ({ params: Promise.resolve({ runId: id }) });
function request(options: { capability?: string | null; body?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest("https://ui.example.test/api/v1/harness-tools/ignored/mcp?url=https://untrusted.example.test", {
    method: "POST", body: options.body ?? '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    headers: { "Content-Type": "application/json", ...(options.capability !== null && { "X-CAIPE-Harness-Capability": options.capability ?? capability }), ...options.headers },
  });
}
beforeEach(() => { global.fetch = jest.fn().mockImplementation(async () => Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } })); });
afterEach(() => jest.restoreAllMocks());

it.each([null, "bad", "a ".repeat(30), "a".repeat(257)])("requires a bounded capability without a browser identity fallback: %p", async (value) => {
  const response = await POST(request({ capability: value, headers: { Authorization: "Bearer user-token", Cookie: "session=private" } }), context());
  expect(response.status).toBe(401);
  expect(global.fetch).not.toHaveBeenCalled();
});
it("rejects an invalid run UUID before forwarding", async () => {
  expect((await POST(request(), context("../other"))).status).toBe(400);
  expect(global.fetch).not.toHaveBeenCalled();
});
it("forwards only the capability to the fixed backend origin and path", async () => {
  const response = await POST(request({ headers: { Authorization: "Bearer private", Cookie: "session=private", "X-User-Context": "untrusted", "Mcp-Session-Id": "untrusted" } }), context());
  expect(response.status).toBe(200);
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url.toString()).toBe(`https://runtime.example.test/api/v1/harness-tools/${runId}/mcp`);
  expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-CAIPE-Harness-Capability": capability } });
  expect(Object.keys(init.headers)).toHaveLength(3);
  expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
});
it("bounds actual request bytes without trusting Content-Length", async () => {
  const response = await POST(request({ body: JSON.stringify({ data: "x".repeat(256 * 1024) }), headers: { "Content-Length": "1" } }), context());
  expect(response.status).toBe(413);
  expect(global.fetch).not.toHaveBeenCalled();
});
it("rejects invalid JSON and non-JSON content before forwarding", async () => {
  expect((await POST(request({ body: "{" }), context())).status).toBe(400);
  expect((await POST(request({ headers: { "Content-Type": "text/plain" } }), context())).status).toBe(415);
  expect(global.fetch).not.toHaveBeenCalled();
});
it("bounds the upstream response and does not expose raw backend errors", async () => {
  (global.fetch as jest.Mock).mockResolvedValueOnce(new Response("x".repeat(8 * 1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } }));
  expect((await POST(request(), context())).status).toBe(502);
  (global.fetch as jest.Mock).mockResolvedValueOnce(new Response("private backend details", { status: 403 }));
  const denied = await POST(request(), context());
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("private backend details");
});

it("forwards SSE keepalives immediately without buffering the human-waiting response", async () => {
  const encoder = new TextEncoder();
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; controller.enqueue(encoder.encode(": keepalive\n\n")); } });
  (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(source, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }));
  const response = await POST(request(), context());
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": keepalive\n\n");
  upstream.enqueue(encoder.encode('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'));
  upstream.close();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"result":{}');
  expect((await reader.read()).done).toBe(true);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it("enforces the cumulative stream byte limit and closes only its observer", async () => {
  const cancelled = jest.fn();
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel: cancelled });
  (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(source, { headers: { "Content-Type": "text/event-stream" } }));
  const response = await POST(request(), context());
  const reader = response.body!.getReader();
  expect((await reader.read()).value!.byteLength).toBe(8 * 1024 * 1024);
  await expect(reader.read()).rejects.toThrow("Harness tool stream is unavailable");
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect((global.fetch as jest.Mock).mock.calls[0][1].signal.aborted).toBe(true);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it("subscriber cancellation aborts the upstream observer without issuing an execution-cancel request", async () => {
  const cancelled = jest.fn();
  const source = new ReadableStream<Uint8Array>({ cancel: cancelled });
  (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(source, { headers: { "Content-Type": "text/event-stream" } }));
  const response = await POST(request(), context());
  await response.body!.cancel();
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect((global.fetch as jest.Mock).mock.calls[0][1].signal.aborted).toBe(true);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it("rejects an unsupported upstream content type without forwarding its body", async () => {
  (global.fetch as jest.Mock).mockResolvedValueOnce(new Response("private upstream detail", { headers: { "Content-Type": "text/plain" } }));
  const response = await POST(request(), context());
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("private upstream detail");
});

it("preserves an empty accepted MCP notification response", async () => {
  (global.fetch as jest.Mock).mockResolvedValueOnce(new Response("", { status: 202 }));
  const response = await POST(request(), context());
  expect(response.status).toBe(202);
  expect(await response.text()).toBe("");
});
