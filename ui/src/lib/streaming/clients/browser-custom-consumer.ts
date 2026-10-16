/**
 * Custom SSE protocol adapter.
 *
 * Consumes the legacy custom SSE format (event types: content, tool_start,
 * tool_end, input_required, context_usage, warning, error, done) and
 * translates them into protocol-agnostic StreamCallbacks.
 *
 * Routes (flat, conversation_id + protocol in body):
 *   POST /api/v1/chat/stream/start
 *   POST /api/v1/chat/stream/resume
 *   POST /api/v1/chat/stream/cancel
 */

import { parseContextUsageData,type InputFieldDefinition } from "@/lib/streaming/types";
import type { StreamAdapter } from "../adapter";
import type { RawStreamEvent,StreamCallbacks,StreamParams } from "../callbacks";
import type { RawSSEEvent } from "../parse-sse";
import type { RunStreamParams } from "../native-runs";
import { BrowserStreamTransport } from "./browser-stream-transport";

// ═══════════════════════════════════════════════════════════════
// CustomStreamAdapter
// ═══════════════════════════════════════════════════════════════

export class CustomStreamAdapter implements StreamAdapter {
  private transport: BrowserStreamTransport;

  constructor(accessToken?: string) {
    this.transport = new BrowserStreamTransport(accessToken);
  }

  abort(): void {
    this.transport.abort();
  }

  async cancelStream(conversationId: string, agentId: string, turnId?: string): Promise<boolean> {
    return this.transport.cancelStream(conversationId, agentId, turnId);
  }

  async streamMessage(params: StreamParams, callbacks: StreamCallbacks): Promise<void> {
    const body = JSON.stringify({
      message: params.message,
      conversation_id: params.conversationId,
      agent_id: params.agentId,
      ...(params.reasoningEffort && { reasoning_effort: params.reasoningEffort }),
      ...(params.turnId && { turn_id: params.turnId }),
      protocol: "custom",
      ...(params.clientContext && { client_context: params.clientContext }),
      ...(params.files?.length && { files: params.files }),
    });

    await this.transport.stream("start", body, params, callbacks, (raw) => this._consumeEvent(raw, callbacks));
  }

  async resumeStream(params: StreamParams, callbacks: StreamCallbacks): Promise<void> {
    const body = JSON.stringify({
      conversation_id: params.conversationId,
      agent_id: params.agentId,
      ...(params.reasoningEffort && { reasoning_effort: params.reasoningEffort }),
      ...(params.turnId && { turn_id: params.turnId }),
      resume_data: params.resumeData,
      protocol: "custom",
      ...(params.clientContext && { client_context: params.clientContext }),
    });

    await this.transport.stream("resume", body, params, callbacks, (raw) => this._consumeEvent(raw, callbacks));
  }

  async reattachStream(params: RunStreamParams, callbacks: StreamCallbacks): Promise<void> {
    await this.transport.reattach(params, callbacks, (raw) => this._consumeEvent(raw, callbacks));
  }

  private _consumeEvent(raw: RawSSEEvent, callbacks: StreamCallbacks): boolean {
    this._emitRawEvent(raw, callbacks);
    return this._dispatchEvent(raw, callbacks);
  }

  // ── Private: event dispatch ────────────────────────────────

  /**
   * Dispatch a single raw SSE event to the appropriate callback.
   * Returns true if this is a terminal event (stream should stop).
   */
  private _dispatchEvent(raw: RawSSEEvent, callbacks: StreamCallbacks): boolean {
    const { event, data } = raw;

    try {
      switch (event) {
        case "reasoning": {
          const parsed = JSON.parse(data);
          if (typeof parsed.text === "string") callbacks.onReasoning?.(parsed.text, parsed.namespace ?? []);
          return false;
        }
        case "content": {
          const parsed = JSON.parse(data);
          callbacks.onContent?.(parsed.text ?? "", parsed.namespace ?? []);
          return false;
        }

        case "tool_start": {
          const parsed = JSON.parse(data);
          callbacks.onToolStart?.(
            parsed.tool_call_id,
            parsed.tool_name,
            parsed.args,
            parsed.namespace ?? [],
          );
          return false;
        }

        case "tool_output": {
          const parsed = JSON.parse(data);
          callbacks.onToolOutput?.(parsed.tool_call_id, parsed.result, parsed.namespace ?? []);
          return false;
        }

        case "tool_end": {
          const parsed = JSON.parse(data);
          callbacks.onToolEnd?.(
            parsed.tool_call_id,
            undefined, // custom protocol doesn't include tool_name in tool_end
            parsed.error,
            parsed.namespace ?? [],
            undefined, // args (not sent in custom protocol tool_end)
            parsed.result,
          );
          return false;
        }

        case "input_required": {
          const parsed = JSON.parse(data);
          if (parsed.type === "tool_approval") {
            callbacks.onToolApprovalRequired?.(
              parsed.interrupt_id,
              parsed.tool_name,
              parsed.tool_args,
              parsed.allowed_decisions,
              parsed.agent,
              parsed.tool_approvals,
            );
          } else {
            callbacks.onInputRequired?.(
              parsed.interrupt_id,
              parsed.prompt,
              parsed.fields as InputFieldDefinition[],
              parsed.agent,
            );
          }
          return true; // terminal — stream pauses for user input
        }

        case "warning": {
          const parsed = JSON.parse(data);
          callbacks.onWarning?.(parsed.message, parsed.namespace ?? []);
          return false;
        }

        case "context_usage": {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const usage = parseContextUsageData(parsed);
          if (usage) {
            callbacks.onContextUsage?.(
              usage,
              (parsed.namespace as string[]) ?? [],
            );
          }
          return false;
        }

        case "done": {
          callbacks.onDone?.();
          return true;
        }

        case "error": {
          const parsed = JSON.parse(data);
          callbacks.onError?.(parsed.error || "Unknown error");
          return true;
        }

        default:
          // Unknown event type — skip
          return false;
      }
    } catch (e) {
      console.error(`[CustomAdapter] Failed to parse ${event} data:`, e, data);
      return false;
    }
  }

  /**
   * Emit a raw event for persistence / replay.
   */
  private _emitRawEvent(raw: RawSSEEvent, callbacks: StreamCallbacks): void {
    if (!callbacks.onRawEvent) return;

    let parsedData: unknown;
    try {
      parsedData = JSON.parse(raw.data);
    } catch {
      parsedData = raw.data;
    }

    const rawEvent: RawStreamEvent = {
      type: raw.event,
      data: parsedData,
      timestamp: Date.now(),
    };
    callbacks.onRawEvent(rawEvent);
  }
}
