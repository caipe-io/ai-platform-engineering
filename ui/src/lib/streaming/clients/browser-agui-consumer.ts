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
import type { RawSSEEvent } from "../parse-sse";
import type { RunStreamParams } from "../native-runs";
import { BrowserStreamTransport } from "./browser-stream-transport";
import {
createAGUIProtocolState,
processAGUIEvent,
resetProtocolState,
type AGUIProtocolState,
} from "../protocols/agui";

// ═══════════════════════════════════════════════════════════════
// AGUIStreamAdapter
// ═══════════════════════════════════════════════════════════════

export class AGUIStreamAdapter implements StreamAdapter {
  private transport: BrowserStreamTransport;
  private protocolState: AGUIProtocolState;

  constructor(accessToken?: string) {
    this.transport = new BrowserStreamTransport(accessToken);
    this.protocolState = createAGUIProtocolState();
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
      protocol: "agui",
      ...(params.clientContext && { client_context: params.clientContext }),
      ...(params.files?.length && { files: params.files }),
    });

    resetProtocolState(this.protocolState);
    await this.transport.stream("start", body, params, callbacks, (raw) => this._dispatchEvent(raw, callbacks));
  }

  async resumeStream(params: StreamParams, callbacks: StreamCallbacks): Promise<void> {
    const body = JSON.stringify({
      conversation_id: params.conversationId,
      agent_id: params.agentId,
      ...(params.reasoningEffort && { reasoning_effort: params.reasoningEffort }),
      ...(params.turnId && { turn_id: params.turnId }),
      resume_data: params.resumeData,
      protocol: "agui",
      ...(params.clientContext && { client_context: params.clientContext }),
    });

    resetProtocolState(this.protocolState);
    await this.transport.stream("resume", body, params, callbacks, (raw) => this._dispatchEvent(raw, callbacks));
  }

  async reattachStream(params: RunStreamParams, callbacks: StreamCallbacks): Promise<void> {
    resetProtocolState(this.protocolState);
    await this.transport.reattach(params, callbacks, (raw) => this._dispatchEvent(raw, callbacks));
  }

  private _dispatchEvent(raw: RawSSEEvent, callbacks: StreamCallbacks): boolean {
    this._emitRawEvent(raw, callbacks);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.data);
    } catch {
      console.error(`[AGUIAdapter] Failed to parse event data:`, raw.data);
      return false;
    }
    return processAGUIEvent(raw.event, parsed, this.protocolState, callbacks);
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
