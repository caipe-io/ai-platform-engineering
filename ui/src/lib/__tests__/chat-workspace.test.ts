import { getWorkspaceTasks, getWorkspaceTurnEvents } from "../chat-workspace";
import { createStreamEvent } from "@/lib/streaming/types";
import type { Conversation } from "@/types/a2a";

const published = createStreamEvent("tool_start", {
  tool_name: "write_todos", tool_call_id: "task-list", namespace: [],
  args: { todos: [{ content: "Validate the change", status: "in_progress" }] },
});
function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return { id: "example-chat", title: "Example", createdAt: new Date(), updatedAt: new Date(),
    participants: [], streamEvents: [], messages: [{ id: "answer", role: "assistant", content: "Working", timestamp: new Date(), streamEvents: [published] }], ...overrides };
}

it("restores tasks from saved messages when no browser stream exists", () => {
  expect(getWorkspaceTasks(conversation())).toEqual([{ content: "Validate the change", status: "in_progress" }]);
  expect(getWorkspaceTurnEvents(conversation())).toEqual([published]);
});

it("uses a completed tool snapshot when its end event omits the name", () => {
  const end = createStreamEvent("tool_end", { tool_call_id: "task-list", namespace: [], args: { todos: [{ content: "Validate the change", status: "completed" }] } });
  expect(getWorkspaceTasks(conversation({ streamEvents: [published, end] }))[0].status).toBe("completed");
});

it("honors explicit task clearing and never carries another conversation's tasks", () => {
  const clear = createStreamEvent("tool_start", { tool_name: "write_todos", tool_call_id: "clear", namespace: [], args: { todos: [] } });
  expect(getWorkspaceTasks(conversation({ streamEvents: [clear] }))).toEqual([]);
  expect(getWorkspaceTasks(conversation({ messages: [] }))).toEqual([]);
});

it("ignores incomplete task snapshots and nested subagent lists", () => {
  const incomplete = createStreamEvent("tool_start", { tool_name: "write_todos", tool_call_id: "incomplete", namespace: [], args: { todos: [{ content: "Incomplete" }] } });
  const nested = { ...published, namespace: ["child"] };
  expect(getWorkspaceTasks(conversation({ streamEvents: [incomplete, nested] }))).toEqual([{ content: "Validate the change", status: "in_progress" }]);
});

it("does not replay old subagent activity when a newer answer has no events", () => {
  const saved = conversation();
  saved.messages.push({ id: "new-answer", role: "assistant", content: "Done", timestamp: new Date() });
  expect(getWorkspaceTurnEvents(saved)).toEqual([]);
});
