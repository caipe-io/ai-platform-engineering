/** @jest-environment node */
import { MongoClient, ObjectId, type Collection, type Db } from "mongodb";
import { reconcileAppConversationMessageCount, upsertChatMessage } from "../chat-message-persistence";
import { persistAssistantCompletion } from "../agentic-apps/assistant-status";
import type { Conversation, Message } from "@/types/mongodb";

let db: Db;
let mockConversations: Collection<Conversation>;
jest.mock("@/lib/mongodb", () => ({ getCollection: async (name: string) => name === "conversations" ? mockConversations : db.collection(name) }));

// Integration qualification: use an isolated MongoDB, never a deployed database.
const integration = process.env.CAIPE_TEST_MONGODB_URI ? describe : describe.skip;
integration("app completion persistence on MongoDB", () => {
  let client: MongoClient;
  const conversationId = "example-conversation", turnId = "example-turn";
  const turn = { turnId, content: "Accepted final answer", completedAt: "2026-01-01T00:00:05.000Z" };
  const completion = { subject: "example-subject", email: "owner@example.test", conversationId,
    agentId: "example-agent", appId: "example-app", turn };
  const browserWrite = async (id = turnId) => { const write = await upsertChatMessage(db.collection<Message>("messages"), {
    conversationId, messageId: `browser-${id}`, role: "assistant", turnId: id, appTurn: true,
    fields: { content: "Interrupted placeholder", metadata: { turn_id: id, is_final: false, turn_status: "interrupted" } },
    insert: { message_id: `browser-${id}`, conversation_id: conversationId, role: "assistant", created_at: new Date() },
  });
    await reconcileAppConversationMessageCount(db.collection<Message>("messages"), mockConversations, conversationId);
    return write;
  };
  beforeAll(async () => {
    client = await MongoClient.connect(process.env.CAIPE_TEST_MONGODB_URI!);
    db = client.db(`app_recovery_${new ObjectId().toHexString()}`);
  });
  afterAll(async () => { await db.dropDatabase(); await client.close(); });
  beforeEach(async () => {
    jest.restoreAllMocks();
    mockConversations = db.collection<Conversation>("conversations");
    await db.collection("messages").deleteMany({}); await db.collection("conversations").deleteMany({});
    await db.collection<Conversation>("conversations").insertOne({ _id: conversationId, owner_id: completion.email,
      owner_subject: completion.subject, client_type: "webui", personal_context: "private",
      app_binding: { app_id: completion.appId, agent_id: completion.agentId },
      participants: [{ type: "agent", id: completion.agentId }], updated_at: new Date("2026-01-01"),
      metadata: { total_messages: 1 } } as Conversation);
    await db.collection("messages").insertOne({ conversation_id: conversationId, role: "user",
      content: "Question", metadata: { turn_id: turnId }, created_at: new Date("2026-01-01") });
  });

  it("repairs a failed count write on the next status poll without resending or reinserting", async () => {
    const update = jest.spyOn(mockConversations, "updateOne").mockRejectedValueOnce(new Error("Transient count failure"));
    await expect(persistAssistantCompletion(completion)).rejects.toThrow("Transient count failure");
    expect(await db.collection("messages").countDocuments({ role: "assistant" })).toBe(1);
    expect((await mockConversations.findOne({ _id: conversationId }))!.metadata.total_messages).toBe(1);
    await persistAssistantCompletion(completion);
    expect(await db.collection("messages").countDocuments({ role: "assistant" })).toBe(1);
    expect((await mockConversations.findOne({ _id: conversationId }))!.metadata.total_messages).toBe(2);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("does not lower a newer browser insertion count when an older recount completes later", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const counted = new Promise<void>(resolve => { entered = resolve; });
    const update = mockConversations.updateOne.bind(mockConversations);
    jest.spyOn(mockConversations, "updateOne").mockImplementationOnce(async (...args) => {
      entered(); await held; return update(...args);
    });
    const pending = persistAssistantCompletion(completion);
    await counted;
    await browserWrite("newer-turn");
    release(); await pending;
    expect(await db.collection("messages").countDocuments()).toBe(3);
    expect((await mockConversations.findOne({ _id: conversationId }))!.metadata.total_messages).toBe(3);
  });

  it("reconciles concurrent polls and browser writes to exactly one accepted result", async () => {
    await Promise.all(Array.from({ length: 30 }, (_, index) => index % 2
      ? browserWrite() : persistAssistantCompletion(completion)));
    const rows = await db.collection<Message>("messages").find({ conversation_id: conversationId, role: "assistant" }).toArray();
    expect(rows).toHaveLength(1); expect(rows[0].content).toBe(turn.content);
    expect(rows[0].metadata).toMatchObject({ is_final: true, turn_status: "done", app_completion: { turn_id: turnId } });
    expect(await db.collection("conversations").findOne({ _id: conversationId } as never)).toMatchObject({
      personal_context: "private", updated_at: new Date("2026-01-01"), metadata: { total_messages: 2 },
    });
  });

  it("keeps an existing legacy message identity and its stored tool events", async () => {
    const id = new ObjectId();
    await db.collection("messages").insertOne({ _id: id, message_id: "legacy-client-id", conversation_id: conversationId,
      role: "assistant", content: "Partial", metadata: { turn_id: turnId }, stream_events: [{ type: "tool_end" }], created_at: new Date() });
    await persistAssistantCompletion(completion); await browserWrite();
    const rows = await db.collection<Message>("messages").find({ role: "assistant" }).toArray();
    expect(rows).toHaveLength(1); expect(rows[0]._id).toEqual(id); expect(rows[0].message_id).toBe("legacy-client-id");
    expect(rows[0].content).toBe(turn.content); expect(rows[0].stream_events).toEqual([{ type: "tool_end" }]);
  });

  it("leaves a newer retry turn independent of the completed earlier turn", async () => {
    await persistAssistantCompletion(completion); await browserWrite("retry-turn");
    await persistAssistantCompletion(completion);
    const rows = await db.collection<Message>("messages").find({ role: "assistant" }).toArray();
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.metadata.turn_id === "retry-turn")?.content).toBe("Interrupted placeholder");
    expect(rows.find(row => row.metadata.turn_id === turnId)?.content).toBe(turn.content);
  });

  it("does not resurrect an edited/rewound turn after its user message was deleted", async () => {
    await db.collection("messages").deleteMany({});
    expect(await persistAssistantCompletion(completion)).toBe(false);
    expect(await db.collection("messages").countDocuments()).toBe(0);
  });

  it("does not write a private result after canonical ownership changes", async () => {
    await db.collection("conversations").updateOne({ _id: conversationId } as never, { $set: { owner_subject: "other-subject" } });
    expect(await persistAssistantCompletion(completion)).toBe(false);
    expect(await db.collection("messages").countDocuments({ role: "assistant" })).toBe(0);
  });
  it.each(["user", "system"] as const)("cannot erase a server completion by changing the incoming role to %s", async role => {
    await persistAssistantCompletion(completion);
    const protectedRow = await db.collection<Message>("messages").findOne({ role: "assistant" });
    await upsertChatMessage(db.collection<Message>("messages"), {
      conversationId, messageId: protectedRow!.message_id, role, turnId,
      fields: { content: "Attempted overwrite", metadata: { turn_id: turnId, app_completion: null } },
      insert: { message_id: protectedRow!.message_id, conversation_id: conversationId, role },
    });
    const row = await db.collection<Message>("messages").findOne({ _id: protectedRow!._id });
    expect(row!.role).toBe("assistant"); expect(row!.content).toBe(turn.content);
    expect(row!.metadata.app_completion).toMatchObject({ turn_id: turnId });
  });

  it("ordinary writes cannot forge the server completion marker", async () => {
    await upsertChatMessage(db.collection<Message>("messages"), {
      conversationId, messageId: "ordinary-message", role: "user", turnId: "new-turn",
      fields: { content: "Question", metadata: { turn_id: "new-turn", app_completion: { completed_at: turn.completedAt } } },
      insert: { message_id: "ordinary-message", conversation_id: conversationId, role: "user" },
    });
    expect((await db.collection<Message>("messages").findOne({ message_id: "ordinary-message" }))!.metadata)
      .not.toHaveProperty("app_completion");
  });

  it("keeps insert-only identity fields immutable even when their stored value is null", async () => {
    await db.collection("messages").insertOne({ message_id: "existing-user", conversation_id: conversationId,
      role: "user", sender_email: null, content: "Original", metadata: { turn_id: "existing-turn" } });
    await upsertChatMessage(db.collection<Message>("messages"), {
      conversationId, messageId: "existing-user", role: "user", turnId: "existing-turn",
      fields: { content: "Updated", metadata: { turn_id: "existing-turn" } },
      insert: { message_id: "existing-user", conversation_id: conversationId, role: "user", sender_email: "other@example.test" },
    });
    expect((await db.collection<Message>("messages").findOne({ message_id: "existing-user" }))!.sender_email).toBeNull();
  });

  it("gives the same turn ID in different conversations distinct globally addressable message IDs", async () => {
    const otherConversationId = "other-conversation";
    const original = await db.collection<Conversation>("conversations").findOne({ _id: conversationId });
    await db.collection<Conversation>("conversations").insertOne({ ...original!, _id: otherConversationId });
    await db.collection("messages").insertOne({ conversation_id: otherConversationId, role: "user",
      content: "Another question", metadata: { turn_id: turnId }, created_at: new Date("2026-01-01") });
    await Promise.all([persistAssistantCompletion(completion),
      persistAssistantCompletion({ ...completion, conversationId: otherConversationId })]);
    const rows = await db.collection<Message>("messages").find({ role: "assistant" }).toArray();
    expect(rows).toHaveLength(2); expect(new Set(rows.map(row => row.message_id)).size).toBe(2);
    for (const row of rows) expect(await db.collection<Message>("messages").findOne({ message_id: row.message_id }))
      .toMatchObject({ conversation_id: row.conversation_id, _id: row._id });
    const ids = rows.map(row => row.message_id).sort();
    await Promise.all([persistAssistantCompletion(completion),
      persistAssistantCompletion({ ...completion, conversationId: otherConversationId })]);
    expect((await db.collection<Message>("messages").find({ role: "assistant" }).toArray()).map(row => row.message_id).sort()).toEqual(ids);
  });

});
