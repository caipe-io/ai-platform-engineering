/**
 * @jest-environment node
 */

import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";

const mockRequireAgentUsePermission = jest.fn().mockResolvedValue(null);
const mockAuthorizeConversationWriteAccess = jest.fn().mockResolvedValue({ denial: null });
const mockGetCollection = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  validateConversationId: jest.fn().mockReturnValue(true),
  successResponse: (data: unknown, status = 200) =>
    NextResponse.json({ success: true, data }, { status }),
}));

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: jest.fn().mockResolvedValue({
    subject: "user-subject",
    email: "test-user@example.com",
    tenantId: "example",
    userContextHeader: "encoded-user",
  }),
  buildBackendHeaders: jest.fn().mockReturnValue({
    "Content-Type": "application/json",
    "X-User-Context": "encoded-user",
  }),
  getDynamicAgentsConfig: jest.fn().mockReturnValue({
    dynamicAgentsUrl: "http://dynamic-agents.example.test",
  }),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/authz-tracing", () => ({
  createAuthzTraceContext: jest.fn().mockReturnValue({
    traceparent: "00-example-trace",
  }),
}));

jest.mock("@/lib/rbac/openfga-agent-authz", () => ({
  requireAgentUsePermission: (...args: unknown[]) =>
    mockRequireAgentUsePermission(...args),
}));

jest.mock("@/app/api/v1/chat/_conversation-authz", () => ({
  authorizeConversationWriteAccess: (...args: unknown[]) =>
    mockAuthorizeConversationWriteAccess(...args),
}));

import { POST } from "../chat/conversations/[id]/rewind/route";

const conversationId = "12345678-1234-1234-1234-123456789012";

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    `http://localhost/api/chat/conversations/${conversationId}/rewind`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function collection(overrides: Record<string, unknown> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    ...overrides,
  };
}

describe("POST /api/chat/conversations/[id]/rewind", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("does not rewind automated history when the shared authorizer rejects it", async () => {
    mockAuthorizeConversationWriteAccess.mockResolvedValueOnce({
      denial: NextResponse.json({ error: "Automated history is read-only" }, { status: 409 }),
    });
    global.fetch = jest.fn();
    const response = await POST(
      request({ agent_id: "primary-agent", message_id: "run-request" }),
      { params: Promise.resolve({ id: conversationId }) },
    );
    expect(response.status).toBe(409);
    expect(mockGetCollection).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rewinds LangGraph and removes the selected turn plus future turns", async () => {
    const ids = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()];
    const messages = [
      {
        _id: ids[0],
        message_id: "user-1",
        conversation_id: conversationId,
        role: "user",
        content: "repeat",
        sender_email: "test-user@example.com",
        created_at: new Date("2026-01-01T00:00:00Z"),
        metadata: { turn_id: "turn-1" },
      },
      {
        _id: ids[1],
        message_id: "assistant-1",
        conversation_id: conversationId,
        role: "assistant",
        content: "first response",
        created_at: new Date("2026-01-01T00:00:01Z"),
        metadata: { turn_id: "turn-1" },
      },
      {
        _id: ids[2],
        message_id: "user-2",
        conversation_id: conversationId,
        role: "user",
        content: "repeat",
        sender_email: "test-user@example.com",
        created_at: new Date("2026-01-01T00:00:02Z"),
        metadata: { turn_id: "turn-2" },
      },
      {
        _id: ids[3],
        message_id: "assistant-2",
        conversation_id: conversationId,
        role: "assistant",
        content: "second response",
        created_at: new Date("2026-01-01T00:00:03Z"),
        metadata: { turn_id: "turn-2" },
      },
    ];
    const conversations = collection({
      findOne: jest.fn().mockResolvedValue({
        _id: conversationId,
        owner_id: "test-user@example.com",
      }),
    });
    const messageCollection = collection({
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue(messages),
        }),
      }),
    });
    const turns = collection();
    const feedback = collection();
    const bookmarks = collection();
    mockGetCollection.mockImplementation((name: string) => {
      const collections = {
        conversations,
        messages: messageCollection,
        turns,
        feedback,
        conversation_bookmarks: bookmarks,
      };
      return Promise.resolve(collections[name as keyof typeof collections]);
    });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { checkpoint_id: "forked-checkpoint" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await POST(
      request({ agent_id: "primary-agent", message_id: "user-2" }),
      { params: Promise.resolve({ id: conversationId }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      removed_messages: 2,
      checkpoint_id: "forked-checkpoint",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      new URL(
        `/api/v1/conversations/${conversationId}/rewind`,
        "http://dynamic-agents.example.test",
      ),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          agent_id: "primary-agent",
          turn_id: "turn-2",
          message_content: "repeat",
          content_occurrence: 2,
        }),
      }),
    );
    expect(messageCollection.deleteMany).toHaveBeenCalledWith({
      _id: { $in: [ids[2], ids[3]] },
    });
    expect(turns.deleteMany).toHaveBeenCalledWith({
      conversation_id: conversationId,
      client_type: "ui",
      turn_id: { $in: ["turn-2"] },
    });
    expect(feedback.deleteMany).toHaveBeenCalledWith({
      conversation_id: conversationId,
      message_id: { $in: ["user-2", "assistant-2"] },
    });
    expect(bookmarks.deleteMany).toHaveBeenCalledWith({
      conversation_id: conversationId,
      message_id: { $in: ["user-2", "assistant-2"] },
    });
    expect(conversations.updateOne).toHaveBeenCalledWith(
      { _id: conversationId },
      expect.objectContaining({
        $set: expect.objectContaining({ "metadata.total_messages": 2 }),
      }),
    );
  });

  it("does not mutate history when checkpoint rewind fails", async () => {
    const messageCollection = collection({
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([
            {
              _id: new ObjectId(),
              message_id: "user-1",
              conversation_id: conversationId,
              role: "user",
              content: "hello",
              sender_email: "test-user@example.com",
              created_at: new Date(),
              metadata: { turn_id: "turn-1" },
            },
          ]),
        }),
      }),
    });
    mockGetCollection.mockImplementation((name: string) =>
      Promise.resolve(
        name === "conversations"
          ? collection({
              findOne: jest.fn().mockResolvedValue({
                _id: conversationId,
                owner_id: "test-user@example.com",
              }),
            })
          : messageCollection,
      ),
    );
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "Checkpoint not found" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await POST(
      request({ agent_id: "primary-agent", message_id: "user-1" }),
      { params: Promise.resolve({ id: conversationId }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Checkpoint not found",
    });
    expect(messageCollection.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects edits from a shared conversation participant", async () => {
    const conversations = collection({
      findOne: jest.fn().mockResolvedValue({
        _id: conversationId,
        owner_id: "owner@example.com",
      }),
    });
    mockGetCollection.mockResolvedValue(conversations);
    global.fetch = jest.fn();

    const response = await POST(
      request({ agent_id: "primary-agent", message_id: "user-1" }),
      { params: Promise.resolve({ id: conversationId }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe("Only the conversation owner can edit its history");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
