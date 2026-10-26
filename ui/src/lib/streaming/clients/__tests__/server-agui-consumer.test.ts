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
});
