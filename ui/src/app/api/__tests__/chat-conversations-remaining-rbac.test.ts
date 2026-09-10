/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetCollection = jest.fn();
const mockGetUserTeamIds = jest.fn();
const mockRequireOwnership = jest.fn();
const mockFilterConversationsByImplicitOrExplicitPermission = jest.fn();
const mockGetDirectSharingAccessConversationIds = jest.fn();
const mockRequireConversationResourcePermission = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public statusCode = 500,
    ) {
      super(message);
    }
  }
  const user = { email: "alice@example.com", role: "user" };
  const session = { sub: "alice-sub", role: "user" };
  return {
    ApiError,
    getAuthFromBearerOrSession: async () => ({ user, session }),
    getPaginationParams: () => ({ page: 1, pageSize: 20, skip: 0 }),
    getUserTeamIds: (...args: unknown[]) => mockGetUserTeamIds(...args),
    paginatedResponse: (items: unknown[], total: number, page: number, pageSize: number) =>
      Response.json({ success: true, data: { items, pagination: { total, page, pageSize } } }),
    requireOwnership: (...args: unknown[]) => mockRequireOwnership(...args),
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    validateEmail: () => true,
    validateConversationId: () => true,
    validateRequired: jest.fn(),
    withAuth: async (_request: NextRequest, handler: (...args: unknown[]) => Promise<Response>) =>
      handler(_request, user, session),
    withErrorHandler:
      <T,>(handler: (...args: unknown[]) => Promise<T>) =>
      async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (error) {
          return Response.json(
            { success: false, error: error instanceof Error ? error.message : "error" },
            { status: (error as { statusCode?: number }).statusCode ?? 500 },
          );
        }
      },
  };
});

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
  getDirectSharingAccessConversationIds: (...args: unknown[]) =>
    mockGetDirectSharingAccessConversationIds(...args),
  requireConversationResourcePermission: (...args: unknown[]) =>
    mockRequireConversationResourcePermission(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireConversationResourcePermission(...args),
}));

function request(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: "11111111-1111-4111-8111-111111111111",
    title: "OpenFGA Conversation",
    owner_id: "bob@example.com",
    sharing: { is_public: false, shared_with: [], shared_with_teams: [] },
    is_pinned: false,
    is_archived: false,
    metadata: {},
    ...overrides,
  };
}

function collectionWithItems(items: unknown[]) {
  const limit = jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(items) });
  const skip = jest.fn().mockReturnValue({ limit });
  const sort = jest.fn().mockReturnValue({ skip });
  return {
    countDocuments: jest.fn().mockResolvedValue(items.length),
    deleteMany: jest.fn(),
    find: jest.fn().mockReturnValue({ sort, toArray: jest.fn().mockResolvedValue([]) }),
    findOne: jest.fn().mockResolvedValue(items[0] ?? null),
    insertMany: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
  };
}

describe("remaining conversation routes use OpenFGA instead of legacy owner/team gates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserTeamIds.mockResolvedValue(["legacy-team"]);
    mockRequireOwnership.mockImplementation(() => {
      throw Object.assign(new Error("legacy owner denied"), { statusCode: 403 });
    });
    mockFilterConversationsByImplicitOrExplicitPermission.mockImplementation(
      async (_session, _email, items) => items,
    );
    mockGetDirectSharingAccessConversationIds.mockResolvedValue([]);
    mockRequireConversationResourcePermission.mockResolvedValue(undefined);
  });

  it("shared conversations prefilter sharing candidates before OpenFGA authorization", async () => {
    const candidate = conversation();
    const conversations = collectionWithItems([candidate]);
    mockGetCollection.mockResolvedValue(conversations);
    const { GET } = await import("../chat/shared/route");

    const response = await GET(request("/api/chat/shared"));

    expect(response.status).toBe(200);
    expect(mockGetUserTeamIds).not.toHaveBeenCalled();
    expect(conversations.find).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_id: { $ne: "alice@example.com" },
      }),
    );
    expect(conversations.find.mock.calls[0][0].$or).toEqual([
      { "sharing.shared_with": "alice@example.com" },
      { "sharing.share_link_enabled": true },
      { "sharing.shared_with_teams.0": { $exists: true } },
    ]);
    expect(mockFilterConversationsByImplicitOrExplicitPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      "alice@example.com",
      [candidate],
      "discover",
      [],
    );
  });

  it("conversation list prefilters owned and sharing-configured candidates before OpenFGA authorization", async () => {
    const candidate = conversation({ owner_id: "alice@example.com" });
    const conversations = collectionWithItems([candidate]);
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "conversations") return conversations;
      return collectionWithItems([]);
    });
    const { GET } = await import("../chat/conversations/route");

    const response = await GET(request("/api/chat/conversations"));

    expect(response.status).toBe(200);
    const mongoQuery = conversations.find.mock.calls[0][0];
    expect(mongoQuery.$and).toEqual(
      expect.arrayContaining([
        {
          $or: [
            { owner_id: "alice@example.com" },
            { "sharing.shared_with": "alice@example.com" },
            { "sharing.shared_with_teams.0": { $exists: true } },
          ],
        },
      ]),
    );
    expect(mockFilterConversationsByImplicitOrExplicitPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      "alice@example.com",
      [candidate],
      "discover",
      [],
    );
  });

  it("search conversations applies candidate and text filters before OpenFGA", async () => {
    const candidate = conversation({ title: "needle" });
    const conversations = collectionWithItems([candidate]);
    mockGetCollection.mockResolvedValue(conversations);
    const { GET } = await import("../chat/search/route");

    const response = await GET(request("/api/chat/search?q=needle"));

    expect(response.status).toBe(200);
    const mongoQuery = conversations.find.mock.calls[0][0];
    expect(mongoQuery.$and).toEqual(
      expect.arrayContaining([
        {
          $or: [
            { owner_id: "alice@example.com" },
            { "sharing.shared_with": "alice@example.com" },
            { "sharing.shared_with_teams.0": { $exists: true } },
          ],
        },
        expect.objectContaining({
          $or: expect.arrayContaining([expect.objectContaining({ title: expect.any(Object) })]),
        }),
      ]),
    );
    expect(mockFilterConversationsByImplicitOrExplicitPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      "alice@example.com",
      [candidate],
      "discover",
      [],
    );
  });

  it("trash listing is bounded to owned and sharing-configured candidates before OpenFGA", async () => {
    const deleted = conversation({ deleted_at: new Date() });
    const conversations = collectionWithItems([deleted]);
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "conversations") return conversations;
      return { deleteMany: jest.fn() };
    });
    const { GET } = await import("../chat/conversations/trash/route");

    const response = await GET(request("/api/chat/conversations/trash"));

    expect(response.status).toBe(200);
    const listQuery = conversations.find.mock.calls[1][0];
    expect(listQuery.$and).toEqual(
      expect.arrayContaining([
        { deleted_at: { $exists: true, $ne: null } },
        {
          $or: [
            { owner_id: "alice@example.com" },
            { "sharing.shared_with": "alice@example.com" },
            { "sharing.shared_with_teams.0": { $exists: true } },
          ],
        },
      ]),
    );
    expect(mockFilterConversationsByImplicitOrExplicitPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      "alice@example.com",
      [deleted],
      "discover",
      [],
    );
  });

  it.each([
    ["pin", "../chat/conversations/[id]/pin/route"],
    ["archive", "../chat/conversations/[id]/archive/route"],
    ["restore", "../chat/conversations/[id]/restore/route"],
  ])("%s accepts OpenFGA write permission without legacy owner equality", async (_name, routePath) => {
    const existing = conversation({ deleted_at: new Date() });
    const conversations = collectionWithItems([existing]);
    mockGetCollection.mockResolvedValue(conversations);
    const { POST } = await import(routePath);

    const response = await POST(
      request("/api/chat/conversations/11111111-1111-4111-8111-111111111111/pin", { method: "POST" }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) },
    );

    expect(response.status).toBe(200);
    expect(mockRequireOwnership).not.toHaveBeenCalled();
    expect(mockRequireConversationResourcePermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      "alice@example.com",
      expect.objectContaining({ _id: "11111111-1111-4111-8111-111111111111" }),
      "write",
    );
  });

  it("share updates accept OpenFGA share permission without legacy owner equality", async () => {
    const conversations = collectionWithItems([conversation()]);
    const sharingAccess = { find: jest.fn(), insertMany: jest.fn(), updateOne: jest.fn() };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "conversations") return conversations;
      if (name === "sharing_access") return sharingAccess;
      throw new Error(`unexpected collection ${name}`);
    });
    const { POST } = await import("../chat/conversations/[id]/share/route");

    const response = await POST(
      request("/api/chat/conversations/11111111-1111-4111-8111-111111111111/share", {
        method: "POST",
        body: JSON.stringify({ user_emails: ["viewer@example.com"], permission: "view" }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) },
    );

    expect(response.status).toBe(200);
    expect(mockRequireOwnership).not.toHaveBeenCalled();
    expect(mockRequireConversationResourcePermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      "alice@example.com",
      expect.objectContaining({ _id: "11111111-1111-4111-8111-111111111111" }),
      "share",
    );
  });
});
