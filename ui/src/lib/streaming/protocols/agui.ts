/**
 * AG-UI Protocol State Machine (Pure Logic — No I/O)
 *
 * Extracted from AGUIStreamAdapter to enable reuse by both the browser client
 * and the server-side stream consumer.
 *
 * This module:
 * - Tracks AG-UI protocol state (namespace, tool buffers, runId)
 * - Processes raw parsed AG-UI events
 * - Fires semantic StreamCallbacks
 * - Has NO fetch, no AbortController, no DOM APIs
 */

import type { StreamCallbacks } from "../callbacks";
import type { InputFieldDefinition } from "../types";

// ═══════════════════════════════════════════════════════════════
// AG-UI event type constants
// ═══════════════════════════════════════════════════════════════

export const AGUI = {
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  CUSTOM: "CUSTOM",
} as const;

// CUSTOM event names
const CUSTOM_NAMESPACE_CONTEXT = "NAMESPACE_CONTEXT";
const CUSTOM_WARNING = "WARNING";
const CUSTOM_INPUT_REQUIRED = "INPUT_REQUIRED";
const CUSTOM_MEMORY_INJECTED = "MEMORY_INJECTED";
const CUSTOM_MEMORY_CONTEXT_USED = "MEMORY_CONTEXT_USED";
const CUSTOM_MEMORY_UPDATED = "MEMORY_UPDATED";
const CUSTOM_MEMORY_UPDATE = "MEMORY_UPDATE";

// ═══════════════════════════════════════════════════════════════
// Protocol State
// ═══════════════════════════════════════════════════════════════

export interface AGUIProtocolState {
  /** Current namespace (set by NAMESPACE_CONTEXT custom events) */
  currentNamespace: string[];
  /** Maps tool call IDs to tool names (from TOOL_CALL_START) */
  toolCallIdToName: Map<string, string>;
  /** Accumulates streaming tool call args (from TOOL_CALL_ARGS deltas) */
  toolCallArgs: Map<string, string>;
  /** Buffers tool call results (from TOOL_CALL_RESULT, no callback fired) */
  toolCallResults: Map<string, string>;
  /** Run ID captured from RUN_STARTED */
  runId: string;
}

/** Create a fresh protocol state (call at stream start). */
export function createAGUIProtocolState(): AGUIProtocolState {
  return {
    currentNamespace: [],
    toolCallIdToName: new Map(),
    toolCallArgs: new Map(),
    toolCallResults: new Map(),
    runId: "",
  };
}

/** Reset protocol state in-place (reuse existing object). */
export function resetProtocolState(state: AGUIProtocolState): void {
  state.currentNamespace = [];
  state.toolCallIdToName.clear();
  state.toolCallArgs.clear();
  state.toolCallResults.clear();
  state.runId = "";
}

// ═══════════════════════════════════════════════════════════════
// Event Processing
// ═══════════════════════════════════════════════════════════════

/**
 * Process a single raw AG-UI event.
 *
 * @param eventType - The AG-UI event type (e.g. "RUN_STARTED", "TEXT_MESSAGE_CONTENT")
 * @param parsed - The parsed JSON data payload of the event
 * @param state - Mutable protocol state
 * @param callbacks - Semantic callbacks to fire
 * @returns true if this is a terminal event (stream should end)
 */
export function processAGUIEvent(
  eventType: string,
  parsed: Record<string, unknown>,
  state: AGUIProtocolState,
  callbacks: StreamCallbacks,
): boolean {
  switch (eventType) {
    // ── Lifecycle ──────────────────────────────────────────
    case AGUI.RUN_STARTED:
      state.runId = (parsed.runId as string) || "";
      return false;

    case AGUI.RUN_FINISHED:
      return handleRunFinished(parsed, state, callbacks);

    case AGUI.RUN_ERROR:
      callbacks.onError?.((parsed.message as string) || "Unknown error");
      return true;

    // ── Text messages ──────────────────────────────────────
    case AGUI.TEXT_MESSAGE_START:
      return false;

    case AGUI.TEXT_MESSAGE_CONTENT:
      callbacks.onContent?.(
        (parsed.delta as string) || "",
        state.currentNamespace,
      );
      return false;

    case AGUI.TEXT_MESSAGE_END:
      return false;

    // ── Tool calls ─────────────────────────────────────────
    case AGUI.TOOL_CALL_START: {
      const toolCallId = parsed.toolCallId as string;
      const toolCallName = parsed.toolCallName as string;
      state.toolCallIdToName.set(toolCallId, toolCallName);
      callbacks.onToolStart?.(
        toolCallId,
        toolCallName,
        undefined,
        state.currentNamespace,
      );
      return false;
    }

    case AGUI.TOOL_CALL_ARGS: {
      const toolCallId = parsed.toolCallId as string;
      const delta = (parsed.delta as string) || "";
      const prev = state.toolCallArgs.get(toolCallId) || "";
      state.toolCallArgs.set(toolCallId, prev + delta);

      const toolName = state.toolCallIdToName.get(toolCallId);
      if (toolName) {
        try {
          const accumulated = state.toolCallArgs.get(toolCallId) || "";
          const argsObj = JSON.parse(accumulated);
          if (argsObj && typeof argsObj === "object") {
            callbacks.onToolStart?.(toolCallId, toolName, argsObj, state.currentNamespace);
          }
        } catch {
          // Args not yet valid JSON — will be updated on next delta or TOOL_CALL_END
        }
      }
      return false;
    }

    case AGUI.TOOL_CALL_RESULT: {
      const toolCallId = parsed.tool_call_id as string;
      const content = parsed.content as string;
      if (toolCallId && content) {
        state.toolCallResults.set(toolCallId, content);
      }
      return false;
    }

    case AGUI.TOOL_CALL_END: {
      const toolCallId = parsed.toolCallId as string;
      const toolName = state.toolCallIdToName.get(toolCallId);
      const accumulatedArgs = state.toolCallArgs.get(toolCallId);
      const resultContent = state.toolCallResults.get(toolCallId);
      state.toolCallArgs.delete(toolCallId);
      state.toolCallResults.delete(toolCallId);

      const error = resultContent?.startsWith("ERROR:") ? resultContent : undefined;

      callbacks.onToolEnd?.(
        toolCallId,
        toolName,
        error,
        state.currentNamespace,
        accumulatedArgs,
        resultContent,
      );
      return false;
    }

    // ── Custom events ──────────────────────────────────────
    case AGUI.CUSTOM:
      return handleCustom(parsed, state, callbacks);

    default:
      return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Internal Handlers
// ═══════════════════════════════════════════════════════════════

function handleRunFinished(
  parsed: Record<string, unknown>,
  _state: AGUIProtocolState,
  callbacks: StreamCallbacks,
): boolean {
  const outcome = parsed.outcome as string;

  if (outcome === "interrupt") {
    const interrupt = parsed.interrupt as Record<string, unknown> | undefined;
    if (interrupt) {
      const reason = interrupt.reason as string | undefined;
      const payload = interrupt.payload as Record<string, unknown> | undefined;

      if (reason === "tool_approval") {
        const toolApprovals = payload?.tool_approvals as Array<{
          tool_name: string;
          tool_args: Record<string, unknown>;
          tool_call_id: string;
          allowed_decisions: string[];
        }> | undefined;
        callbacks.onToolApprovalRequired?.(
          interrupt.id as string,
          (payload?.tool_name as string) || "",
          (payload?.tool_args as Record<string, unknown>) || {},
          (payload?.allowed_decisions as string[]) || ["approve", "edit", "reject"],
          (payload?.agent as string) || "",
          toolApprovals,
        );
      } else {
        callbacks.onInputRequired?.(
          interrupt.id as string,
          (payload?.prompt as string) || "",
          (payload?.fields as InputFieldDefinition[]) || [],
          (payload?.agent as string) || "",
        );
      }
    }
    return true;
  }

  callbacks.onDone?.();
  return true;
}

function handleCustom(
  parsed: Record<string, unknown>,
  state: AGUIProtocolState,
  callbacks: StreamCallbacks,
): boolean {
  const name = parsed.name as string;
  const value = parsed.value as Record<string, unknown> | undefined;

  switch (name) {
    case CUSTOM_NAMESPACE_CONTEXT:
      state.currentNamespace = (value?.namespace as string[]) || [];
      return false;

    case CUSTOM_WARNING:
      callbacks.onWarning?.(
        (value?.message as string) || "",
        (value?.namespace as string[]) || state.currentNamespace,
      );
      return false;

    case CUSTOM_INPUT_REQUIRED:
      callbacks.onInputRequired?.(
        (value?.interrupt_id as string) || "",
        (value?.prompt as string) || (value?.message as string) || "",
        (value?.fields as InputFieldDefinition[]) || [],
        (value?.agent as string) || "",
      );
      return true;

    case CUSTOM_MEMORY_INJECTED:
      callbacks.onMemoryInjected?.(
        stringArray(value?.memory_ids),
        namespaceArray(value?.namespace, state.currentNamespace),
      );
      return false;

    case CUSTOM_MEMORY_CONTEXT_USED:
      // Backward compatibility for persisted legacy streams.
      callbacks.onMemoryInjected?.(
        stringArray(value?.memory_ids),
        namespaceArray(value?.namespace, state.currentNamespace),
      );
      return false;

    case CUSTOM_MEMORY_UPDATED:
    case CUSTOM_MEMORY_UPDATE:
      callbacks.onMemoryUpdate?.(
        stringArray(value?.memory_ids),
        typeof value?.action === "string" ? value.action : undefined,
        namespaceArray(value?.namespace, state.currentNamespace),
      );
      return false;

    default:
      return false;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function namespaceArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.map(String) : fallback;
}
