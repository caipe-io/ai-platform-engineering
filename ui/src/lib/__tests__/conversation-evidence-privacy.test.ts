/** @jest-environment node */
import { admitPersonalEvidenceConversation, assertPrivateConversationIdempotencyAccess,
  claimConversationShareable, isPersonalEvidenceConversationEligible, reserveConversationMessageWrite } from "../conversation-evidence-privacy";
import type { Conversation } from "@/types/mongodb";

const mockGetCollection = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: (...args: unknown[]) => mockGetCollection(...args) }));
let conversation: Conversation;
const update = jest.fn();
const activeShare = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  conversation = { _id: "conversation-primary", client_type: "webui", owner_id: "owner@example.test",
    owner_subject: "subject-primary", owner_identity_version: 2,
    participants: [{ type: "agent", id: "agent-primary" }],
    sharing: { is_public: false, shared_with: [], shared_with_teams: [], share_link_enabled: false } } as Conversation;
  activeShare.mockResolvedValue(null);
  update.mockImplementation(async (filter, mutation) => {
    const choices = filter.$or as Array<Record<string, unknown>>;
    const matches = choices.some((choice) => choice.personal_context === conversation.personal_context ||
      (typeof choice.personal_context === "object" && conversation.personal_context === undefined));
    if (!matches) return { matchedCount: 0 };
    conversation.personal_context = mutation.$set.personal_context;
    return { matchedCount: 1 };
  });
  mockGetCollection.mockImplementation(async (name) => name === "conversations"
    ? { findOne: async () => ({ ...conversation }), updateOne: update }
    : { findOne: activeShare });
});

const admit = () => admitPersonalEvidenceConversation(conversation._id, "subject-primary", "owner@example.test", "agent-primary");

it("readiness has no mutation; personal admission is idempotent and prevents sharing", async () => {
  expect(await isPersonalEvidenceConversationEligible(conversation._id, "subject-primary", "owner@example.test", "agent-primary")).toBe(true);
  expect(update).not.toHaveBeenCalled();
  await admit(); await admit();
  expect(conversation.personal_context).toBe("private");
  await expect(claimConversationShareable(conversation._id)).rejects.toMatchObject({ code: "PERSONAL_CONTEXT_PRIVATE" });
});

it("excludes personal admission after sharing wins the same conditional field", async () => {
  await claimConversationShareable(conversation._id);
  await expect(admit()).rejects.toMatchObject({ code: "PERSONAL_CONTEXT_REQUIRED" });
  expect(conversation.personal_context).toBe("shareable");
});

it("allows exactly one kind of admission when sharing and personal retrieval race", async () => {
  const results = await Promise.allSettled([admit(), claimConversationShareable(conversation._id)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
});

it.each(["owner", "agent", "shared", "service", "automated", "deleted", "legacy-share"])("rejects ineligible %s contexts before mutation", async (kind) => {
  if (kind === "owner") conversation.owner_subject = "other-subject";
  if (kind === "agent") conversation.participants = [{ type: "agent", id: "other-agent" }];
  if (kind === "shared") conversation.sharing!.is_public = true;
  if (kind === "service") conversation.created_by_service_account = "example-service";
  if (kind === "automated") conversation.source = "autonomous";
  if (kind === "deleted") conversation.deleted_at = new Date();
  if (kind === "legacy-share") activeShare.mockResolvedValue({ _id: "old-share" });
  await expect(admit()).rejects.toMatchObject({ statusCode: 403 });
  expect(update).not.toHaveBeenCalled();
});

it("rejects idempotent repairs for a foreign subject or service account despite matching email", async () => {
  await admit();
  for (const caller of [{ sub: "other-subject" }, { sub: "subject-primary", isServiceAccount: true }]) {
    expect(() => assertPrivateConversationIdempotencyAccess(conversation, caller, "owner@example.test"))
      .toThrow("Private personal research");
  }
});

it("reports a missing sharing target separately from a private chat", async () => {
  mockGetCollection.mockResolvedValue({ updateOne: async () => ({ matchedCount: 0 }), findOne: async () => null });
  await expect(claimConversationShareable("missing-conversation")).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
});

it("does not turn an owner-only write into a sharing reservation", async () => {
  await reserveConversationMessageWrite(conversation, { sub: "subject-primary" }, "owner@example.test");
  expect(update).not.toHaveBeenCalled();
  await admit();
});

it.each([{ sub: "other-subject" }, { sub: "subject-primary", isServiceAccount: true }])
  ("reserves a non-owner writer before legacy sharing can disappear: %j", async caller => {
    await reserveConversationMessageWrite(conversation, caller, "owner@example.test");
    expect(conversation.personal_context).toBe("shareable");
    await expect(admit()).rejects.toMatchObject({ statusCode: 403 });
  });

it("rejects a delayed non-owner write after personal admission wins", async () => {
  const stale = { ...conversation };
  await admit();
  await expect(reserveConversationMessageWrite(stale, { sub: "other-subject" }, "owner@example.test"))
    .rejects.toMatchObject({ statusCode: 403, code: "PRIVATE_CONVERSATION_OWNER_REQUIRED" });
});
