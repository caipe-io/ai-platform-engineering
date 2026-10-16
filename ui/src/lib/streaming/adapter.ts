/**
 * StreamAdapter — protocol-agnostic interface for consuming SSE streams.
 *
 * Mirror of the backend StreamEncoder ABC. Components call adapter methods
 * and receive semantic callbacks — they never see wire events.
 *
 * The factory creates the appropriate adapter based on the protocol config.
 *
 * Routes (flat, conversation_id + protocol in body):
 *   POST /api/v1/chat/stream/start   → streamMessage
 *   POST /api/v1/chat/stream/resume   → resumeStream
 *   POST /api/v1/chat/stream/cancel   → cancelStream
 */

import type { StreamCallbacks,StreamParams } from "./callbacks";
import { AGUIStreamAdapter } from "./clients/browser-agui-consumer";
import { CustomStreamAdapter } from "./clients/browser-custom-consumer";
import type { RunStreamParams } from "./native-runs";

// ═══════════════════════════════════════════════════════════════
// Adapter interface
// ═══════════════════════════════════════════════════════════════

export interface StreamAdapter {
  /** Stream events for a new user message */
  streamMessage(params: StreamParams, callbacks: StreamCallbacks): Promise<void>;

  /** Resume streaming after HITL form submission */
  resumeStream(params: StreamParams, callbacks: StreamCallbacks): Promise<void>;

  /** Replay and follow an admitted run without starting or resuming execution. */
  reattachStream(params: RunStreamParams, callbacks: StreamCallbacks): Promise<void>;

  /** Cancel the stream on the backend */
  cancelStream(conversationId: string, agentId: string, turnId?: string): Promise<boolean>;

  /** Abort the client-side HTTP connection */
  abort(): void;
}

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

export interface StreamAdapterConfig {
  /** Wire protocol: "custom" for legacy SSE, "agui" for AG-UI */
  protocol: "custom" | "agui";
  /** JWT access token for Bearer authentication */
  accessToken?: string;
}

/**
 * Create a protocol-specific stream adapter.
 *
 * The adapter owns the HTTP lifecycle (fetch, abort, error handling).
 * Callers just provide StreamCallbacks.
 *
 * Routes are flat — conversation_id and protocol are in the request body:
 *   /api/v1/chat/stream/start
 *   /api/v1/chat/stream/resume
 *   /api/v1/chat/stream/cancel
 */
export function createStreamAdapter(config: StreamAdapterConfig): StreamAdapter {
  switch (config.protocol) {
    case "agui":
      return new AGUIStreamAdapter(config.accessToken);
    case "custom":
    default:
      return new CustomStreamAdapter(config.accessToken);
  }
}
