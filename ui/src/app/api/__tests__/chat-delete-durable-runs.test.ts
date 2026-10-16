/** @jest-environment node */

import { deleteConversationsPermanently } from "../chat/conversations/delete-permanently";

const mockGetCollection = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: (...args: unknown[]) => mockGetCollection(...args) }));

it("erases only the deleted conversation journals, removing metadata before replay events", async () => {
  const calls: Array<{ collection: string; operation: string; query: unknown }> = [];
  mockGetCollection.mockImplementation(async (collection: string) => ({
    find: (query: unknown) => {
      calls.push({ collection, operation: "find", query });
      return { toArray: async () => [{ run_id: "target-run" }] };
    },
    deleteMany: async (query: unknown) => {
      calls.push({ collection, operation: "delete", query });
    },
    updateOne: async (query: unknown) => {
      calls.push({ collection, operation: "update", query });
    },
  }));
  await deleteConversationsPermanently([{ _id: "target-conversation", participants: [{ type: "agent", id: "example-agent" }] }]);

  const metadataIndex = calls.findIndex((call) => call.collection === "native_acp_execution_runs" && call.operation === "delete");
  const eventIndex = calls.findIndex((call) => call.collection === "native_acp_execution_events" && call.operation === "delete");
  expect(metadataIndex).toBeLessThan(eventIndex);
  expect(calls[0]).toEqual({ collection: "native_acp_deleted_sessions", operation: "update", query: { _id: "target-conversation" } });
  expect(calls[metadataIndex].query).toEqual({ session_id: { $in: ["target-conversation"] } });
  expect(calls[eventIndex].query).toEqual({
    $or: [{ session_id: { $in: ["target-conversation"] } }, { run_id: { $in: ["target-run"] } }],
  });
  expect(calls.find((call) => call.collection === "messages")?.query).toEqual({ conversation_id: { $in: ["target-conversation"] } });
});

it("limits autonomous deletion to its explicit execution binding rather than every task run", async () => {
  const calls: Array<{ collection: string; query: unknown }> = [];
  mockGetCollection.mockImplementation(async (collection: string) => ({
    find: (query: unknown) => {
      calls.push({ collection, query });
      return { toArray: async () => [{ run_id: "target-run" }] };
    },
    deleteMany: async (query: unknown) => calls.push({ collection, query }),
    updateOne: async () => undefined,
  }));
  await deleteConversationsPermanently([{
    _id: "task-conversation",
    participants: [{ type: "agent", id: "example-agent" }],
    source: "autonomous", task_id: "target-task", execution_context_id: "latest-context",
  }]);
  expect(calls.find((call) => call.collection === "autonomous_runs")).toBeUndefined();
  expect(calls.find((call) => call.collection === "native_acp_execution_runs")?.query).toEqual({
    session_id: { $in: ["task-conversation", "latest-context"] },
  });
});
