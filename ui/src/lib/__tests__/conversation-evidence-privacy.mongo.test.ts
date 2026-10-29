/** @jest-environment node */
import { MongoClient, type Db } from "mongodb";
import { admitPersonalEvidenceConversation, claimConversationShareable,
  reserveConversationMessageWrite, removeConversationTeamShares } from "../conversation-evidence-privacy";
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

  it("serializes a delayed legacy non-owner write with private admission", async () => {
    for (let index = 0; index < 20; index++) {
      const id = `delayed-writer-${index}`;
      const original = { _id: id, client_type: "webui", owner_id: "owner@example.test", owner_subject: "owner-subject",
        owner_identity_version: 2, participants: [{ type: "agent", id: "example-agent" }],
        sharing: { is_public: false, share_link_enabled: false, shared_with: [], shared_with_teams: [] } } as Conversation;
      await mockDb.collection<Conversation>("conversations").insertOne(original);
      const write = async () => {
        await reserveConversationMessageWrite(original, { sub: "old-writer-subject" }, "owner@example.test");
        await mockDb.collection("messages").insertOne({ conversation_id: id, content: "Delayed shared edit" });
      };
      const personal = () => admitPersonalEvidenceConversation(id, "owner-subject", "owner@example.test", "example-agent");
      const outcomes = await Promise.allSettled(index % 2 ? [write(), personal()] : [personal(), write()]);
      expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const saved = await mockDb.collection<Conversation>("conversations").findOne({ _id: id });
      expect(await mockDb.collection("messages").countDocuments({ conversation_id: id }))
        .toBe(saved!.personal_context === "private" ? 0 : 1);
    }
  });

  it("preserves collaboration eligibility atomically when deleting the last legacy team share", async () => {
    const id = "legacy-team-history";
    await mockDb.collection<Conversation>("conversations").insertOne({ _id: id, client_type: "webui",
      owner_id: "owner@example.test", owner_subject: "owner-subject", owner_identity_version: 2,
      participants: [{ type: "agent", id: "example-agent" }], sharing: { shared_with_teams: ["example-team"] } } as Conversation);
    const attempts = [removeConversationTeamShares("example-team"),
      admitPersonalEvidenceConversation(id, "owner-subject", "owner@example.test", "example-agent")];
    const results = await Promise.allSettled(attempts);
    expect(results[0].status).toBe("fulfilled"); expect(results[1].status).toBe("rejected");
    expect(await mockDb.collection<Conversation>("conversations").findOne({ _id: id }))
      .toMatchObject({ personal_context: "shareable", sharing: { shared_with_teams: [] } });
    await expect(admitPersonalEvidenceConversation(id, "owner-subject", "owner@example.test", "example-agent"))
      .rejects.toMatchObject({ statusCode: 403 });
    await mockDb.collection<Conversation>("conversations").updateOne({ _id: id },
      { $set: { personal_context: "private", "sharing.shared_with_teams": ["example-team"] } });
    await removeConversationTeamShares("example-team");
    expect((await mockDb.collection<Conversation>("conversations").findOne({ _id: id }))!.personal_context).toBe("private");
  });
});
