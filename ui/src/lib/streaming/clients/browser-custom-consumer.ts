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
import { serverHistoryFromHeaders } from "../server-history";
import type { RawStreamEvent,StreamCallbacks,StreamParams } from "../callbacks";
import { parseSSEStream,type RawSSEEvent } from "../parse-sse";
import { buildStreamErrorFromResponse } from "../stream-error";

/** Flat API route prefix for chat streaming. */
const STREAM_BASE = "/api/v1/chat/stream";
const CANCEL_URL = `${STREAM_BASE}/cancel`;

// ═══════════════════════════════════════════════════════════════
// CustomStreamAdapter
// ═══════════════════════════════════════════════════════════════

export class CustomStreamAdapter implements StreamAdapter {
  private abortController: AbortController | null = null;

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async cancelStream(conversationId: string, agentId: string, options?: { keepSubscription?: boolean }): Promise<boolean> {
    if (!options?.keepSubscription) this.abort();

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };

      const response = await fetch(CANCEL_URL, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({
          conversation_id: conversationId,
          agent_id: agentId,
        }),
      });

      if (!response.ok) {
        console.error(`[CustomAdapter] Cancel failed: ${response.status}`);
        return false;
      }

      const result = await response.json();
      return result.cancelled ?? false;
    } catch (error) {
      console.error("[CustomAdapter] Cancel error:", error);
      return false;
    }
  }

  async streamMessage(params: StreamParams, callbacks: StreamCallbacks): Promise<void> {
    const url = `${STREAM_BASE}/start`;
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

    await this._stream(url, body, callbacks);
  }

  async resumeStream(params: StreamParams, callbacks: StreamCallbacks): Promise<void> {
    const url = `${STREAM_BASE}/resume`;
    const body = JSON.stringify({
      conversation_id: params.conversationId,
      agent_id: params.agentId,
      ...(params.reasoningEffort && { reasoning_effort: params.reasoningEffort }),
      resume_data: params.resumeData,
      ...(params.turnId && { turn_id: params.turnId }),
      protocol: "custom",
      ...(params.clientContext && { client_context: params.clientContext }),
    });

    await this._stream(url, body, callbacks);
  }

  async reconnectStream(params: StreamParams, callbacks: StreamCallbacks): Promise<void> {
    await this._stream(`${STREAM_BASE}/status`, JSON.stringify({
      conversation_id: params.conversationId, agent_id: params.agentId,
      protocol: "custom", replay: true,
    }), callbacks, true);
  }

  // ── Private: shared stream loop ────────────────────────────

  private async _stream(url: string, body: string, callbacks: StreamCallbacks, reconnect = false): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body,
        signal: this.abortController.signal,
      });

      const admission = serverHistoryFromHeaders(response.headers);
      if (admission) {
        if (admission.conversationId !== JSON.parse(body).conversation_id) {
          throw new Error("The runtime returned another conversation's history");
        }
        callbacks.onRunAdmission?.(admission);
      }
      if (!admission && ((!reconnect && (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 499))) ||
          response.headers.get("X-Harness-History-Owner") === "client")) callbacks.onClientHistory?.();
      if (reconnect && (response.status === 404 || response.status === 501 ||
          (response.ok && !admission))) return;

      if (!response.ok) {
        // Build a structured StreamError so the chat panel can distinguish
        // auth failures (toast + sign-in CTA) from generic backend errors
        // (inline error in the assistant turn). See lib/streaming/stream-error.ts.
        throw await buildStreamErrorFromResponse(response);
      }

      for await (const raw of parseSSEStream(response)) {
        this._emitRawEvent(raw, callbacks);
        const terminal = this._dispatchEvent(raw, callbacks);
        if (terminal) break;
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        // Client-side abort — not an error
        return;
      }
      throw error;
    } finally {
      this.abortController = null;
    }
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
          const parsed = data ? JSON.parse(data) : {};
          if (parsed.outcome === "cancelled") callbacks.onDone?.("cancelled");
          else callbacks.onDone?.();
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
