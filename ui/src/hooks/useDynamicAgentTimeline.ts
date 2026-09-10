/**
 * useAgentTimeline Hook
 *
 * Transforms SSE events into an interleaved timeline for the AgentTimeline component.
 * This hook processes events through TimelineManager and memoizes the output.
 *
 * Usage:
 * const { data } = useAgentTimeline(turnEvents, isStreaming);
 * <AgentTimeline data={data} ... />
 */

import { createTimelineManager } from "@/lib/da-timeline-manager";
import type {
StreamEvent,
ToolEndEventData,
ToolStartEventData,
} from "@/lib/streaming/types";
import { isToolStartData } from "@/lib/streaming/types";
import type { StatusType,TimelineData } from "@/types/dynamic-agent-timeline";
import { useMemo } from "react";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface UseAgentTimelineResult {
  /** Interleaved timeline data for rendering */
  data: TimelineData;
}

// ═══════════════════════════════════════════════════════════════
// Helper: Empty data for initial state
// ═══════════════════════════════════════════════════════════════

const EMPTY_DATA: TimelineData = {
  segments: [],
  finalAnswer: null,
  isStreaming: false,
  hasTools: false,
};

// ═══════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════

/**
 * Transform SSE events into interleaved timeline data.
 *
 * @param events - SSE events for the current message turn
 * @param isStreaming - Whether the stream is still active
 * @param turnStatus - Status to show when finalized: "done", "interrupted", or "waiting_for_input"
 * @returns Interleaved timeline data for AgentTimeline
 */
export function useAgentTimeline(
  events: StreamEvent[],
  isStreaming: boolean,
  turnStatus?: StatusType
): UseAgentTimelineResult {
  const data = useMemo<TimelineData>(() => {
    if (events.length === 0) {
      return isStreaming ? { ...EMPTY_DATA, isStreaming: true } : EMPTY_DATA;
    }

    // Timeline data is a deterministic projection of the current turn. Keeping
    // it out of state avoids a second render for every streamed token.
    const manager = createTimelineManager();

    for (const event of events) {
      const namespace = event.namespace || [];

      switch (event.type) {
        case "content":
          if (event.content) {
            manager.pushContent(event.content, namespace);
          }
          break;

        case "tool_start":
          if (event.toolData && isToolStartData(event.toolData)) {
            manager.pushToolStart(event.toolData as ToolStartEventData, namespace);
          }
          break;

        case "tool_end":
          if (event.toolData) {
            const toolData = event.toolData as ToolEndEventData;
            if (toolData.error) {
              manager.pushToolFailed(toolData.tool_call_id, namespace, toolData.error);
            } else {
              manager.pushToolEnd(toolData.tool_call_id, namespace, toolData.args, toolData.result);
            }
          }
          break;

        case "warning":
          if (event.warningData?.message) {
            manager.pushWarning(event.warningData.message);
          } else if (event.displayContent) {
            manager.pushWarning(event.displayContent);
          }
          break;

        case "error":
          if (event.displayContent) {
            manager.pushError(event.displayContent);
          } else if (event.content) {
            manager.pushError(event.content);
          }
          break;
      }
    }

    if (!isStreaming) {
      manager.finalize(turnStatus || "done");
    }

    return manager.getGroupedData();
  }, [events, isStreaming, turnStatus]);

  return { data };
}

// ═══════════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════════

export default useAgentTimeline;
