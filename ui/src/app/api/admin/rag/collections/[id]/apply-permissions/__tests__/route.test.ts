/**
 * @jest-environment node
 *
 * Superadmin bulk remediation tool: apply an Owner and/or Search Access
 * (replace or additive) to every datasource currently in a collection.
 * Bypasses the publication-approval workflow entirely, since this panel is
 * superadmin-only (gated by admin_ui admin + organization manage).
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockGetCollection = jest.fn();
const mockReconcileIngestionSourceRelationships = jest.fn();
const mockReconcileKnowledgeBaseRelationships = jest.fn();
const mockReconcileDataSourceRelationships = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    requireRbacPermission: (...args: unknown[]) =>
      mockRequireRbacPermission(...args),
    successResponse: (data: unknown) => Response.json({ success: true, data }),
    withErrorHandler:
      <T>(handler: (request: NextRequest, context: T) => Promise<Response>) =>
      async (request: NextRequest, context: T) => {
        try {
          return await handler(request, context);
        } catch (error) {
          const { ApiError } = actual;
          if (error instanceof ApiError) {
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

jest.mock("@/lib/rbac/organization", () => ({
  caipeOrgKey: () => "example-org",
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileIngestionSourceRelationships: (...args: unknown[]) =>
    mockReconcileIngestionSourceRelationships(...args),
  reconcileKnowledgeBaseRelationships: (...args: unknown[]) =>
    mockReconcileKnowledgeBaseRelationships(...args),
  reconcileDataSourceRelationships: (...args: unknown[]) =>
    mockReconcileDataSourceRelationships(...args),
}));

const session = { sub: "admin-sub", accessToken: "token-123", org: "example-org" };

const COLLECTION = {
  _id: "primary-collection",
  name: "Primary collection",
  source_ids: ["source-a", "source-b", "source-missing"],
};

const SOURCE_A = {
  source_id: "source-a",
  owner_team_slug: "old-owner",
  shared_with_teams: [],
  search_with_teams: ["existing-search-team"],
  search_with_users: [],
  visibility: "team",
};

const SOURCE_B = {
  source_id: "source-b",
  owner_subject: "old-owner-person",
  shared_with_teams: [],
  search_with_teams: [],
  search_with_users: ["existing-user"],
  visibility: "team",
};

function request(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/admin/rag/collections/primary-collection/apply-permissions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function context(id = "primary-collection") {
  return { params: Promise.resolve({ id }) };
}

function mockCollections({
  collection = COLLECTION,
  sources = [SOURCE_A, SOURCE_B],
  teams = [{ slug: "new-owner-team" }, { slug: "new-search-team" }],
  updateOne = jest.fn().mockResolvedValue({ acknowledged: true }),
}: {
  collection?: Record<string, unknown> | null;
  sources?: Array<Record<string, unknown>>;
  teams?: Array<Record<string, unknown>>;
  updateOne?: jest.Mock;
} = {}): { updateOne: jest.Mock } {
  mockGetCollection.mockImplementation(async (name: string) => {
    if (name === "rag_collections") {
      return {
        findOne: jest.fn(async ({ _id }: { _id: string }) =>
          collection && collection._id === _id ? collection : null,
        ),
      };
    }
    if (name === "rag_ingestion_sources") {
      return {
        findOne: jest.fn(async ({ source_id }: { source_id: string }) =>
          sources.find((s) => s.source_id === source_id) ?? null,
        ),
        updateOne,
      };
    }
    if (name === "teams") {
      return {
        findOne: jest.fn(async ({ slug }: { slug: string }) =>
          teams.find((t) => t.slug === slug) ?? null,
        ),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  });
  return { updateOne };
}

describe("POST /api/admin/rag/collections/[id]/apply-permissions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session });
    mockRequireRbacPermission.mockResolvedValue(undefined);
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockCollections();
  });

  it("requires admin_ui admin and organization manage permissions", async () => {
    await import("../route").then(({ POST }) =>
      POST(request({ owner_team_slug: "new-owner-team" }), context()),
    );

    expect(mockRequireRbacPermission).toHaveBeenCalledWith(
      session,
      "admin_ui",
      "admin",
    );
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(session, {
      type: "organization",
      id: "example-org",
      action: "manage",
    });
  });

  it("404s when the collection does not exist", async () => {
    mockCollections({ collection: null });
    const { POST } = await import("../route");
    const response = await POST(
      request({ owner_team_slug: "new-owner-team" }),
      context("missing-collection"),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.code).toBe("COLLECTION_NOT_FOUND");
  });

  it("rejects a request that applies neither an Owner nor Search Access", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({}), context());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("NOTHING_TO_APPLY");
  });

  it("overwrites the Owner on every datasource in the collection", async () => {
    const { updateOne } = mockCollections();
    const { POST } = await import("../route");
    const response = await POST(
      request({ owner_team_slug: "new-owner-team" }),
      context(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.updated_count).toBe(2);
    expect(body.data.skipped_count).toBe(1);
    expect(body.data.results).toEqual(
      expect.arrayContaining([
        { source_id: "source-a", status: "updated" },
        { source_id: "source-b", status: "updated" },
        { source_id: "source-missing", status: "skipped", reason: "not_found" },
      ]),
    );
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "source-a",
        ownerTeamSlug: "new-owner-team",
        previousOwnerTeamSlug: "old-owner",
        ownerSubject: null,
        previousOwnerSubject: null,
      }),
    );
    expect(updateOne).toHaveBeenCalledWith(
      { source_id: "source-a" },
      {
        $set: expect.objectContaining({ owner_team_slug: "new-owner-team" }),
        $unset: { owner_subject: "" },
      },
    );
    // Search Access untouched when not requested.
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
  });

  it("replaces Search Access, dropping any existing grants not in the new list", async () => {
    const { updateOne } = mockCollections();
    const { POST } = await import("../route");
    const response = await POST(
      request({ search_team_slugs: ["new-search-team"] }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "source-a",
        nextSharedTeamSlugs: ["new-search-team"],
        previousSharedTeamSlugs: ["existing-search-team"],
      }),
    );
    expect(updateOne).toHaveBeenCalledWith(
      { source_id: "source-a" },
      {
        $set: expect.objectContaining({
          search_with_teams: ["new-search-team"],
          search_with_users: [],
        }),
      },
    );
  });

  it("falls back to a legacy search_owner_team_slug when replacing Search Access, and clears it", async () => {
    const { updateOne } = mockCollections({
      sources: [
        {
          source_id: "source-a",
          owner_team_slug: "old-owner",
          shared_with_teams: [],
          search_owner_team_slug: "legacy-search-team",
          visibility: "team",
        },
        SOURCE_B,
      ],
    });
    const { POST } = await import("../route");
    const response = await POST(
      request({ search_team_slugs: ["new-search-team"] }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "source-a",
        nextSharedTeamSlugs: ["new-search-team"],
        previousSharedTeamSlugs: ["legacy-search-team"],
      }),
    );
    expect(updateOne).toHaveBeenCalledWith(
      { source_id: "source-a" },
      {
        $set: expect.objectContaining({
          search_with_teams: ["new-search-team"],
        }),
        $unset: { search_owner_team_slug: "" },
      },
    );
  });

  it("replacing only search_team_slugs never touches an unrelated existing search_with_users grant", async () => {
    const { updateOne } = mockCollections();
    const { POST } = await import("../route");
    const response = await POST(
      request({ search_team_slugs: ["new-search-team"] }),
      context(),
    );

    expect(response.status).toBe(200);
    // source-b was never mentioned by search_team_slugs/search_user_subjects
    // in this request at all, but shares the same batch - its existing
    // search_with_users grant must survive untouched.
    expect(updateOne).toHaveBeenCalledWith(
      { source_id: "source-b" },
      {
        $set: expect.objectContaining({
          search_with_users: ["existing-user"],
        }),
      },
    );
    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "source-b",
        nextSharedUserSubjects: ["existing-user"],
        previousSharedUserSubjects: ["existing-user"],
      }),
    );
  });

  it("skips a source when the additive merge would exceed the Search Access cap instead of applying it", async () => {
    const manyExistingTeams = Array.from({ length: 50 }, (_, i) => `team-${i}`);
    const { updateOne } = mockCollections({
      sources: [
        {
          source_id: "source-a",
          owner_team_slug: "old-owner",
          shared_with_teams: [],
          search_with_teams: manyExistingTeams,
          search_with_users: [],
          visibility: "team",
        },
        SOURCE_B,
      ],
    });
    const { POST } = await import("../route");
    const response = await POST(
      request({
        search_team_slugs: ["new-search-team"],
        search_mode: "additive",
      }),
      context(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.results).toEqual(
      expect.arrayContaining([
        {
          source_id: "source-a",
          status: "skipped",
          reason: "search_limit_exceeded",
        },
      ]),
    );
    expect(updateOne).not.toHaveBeenCalledWith(
      { source_id: "source-a" },
      expect.anything(),
    );
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeBaseId: "source-a" }),
    );
  });

  it("isolates a per-source failure instead of failing the whole batch", async () => {
    mockReconcileIngestionSourceRelationships.mockImplementation(
      async ({ sourceId }: { sourceId: string }) => {
        if (sourceId === "source-a") throw new Error("transient OpenFGA error");
      },
    );
    const { POST } = await import("../route");
    const response = await POST(
      request({ owner_team_slug: "new-owner-team" }),
      context(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.results).toEqual(
      expect.arrayContaining([
        { source_id: "source-a", status: "skipped", reason: "error" },
        { source_id: "source-b", status: "updated" },
      ]),
    );
    expect(body.data.updated_count).toBe(1);
    expect(body.data.skipped_count).toBe(2);
  });

  it("adds to existing Search Access in additive mode instead of replacing it", async () => {
    const { updateOne } = mockCollections();
    const { POST } = await import("../route");
    await POST(
      request({
        search_team_slugs: ["new-search-team"],
        search_mode: "additive",
      }),
      context(),
    );

    expect(updateOne).toHaveBeenCalledWith(
      { source_id: "source-a" },
      {
        $set: expect.objectContaining({
          search_with_teams: ["existing-search-team", "new-search-team"],
        }),
      },
    );
    // source-b already has an existing search user, additive keeps it.
    expect(updateOne).toHaveBeenCalledWith(
      { source_id: "source-b" },
      {
        $set: expect.objectContaining({
          search_with_users: ["existing-user"],
        }),
      },
    );
  });

  it("applies both an Owner and Search Access together in one pass", async () => {
    mockCollections();
    const { POST } = await import("../route");
    const response = await POST(
      request({
        owner_subject: "new-owner-person",
        search_user_subjects: ["new-search-user"],
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerTeamSlug: null,
        ownerSubject: "new-owner-person",
      }),
    );
    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({ nextSharedUserSubjects: ["new-search-user"] }),
    );
  });

  it("rejects an owner team that does not exist", async () => {
    mockCollections({ teams: [] });
    const { POST } = await import("../route");
    const response = await POST(
      request({ owner_team_slug: "missing-team" }),
      context(),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.code).toBe("OWNER_TEAM_NOT_FOUND");
    expect(mockReconcileIngestionSourceRelationships).not.toHaveBeenCalled();
  });

  it("rejects a search team that does not exist", async () => {
    mockCollections({ teams: [] });
    const { POST } = await import("../route");
    const response = await POST(
      request({ search_team_slugs: ["missing-team"] }),
      context(),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.code).toBe("SEARCH_TEAM_NOT_FOUND");
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
  });
});
