/**
 * @jest-environment node
 */

// 098/streaming refactor moved the adapters under `clients/` and the
// public entry point became `createStreamAdapter({ protocol: "custom" })`.
// We still want to exercise the legacy class directly to keep the
// protocol-level assertions tight; import from the new location.
import { CustomStreamAdapter } from "../clients/browser-custom-consumer";
import type { StreamCallbacks } from "../callbacks";

const mockFetch = jest.fn();

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const chunks = frames.map((frame) => encoder.encode(frame));
  let index = 0;

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
        } else {
          controller.close();
        }
      },
    }),
    { status: 200 },
  );
}

function callbacks(): Required<StreamCallbacks> {
  return {
    onContent: jest.fn(),
    onToolStart: jest.fn(),
    onToolEnd: jest.fn(),
    onInputRequired: jest.fn(),
    onToolApprovalRequired: jest.fn(),
    onWarning: jest.fn(),
    onMemoryInjected: jest.fn(),
    onMemoryUpdate: jest.fn(),
    onDone: jest.fn(),
    onError: jest.fn(),
    onRawEvent: jest.fn(),
  };
}

beforeAll(() => {
  global.fetch = mockFetch;
  jest.spyOn(console, "error").mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, "now").mockReturnValue(123456);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe("CustomStreamAdapter", () => {
  it("streams custom protocol events into semantic callbacks and raw events", async () => {
    mockFetch.mockResolvedValue(
      sseResponse([
        'event: content\ndata: {"text":"hello","namespace":["agent"]}\n\n',
        'event: tool_start\ndata: {"tool_call_id":"call-1","tool_name":"search","args":{"q":"rbac"},"namespace":[]}\n\n',
        'event: tool_end\ndata: {"tool_call_id":"call-1","result":"ok","namespace":[]}\n\n',
        'event: warning\ndata: {"message":"careful","namespace":["agent"]}\n\n',
        'event: memory_injected\ndata: {"memory_ids":["mem-1"],"namespace":[]}\n\n',
        'event: memory_context_used\ndata: {"memory_ids":["mem-2"],"namespace":[]}\n\n',
        'event: memory_update\ndata: {"memory_ids":["mem-3"],"action":"remember","namespace":[]}\n\n',
        "event: unknown\ndata: ignored\n\n",
        "event: done\ndata: {}\n\n",
      ]),
    );
    const cb = callbacks();
    const adapter = new CustomStreamAdapter("token-1");

    await adapter.streamMessage(
      {
        message: "hello",
        conversationId: "conversation-1",
        agentId: "agent-1",
        clientContext: { activeTeam: "platform" },
        memoryEnabled: false,
        projectId: "pod-a",
      },
      cb,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/chat/stream/start",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          message: "hello",
          conversation_id: "conversation-1",
          agent_id: "agent-1",
          protocol: "custom",
          memory_enabled: false,
          project_id: "pod-a",
          client_context: { activeTeam: "platform" },
        }),
      }),
    );
    expect(cb.onContent).toHaveBeenCalledWith("hello", ["agent"]);
    expect(cb.onToolStart).toHaveBeenCalledWith(
      "call-1",
      "search",
      { q: "rbac" },
      [],
    );
    expect(cb.onToolEnd).toHaveBeenCalledWith(
      "call-1",
      undefined,
      undefined,
      [],
      undefined,
      "ok",
    );
    expect(cb.onWarning).toHaveBeenCalledWith("careful", ["agent"]);
    expect(cb.onMemoryInjected).toHaveBeenNthCalledWith(1, ["mem-1"], []);
    expect(cb.onMemoryInjected).toHaveBeenNthCalledWith(2, ["mem-2"], []);
    expect(cb.onMemoryUpdate).toHaveBeenCalledWith(["mem-3"], "remember", []);
    expect(cb.onDone).toHaveBeenCalledTimes(1);
    expect(cb.onRawEvent).toHaveBeenCalledWith({
      type: "content",
      data: { text: "hello", namespace: ["agent"] },
      timestamp: 123456,
    });
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it("uses the resume endpoint and stops at input_required form requests", async () => {
    mockFetch.mockResolvedValue(
      sseResponse([
        'event: input_required\ndata: {"interrupt_id":"int-1","prompt":"Need input","fields":[{"field_name":"repo","field_type":"text"}],"agent":"helper"}\n\n',
        'event: content\ndata: {"text":"after terminal"}\n\n',
      ]),
    );
    const cb = callbacks();
    const adapter = new CustomStreamAdapter();

    await adapter.resumeStream(
      {
        conversationId: "conversation-1",
        agentId: "agent-1",
        resumeData: '{"repo":"demo"}',
      },
      cb,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/chat/stream/resume",
      expect.objectContaining({
        body: JSON.stringify({
          conversation_id: "conversation-1",
          agent_id: "agent-1",
          resume_data: '{"repo":"demo"}',
          protocol: "custom",
          memory_enabled: true,
        }),
      }),
    );
    expect(cb.onInputRequired).toHaveBeenCalledWith(
      "int-1",
      "Need input",
      [{ field_name: "repo", field_type: "text" }],
      "helper",
    );
    expect(cb.onContent).not.toHaveBeenCalled();
  });

  it("dispatches tool approval requests as terminal HITL events", async () => {
    mockFetch.mockResolvedValue(
      sseResponse([
        'event: input_required\ndata: {"type":"tool_approval","interrupt_id":"approval-1","tool_name":"delete_file","tool_args":{"path":"/tmp/a"},"allowed_decisions":["approve","reject"],"agent":"helper"}\n\n',
      ]),
    );
    const cb = callbacks();

    await new CustomStreamAdapter().streamMessage(
      { message: "delete", conversationId: "conversation-1", agentId: "agent-1" },
      cb,
    );

    // 098 added a 6th `toolApprovals` parameter (batched gated tool calls).
    // The custom protocol doesn't emit it, so it's expected to be undefined.
    expect(cb.onToolApprovalRequired).toHaveBeenCalledWith(
      "approval-1",
      "delete_file",
      { path: "/tmp/a" },
      ["approve", "reject"],
      "helper",
      undefined,
    );
    expect(cb.onInputRequired).not.toHaveBeenCalled();
  });

  it("dispatches terminal error events and skips malformed JSON events", async () => {
    mockFetch.mockResolvedValue(
      sseResponse([
        "event: content\ndata: not-json\n\n",
        'event: error\ndata: {"error":"backend failed"}\n\n',
      ]),
    );
    const cb = callbacks();

    await new CustomStreamAdapter().streamMessage(
      { message: "hello", conversationId: "conversation-1", agentId: "agent-1" },
      cb,
    );

    expect(cb.onContent).not.toHaveBeenCalled();
    expect(cb.onError).toHaveBeenCalledWith("backend failed");
  });

  it("cancels streams with bearer auth and handles failed cancellation", async () => {
    const adapter = new CustomStreamAdapter("token-1");

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ cancelled: true }), { status: 200 }),
    );
    await expect(adapter.cancelStream("conversation-1", "agent-1")).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/chat/stream/cancel",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          conversation_id: "conversation-1",
          agent_id: "agent-1",
        }),
      }),
    );

    mockFetch.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(adapter.cancelStream("conversation-1", "agent-1")).resolves.toBe(false);

    mockFetch.mockRejectedValueOnce(new Error("network"));
    await expect(adapter.cancelStream("conversation-1", "agent-1")).resolves.toBe(false);
  });

  it("returns quietly on client-side abort errors", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    mockFetch.mockRejectedValue(abortError);

    await expect(
      new CustomStreamAdapter().streamMessage(
        { message: "hello", conversationId: "conversation-1", agentId: "agent-1" },
        callbacks(),
      ),
    ).resolves.toBeUndefined();
  });
});
