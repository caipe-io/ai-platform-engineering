/** @jest-environment node */
import { readAssistantStatus, persistAssistantCompletion } from "../assistant-status";
import { getCollection } from "@/lib/mongodb";
import { reconcileAppConversationMessageCount, upsertChatMessage } from "@/lib/chat-message-persistence";
import type { Conversation } from "@/types/mongodb";

jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));
jest.mock("@/lib/chat-message-persistence", () => ({ upsertChatMessage: jest.fn(), reconcileAppConversationMessageCount: jest.fn() }));
const turn = { turnId: "example-turn", content: "Accepted final answer", completedAt: "2026-01-01T12:00:00.000Z" };
const input = { subject: "example-subject", email: "owner@example.test", conversationId: "example-chat",
  agentId: "example-agent", appId: "example-app", turn };
const findConversation = jest.fn(), findMessage = jest.fn(), updateConversation = jest.fn();
let conversation: Conversation;
beforeEach(() => {
  jest.clearAllMocks();
  conversation = { _id: input.conversationId, client_type: "webui", owner_id: input.email,
    owner_subject: input.subject, participants: [{ type: "agent", id: input.agentId }],
    app_binding: { app_id: input.appId, agent_id: input.agentId }, personal_context: "private" } as Conversation;
  findConversation.mockImplementation(async () => conversation);
  findMessage.mockResolvedValue({ created_at: new Date("2026-01-01") });
  jest.mocked(getCollection).mockImplementation(async name => (name === "conversations"
    ? { findOne: findConversation, updateOne: updateConversation } : { findOne: findMessage }) as never);
  jest.mocked(upsertChatMessage).mockResolvedValue({ result: { upsertedCount: 0 }, message: {} } as never);
});

it("accepts an explicitly requested previous completion while a newer turn is running", async () => {
  expect(await readAssistantStatus(Response.json({ running: true, turnId: "newer-turn", completedTurn: turn })))
    .toEqual({ running: true, turnId: "newer-turn", completedTurn: turn });
});

it.each([
  { running: "false" }, { running: false, turnId: "" },
  { running: false, completedTurn: { ...turn, content: "x".repeat(12_001) } },
  { running: false, completedTurn: { ...turn, completedAt: "invalid" } },
  { running: false, completedTurn: { ...turn, grant: "hidden-state" } },
])("rejects malformed or overbroad completion data", async value => {
  await expect(readAssistantStatus(Response.json(value))).rejects.toThrow();
});

it("bounds the streamed response before parsing", async () => {
  await expect(readAssistantStatus(new Response("x".repeat(65_537)))).rejects.toThrow(/limit/);
});

it.each(["owner", "agent", "app", "deleted", "missing-user-turn"])("does not persist a mismatched %s", async field => {
  if (field === "owner") conversation.owner_subject = "other-subject";
  if (field === "agent") conversation.participants[0].id = "other-agent";
  if (field === "app") conversation.app_binding!.app_id = "other-app";
  if (field === "deleted") conversation.deleted_at = new Date();
  if (field === "missing-user-turn") findMessage.mockResolvedValue(null);
  expect(await persistAssistantCompletion(input)).toBe(false);
  expect(upsertChatMessage).not.toHaveBeenCalled();
});

it("fills only the requested user turn without moving conversation activity or privacy", async () => {
  expect(await persistAssistantCompletion(input)).toBe(true);
  expect(findMessage).toHaveBeenCalledWith({ conversation_id: input.conversationId, role: "user", "metadata.turn_id": turn.turnId });
  expect(upsertChatMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    conversationId: input.conversationId, turnId: turn.turnId, appTurn: true,
    fields: expect.objectContaining({ content: turn.content, metadata: expect.objectContaining({
      turn_id: turn.turnId, is_final: true, turn_status: "done",
      app_completion: expect.objectContaining({ app_id: input.appId, agent_id: input.agentId }),
    }) }),
  }));
  expect(updateConversation).not.toHaveBeenCalled();
  expect(reconcileAppConversationMessageCount).toHaveBeenCalledWith(expect.anything(), expect.anything(), input.conversationId);
  expect(conversation.personal_context).toBe("private");
});
