/** @jest-environment node */
import { authorizeConversationReadAccess, authorizeConversationWriteAccess } from "../_conversation-authz";

const mockFindConversation = jest.fn();
const mockPermission = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  getCollection: async () => ({ findOne: mockFindConversation }),
}));
jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({
  requireConversationResourcePermission: (...args: unknown[]) => mockPermission(...args),
}));

const auth = { subject: "test-user", email: "test-user@example.test" };
const conversation = {
  _id: "conversation-example", client_type: "webui",
  participants: [{ type: "agent", id: "agent-primary" }],
};

beforeEach(() => {
  jest.resetAllMocks();
  mockFindConversation.mockResolvedValue(conversation);
  mockPermission.mockResolvedValue(undefined);
});

it.each([
  ["read", authorizeConversationReadAccess], ["write", authorizeConversationWriteAccess],
])("requires the saved agent after conversation %s authorization", async (permission, authorize) => {
  const response = await authorize(auth, conversation._id, "agent-secondary");
  expect(response.denial?.status).toBe(409);
  expect(mockPermission).toHaveBeenCalledWith(expect.objectContaining({ sub: auth.subject }), auth.email, conversation, permission);
  expect((await authorize(auth, conversation._id, "agent-primary")).denial).toBeNull();
});

it("returns the access denial before revealing a saved agent mismatch", async () => {
  mockPermission.mockRejectedValue(Object.assign(new Error("Denied"), { statusCode: 403 }));
  expect((await authorizeConversationWriteAccess(auth, conversation._id, "agent-secondary")).denial?.status).toBe(403);
});

it("retains the Slack write exception while enforcing its saved agent", async () => {
  mockFindConversation.mockResolvedValue({ ...conversation, client_type: "slack" });
  expect((await authorizeConversationWriteAccess(auth, conversation._id, "agent-secondary")).denial?.status).toBe(409);
  expect((await authorizeConversationWriteAccess(auth, conversation._id, "agent-primary")).denial).toBeNull();
  expect(mockPermission).not.toHaveBeenCalled();
});

it("requires read permission for Slack history and replay", async () => {
  mockFindConversation.mockResolvedValue({ ...conversation, client_type: "slack" });
  mockPermission.mockRejectedValue(Object.assign(new Error("Read revoked"), { statusCode: 403 }));
  expect((await authorizeConversationReadAccess(auth, conversation._id, "agent-primary")).denial?.status).toBe(403);
  expect(mockPermission).toHaveBeenCalledWith(expect.anything(), auth.email, expect.anything(), "read");
});

it.each([authorizeConversationReadAccess, authorizeConversationWriteAccess])("preserves service-account classification", async authorize => {
  await authorize({ ...auth, isServiceAccount: true }, conversation._id, "agent-primary");
  expect(mockPermission.mock.calls[0][0]).toEqual(expect.objectContaining({ sub: auth.subject, isServiceAccount: true }));
});

it("allows authorized legacy conversations without an agent participant", async () => {
  mockFindConversation.mockResolvedValue({ ...conversation, participants: [] });
  expect((await authorizeConversationWriteAccess(auth, conversation._id, "agent-primary")).denial).toBeNull();
});

it("allows reading automated history while keeping interactive writes read-only", async () => {
  mockFindConversation.mockResolvedValue({ ...conversation, source: "autonomous" });
  expect((await authorizeConversationReadAccess(auth, conversation._id, "agent-primary")).denial).toBeNull();
  expect((await authorizeConversationWriteAccess(auth, conversation._id, "agent-primary")).denial?.status).toBe(409);
});

it("returns 404 for a missing conversation", async () => {
  mockFindConversation.mockResolvedValue(null);
  expect((await authorizeConversationReadAccess(auth, conversation._id, "agent-primary")).denial?.status).toBe(404);
  expect(mockPermission).not.toHaveBeenCalled();
});
