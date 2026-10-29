/** @jest-environment node */
import { NextRequest } from "next/server";

const mockGetCollection = jest.fn();
const mockDeletePermanently = jest.fn();
const mockResourcePermission = jest.fn();
let mockSession: { sub: string; role: string; isServiceAccount?: boolean };
const mockUser = { email: "owner@example.com" };

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args), isMongoDBConfigured: true,
}));
jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockResourcePermission(...args),
  filterResourcesByPermission: async (_session: unknown, items: unknown[]) => items,
}));
jest.mock("../chat/conversations/delete-permanently", () => ({
  deleteConversationsPermanently: (...args: unknown[]) => mockDeletePermanently(...args),
}));
jest.mock("@/lib/api-middleware", () => ({
  ApiError: jest.requireActual("@/lib/api-error").ApiError,
  getPaginationParams: () => ({ page: 1, pageSize: 20, skip: 0 }),
  validateConversationId: () => true,
  validateRequired: () => undefined,
  requireConversationAccess: async () => ({ conversation: await (await mockGetCollection("conversations")).findOne(), access_level: "owner" }),
  paginatedResponse: (items: unknown[]) => Response.json({ data: { items } }),
  successResponse: (data: unknown) => Response.json({ data }),
  withAuth: async (
    request: NextRequest,
    handler: (request: NextRequest, user: typeof mockUser, session: typeof mockSession) => Promise<Response>,
  ) => handler(request, mockUser, mockSession),
  withErrorHandler: (handler: (...args: unknown[]) => Promise<Response>) => async (...args: unknown[]) => {
    try { return await handler(...args); }
    catch (error) {
      const failure = error as { statusCode?: number; code?: string };
      return Response.json({ code: failure.code }, { status: failure.statusCode ?? 500 });
    }
  },
}));

const privateChat = {
  _id: "11111111-1111-4111-8111-111111111111", owner_id: "owner@example.com",
  owner_subject: "owner-sub", owner_identity_version: 2,
  personal_context: "private",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSession = { sub: "owner-sub", role: "user" };
  mockResourcePermission.mockResolvedValue(undefined);
  mockDeletePermanently.mockResolvedValue(undefined);
});

describe("private evidence opaque turn writes", () => {
  it("rejects a stale writer after private admission before writing an opaque turn", async () => {
    mockSession.sub = "old-writer-subject";
    const turns = { updateOne: jest.fn(), findOne: jest.fn() };
    const conversations = { findOne: jest.fn().mockResolvedValueOnce({ ...privateChat, personal_context: undefined })
      .mockResolvedValue(privateChat), updateOne: jest.fn().mockResolvedValue({ matchedCount: 0 }) };
    mockGetCollection.mockImplementation(async name => name === "turns" ? turns : conversations);
    const { POST } = await import("../chat/conversations/[id]/turns/route");
    const response = await POST(new NextRequest(`https://example.test/api/chat/conversations/${privateChat._id}/turns`, {
      method: "POST", body: JSON.stringify({ turn_id: "legacy-turn", client_type: "ui", payload: { answer: "Late shared write" } }),
    }), { params: Promise.resolve({ id: privateChat._id }) });
    expect(response.status).toBe(403);
    expect(turns.updateOne).not.toHaveBeenCalled();
  });
});

describe("private evidence archive retention", () => {
  async function getTrash(expired: unknown[]) {
    const conversations = {
      find: jest.fn(() => ({
        toArray: async () => expired,
        sort: () => ({ skip: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      })),
      countDocuments: async () => 0,
    };
    mockGetCollection.mockImplementation(async (name) => name === "conversations" ? conversations : { distinct: async () => [] });
    const { GET } = await import("../chat/conversations/trash/route");
    return GET(new NextRequest("https://example.test/api/chat/conversations/trash"));
  }

  it.each([
    { sub: "different-sub", role: "user" },
    { sub: "owner-sub", role: "admin", isServiceAccount: true },
    { sub: "different-sub", role: "admin" },
  ])("does not purge another subject's private chat: %j", async (session) => {
    mockSession = session;
    const ordinaryChat = { ...privateChat, _id: "ordinary-chat", personal_context: undefined };
    expect((await getTrash([privateChat, ordinaryChat])).status).toBe(200);
    expect(mockDeletePermanently).toHaveBeenCalledWith([ordinaryChat]);
  });

  it("preserves ordinary retention and permits the canonical private owner", async () => {
    expect((await getTrash([privateChat])).status).toBe(200);
    expect(mockDeletePermanently).toHaveBeenCalledWith([privateChat]);
  });
});

describe("private evidence direct message-ID update", () => {
  const message = { message_id: "message-id", conversation_id: privateChat._id, content: "Personal evidence" };
  let messages: { findOne: jest.Mock; updateOne: jest.Mock };
  let conversations: { findOne: jest.Mock; updateOne: jest.Mock };

  beforeEach(() => {
    messages = { findOne: jest.fn().mockResolvedValue(message), updateOne: jest.fn() };
    conversations = { findOne: jest.fn().mockResolvedValue(privateChat), updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }) };
    mockGetCollection.mockImplementation(async (name) => name === "messages" ? messages : conversations);
  });

  async function updateMessage(body: Record<string, unknown>) {
    const { PUT } = await import("../chat/messages/[id]/route");
    return PUT(new NextRequest("https://example.test/api/chat/messages/message-id", {
      method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }), { params: Promise.resolve({ id: "message-id" }) });
  }

  it.each([
    { sub: "different-sub", role: "user" },
    { sub: "owner-sub", role: "admin", isServiceAccount: true },
    { sub: "different-sub", role: "admin" },
  ])("rejects foreign/SA writes despite an allowed old writer grant: %j", async (session) => {
    mockSession = session;
    const response = await updateMessage({ content: "Changed" });
    expect(response.status).toBe(403);
    expect(messages.updateOne).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ code: "PRIVATE_CONVERSATION_OWNER_REQUIRED" });
  });

  it("does not expose private message content through an empty update", async () => {
    mockSession.sub = "different-sub";
    const response = await updateMessage({});
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain(message.content);
  });

  it("allows the owner and retains the original resource check", async () => {
    expect((await updateMessage({ content: "Changed" })).status).toBe(200);
    expect(messages.updateOne).toHaveBeenCalledWith({ message_id: "message-id", "metadata.app_completion": { $exists: false } }, { $set: { content: "Changed" } });
    expect(mockResourcePermission).toHaveBeenCalledWith(mockSession, { type: "conversation", id: privateChat._id, action: "write" });
  });

  it("leaves ordinary messages on the original permission path", async () => {
    conversations.findOne.mockResolvedValue({ ...privateChat, personal_context: undefined });
    mockSession.sub = "different-sub";
    expect((await updateMessage({ content: "Changed" })).status).toBe(200);
    expect(messages.updateOne).toHaveBeenCalled();
    expect(mockResourcePermission).toHaveBeenCalledTimes(1);
    expect(conversations.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: privateChat._id }),
      { $set: { personal_context: "shareable" } });
  });

  it("rejects a stale team writer when private admission wins before the write reservation", async () => {
    mockSession.sub = "other-subject";
    conversations.findOne.mockResolvedValueOnce({ ...privateChat, personal_context: undefined });
    conversations.updateOne.mockResolvedValue({ matchedCount: 0 });
    const response = await updateMessage({ content: "Late shared update" });
    expect(response.status).toBe(403);
    expect(messages.updateOne).not.toHaveBeenCalled();
  });
});
