/** @jest-environment node */
import { MongoClient, type Db } from "mongodb";
import { admitPersonalEvidenceConversation, claimConversationShareable } from "../conversation-evidence-privacy";
import type { Conversation } from "@/types/mongodb";

let mockDb: Db;
jest.mock("@/lib/mongodb", () => ({ getCollection: async (name: string) => mockDb.collection(name) }));

const uri = process.env.PERSONAL_CONTEXT_TEST_MONGODB_URI;
const mongo = uri ? describe : describe.skip;

mongo("personal context Mongo admission", () => {
  let client: MongoClient;
  beforeAll(async () => {
    const target = new URL(uri!);
    if (!["127.0.0.1", "localhost", "mongodb"].includes(target.hostname) || !/^\/test_personal_context_[a-z0-9_]+$/.test(target.pathname)) {
      throw new Error("Personal context tests require an isolated local test_personal_context_* database");
    }
    client = new MongoClient(uri!);
    await client.connect();
    mockDb = client.db();
  });
  afterAll(async () => { if (client) { await mockDb.dropDatabase(); await client.close(); } });

  it("atomically chooses private or shareable across concurrent requests", async () => {
    for (let index = 0; index < 20; index += 1) {
      const id = `conversation-${index}`;
      await mockDb.collection<Conversation>("conversations").insertOne({ _id: id, client_type: "webui",
        owner_id: "owner@example.test", owner_subject: "subject-primary", owner_identity_version: 2,
        participants: [{ type: "agent", id: "agent-primary" }],
        sharing: { is_public: false, shared_with: [], shared_with_teams: [], share_link_enabled: false } } as Conversation);
      const personal = () => admitPersonalEvidenceConversation(id, "subject-primary", "owner@example.test", "agent-primary");
      const results = await Promise.allSettled(index % 2 ? [personal(), claimConversationShareable(id)] : [claimConversationShareable(id), personal()]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const saved = await mockDb.collection<Conversation>("conversations").findOne({ _id: id });
      if (saved!.personal_context === "private") {
        await personal();
        await expect(claimConversationShareable(id)).rejects.toMatchObject({ code: "PERSONAL_CONTEXT_PRIVATE" });
      } else {
        expect(saved!.personal_context).toBe("shareable");
        await expect(personal()).rejects.toMatchObject({ code: "PERSONAL_CONTEXT_REQUIRED" });
      }
    }
  });
});
