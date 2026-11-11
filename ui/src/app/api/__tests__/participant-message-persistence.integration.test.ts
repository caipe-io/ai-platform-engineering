/** @jest-environment node */
import { MongoClient, type Db } from "mongodb";
import { NextRequest } from "next/server";
import { POST } from "../chat/conversations/[id]/messages/route";
let mockDb: Db;
const chat = { _id: "12345678-1234-4123-8123-123456789abc", owner_id: "owner@example.test", participants: [{ type: "agent", id: "primary" }], coordination_agents: [{ agent_id: "helper", handle: "helper" }] };
jest.mock("@/lib/mongodb", () => ({ getCollection: async (name: string) => mockDb.collection(name) }));
jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({ requireConversationResourcePermission: jest.fn() }));
jest.mock("@/lib/api-middleware", () => ({ ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: async () => ({ user: { email: "owner@example.test" }, session: { sub: "example-owner" } }),
  requireConversationAccess: async () => ({ conversation: chat }),
}));
const suite = process.env.NOTIFICATIONS_MONGO_TEST === "1" ? describe : describe.skip;
suite("participant answer persistence across browser subscribers", () => {
  let client: MongoClient;
  beforeAll(async () => { client = await new MongoClient(process.env.NOTIFICATIONS_MONGODB_URI!).connect(); mockDb = client.db(`participant_message_test_${process.pid}`); });
  beforeEach(async () => { await mockDb.dropDatabase(); await mockDb.collection("conversations").insertOne(chat as never); });
  afterAll(async () => { await mockDb.dropDatabase(); await client.close(); });
  async function save(content: string, metadata = { turn_id: "example-turn", agent_id: "primary", is_final: true, turn_status: "done" }, id = "reply-primary-example-turn-assistant") {
    return POST(new NextRequest("https://example.test/api/messages", { method: "POST", body: JSON.stringify({ message_id: id, role: "assistant", content, metadata }) }), { params: Promise.resolve({ id: chat._id }) });
  }
  it("creates one database row when eight subscribers concurrently finalize the same answer", async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => save("Authoritative result")));
    expect(responses.every(response => [200, 201].includes(response.status))).toBe(true);
    expect(await mockDb.collection("messages").countDocuments()).toBe(1);
  });
  it("never replaces a completed answer with a late partial or interrupted save", async () => {
    await save("Authoritative result");
    await save("Partial", { turn_id: "example-turn", agent_id: "primary", is_final: false, turn_status: "" });
    const interrupted = await save("Disconnected", { turn_id: "example-turn", agent_id: "primary", is_final: true, turn_status: "interrupted" });
    expect(interrupted.status).toBe(200);
    expect((await interrupted.json()).data.content).toBe("Authoritative result");
    expect(await mockDb.collection("messages").countDocuments()).toBe(1);
  });
  it("retains separate answers for different participants sharing a turn label", async () => {
    await save("Primary reply");
    await save("Helper reply", { turn_id: "example-turn", agent_id: "helper", is_final: true, turn_status: "done" }, "reply-helper-example-turn-assistant");
    expect(await mockDb.collection("messages").countDocuments()).toBe(2);
  });
});
