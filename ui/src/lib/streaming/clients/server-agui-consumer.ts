/**
 * Stream Consumer — Server-side headless AG-UI stream consumer.
 *
 * Opens an SSE connection to the DA server, processes events via the shared
 * AG-UI protocol state machine, creates StreamEvents, and persists them to
 * the event store incrementally.
 *
 * This is the server-side equivalent of what the browser DA chat panel does,
 * minus the Zustand state and UI rendering.
 */

import { appendEvents } from "@/lib/server/event-store";
import type { StreamCallbacks } from "../callbacks";
import { parseSSEStream } from "../parse-sse";
import {
createAGUIProtocolState,
processAGUIEvent,
resetProtocolState,
} from "../protocols/agui";
import type { StreamEvent } from "../types";
import { createStreamEvent } from "../types";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface ConsumeOptions {
  /** Full URL to POST to (DA server chat endpoint) */
  url: string;
  /** JSON request body */
  body: Record<string, unknown>;
  /** HTTP headers (including auth) */
  headers: Record<string, string>;
  /** Source type for event store */
  sourceType: "workflow_step" | "message";
  /** Source ID for event store (e.g. "wfrun-xxx-step-0") */
  sourceId: string;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface ConsumeResult {
  /** Accumulated text content from the stream */
  text: string;
  /** Whether the stream was interrupted (HITL) */
  interrupted: boolean;
  /** Interrupt details if interrupted */
  interrupt?: {
    type: "input_required" | "tool_approval";
    interruptId: string;
    prompt?: string;
    fields?: unknown[];
    agent?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolApprovals?: Array<{
      tool_name: string;
      tool_args: Record<string, unknown>;
      tool_call_id: string;
      allowed_decisions: string[];
    }>;
  };
  /** Error message if stream errored */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// Consumer
// ═══════════════════════════════════════════════════════════════

/** Batch size for event persistence (flush every N events) */
const EVENT_FLUSH_BATCH_SIZE = 10;

/**
 * Consume an AG-UI SSE stream from the DA server.
 *
 * Events are persisted incrementally to the event store.
 * Returns the final result (accumulated text, interrupt info, or error).
 */
export async function consumeAgentStream(options: ConsumeOptions): Promise<ConsumeResult> {
  const { url, body, headers, sourceType, sourceId, signal } = options;

  const state = createAGUIProtocolState();
  resetProtocolState(state);

  let accumulatedText = "";
  let interrupted = false;
  let interrupt: ConsumeResult["interrupt"] | undefined;
  let error: string | undefined;
  let pendingEvents: StreamEvent[] = [];

  // Build callbacks that create StreamEvents and buffer them
  const callbacks: StreamCallbacks = {
    onContent(text, namespace) {
      accumulatedText += text;
      pendingEvents.push(
        createStreamEvent("content", { text, namespace }),
      );
    },
    onToolStart(toolCallId, toolName, args, namespace) {
      pendingEvents.push(
        createStreamEvent("tool_start", {
          tool_call_id: toolCallId,
          tool_name: toolName,
          args,
          namespace: namespace ?? [],
        }),
      );
    },
    onToolOutput(toolCallId, result, namespace) {
      const event = createStreamEvent("tool_output", { tool_call_id: toolCallId, result, namespace });
      pendingEvents.push(event);
    },
    onToolEnd(toolCallId, toolName, err, namespace, args, result) {
      pendingEvents.push(
        createStreamEvent("tool_end", {
          tool_call_id: toolCallId,
          tool_name: toolName,
          error: err,
          args: args ? tryParseJSON(args) : undefined,
          result,
          namespace: namespace ?? [],
        }),
      );
    },
    onWarning(message, namespace) {
      pendingEvents.push(
        createStreamEvent("warning", { message, namespace: namespace ?? [] }),
      );
    },
    onError(message) {
      error = message;
      pendingEvents.push(
        createStreamEvent("error", { message, namespace: [] }),
      );
    },
    onInputRequired(interruptId, prompt, fields, agent) {
      interrupted = true;
      interrupt = { type: "input_required", interruptId, prompt, fields, agent };
      pendingEvents.push(
        createStreamEvent("input_required", {
          interrupt_id: interruptId,
          prompt,
          fields,
          agent,
          namespace: [],
        }),
      );
    },
    onToolApprovalRequired(interruptId, toolName, toolArgs, _allowedDecisions, agent, toolApprovals) {
      interrupted = true;
      interrupt = { type: "tool_approval", interruptId, toolName, toolArgs, agent, toolApprovals };
      // Store as input_required event type (UI treats both as interrupts)
      pendingEvents.push(
        createStreamEvent("input_required", {
          interrupt_id: interruptId,
          prompt: `Tool "${toolName}" requires approval`,
          fields: [],
          agent,
          namespace: [],
        }),
      );
    },
    onDone() {
      // No-op — handled by stream loop exit
    },
  };

  // Flush pending events to store
  async function flush(): Promise<void> {
    if (pendingEvents.length === 0) return;
    const batch = pendingEvents;
    pendingEvents = [];
    await appendEvents(sourceType, sourceId, batch);
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Accept": "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`DA server error: ${response.status} ${response.statusText}. ${errorBody}`);
    }

    for await (const raw of parseSSEStream(response)) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw.data);
      } catch {
        continue;
      }

      const terminal = processAGUIEvent(raw.event, parsed, state, callbacks);

      // Flush in batches
      if (pendingEvents.length >= EVENT_FLUSH_BATCH_SIZE) {
        await flush();
      }

      if (terminal) break;
    }

    // Final flush
    await flush();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      await flush();
      return { text: accumulatedText, interrupted: false, error: "Cancelled" };
    }
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const causeInfo = cause?.code ? ` (${cause.code})` : cause?.message ? ` (${cause.message})` : "";
    const msg = `${(err as Error).message || "Unknown error"}${causeInfo} — target: ${url}`;
    error = error || msg;

    // Create an error event so the UI timeline shows what went wrong
    pendingEvents.push(
      createStreamEvent("error", { message: error, namespace: [] }),
    );
    await flush();
  }

  return { text: accumulatedText, interrupted, interrupt, error };
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function tryParseJSON(str: string): Record<string, unknown> | undefined {
  try {
    const obj = JSON.parse(str);
    return typeof obj === "object" && obj !== null ? obj : undefined;
  } catch {
    return undefined;
  }
}
