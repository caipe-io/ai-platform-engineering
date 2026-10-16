import { createStreamEvent,isToolStartData,type StreamEvent } from "@/lib/streaming/types";

/**
 * Build seed events for subagent tasks that were still running when a turn
 * paused for human input.
 *
 * Resume streams continue the existing LangGraph task namespace, but do not
 * repeat the parent `task` tool start. A new assistant turn therefore needs
 * this small piece of prior context so its timeline can attach resumed child
 * events to the correct subagent.
 */
export function createSubagentResumeSeedEvents(events: StreamEvent[]): StreamEvent[] {
  const activeTasks = new Map<string, { args?: Record<string, unknown> }>();

  for (const event of events) {
    if (event.type === "tool_start" && isToolStartData(event.toolData)) {
      if (event.namespace.length === 0 && event.toolData.tool_name === "task") {
        activeTasks.set(event.toolData.tool_call_id, { args: event.toolData.args });
      }
      continue;
    }

    if (event.type === "tool_end" && event.toolData) {
      activeTasks.delete(event.toolData.tool_call_id);
    }
  }

  return [...activeTasks.entries()].map(([toolCallId, task]) =>
    ({
      ...createStreamEvent("tool_start", {
        tool_name: "task",
        tool_call_id: toolCallId,
        args: task.args,
        namespace: [],
      }),
      isResumeSeed: true,
    }),
  );
}
