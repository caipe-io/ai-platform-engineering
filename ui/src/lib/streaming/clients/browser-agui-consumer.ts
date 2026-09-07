/**
 * AG-UI Browser Client
 *
 * Browser-side streaming client for the AG-UI protocol. Handles fetch,
 * AbortController, and raw event emission. Delegates protocol logic
 * (event parsing, state tracking, callback dispatch) to protocols/agui.ts.
 *
 * Routes (flat, conversation_id + protocol in body):
 *   POST /api/v1/chat/stream/start
 *   POST /api/v1/chat/stream/resume
 *   POST /api/v1/chat/stream/cancel
 */

import type { StreamAdapter } from "../adapter";
import type { RawStreamEvent,StreamCallbacks,StreamParams } from "../callbacks";
import { parseSSEStream,type RawSSEEvent } from "../parse-sse";
import {
createAGUIProtocolState,
processAGUIEvent,
resetProtocolState,
type AGUIProtocolState,
} from "../protocols/agui";

/** Flat API route prefix for chat streaming. */
const STREAM_BASE = "/api/v1/chat/stream";
const CANCEL_URL = `${STREAM_BASE}/cancel`;

// ═══════════════════════════════════════════════════════════════
// AGUIStreamAdapter
// ═══════════════════════════════════════════════════════════════

export class AGUIStreamAdapter implements StreamAdapter {
  private accessToken?: string;
  private abortController: AbortController | null = null;
  private protocolState: AGUIProtocolState;

  constructor(accessToken?: string) {
    this.accessToken = accessToken;
    this.protocolState = createAGUIProtocolState();
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async cancelStream(conversationId: string, agentId: string): Promise<boolean> {
    this.abort();

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.accessToken) {
        headers["Authorization"] = `Bearer ${this.accessToken}`;
      }

      const response = await fetch(CANCEL_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          conversation_id: conversationId,
          agent_id: agentId,
        }),
      });

      if (!response.ok) {
        console.error(`[AGUIAdapter] Cancel failed: ${response.status}`);
        return false;
      }

      const result = await response.json();
      return result.cancelled ?? false;
    } catch (error) {
      console.error("[AGUIAdapter] Cancel error:", error);
      return false;
    }
  }

  async streamMessage(params: StreamParams, callbacks: StreamCallbacks): Promise<void> {
    const url = `${STREAM_BASE}/start`;
    const body = JSON.stringify({
      message: params.message,
      conversation_id: params.conversationId,
      agent_id: params.agentId,
      protocol: "agui",
      memory_enabled: params.memoryEnabled ?? true,
      project_id: params.projectId,
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
      resume_data: params.resumeData,
      protocol: "agui",
      memory_enabled: params.memoryEnabled ?? true,
      project_id: params.projectId,
      ...(params.clientContext && { client_context: params.clientContext }),
    });

    await this._stream(url, body, callbacks);
  }

  // ── Private: shared stream loop ────────────────────────────

  private async _stream(url: string, body: string, callbacks: StreamCallbacks): Promise<void> {
    resetProtocolState(this.protocolState);

    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    };
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(
            "Session expired: Your authentication token has expired. " +
            "Please save your work and log in again.",
          );
        }
        const errorBody = await response.text().catch(() => "");
        throw new Error(
          `HTTP error: ${response.status} ${response.statusText}. ${errorBody || "(empty)"}`,
        );
      }

      for await (const raw of parseSSEStream(response)) {
        this._emitRawEvent(raw, callbacks);

        // Parse and dispatch via protocol state machine
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw.data);
        } catch {
          console.error(`[AGUIAdapter] Failed to parse event data:`, raw.data);
          continue;
        }

        const terminal = processAGUIEvent(raw.event, parsed, this.protocolState, callbacks);
        if (terminal) break;
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return;
      }
      throw error;
    } finally {
      this.abortController = null;
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
