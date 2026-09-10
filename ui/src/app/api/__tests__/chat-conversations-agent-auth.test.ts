/**
 * @jest-environment node
 */

import { NextRequest, NextResponse } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockGetCollection = jest.fn();
const mockRequireAgentUsePermission = jest.fn();
const mockGetUserTeamIds = jest.fn();
const mockFilterConversationsByImplicitOrExplicitPermission = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public statusCode = 500,
    ) {
      super(message);
    }
  }

  return {
    ApiError,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    getPaginationParams: () => ({ page: 1, pageSize: 20, skip: 0 }),
    getUserTeamIds: (...args: unknown[]) => mockGetUserTeamIds(...args),
    paginatedResponse: (items: unknown[], total: number, page: number, pageSize: number) =>
      Response.json({ success: true, data: { items, pagination: { total, page, pageSize } } }),
    requireRbacPermission: (...args: unknown[]) => mockRequireRbacPermission(...args),
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    validateRequired: (body: Record<string, unknown>, fields: string[]) => {
      for (const field of fields) {
        if (!body[field]) throw new ApiError(`Missing required field: ${field}`, 400);
      }
    },
    withErrorHandler:
      <T,>(handler: (request: NextRequest) => Promise<T>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (error) {
          return Response.json(
            { success: false, error: error instanceof Error ? error.message : "error" },
            { status: (error as { statusCode?: number }).statusCode ?? 500 },
          );
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({
  annotateConversationsWithViewerSharing: (_session: unknown, userEmail: string, items: Array<{ owner_id?: string }>) =>
    items.map((item) => ({
      ...item,
      viewer_has_shared_access: item.owner_id?.toLowerCase() !== userEmail.toLowerCase(),
    })),
  conversationVisibilityCandidateQuery: (userEmail: string, directShareConversationIds: string[] = []) => ({
    $or: [
      { owner_id: userEmail },
      { "sharing.shared_with": userEmail },
      ...(directShareConversationIds.length > 0 ? [{ _id: { $in: directShareConversationIds } }] : []),
      { "sharing.shared_with_teams.0": { $exists: true } },
    ],
  }),
  filterConversationsByImplicitOrExplicitPermission: (...args: unknown[]) =>
    mockFilterConversationsByImplicitOrExplicitPermission(...args),
  getDirectSharingAccessConversationIds: jest.fn(async () => []),
}));

jest.mock("@/lib/rbac/openfga-agent-authz", () => ({
  requireAgentUsePermission: (...args: unknown[]) => mockRequireAgentUsePermission(...args),
}));

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest(new URL("/api/chat/conversations", "http://localhost:3000"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat/conversations agent authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "alice@example.com", name: "Alice" },
      session: { sub: "alice-sub", role: "user" },
    });
    mockRequireRbacPermission.mockResolvedValue(undefined);
    mockRequireAgentUsePermission.mockResolvedValue(null);
    mockGetUserTeamIds.mockResolvedValue(["legacy-team"]);
    mockFilterConversationsByImplicitOrExplicitPermission.mockImplementation(
      async (_session, _email, items) => items,
    );
  });

  it("lists bounded conversation candidates before OpenFGA filtering", async () => {
    const candidate = {
      _id: "conv-openfga-only",
      title: "OpenFGA Only",
      client_type: "webui",
      owner_id: "bob@example.com",
      sharing: { is_public: false, shared_with: [], shared_with_teams: [] },
      metadata: {},
    };
    const limit = jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([candidate]) });
    const skip = jest.fn().mockReturnValue({ limit });
    const sort = jest.fn().mockReturnValue({ skip });
    const find = jest.fn().mockReturnValue({ sort });
    const countDocuments = jest.fn().mockResolvedValue(1);
    mockGetCollection.mockResolvedValue({ find, countDocuments });
    const { GET } = await import("../chat/conversations/route");

    const response = await GET(new NextRequest(new URL("/api/chat/conversations", "http://localhost:3000")));

    expect(response.status).toBe(200);
    expect(mockGetUserTeamIds).not.toHaveBeenCalled();
    expect(countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        $and: expect.arrayContaining([
          {
            $or: [
              { owner_id: "alice@example.com" },
              { "sharing.shared_with": "alice@example.com" },
              { "sharing.shared_with_teams.0": { $exists: true } },
            ],
          },
        ]),
      }),
    );
    expect(mockFilterConversationsByImplicitOrExplicitPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      "alice@example.com",
      [candidate],
      "discover",
      [],
    );
  });

  it("checks OpenFGA can_use before binding a dynamic agent to a new conversation", async () => {
    const insertOne = jest.fn().mockResolvedValue({ insertedId: "conv-1" });
    mockGetCollection.mockResolvedValue({ findOne: jest.fn(), insertOne });
    const { POST } = await import("../chat/conversations/route");

    const response = await POST(
      request({
        title: "New Conversation",
        client_type: "webui",
        agent_id: "foo-bar",
      }),
    );

    expect(response.status).toBe(201);
    expect(mockRequireAgentUsePermission).toHaveBeenCalledWith({
      subject: "alice-sub",
      agentId: "foo-bar",
      email: "alice@example.com",
    });
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        participants: expect.arrayContaining([expect.objectContaining({ type: "agent", id: "foo-bar" })]),
      }),
    );
  });

  it("persists source: 'api' when the caller declares an api origin", async () => {
    const insertOne = jest.fn().mockResolvedValue({ insertedId: "conv-1" });
    mockGetCollection.mockResolvedValue({ findOne: jest.fn(), insertOne });
    const { POST } = await import("../chat/conversations/route");

    const response = await POST(
      request({
        title: "ask-forge",
        client_type: "webui",
        agent_id: "default",
        source: "api",
      }),
    );

    expect(response.status).toBe(201);
    expect(insertOne).toHaveBeenCalledWith(expect.objectContaining({ source: "api" }));
  });

  it("ignores an unrecognized source value from the caller", async () => {
    const insertOne = jest.fn().mockResolvedValue({ insertedId: "conv-1" });
    mockGetCollection.mockResolvedValue({ findOne: jest.fn(), insertOne });
    const { POST } = await import("../chat/conversations/route");

    const response = await POST(
      request({
        title: "New Conversation",
        client_type: "webui",
        agent_id: "foo-bar",
        source: "autonomous",
      }),
    );

    expect(response.status).toBe(201);
    expect(insertOne).toHaveBeenCalledWith(expect.not.objectContaining({ source: expect.anything() }));
  });

  it("forces client_type/source to 'api' for a Bearer caller falsely claiming 'webui'", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "ask-forge@example.com", name: "ask-forge" },
      session: { sub: "external-sub", role: "user", authMethod: "bearer" },
    });
    const insertOne = jest.fn().mockResolvedValue({ insertedId: "conv-1" });
    mockGetCollection.mockResolvedValue({ findOne: jest.fn(), insertOne });
    const { POST } = await import("../chat/conversations/route");

    const response = await POST(
      request({
        title: "ask-forge",
        client_type: "webui",
        agent_id: "default",
      }),
    );

    expect(response.status).toBe(201);
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ client_type: "api", source: "api" }),
    );
  });

  it("does not override a Bearer caller that self-declares 'slack'", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "slackbot@example.com", name: "Slack Bot" },
      session: { sub: "slack-bot-sub", role: "user", authMethod: "bearer" },
    });
    const insertOne = jest.fn().mockResolvedValue({ insertedId: "conv-1" });
    mockGetCollection.mockResolvedValue({ findOne: jest.fn(), insertOne });
    const { POST } = await import("../chat/conversations/route");

    const response = await POST(
      request({
        title: "Slack thread",
        client_type: "slack",
        agent_id: "default",
      }),
    );

    expect(response.status).toBe(201);
    expect(insertOne).toHaveBeenCalledWith(expect.objectContaining({ client_type: "slack" }));
    expect(insertOne).toHaveBeenCalledWith(expect.not.objectContaining({ source: expect.anything() }));
  });

  it("does not override a Bearer caller that self-declares 'webex'", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "webexbot@example.com", name: "Webex Bot" },
      session: { sub: "webex-bot-sub", role: "user", authMethod: "bearer" },
    });
    const insertOne = jest.fn().mockResolvedValue({ insertedId: "conv-1" });
    mockGetCollection.mockResolvedValue({ findOne: jest.fn(), insertOne });
    const { POST } = await import("../chat/conversations/route");

    const response = await POST(
      request({
        title: "Webex thread",
        client_type: "webex",
        agent_id: "default",
      }),
    );

    expect(response.status).toBe(201);
    expect(insertOne).toHaveBeenCalledWith(expect.objectContaining({ client_type: "webex" }));
  });

  it("does not override a session-cookie-authenticated caller declaring 'webui'", async () => {
    // Default beforeEach fixture has no authMethod set — the genuine
    // session-cookie path — so 'webui' must be trusted as-is.
    const insertOne = jest.fn().mockResolvedValue({ insertedId: "conv-1" });
    mockGetCollection.mockResolvedValue({ findOne: jest.fn(), insertOne });
    const { POST } = await import("../chat/conversations/route");

    const response = await POST(
      request({
        title: "Browser conversation",
        client_type: "webui",
        agent_id: "default",
      }),
    );

    expect(response.status).toBe(201);
    expect(insertOne).toHaveBeenCalledWith(expect.objectContaining({ client_type: "webui" }));
    expect(insertOne).toHaveBeenCalledWith(expect.not.objectContaining({ source: expect.anything() }));
  });

  it("does not create the conversation when OpenFGA denies agent use", async () => {
    const insertOne = jest.fn();
    mockGetCollection.mockResolvedValue({ findOne: jest.fn(), insertOne });
    mockRequireAgentUsePermission.mockResolvedValue(
      NextResponse.json(
        { success: false, error: "Permission denied", code: "agent#use" },
        { status: 403 },
      ),
    );
    const { POST } = await import("../chat/conversations/route");

    const response = await POST(
      request({
        title: "New Conversation",
        client_type: "webui",
        agent_id: "foo-bar",
      }),
    );

    expect(response.status).toBe(403);
    expect(insertOne).not.toHaveBeenCalled();
  });
});
