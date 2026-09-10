/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockRequireConversationResourcePermission = jest.fn();
const mockRequireResourcePermission = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    statusCode: number;
    code?: string;

    constructor(message: string, statusCode = 500, code?: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  }

  return {
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    withErrorHandler:
      (handler: (...args: unknown[]) => Promise<Response>) =>
      async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (error) {
          const err = error as { message?: string; statusCode?: number; code?: string };
          return Response.json(
            { success: false, error: err.message ?? "Internal server error", code: err.code },
            { status: err.statusCode ?? 500 },
          );
        }
      },
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    ApiError,
    validateConversationId: () => true,
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({
  requireConversationResourcePermission: (...args: unknown[]) =>
    mockRequireConversationResourcePermission(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
}));

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    new URL("/api/chat/conversations/11111111-1111-4111-8111-111111111111/metadata", "http://localhost:3000"),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("PATCH /api/chat/conversations/[id]/metadata auth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "sraradhy@cisco.com", name: "Sri Aradhyula" },
      session: {
        accessToken: "slack-obo-token",
        sub: "9c7381c0-9f57-44c6-86ef-978b1c48811c",
        user: { email: "sraradhy@cisco.com" },
      },
    });
    mockRequireConversationResourcePermission.mockResolvedValue(undefined);
    mockRequireResourcePermission.mockRejectedValue(
      Object.assign(new Error("You do not have permission to access this resource."), {
        statusCode: 403,
        code: "conversation#write",
      }),
    );
  });

  it("allows Slack OBO users to update metadata on conversations they implicitly own", async () => {
    const conversation = {
      _id: "11111111-1111-4111-8111-111111111111",
      title: "Slack Thread",
      client_type: "slack",
      owner_id: "sraradhy@cisco.com",
      owner_subject: "9c7381c0-9f57-44c6-86ef-978b1c48811c",
      metadata: { thread_ts: "1779106284.678209" },
    };
    const conversations = {
      findOne: jest.fn().mockResolvedValueOnce(conversation).mockResolvedValueOnce({
        ...conversation,
        metadata: { ...conversation.metadata, last_processed_ts: "1779106330.882329" },
      }),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    };
    mockGetCollection.mockResolvedValue(conversations);

    const { PATCH } = await import("../chat/conversations/[id]/metadata/route");
    const response = await PATCH(request({ metadata: { last_processed_ts: "1779106330.882329" } }), {
      params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
    });

    expect(response.status).toBe(200);
    expect(mockRequireConversationResourcePermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "9c7381c0-9f57-44c6-86ef-978b1c48811c" }),
      "sraradhy@cisco.com",
      expect.objectContaining({ client_type: "slack" }),
      "write",
    );
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
    expect(conversations.updateOne).toHaveBeenCalledWith(
      { _id: "11111111-1111-4111-8111-111111111111" },
      expect.objectContaining({
        $set: expect.objectContaining({
          "metadata.last_processed_ts": "1779106330.882329",
        }),
      }),
    );
  });
});
