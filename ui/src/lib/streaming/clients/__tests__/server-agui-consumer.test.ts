/** @jest-environment node */

jest.mock("@/lib/server/event-store", () => ({ appendEvents: jest.fn().mockResolvedValue(undefined) }));

import { appendEvents } from "@/lib/server/event-store";
import { consumeAgentStream } from "../server-agui-consumer";

const options = {
  url: "https://example.test/api/v1/chat/stream/start",
  body: {},
  headers: {},
  sourceType: "workflow_step" as const,
  sourceId: "test-run-step-1",
};

function frame(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

describe("workflow stream completion", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function respond(body: string): void {
    (global.fetch as jest.Mock).mockResolvedValue(new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    }));
  }

  it("fails and persists an error when the connection ends before a terminal event", async () => {
    respond(frame("TEXT_MESSAGE_CONTENT", { delta: "Partial answer" }));
    const result = await consumeAgentStream(options);
    expect(result.error).toContain("without a completion event");
    expect(result.text).toBe("Partial answer");
    expect(appendEvents).toHaveBeenCalledWith("workflow_step", options.sourceId,
      expect.arrayContaining([expect.objectContaining({ type: "error" })]));
  });

  it("preserves an actionable truncation error instead of marking the step completed", async () => {
    respond(frame("RUN_ERROR", { code: "MODEL_OUTPUT_TRUNCATED", message: "Output limit reached; task is incomplete." }));
    const result = await consumeAgentStream(options);
    expect(result.error).toBe("Output limit reached; task is incomplete.");
    expect(result.interrupted).toBe(false);
  });

  it("accepts an explicitly completed tool-only step", async () => {
    respond(frame("RUN_FINISHED", { outcome: "success" }));
    expect(await consumeAgentStream(options)).toMatchObject({ text: "", interrupted: false, error: undefined });
  });

  it("preserves pending user input as an interrupt", async () => {
    respond(frame("RUN_FINISHED", {
      outcome: "interrupt",
      interrupt: { id: "test-input", reason: "human_input", payload: { prompt: "Choose a region", fields: [] } },
    }));
    expect(await consumeAgentStream(options)).toMatchObject({
      interrupted: true,
      error: undefined,
      interrupt: { interruptId: "test-input", prompt: "Choose a region" },
    });
  });

  function hang(body: string, intervalBody?: string): void {
    (global.fetch as jest.Mock).mockImplementation(async (_url, init: RequestInit) => {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          const timer = intervalBody ? setInterval(() => controller.enqueue(encoder.encode(intervalBody)), 10) : undefined;
          init.signal!.addEventListener("abort", () => {
            clearInterval(timer);
            controller.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
      }));
    });
  }

  it("persists a tool result before completion and stops a silent stream without permitting replay", async () => {
    jest.useFakeTimers();
    hang(frame("TOOL_CALL_START", { toolCallId: "write-1", toolCallName: "update_resource" }) +
      frame("TOOL_CALL_RESULT", { tool_call_id: "write-1", content: "committed" }) +
      frame("TOOL_CALL_END", { toolCallId: "write-1" }), ": heartbeat\n\n");
    const pending = consumeAgentStream({ ...options, idleTimeoutMs: 100 });
    await jest.advanceTimersByTimeAsync(50);
    expect(appendEvents).toHaveBeenCalledWith("workflow_step", options.sourceId,
      expect.arrayContaining([expect.objectContaining({ type: "tool_end", toolData: expect.objectContaining({ result: "committed" }) })]));
    await jest.advanceTimersByTimeAsync(51);
    expect(await pending).toMatchObject({ error: expect.stringContaining("stopped making progress"), retryable: false });
  });

  it("enforces the absolute deadline even when content keeps arriving", async () => {
    jest.useFakeTimers();
    hang(frame("RUN_STARTED"), frame("TEXT_MESSAGE_CONTENT", { delta: "progress" }));
    const pending = consumeAgentStream({ ...options, idleTimeoutMs: 100, maxDurationMs: 50 });
    await jest.advanceTimersByTimeAsync(51);
    expect(await pending).toMatchObject({ error: expect.stringContaining("execution deadline") });
  });

  it("bounds waiting for response headers without assuming the request was not admitted", async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const pending = consumeAgentStream({ ...options, idleTimeoutMs: 100 });
    await jest.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ retryable: false, error: expect.stringContaining("stopped making progress") });
  });

  it("does not retry a disconnected stream after a tool was admitted", async () => {
    respond(frame("TOOL_CALL_START", { toolCallId: "write-1", toolCallName: "update_resource" }));
    expect(await consumeAgentStream(options)).toMatchObject({ retryable: false, error: expect.stringContaining("without a completion event") });
  });

  it("cleans up deadlines after a successful terminal event", async () => {
    jest.useFakeTimers();
    respond(frame("RUN_FINISHED", { outcome: "success" }));
    await consumeAgentStream(options);
    expect(jest.getTimerCount()).toBe(0);
  });
});
