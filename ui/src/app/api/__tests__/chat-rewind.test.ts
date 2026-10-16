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
      conversation_id: conversationId,
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

describe("sandbox rewind history acknowledgement", () => {
  const originalFetch = global.fetch;
  const checkpointId = "native-checkpoint";
  beforeEach(() => jest.clearAllMocks());
  afterAll(() => { global.fetch = originalFetch; });

  function fixture() {
    const ids = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()];
    let history = ids.map((id, index) => ({
      _id: id, message_id: ["user-1", "assistant-1", "user-2", "assistant-2"][index],
      conversation_id: conversationId, role: index % 2 === 0 ? "user" : "assistant",
      content: index % 2 === 0 ? "repeat" : "response", sender_email: "test-user@example.com",
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)), metadata: { turn_id: `turn-${Math.floor(index / 2) + 1}` },
    }));
    const conversation: Record<string, unknown> = {
      _id: conversationId, owner_id: "test-user@example.com", metadata: { total_messages: 4 },
    };
    function value(key: string): unknown {
      return key.split(".").reduce<unknown>((current, part) =>
        current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, conversation);
    }
    function matches(filter: Record<string, unknown>): boolean {
      return Object.entries(filter).every(([key, expected]) => {
        if (key === "$or") return (expected as Record<string, unknown>[]).some(matches);
        if (expected && typeof expected === "object" && "$exists" in expected) return (value(key) !== undefined) === expected.$exists;
        return value(key) === expected;
      });
    }
    const conversations = collection({
      findOne: jest.fn().mockImplementation(async () => ({ ...conversation,
        native_rewind: conversation.native_rewind ? { ...(conversation.native_rewind as Record<string, unknown>) } : undefined,
      })),
      updateOne: jest.fn().mockImplementation(async (filter, update) => {
        if (!matches(filter)) return { matchedCount: 0, modifiedCount: 0 };
        for (const [key, newValue] of Object.entries(update.$set ?? {})) {
          const parts = key.split(".");
          let parent = conversation;
          for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
          parent[parts.at(-1)!] = key === "native_rewind" ? { ...(newValue as Record<string, unknown>) } : newValue;
        }
        return { matchedCount: 1, modifiedCount: 1 };
      }),
    });
    const messages = collection({
      find: jest.fn().mockImplementation(() => ({ sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockImplementation(async () => [...history]),
      }) })),
      deleteMany: jest.fn().mockImplementation(async (filter) => {
        expect(filter.conversation_id).toBe(conversationId);
        const previous = history.length;
        history = history.filter((message) => !filter._id.$in.some((id: ObjectId) => message._id.equals(id)));
        return { deletedCount: previous - history.length };
      }),
    });
    const turns = collection();
    const feedback = collection();
    const bookmarks = collection();
    mockGetCollection.mockImplementation(async (name: string) => ({
      conversations, messages, turns, feedback, conversation_bookmarks: bookmarks,
    })[name]);
    const response = (data: Record<string, unknown>, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { "Content-Type": "application/json" },
    });
    const backend = async (url: URL) => url.pathname.endsWith("/confirm")
      ? response({ success: true, data: { conversation_id: conversationId, checkpoint_id: checkpointId } })
      : response({ success: true, data: { checkpoint_id: checkpointId, confirmation_required: true } });
    const fetcher = jest.fn().mockImplementation(backend);
    global.fetch = fetcher;
    const invoke = (messageId = "user-2") => POST(request({ agent_id: "primary-agent", message_id: messageId }), {
      params: Promise.resolve({ id: conversationId }),
    });
    const operation = () => conversation.native_rewind as Record<string, unknown> | undefined;
    return { ids, history: () => history, conversation, conversations, messages, turns, feedback, bookmarks,
      fetcher, backend, response, invoke, operation };
  }

  it("confirms native state only after all canonical history cleanup has finished", async () => {
    const state = fixture();
    state.fetcher.mockImplementation(async (url: URL) => {
      if (url.pathname.endsWith("/confirm")) {
        expect(state.history().map((message) => message.message_id)).toEqual(["user-1", "assistant-1"]);
        expect(state.turns.deleteMany).toHaveBeenCalledTimes(1);
        expect(state.feedback.deleteMany).toHaveBeenCalledTimes(1);
        expect(state.bookmarks.deleteMany).toHaveBeenCalledTimes(1);
        expect(state.operation()?.phase).toBe("history_applied");
      }
      return state.backend(url);
    });
    expect((await state.invoke()).status).toBe(200);
    expect(state.fetcher).toHaveBeenCalledTimes(2);
    expect(state.fetcher).toHaveBeenLastCalledWith(new URL(
      `/api/v1/conversations/${conversationId}/rewind/confirm`, "http://dynamic-agents.example.test",
    ), expect.objectContaining({ body: JSON.stringify({ agent_id: "primary-agent", checkpoint_id: checkpointId,
      turn_id: "turn-2", message_content: "repeat", content_occurrence: 2 }) }));
    expect(state.operation()?.phase).toBe("completed");
    expect(state.operation()).not.toHaveProperty("message_content");
    expect(state.operation()).not.toHaveProperty("removed_ids");
  });

  it("retries failed confirmation after the target message has already been removed", async () => {
    const state = fixture();
    let fail = true;
    state.fetcher.mockImplementation(async (url: URL) => {
      if (url.pathname.endsWith("/confirm") && fail) { fail = false; return state.response({ error: "unavailable" }, 503); }
      return state.backend(url);
    });
    expect((await state.invoke()).status).toBe(503);
    expect(state.history()).toHaveLength(2);
    expect(state.operation()?.phase).toBe("history_applied");
    expect((await state.invoke()).status).toBe(200);
    expect(state.messages.deleteMany).toHaveBeenCalledTimes(1);
    expect(state.fetcher.mock.calls.filter(([url]) => !(url as URL).pathname.endsWith("/confirm"))).toHaveLength(1);
    expect(state.fetcher.mock.calls.filter(([url]) => (url as URL).pathname.endsWith("/confirm"))).toHaveLength(2);
    expect((await state.invoke()).status).toBe(200);
    expect(state.fetcher).toHaveBeenCalledTimes(3);
  });

  it("recovers partial collection cleanup without needing the deleted original message", async () => {
    const state = fixture();
    state.feedback.deleteMany.mockRejectedValueOnce(new Error("database unavailable"));
    expect((await state.invoke()).status).toBe(503);
    expect(state.history()).toHaveLength(2);
    expect(state.operation()?.phase).toBe("pending_history");
    expect(state.fetcher).toHaveBeenCalledTimes(1);
    expect((await state.invoke()).status).toBe(200);
    expect(state.fetcher).toHaveBeenCalledTimes(2);
    expect(state.messages.deleteMany).toHaveBeenCalledTimes(2);
    expect(state.operation()?.phase).toBe("completed");
  });

  it("does not reset a new branch after a lost final confirmation acknowledgement", async () => {
    const state = fixture();
    const update = state.conversations.updateOne.getMockImplementation()!;
    let fail = true;
    state.conversations.updateOne.mockImplementation(async (filter, change) => {
      if (fail && change.$set?.native_rewind?.phase === "completed") { fail = false; throw new Error("Final receipt write failed"); }
      return update(filter, change);
    });
    expect((await state.invoke()).status).toBe(503);
    expect(state.operation()?.phase).toBe("history_applied");
    (state.conversation.metadata as Record<string, unknown>).total_messages = 4;
    expect((await state.invoke()).status).toBe(200);
    expect(state.messages.deleteMany).toHaveBeenCalledTimes(1);
    expect((state.conversation.metadata as Record<string, unknown>).total_messages).toBe(4);
    expect(state.operation()?.phase).toBe("completed");
  });

  it("blocks a different edit while the original confirmation is pending", async () => {
    const state = fixture();
    state.fetcher.mockImplementation(async (url: URL) => url.pathname.endsWith("/confirm")
      ? state.response({ error: "unavailable" }, 503) : state.backend(url));
    expect((await state.invoke()).status).toBe(503);
    const calls = state.fetcher.mock.calls.length;
    expect((await state.invoke("user-1")).status).toBe(409);
    expect(state.fetcher).toHaveBeenCalledTimes(calls);
    expect(state.messages.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("does not accept HTTP success acknowledging a different checkpoint", async () => {
    const state = fixture();
    state.fetcher.mockImplementation(async (url: URL) => url.pathname.endsWith("/confirm")
      ? state.response({ success: true, data: { conversation_id: conversationId, checkpoint_id: "different" } }) : state.backend(url));
    expect((await state.invoke()).status).toBe(409);
    expect(state.operation()?.phase).toBe("history_applied");
  });

  it("ignores client metadata resembling a server-owned edit operation", async () => {
    const state = fixture();
    (state.conversation.metadata as Record<string, unknown>).native_rewind = {
      phase: "history_applied", message_id: "user-2", removed_ids: [new ObjectId()],
    };
    expect((await state.invoke()).status).toBe(200);
    expect(state.messages.deleteMany).toHaveBeenCalledWith({ conversation_id: conversationId, _id: { $in: state.ids.slice(2) } });
  });

  it("does not let a delayed rewind response replace a newer completed edit", async () => {
    const state = fixture();
    state.fetcher.mockImplementation(async (url: URL) => {
      // Another observer completed this edit, then a later edit completed,
      // while this request was still awaiting its original backend response.
      state.conversation.native_rewind = {
        operation_id: "later-operation", epoch: 0, owner_subject: "user-subject", owner_email: "test-user@example.com",
        agent_id: "primary-agent", message_id: "user-1", turn_id: "turn-1", checkpoint_id: "later-checkpoint",
        removed_messages: 4, phase: "completed",
      };
      return state.backend(url);
    });
    expect((await state.invoke()).status).toBe(409);
    expect(state.operation()?.operation_id).toBe("later-operation");
    expect(state.messages.deleteMany).not.toHaveBeenCalled();
    expect(state.fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect an edit from a delayed response after canonical runtime clear", async () => {
    const state = fixture();
    state.fetcher.mockImplementation(async (url: URL) => {
      state.conversation.native_rewind_epoch = 1;
      delete state.conversation.native_rewind;
      return state.backend(url);
    });
    expect((await state.invoke()).status).toBe(409);
    expect(state.operation()).toBeUndefined();
    expect(state.messages.deleteMany).not.toHaveBeenCalled();
    expect(state.fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not delete UI history for a malformed successful backend response", async () => {
    const state = fixture();
    state.fetcher.mockResolvedValue(state.response({ detail: "Not a native rewind acknowledgement" }));
    expect((await state.invoke()).status).toBe(502);
    expect(state.messages.deleteMany).not.toHaveBeenCalled();
    expect(state.operation()).toBeUndefined();
  });
});
