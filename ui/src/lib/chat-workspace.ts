import type { Conversation } from "@/types/a2a";
import { TODO_TOOL_NAME, type StreamEvent, type TodoItem } from "@/lib/streaming/types";

/** Read the latest published task snapshot, including after a browser refresh. */
export function getWorkspaceTasks(conversation?: Conversation): TodoItem[] {
  if (!conversation) return [];
  const batches = [
    ...conversation.messages.map((message) => message.streamEvents ?? []),
    conversation.streamEvents,
  ];
  for (let batch = batches.length - 1; batch >= 0; batch--) {
    const events = batches[batch];
    const names = new Map<string, string>();
    for (const event of events) {
      if (event.type === "tool_start" && !event.namespace?.length && event.toolData && "tool_name" in event.toolData) {
        names.set(event.toolData.tool_call_id, event.toolData.tool_name);
      }
    }
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event.type !== "tool_start" && event.type !== "tool_end") continue;
      const data = event.toolData;
      if (!data || (event.namespace?.length ?? 0) > 0) continue;
      const name = "tool_name" in data ? data.tool_name : names.get(data.tool_call_id);
      if (name !== TODO_TOOL_NAME || !data.args || ("error" in data && data.error)) continue;
      let args: unknown = data.args;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
      if (!args || typeof args !== "object" || !("todos" in args) || !Array.isArray(args.todos)) continue;
      const todos = args.todos;
      // An incomplete stream must not replace the last valid snapshot.
      if (!todos.every((todo: unknown) => !!todo && typeof todo === "object" &&
        "content" in todo && typeof todo.content === "string" && "status" in todo &&
        ["pending", "in_progress", "completed"].includes(String(todo.status)))) continue;
      return todos.map((todo) => ({ content: todo.content, status: todo.status }));
    }
  }
  return [];
}

export function getWorkspaceTurnEvents(conversation?: Conversation): StreamEvent[] {
  if (!conversation) return [];
  if (conversation.streamEvents.length) return conversation.streamEvents;
  const last = conversation.messages.findLast((message) => message.role === "assistant");
  return last?.streamEvents ?? [];
}
