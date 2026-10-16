/** @jest-environment node */

import { createStreamAdapter } from "../adapter";
import { StreamError } from "../stream-error";

const mockFetch = jest.fn();
const runId = "run-example";
const params = { conversationId: "conversation-1", agentId: "agent-1", turnId: "turn-1", message: "inspect" };

function stream(frames: Array<[number, string, unknown]>): Response {
  const text = frames.map(([sequence, event, data]) =>
    `id: ${runId}:${sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  ).join("");
  return new Response(text, { headers: { "X-CAIPE-Run-Id": runId } });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  global.fetch = mockFetch;
});

afterEach(() => {
  jest.useRealTimers();
});

it("reconnects by cursor, deduplicates replay, and never sends the prompt again", async () => {
  mockFetch.mockResolvedValueOnce(stream([[1, "content", { text: "first " }]]));
  mockFetch.mockResolvedValueOnce(stream([
    [1, "content", { text: "first " }],
    [2, "content", { text: "second" }],
    [3, "done", {}],
    [4, "CAIPE_RUN_STATUS", { run_id: runId, status: "completed" }],
  ]));
  const callbacks = { onContent: jest.fn(), onDone: jest.fn(), onConnectionState: jest.fn() };
  const result = createStreamAdapter({ protocol: "custom" }).streamMessage(params, callbacks);
  await jest.runAllTimersAsync();
  await result;

  expect(callbacks.onContent.mock.calls.map(([text]) => text).join("")).toBe("first second");
  expect(callbacks.onDone).toHaveBeenCalledTimes(1);
  expect(callbacks.onConnectionState).toHaveBeenCalledWith("reconnecting");
  expect(mockFetch.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  expect(mockFetch).toHaveBeenLastCalledWith(
    "/api/v1/chat/runs/run-example/stream?conversation_id=conversation-1&agent_id=agent-1&after=1",
    expect.objectContaining({ cache: "no-store" }),
  );
});

it("retains AG-UI namespace and partial tool arguments while reattaching", async () => {
  mockFetch.mockResolvedValueOnce(stream([
    [1, "RUN_STARTED", { runId }],
    [2, "CUSTOM", { name: "NAMESPACE_CONTEXT", value: { namespace: ["child"] } }],
    [3, "TOOL_CALL_START", { toolCallId: "tool-1", toolCallName: "write_file" }],
    [4, "TOOL_CALL_ARGS", { toolCallId: "tool-1", delta: '{"path":' }],
  ]));
  mockFetch.mockResolvedValueOnce(stream([
    [5, "TOOL_CALL_ARGS", { toolCallId: "tool-1", delta: '"/logical.txt"}' }],
    [6, "TOOL_CALL_END", { toolCallId: "tool-1" }],
    [7, "RUN_FINISHED", { runId }],
    [8, "CAIPE_RUN_STATUS", { run_id: runId, status: "completed" }],
  ]));
  const callbacks = { onToolStart: jest.fn(), onToolEnd: jest.fn(), onDone: jest.fn() };
  const result = createStreamAdapter({ protocol: "agui" }).streamMessage(params, callbacks);
  await jest.runAllTimersAsync();
  await result;

  expect(callbacks.onToolStart).toHaveBeenLastCalledWith("tool-1", "write_file", { path: "/logical.txt" }, ["child"]);
  expect(callbacks.onToolEnd).toHaveBeenCalledWith("tool-1", "write_file", undefined, ["child"], '{"path":"/logical.txt"}', undefined);
  expect(callbacks.onDone).toHaveBeenCalledTimes(1);
});

it("recovers a lost admission response by the same turn ID instead of repeating POST", async () => {
  mockFetch.mockRejectedValueOnce(new TypeError("network failed"));
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ run: { run_id: runId, turn_id: params.turnId } })));
  mockFetch.mockResolvedValueOnce(stream([
    [1, "content", { text: "recovered" }],
    [2, "done", {}],
    [3, "CAIPE_RUN_STATUS", { run_id: runId, status: "completed" }],
  ]));
  const callbacks = { onContent: jest.fn() };
  const result = createStreamAdapter({ protocol: "custom" }).streamMessage(params, callbacks);
  await jest.runAllTimersAsync();
  await result;

  expect(callbacks.onContent).toHaveBeenCalledWith("recovered", []);
  expect(mockFetch.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
});

it("reports an interrupted durable run without treating the event as a network failure", async () => {
  mockFetch.mockResolvedValueOnce(stream([[1, "CAIPE_RUN_STATUS", { run_id: runId, status: "interrupted" }]]));
  const callbacks = { onRunStatus: jest.fn(), onError: jest.fn(), onDone: jest.fn() };
  await createStreamAdapter({ protocol: "agui" }).reattachStream({ ...params, runId }, callbacks);

  expect(callbacks.onRunStatus).toHaveBeenCalledWith("interrupted");
  expect(callbacks.onError).toHaveBeenCalledWith("Run interrupted. Saved progress is retained.");
  expect(callbacks.onDone).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it.each(["custom", "agui"] as const)("preserves the actionable %s error when the durable failure marker follows", async (protocol) => {
  const message = "The selected model has no configured provider";
  const nativeError: [number, string, unknown] = protocol === "custom"
    ? [1, "error", { error: message }]
    : [1, "RUN_ERROR", { message }];
  mockFetch.mockResolvedValueOnce(stream([
    nativeError,
    [2, "CAIPE_RUN_STATUS", { run_id: runId, status: "failed" }],
  ]));
  const callbacks = { onError: jest.fn(), onRunStatus: jest.fn() };
  await createStreamAdapter({ protocol }).reattachStream({ ...params, runId }, callbacks);
  expect(callbacks.onError).toHaveBeenCalledTimes(1);
  expect(callbacks.onError).toHaveBeenCalledWith(message);
  expect(callbacks.onRunStatus).toHaveBeenCalledWith("failed");
});

it("fails closed on a missing event rather than silently corrupting the timeline", async () => {
  mockFetch.mockResolvedValueOnce(stream([[2, "content", { text: "gap" }]]));
  const callbacks = { onContent: jest.fn() };
  await expect(createStreamAdapter({ protocol: "custom" }).reattachStream({ ...params, runId }, callbacks))
    .rejects.toMatchObject({ status: 410 });
  expect(callbacks.onContent).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it.each([401, 403, 410])("does not retry a denied or expired replay (%s)", async (status) => {
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Replay unavailable" }), { status }));
  await expect(createStreamAdapter({ protocol: "custom" }).reattachStream({ ...params, runId }, {}))
    .rejects.toBeInstanceOf(StreamError);
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it("honors Stop before admission without creating a run after history persistence", async () => {
  const adapter = createStreamAdapter({ protocol: "custom" });
  await expect(adapter.cancelStream(params.conversationId, params.agentId, params.turnId)).resolves.toBe(true);
  const callbacks = { onRunStatus: jest.fn(), onError: jest.fn() };
  await adapter.streamMessage(params, callbacks);
  expect(mockFetch).not.toHaveBeenCalled();
  expect(callbacks.onRunStatus).toHaveBeenCalledWith("cancelled");
});

it("retries scoped Stop while admission is pending and waits for the actual cancelled marker", async () => {
  let cancelCount = 0;
  mockFetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/start")) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return stream([[1, "CAIPE_RUN_STATUS", { run_id: runId, status: "cancelled" }]]);
    }
    if (url.endsWith("/cancel")) {
      cancelCount += 1;
      return new Response(JSON.stringify({ cancelled: cancelCount > 1 }));
    }
    return new Response(JSON.stringify({ run: { run_id: runId, turn_id: params.turnId, status: "running" } }));
  });
  const adapter = createStreamAdapter({ protocol: "custom" });
  const callbacks = { onRunStatus: jest.fn(), onDone: jest.fn() };
  const execution = adapter.streamMessage(params, callbacks);
  const cancellation = adapter.cancelStream(params.conversationId, params.agentId, params.turnId);
  await jest.runAllTimersAsync();
  await expect(cancellation).resolves.toBe(true);
  await execution;

  expect(cancelCount).toBe(2);
  expect(callbacks.onRunStatus).toHaveBeenCalledWith("cancelled");
  expect(callbacks.onDone).not.toHaveBeenCalled();
  for (const [url, init] of mockFetch.mock.calls.filter(([url]) => url.endsWith("/cancel"))) {
    expect(url).toBe("/api/v1/chat/stream/cancel");
    expect(JSON.parse(init.body)).toEqual({ conversation_id: params.conversationId, agent_id: params.agentId, turn_id: params.turnId });
  }
});

it("starts a resumed segment at the admitted cursor and never resets it on reconnect", async () => {
  const first = stream([[8, "content", { text: "resumed " }]]);
  first.headers.set("X-CAIPE-First-Sequence", "7");
  const second = stream([[8, "content", { text: "duplicate" }], [9, "content", { text: "answer" }], [10, "CAIPE_RUN_STATUS", { run_id: runId, status: "completed" }]]);
  second.headers.set("X-CAIPE-First-Sequence", "99");
  mockFetch.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const callbacks = { onContent: jest.fn(), onDone: jest.fn() };
  const result = createStreamAdapter({ protocol: "custom" }).resumeStream({ ...params, resumeData: JSON.stringify({ type: "tool_approval", interrupt_id: "approval-1", decision: "reject" }) }, callbacks);
  await jest.runAllTimersAsync();
  await result;
  expect(callbacks.onContent.mock.calls.map(([text]) => text).join("")).toBe("resumed answer");
  expect(mockFetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  expect(mockFetch.mock.calls[1][0]).toContain("after=8");
});

it("reattaches only the current resume segment after reload", async () => {
  mockFetch.mockResolvedValueOnce(stream([[5, "content", { text: "current segment" }], [6, "CAIPE_RUN_STATUS", { run_id: runId, status: "completed" }]]));
  const callbacks = { onContent: jest.fn() };
  await createStreamAdapter({ protocol: "custom" }).reattachStream({ ...params, runId, firstSequence: 4 }, callbacks);
  expect(mockFetch.mock.calls[0][0]).toContain("after=4");
  expect(callbacks.onContent).toHaveBeenCalledWith("current segment", []);
});

it("discovers the current segment after a lost resume admission response", async () => {
  mockFetch.mockRejectedValueOnce(new TypeError("lost response"));
  mockFetch.mockResolvedValueOnce(Response.json({ run: { run_id: runId, turn_id: params.turnId, first_sequence: 4 } }));
  const replay = stream([[5, "content", { text: "recovered resume" }], [6, "CAIPE_RUN_STATUS", { run_id: runId, status: "completed" }]]);
  replay.headers.set("X-CAIPE-First-Sequence", "4");
  mockFetch.mockResolvedValueOnce(replay);
  const callbacks = { onContent: jest.fn() };
  const result = createStreamAdapter({ protocol: "custom" }).resumeStream({ ...params, resumeData: '{"type":"form_input","interrupt_id":"input-1","values":{}}' }, callbacks);
  await jest.runAllTimersAsync();
  await result;
  expect(mockFetch.mock.calls[2][0]).toContain("after=4");
  expect(callbacks.onContent).toHaveBeenCalledWith("recovered resume", []);
  expect(mockFetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
});

it.each(["-1", "1.5", "9007199254740992", ""])("rejects an invalid segment cursor header %p", async (value) => {
  const response = stream([[1, "content", { text: "untrusted" }]]);
  response.headers.set("X-CAIPE-First-Sequence", value);
  mockFetch.mockResolvedValueOnce(response);
  const callbacks = { onContent: jest.fn() };
  await expect(createStreamAdapter({ protocol: "custom" }).streamMessage(params, callbacks)).rejects.toMatchObject({ status: 502 });
  expect(callbacks.onContent).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
