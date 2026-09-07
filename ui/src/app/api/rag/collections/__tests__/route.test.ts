/** @jest-environment node */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockHasOrganizationAdmin = jest.fn();
const mockReconcileCollectionRelationships = jest.fn();
const mockReplaceCollectionSources = jest.fn();
const mockManageableDatasourceIdsForCollectionPublishing = jest.fn();
const mockReconcileTupleDiff = jest.fn();
const mockRemoveRagCollectionFromAgentPins = jest.fn();
const mockBatchCheckOpenFgaTuples = jest.fn();
const mockRecordAutoApprovedPublication = jest.fn();
const mockInvalidatePublicationRequests = jest.fn();
const mockCreatePublicationRequest = jest.fn();
const mockRagCollectionSourceDependencyRevisions = jest.fn();
let mockPublicationSettings: Record<string, unknown>;

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) =>
      Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T>(handler: (request: NextRequest, context: T) => Promise<Response>) =>
      async (request: NextRequest, context: T) => {
        try {
          return await handler(request, context);
        } catch (error) {
          if (error instanceof actual.ApiError) {
            return Response.json(
              { success: false, error: error.message, code: error.code },
              { status: error.statusCode },
            );
          }
          throw error;
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/authz", () => ({
  reconcileTupleDiff: (...args: unknown[]) => mockReconcileTupleDiff(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  batchCheckOpenFgaTuples: (...args: unknown[]) =>
    mockBatchCheckOpenFgaTuples(...args),
}));

jest.mock("@/lib/publication-approval.server", () => {
  const actual = jest.requireActual("@/lib/publication-approval.server");
  return {
    ...actual,
    listPublicationActorTeamSlugs: jest.fn(async () => []),
    recordAutoApprovedPublication: (...args: unknown[]) =>
      mockRecordAutoApprovedPublication(...args),
    createPublicationRequest: (...args: unknown[]) =>
      mockCreatePublicationRequest(...args),
    invalidatePublicationRequests: (...args: unknown[]) =>
      mockInvalidatePublicationRequests(...args),
  };
});

jest.mock("@/lib/publication-approval-settings", () => {
  const actual = jest.requireActual("@/lib/publication-approval-settings");
  return {
    ...actual,
    getPublicationApprovalSettings: jest.fn(async () => mockPublicationSettings),
  };
});

jest.mock("@/lib/rag-collection-publication-approval.server", () => {
  const actual = jest.requireActual(
    "@/lib/rag-collection-publication-approval.server",
  );
  return {
    ...actual,
    ragCollectionSourceDependencyRevisions: (...args: unknown[]) =>
      mockRagCollectionSourceDependencyRevisions(...args),
  };
});

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
  filterResourcesByPermission: (...args: unknown[]) =>
    mockFilterResourcesByPermission(...args),
  subjectFromSession: () => "user:editor-sub",
}));

jest.mock("@/lib/rbac/platform-admin", () => ({
  hasOrganizationAdmin: (...args: unknown[]) =>
    mockHasOrganizationAdmin(...args),
}));

jest.mock("@/lib/rag-collections.server", () => ({
  RAG_COLLECTIONS_COLLECTION: "rag_collections",
  RAG_COLLECTION_ID_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  ragCollectionSetFields: (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value).filter(
        ([key, fieldValue]) => key !== "_id" && fieldValue !== undefined,
      ),
    ),
  collectionMembershipTuple: (collectionId: string, sourceId: string) => ({
    user: `rag_collection:${collectionId}`,
    relation: "parent_collection",
    object: `knowledge_base:${sourceId}`,
  }),
  collectionRelationshipTuples: (collection: { _id: string }) => [
    {
      user: "user:creator-sub",
      relation: "creator",
      object: `rag_collection:${collection._id}`,
    },
  ],
  reconcileCollectionRelationships: (...args: unknown[]) =>
    mockReconcileCollectionRelationships(...args),
  replaceCollectionSources: (...args: unknown[]) =>
    mockReplaceCollectionSources(...args),
  manageableDatasourceIdsForCollectionPublishing: (...args: unknown[]) =>
    mockManageableDatasourceIdsForCollectionPublishing(...args),
  ensureRagCollectionReaderTeamsCanSearch: (
    readerTeamSlugs: string[],
    actorSubject: string,
  ) =>
    readerTeamSlugs.length === 0
      ? Promise.resolve()
      : mockReconcileTupleDiff(
          {
            writes: readerTeamSlugs.map((slug) => ({
              user: `team:${slug}#member`,
              relation: "searcher",
              object: "organization:example-org",
            })),
            deletes: [],
          },
          {
            caller: { type: "user", id: actorSubject },
            source: "rag_collection_reader_search_capability",
          },
        ),
  removeRagCollectionFromAgentPins: (...args: unknown[]) =>
    mockRemoveRagCollectionFromAgentPins(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: () => "organization:example-org",
}));

import { DELETE, PATCH } from "../[id]/route";

const personalCollection = {
  _id: "primary",
  name: "Primary knowledge",
  description: "Example knowledge",
  is_platform: false,
  source_ids: ["source-a"],
  owner_subject: "owner-sub",
  maintainer_team_slugs: [],
  reader_team_slugs: [],
  global_read: false,
  created_by: "creator-sub",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function request(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/rag/collections/primary", {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

function context(id = "primary") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  const { DEFAULT_PUBLICATION_APPROVAL_SETTINGS } = jest.requireActual(
    "@/lib/publication-approval-settings",
  );
  mockPublicationSettings = {
    ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
    require_rag_publication_approval: false,
  };
  mockGetAuthFromBearerOrSession.mockResolvedValue({
    user: { email: "editor@example.com" },
    session: { sub: "editor-sub", user: { email: "editor@example.com" } },
  });
  mockRequireResourcePermission.mockResolvedValue(undefined);
  mockHasOrganizationAdmin.mockResolvedValue(false);
  mockFilterResourcesByPermission.mockImplementation(
    async (_session, rows) => rows,
  );
  mockReconcileCollectionRelationships.mockResolvedValue(undefined);
  mockReplaceCollectionSources.mockImplementation(async (_id, sourceIds) => ({
    ...personalCollection,
    source_ids: sourceIds,
  }));
  mockManageableDatasourceIdsForCollectionPublishing.mockImplementation(
    async (_session, sourceIds: string[]) => new Set(sourceIds),
  );
  mockReconcileTupleDiff.mockResolvedValue(undefined);
  mockRemoveRagCollectionFromAgentPins.mockResolvedValue(2);
  mockRecordAutoApprovedPublication.mockResolvedValue(undefined);
  mockInvalidatePublicationRequests.mockResolvedValue(0);
  mockCreatePublicationRequest.mockResolvedValue({
    _id: "request-primary",
    status: "pending",
  });
  mockRagCollectionSourceDependencyRevisions.mockResolvedValue({
    "source-a": "revision-a",
    "source-b": "revision-b",
  });
  mockBatchCheckOpenFgaTuples.mockImplementation(async (tuples: unknown[]) =>
    tuples.map(() => true),
  );

  mockGetCollection.mockImplementation(async (name: string) => {
    if (name === "rag_collections") {
      return {
        findOne: jest.fn().mockResolvedValue(personalCollection),
        updateOne: jest
          .fn()
          .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
        replaceOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
      };
    }
    if (name === "rag_ingestion_sources") {
      return {
        find: jest.fn().mockReturnValue({
          project: jest.fn().mockReturnThis(),
          toArray: jest
            .fn()
            .mockResolvedValue([
              { source_id: "source-a" },
              { source_id: "source-b" },
            ]),
        }),
      };
    }
    if (name === "teams") {
      return {
        find: jest.fn().mockReturnValue({
          project: jest.fn().mockReturnThis(),
          toArray: jest.fn().mockResolvedValue([{ slug: "readers" }]),
        }),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  });
});

describe("PATCH /api/rag/collections/[id]", () => {
  it("rejects service-account collection mutations", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValueOnce({
      user: { email: "automation@example.com" },
      session: { sub: "automation-sub", isServiceAccount: true },
    });

    const response = await PATCH(
      request("PATCH", { source_ids: [] }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        code: "SERVICE_ACCOUNT_COLLECTION_MUTATION_FORBIDDEN",
      }),
    );
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("rejects publishing a datasource the caller cannot manage", async () => {
    mockFilterResourcesByPermission.mockResolvedValueOnce([{ id: "primary" }]);
    mockManageableDatasourceIdsForCollectionPublishing.mockResolvedValueOnce(
      new Set(),
    );

    const response = await PATCH(
      request("PATCH", { source_ids: ["source-a", "source-b"] }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(mockReplaceCollectionSources).not.toHaveBeenCalled();
  });

  it("does not let a personal collection owner turn source management into search access", async () => {
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "rag_collections") {
        return {
          findOne: jest.fn().mockResolvedValue({
            ...personalCollection,
            owner_subject: "editor-sub",
          }),
          updateOne: jest.fn(),
          replaceOne: jest.fn(),
        };
      }
      if (name === "rag_ingestion_sources") {
        return {
          find: jest.fn().mockReturnValue({
            project: jest.fn().mockReturnThis(),
            toArray: jest
              .fn()
              .mockResolvedValue([
                { source_id: "source-a" },
                { source_id: "source-b" },
              ]),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    mockFilterResourcesByPermission.mockResolvedValueOnce([{ id: "primary" }]);
    mockBatchCheckOpenFgaTuples.mockResolvedValueOnce([false]);

    const response = await PATCH(
      request("PATCH", { source_ids: ["source-a", "source-b"] }),
      context(),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe("DATASOURCE_READ_REQUIRED");
    expect(mockReplaceCollectionSources).not.toHaveBeenCalled();
    expect(mockBatchCheckOpenFgaTuples).toHaveBeenCalledWith([
      {
        user: "user:editor-sub",
        relation: "can_read",
        object: "data_source:source-b",
      },
    ]);
  });

  it("does not let an administrator grant a personal owner access through collection membership", async () => {
    mockHasOrganizationAdmin.mockResolvedValue(true);
    mockFilterResourcesByPermission.mockResolvedValueOnce([{ id: "primary" }]);
    mockBatchCheckOpenFgaTuples.mockResolvedValueOnce([false]);

    const response = await PATCH(
      request("PATCH", { source_ids: ["source-a", "source-b"] }),
      context(),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe("DATASOURCE_READ_REQUIRED");
    expect(mockBatchCheckOpenFgaTuples).toHaveBeenCalledWith([
      {
        user: "user:owner-sub",
        relation: "can_read",
        object: "data_source:source-b",
      },
    ]);
    expect(mockReplaceCollectionSources).not.toHaveBeenCalled();
  });

  it("allows a publisher to remove membership without managing the datasource", async () => {
    mockFilterResourcesByPermission.mockResolvedValueOnce([{ id: "primary" }]);

    const response = await PATCH(
      request("PATCH", { source_ids: [] }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mockReplaceCollectionSources).toHaveBeenCalledWith("primary", []);
  });

  it("reserves Owner delegation for organization admins", async () => {
    const response = await PATCH(
      request("PATCH", { maintainer_team_slugs: ["readers"] }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(mockReconcileCollectionRelationships).not.toHaveBeenCalled();
  });

  it("gives delegated reader teams the coarse search capability", async () => {
    mockHasOrganizationAdmin.mockResolvedValue(true);

    const response = await PATCH(
      request("PATCH", { reader_team_slugs: ["readers"] }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      {
        writes: [
          {
            user: "team:readers#member",
            relation: "searcher",
            object: "organization:example-org",
          },
        ],
        deletes: [],
      },
      {
        caller: { type: "user", id: "editor-sub" },
        source: "rag_collection_reader_search_capability",
      },
    );
  });

  it("snapshots every proposed datasource revision before requesting shared publication", async () => {
    const { DEFAULT_PUBLICATION_APPROVAL_SETTINGS } = jest.requireActual(
      "@/lib/publication-approval-settings",
    );
    mockPublicationSettings = {
      ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
      require_rag_publication_approval: true,
    };
    const sharedCollection = {
      ...personalCollection,
      reader_team_slugs: ["search-team"],
    };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "rag_collections") {
        return {
          findOne: jest.fn().mockResolvedValue(sharedCollection),
          updateOne: jest
            .fn()
            .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
          replaceOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        };
      }
      if (name === "rag_ingestion_sources") {
        return {
          find: jest.fn().mockReturnValue({
            project: jest.fn().mockReturnThis(),
            toArray: jest
              .fn()
              .mockResolvedValue([
                { source_id: "source-a" },
                { source_id: "source-b" },
              ]),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    mockFilterResourcesByPermission.mockResolvedValueOnce([{ id: "primary" }]);

    const response = await PATCH(
      request("PATCH", { source_ids: ["source-a", "source-b"] }),
      context(),
    );

    expect(response.status).toBe(202);
    expect(mockRagCollectionSourceDependencyRevisions).toHaveBeenCalledWith([
      "source-a",
      "source-b",
    ]);
    expect(mockCreatePublicationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedState: expect.objectContaining({
          source_dependency_revisions: {
            "source-a": "revision-a",
            "source-b": "revision-b",
          },
        }),
      }),
    );
  });

  it("keeps company-wide collection Search active while removal waits for approval", async () => {
    const { DEFAULT_PUBLICATION_APPROVAL_SETTINGS } = jest.requireActual(
      "@/lib/publication-approval-settings",
    );
    mockPublicationSettings = {
      ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
      require_rag_publication_approval: true,
    };
    const companyWideCollection = {
      ...personalCollection,
      reader_team_slugs: ["everyone", "project-team"],
    };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "rag_collections") {
        return {
          findOne: jest.fn().mockResolvedValue(companyWideCollection),
          updateOne: jest
            .fn()
            .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
          replaceOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        };
      }
      if (name === "rag_ingestion_sources") {
        return {
          find: jest.fn().mockReturnValue({
            project: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue([{ source_id: "source-a" }]),
          }),
        };
      }
      if (name === "teams") {
        return {
          find: jest.fn().mockReturnValue({
            project: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue([
              { slug: "owner-team" },
              { slug: "project-team" },
            ]),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const response = await PATCH(
      request("PATCH", { reader_team_slugs: ["project-team"] }),
      context(),
    );

    expect(response.status).toBe(202);
    expect(mockCreatePublicationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedState: expect.objectContaining({
          reader_team_slugs: ["project-team"],
        }),
        effectiveState: expect.objectContaining({
          reader_team_slugs: ["everyone", "project-team"],
        }),
        riskFacts: expect.objectContaining({
          removed_team_slugs: ["everyone"],
        }),
      }),
    );
  });

  it("rejects malformed collection ids before querying policy or Mongo", async () => {
    const response = await PATCH(
      request("PATCH", { source_ids: [] }),
      context("invalid collection id"),
    );

    expect(response.status).toBe(400);
    expect(mockGetAuthFromBearerOrSession).not.toHaveBeenCalled();
    expect(mockGetCollection).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/rag/collections/[id]", () => {
  it("rejects service-account collection deletion", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValueOnce({
      user: { email: "automation@example.com" },
      session: { sub: "automation-sub", isServiceAccount: true },
    });

    const response = await DELETE(request("DELETE"), context());

    expect(response.status).toBe(403);
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("protects Platform RAG from deletion", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        ...personalCollection,
        _id: "platform-rag",
        is_platform: true,
      }),
    });

    const response = await DELETE(request("DELETE"), context("platform-rag"));

    expect(response.status).toBe(409);
    expect(mockReconcileTupleDiff).not.toHaveBeenCalled();
  });

  it("deletes only collection tuples and removes stale agent references", async () => {
    const response = await DELETE(request("DELETE"), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ deleted: "primary", agents_updated: 2 });
    expect(mockRemoveRagCollectionFromAgentPins).toHaveBeenCalledWith(
      "primary",
    );
    expect(mockInvalidatePublicationRequests).toHaveBeenCalledWith(
      { kind: "rag_collection", id: "primary", label: "Primary knowledge" },
      expect.objectContaining({ subject: "editor-sub" }),
      expect.stringContaining("deleted before this proposal was approved"),
    );
    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      {
        writes: [],
        deletes: [
          {
            user: "rag_collection:primary",
            relation: "parent_collection",
            object: "knowledge_base:source-a",
          },
          {
            user: "user:creator-sub",
            relation: "creator",
            object: "rag_collection:primary",
          },
        ],
      },
      { source: "rag_collection_delete" },
    );
  });
});
