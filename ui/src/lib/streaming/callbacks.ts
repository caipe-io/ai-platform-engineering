/**
 * StreamCallbacks — the stable semantic interface between protocol adapters and UI consumers.
 *
 * Components never see wire events. They receive semantic callbacks that describe
 * what happened (content arrived, tool started, input needed, etc.) without
 * exposing any protocol-specific details.
 *
 * All callbacks are optional — adapters check before calling.
 */

import type { InputFieldDefinition } from "@/lib/streaming/types";

// ═══════════════════════════════════════════════════════════════
// Raw event type for persistence / replay
// ═══════════════════════════════════════════════════════════════

/**
 * Minimal wire event record for storage and replay.
 * Adapters emit one of these via onRawEvent for every wire-level event.
 * The UI stores these in the turns collection for timeline reconstruction.
 */
export interface RawStreamEvent {
  /** Wire event type (e.g. "content", "tool_start", "TEXT_MESSAGE_CONTENT") */
  type: string;
  /** Parsed event data (protocol-specific shape) */
  data: unknown;
  /** Unix timestamp in milliseconds */
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════
// Stream parameters
// ═══════════════════════════════════════════════════════════════

/**
 * Parameters for initiating or resuming a stream.
 * Protocol adapters transform these into the backend's expected request format.
 */
export interface StreamParams {
  /** User message text (for new messages) */
  message?: string;
  /** Conversation / thread ID */
  conversationId: string;
  /** Agent config ID (determines routing in unified gateway) */
  agentId: string;
  /** JSON-stringified resume data (for HITL resume — form input or tool approval) */
  resumeData?: string;
  /** Turn ID for request/response pairing */
  turnId?: string;
  /** Client source identifier */
  source?: string;
  /** Additional properties forwarded to the backend */
  forwardedProps?: Record<string, unknown>;
  /** Opaque client context passed to the backend for system prompt rendering */
  clientContext?: Record<string, unknown>;
  /**
   * Multimodal attachments for this turn. Forwarded verbatim as the request's
   * top-level `files` field; the backend maps each to an image/document block.
   */
  files?: Array<{ mime_type: string; data: string; name: string }>;
  /** Whether memory should be injected and memory tools enabled for this chat run */
  memoryEnabled?: boolean;
  /** Immutable Project selected when the conversation was created */
  projectId?: string;
}

// ═══════════════════════════════════════════════════════════════
// StreamCallbacks
// ═══════════════════════════════════════════════════════════════

export interface StreamCallbacks {
  /** Streaming text content arrived */
  onContent?(text: string, namespace: string[]): void;

  /** A tool invocation started */
  onToolStart?(
    toolCallId: string,
    toolName: string,
    args?: Record<string, unknown>,
    namespace?: string[],
  ): void;

  /** A tool invocation completed (with optional error and accumulated args) */
  onToolEnd?(
    toolCallId: string,
    toolName?: string,
    error?: string,
    namespace?: string[],
    args?: string,
    result?: string,
  ): void;

  /** Agent is requesting user input via a form (HITL) */
  onInputRequired?(
    interruptId: string,
    prompt: string,
    fields: InputFieldDefinition[],
    agent: string,
  ): void;

  /** Agent tool call requires human approval (HITL) */
  onToolApprovalRequired?(
    interruptId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    allowedDecisions: string[],
    agent: string,
    /** When the LLM batches multiple gated tool calls in one AI message */
    toolApprovals?: Array<{
      tool_name: string;
      tool_args: Record<string, unknown>;
      tool_call_id: string;
      allowed_decisions: string[];
    }>,
  ): void;

  /** Non-fatal warning from the agent */
  onWarning?(message: string, namespace?: string[]): void;

  /** Memory records were injected into model context for this chat run */
  onMemoryInjected?(memoryIds: string[], namespace?: string[]): void;

  /** Durable memory was changed by a memory file edit */
  onMemoryUpdate?(memoryIds: string[], action?: string, namespace?: string[]): void;

  /** Stream completed successfully */
  onDone?(): void;

  /** Unrecoverable error */
  onError?(message: string): void;

  /** Raw wire event for persistence / replay (fired for every event) */
  onRawEvent?(event: RawStreamEvent): void;
}
