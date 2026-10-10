/**
 * @jest-environment node
 *
 * Tests for the SA auto-grant behaviour in POST /api/chat/conversations:
 *  - SA caller → writeOpenFgaTuples called with writer tuple; created_by_service_account set
 *  - Normal user caller → NO tuple write; created_by_service_account NOT set
 *  - Idempotency hit with SA caller → writer tuple ensured (write-if-missing)
 *  - Idempotency hit with normal caller → NO tuple write
 *  - writeOpenFgaTuples failure → best-effort (conversation still returned 201)
 */

import { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockGetCollection = jest.fn();
const mockRequireAgentUsePermission = jest.fn();
const mockFilterConversationsByImplicitOrExplicitPermission = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();

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

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(new URL("/api/chat/conversations", "http://localhost:3000"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeCollection(existingDoc: Record<string, unknown> | null = null) {
  return {
    findOne: jest.fn().mockResolvedValue(existingDoc),
    insertOne: jest.fn().mockResolvedValue({ insertedId: "conv-new" }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
  };
}

const SA_SUB = "sa-uuid-abc";
const HUMAN_EMAIL = "human@example.com";
const AGENT_ID = "agent-default";
const CONV_BODY = { title: "Test Conversation", client_type: "slack", agent_id: AGENT_ID };

describe("POST /api/chat/conversations — SA auto-grant", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireRbacPermission.mockResolvedValue(undefined);
    mockRequireAgentUsePermission.mockResolvedValue(null);
    mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
    mockFilterConversationsByImplicitOrExplicitPermission.mockImplementation(
      async (_session, _email, items) => items,
    );
  });

  // ── SA caller: create path ───────────────────────────────────────────────────

  describe("SA caller (isServiceAccount=true)", () => {
    beforeEach(() => {
      mockGetAuthFromBearerOrSession.mockResolvedValue({
        user: { email: HUMAN_EMAIL, name: "Human" },
        session: { sub: SA_SUB, role: "user", isServiceAccount: true },
      });
    });

    it("writes a writer tuple and stamps created_by_service_account on a fresh create", async () => {
      const col = makeCollection(null);
      mockGetCollection.mockResolvedValue(col);
      const { POST } = await import("../chat/conversations/route");

      const response = await POST(postRequest({ ...CONV_BODY, owner_id: HUMAN_EMAIL }));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.data.created).toBe(true);

      // owner_id stays the human's email (auditability)
      expect(col.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ owner_id: HUMAN_EMAIL }),
      );
      // created_by_service_account must be stamped
      expect(col.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ created_by_service_account: SA_SUB }),
      );
      expect(col.insertOne).toHaveBeenCalledWith(
        expect.not.objectContaining({ owner_subject: expect.anything() }),
      );

      // writer tuple must be written
      expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith(
        expect.objectContaining({
          writes: expect.arrayContaining([
            expect.objectContaining({
              user: `service_account:${SA_SUB}`,
              relation: "writer",
              object: expect.stringMatching(/^conversation:/),
            }),
          ]),
          deletes: [],
        }),
      );
    });

    it("owner_id stays the human's email (auditability) regardless of who is the SA caller", async () => {
      const col = makeCollection(null);
      mockGetCollection.mockResolvedValue(col);
      const { POST } = await import("../chat/conversations/route");

      await POST(postRequest({ ...CONV_BODY, owner_id: HUMAN_EMAIL }));

      // owner_id MUST be the human's email — the SA does not take ownership
      expect(col.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ owner_id: HUMAN_EMAIL }),
      );
      // created_by_service_account should be the SA sub for audit trail
      expect(col.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ created_by_service_account: SA_SUB }),
      );
    });

    it("uses a known email for analytics without granting an unlinked caller ownership", async () => {
      mockGetAuthFromBearerOrSession.mockResolvedValue({
        user: { email: "service-account-connector", name: "Connector" },
        session: {
          sub: SA_SUB,
          role: "user",
          isServiceAccount: true,
          authMethod: "bearer",
        },
      });
      const conversations = makeCollection(null);
      const users = {
        findOne: jest.fn().mockResolvedValue({ keycloak_sub: "person-subject" }),
      };
      mockGetCollection.mockImplementation(async (name: string) => (
        name === "users" ? users : conversations
      ));
      const { POST } = await import("../chat/conversations/route");

      const response = await POST(postRequest({
        ...CONV_BODY,
        owner_id: HUMAN_EMAIL,
        metadata: { owner_connector_id: "U123EXAMPLE" },
      }));

      expect(response.status).toBe(201);
      expect(conversations.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          owner_id: HUMAN_EMAIL,
          owner_canonical_subject: "person-subject",
        }),
      );
      expect(conversations.insertOne).toHaveBeenCalledWith(
        expect.not.objectContaining({ owner_subject: expect.anything() }),
      );
      expect(conversations.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            {
              $or: expect.arrayContaining([
                { owner_id: "U123EXAMPLE" },
              ]),
            },
          ]),
        }),
        {
          $set: {
            owner_canonical_subject: "person-subject",
            owner_identity_version: 2,
          },
        },
      );
    });

    it("returns 201 even when writeOpenFgaTuples throws (best-effort)", async () => {
      mockWriteOpenFgaTuples.mockRejectedValue(new Error("OpenFGA unavailable"));
      const col = makeCollection(null);
      mockGetCollection.mockResolvedValue(col);
      const { POST } = await import("../chat/conversations/route");

      const response = await POST(postRequest({ ...CONV_BODY, owner_id: HUMAN_EMAIL }));

      expect(response.status).toBe(201);
      expect(col.insertOne).toHaveBeenCalled();
    });
  });

  // ── Normal user: create path ─────────────────────────────────────────────────

  describe("normal user caller (isServiceAccount falsy)", () => {
    beforeEach(() => {
      mockGetAuthFromBearerOrSession.mockResolvedValue({
        user: { email: "alice@example.com", name: "Alice" },
        session: { sub: "alice-sub", role: "user" },
      });
    });

    it("does NOT write any writer tuple and does NOT stamp created_by_service_account", async () => {
      const col = makeCollection(null);
      mockGetCollection.mockResolvedValue(col);
      const { POST } = await import("../chat/conversations/route");

      const response = await POST(postRequest(CONV_BODY));

      expect(response.status).toBe(201);
      // No tuple write for normal users
      expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
      // No SA provenance field
      expect(col.insertOne).toHaveBeenCalledWith(
        expect.not.objectContaining({ created_by_service_account: expect.anything() }),
      );
    });

    it("stamps owner_subject when the owner is the caller", async () => {
      const col = makeCollection(null);
      mockGetCollection.mockResolvedValue(col);
      const { POST } = await import("../chat/conversations/route");

      await POST(postRequest(CONV_BODY));

      expect(col.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          owner_id: "alice@example.com",
          owner_subject: "alice-sub",
          owner_canonical_subject: "alice-sub",
          owner_identity_version: 2,
        }),
      );
      expect(col.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            expect.objectContaining({ $or: expect.any(Array) }),
          ]),
        }),
        {
          $set: {
            owner_subject: "alice-sub",
            owner_canonical_subject: "alice-sub",
            owner_identity_version: 2,
          },
        },
      );
    });

    it("reconciles the stable Slack id when a linked request supplies an email", async () => {
      mockGetAuthFromBearerOrSession.mockResolvedValue({
        user: { email: "alice@example.com", name: "Alice" },
        session: { sub: "alice-sub", role: "user", authMethod: "bearer" },
      });
      const col = makeCollection(null);
      mockGetCollection.mockResolvedValue(col);
      const { POST } = await import("../chat/conversations/route");

      await POST(postRequest({
        ...CONV_BODY,
        owner_id: "alice@example.com",
        metadata: { owner_connector_id: "U123EXAMPLE" },
      }));

      expect(col.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          owner_id: "alice@example.com",
          owner_subject: "alice-sub",
          owner_canonical_subject: "alice-sub",
          owner_identity_version: 2,
        }),
      );
      expect(col.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            {
              $or: expect.arrayContaining([
                { owner_id: "U123EXAMPLE" },
              ]),
            },
          ]),
        }),
        expect.objectContaining({
          $set: expect.objectContaining({ owner_subject: "alice-sub" }),
        }),
      );
    });

    it("does not create a linked conversation when identity reconciliation fails", async () => {
      const col = makeCollection(null);
      col.updateMany.mockRejectedValue(new Error("database unavailable"));
      mockGetCollection.mockResolvedValue(col);
      const { POST } = await import("../chat/conversations/route");

      const response = await POST(postRequest(CONV_BODY));

      expect(response.status).toBe(500);
      expect(col.insertOne).not.toHaveBeenCalled();
    });
  });

  // ── Idempotency hit: SA caller ───────────────────────────────────────────────

  describe("idempotency hit (existing conversation) with SA caller", () => {
    const existingConv = {
      _id: "existing-conv-id",
      title: "Old Conversation",
      client_type: "slack",
      owner_id: HUMAN_EMAIL,
      metadata: {},
    };

    beforeEach(() => {
      mockGetAuthFromBearerOrSession.mockResolvedValue({
        user: { email: HUMAN_EMAIL, name: "Human" },
        session: { sub: SA_SUB, role: "user", isServiceAccount: true },
      });
    });

    it("ensures the writer tuple (write-if-missing) on idempotency hit", async () => {
      const col = makeCollection(existingConv);
      mockGetCollection.mockResolvedValue(col);
      const { POST } = await import("../chat/conversations/route");

      const response = await POST(
        postRequest({ ...CONV_BODY, idempotency_key: "slack-thread-ts-123" }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data.created).toBe(false);

      // The writer tuple must be written (heals pre-fix conversations)
      expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith(
        expect.objectContaining({
          writes: expect.arrayContaining([
            expect.objectContaining({
              user: `service_account:${SA_SUB}`,
              relation: "writer",
              object: `conversation:${existingConv._id}`,
            }),
          ]),
          deletes: [],
        }),
      );
    });

    it("returns the existing conversation even when idempotency-hit grant write fails", async () => {
      mockWriteOpenFgaTuples.mockRejectedValue(new Error("OpenFGA down"));
      const col = makeCollection(existingConv);
      mockGetCollection.mockResolvedValue(col);
      const { POST } = await import("../chat/conversations/route");

      const response = await POST(
        postRequest({ ...CONV_BODY, idempotency_key: "slack-thread-ts-123" }),
      );

      expect(response.status).toBe(200);
    });
  });

  // ── Idempotency hit: normal user ─────────────────────────────────────────────

  describe("idempotency hit with normal user caller", () => {
    const existingConv = {
      _id: "existing-conv-id-2",
      title: "Existing Conversation",
      client_type: "webui",
      owner_id: "alice@example.com",
      metadata: {},
    };

    beforeEach(() => {
      mockGetAuthFromBearerOrSession.mockResolvedValue({
        user: { email: "alice@example.com", name: "Alice" },
        session: { sub: "alice-sub", role: "user" },
      });
    });

    it("does NOT write any grant on idempotency hit for normal users", async () => {
      const col = makeCollection(existingConv);
      mockGetCollection.mockResolvedValue(col);
      const { POST } = await import("../chat/conversations/route");

      const response = await POST(
        postRequest({ ...CONV_BODY, idempotency_key: "some-key" }),
      );

      expect(response.status).toBe(200);
      expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
    });
  });
});
