/**
 * @jest-environment node
 *
 * Tests for `PATCH`/`DELETE /api/rag/sources/[sourceId]` (spec
 * 2026-07-21-rag-source-config-db, US3 Update/Delete).
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockCanTransferResourceOwnership = jest.fn();
const mockReconcileIngestionSourceRelationships = jest.fn();
const mockReconcileKnowledgeBaseRelationships = jest.fn();
const mockReconcileDataSourceRelationships = jest.fn();
const mockDeleteAllDataSourceRelationshipTuples = jest.fn();
const mockDeleteAllIngestionSourceRelationshipTuples = jest.fn();
const mockDeleteAllKnowledgeBaseRelationshipTuples = jest.fn();
const mockGetRagIngestorLimits = jest.fn();
const mockEnforceRagIngestorLimits = jest.fn();
const mockResolveUserIdentitiesBySubject = jest.fn();
const mockRemoveDatasourceFromRagCollections = jest.fn();
const mockRemoveDatasourceFromAgentPins = jest.fn();
const mockDatasourceCollectionAudience = jest.fn();
const mockGetPublicationApprovalSettings = jest.fn();
const mockCreatePublicationRequest = jest.fn();
const mockRecordAutoApprovedPublication = jest.fn();
const mockInvalidatePublicationRequests = jest.fn();
const mockInvalidatePublicationRequestsReferencingDatasource = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public statusCode = 500,
      public code?: string,
    ) {
      super(message);
    }
  }

  return {
    ApiError,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) =>
      Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T>(
        handler: (
          request: NextRequest,
          context: { params: Promise<{ sourceId: string }> },
        ) => Promise<T>,
      ) =>
      async (
        request: NextRequest,
        context: { params: Promise<{ sourceId: string }> },
      ) => {
        try {
          return await handler(request, context);
        } catch (error) {
          return Response.json(
            {
              success: false,
              error: error instanceof Error ? error.message : "error",
              code: (error as { code?: string }).code,
            },
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

jest.mock("@/lib/publication-approval.server", () => {
  const actual = jest.requireActual("@/lib/publication-approval.server");
  return {
    ...actual,
    listPublicationActorTeamSlugs: jest.fn(async () => []),
    createPublicationRequest: (...args: unknown[]) =>
      mockCreatePublicationRequest(...args),
    recordAutoApprovedPublication: (...args: unknown[]) =>
      mockRecordAutoApprovedPublication(...args),
    invalidatePublicationRequests: (...args: unknown[]) =>
      mockInvalidatePublicationRequests(...args),
    invalidatePublicationRequestsReferencingDatasource: (...args: unknown[]) =>
      mockInvalidatePublicationRequestsReferencingDatasource(...args),
  };
});

jest.mock("@/lib/publication-approval-settings", () => {
  const actual = jest.requireActual("@/lib/publication-approval-settings");
  return {
    ...actual,
    getPublicationApprovalSettings: (...args: unknown[]) =>
      mockGetPublicationApprovalSettings(...args),
  };
});

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
  canTransferResourceOwnership: (...args: unknown[]) =>
    mockCanTransferResourceOwnership(...args),
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileIngestionSourceRelationships: (...args: unknown[]) =>
    mockReconcileIngestionSourceRelationships(...args),
  reconcileKnowledgeBaseRelationships: (...args: unknown[]) =>
    mockReconcileKnowledgeBaseRelationships(...args),
  reconcileDataSourceRelationships: (...args: unknown[]) =>
    mockReconcileDataSourceRelationships(...args),
  deleteAllDataSourceRelationshipTuples: (...args: unknown[]) =>
    mockDeleteAllDataSourceRelationshipTuples(...args),
  deleteAllIngestionSourceRelationshipTuples: (...args: unknown[]) =>
    mockDeleteAllIngestionSourceRelationshipTuples(...args),
  deleteAllKnowledgeBaseRelationshipTuples: (...args: unknown[]) =>
    mockDeleteAllKnowledgeBaseRelationshipTuples(...args),
}));

jest.mock("@/lib/rag-ingestor-limits.server", () => ({
  getRagIngestorLimits: (...args: unknown[]) =>
    mockGetRagIngestorLimits(...args),
  enforceRagIngestorLimits: (...args: unknown[]) =>
    mockEnforceRagIngestorLimits(...args),
}));

jest.mock("@/lib/rag-collections.server", () => ({
  datasourceCollectionAudience: (...args: unknown[]) =>
    mockDatasourceCollectionAudience(...args),
  removeDatasourceFromRagCollections: (...args: unknown[]) =>
    mockRemoveDatasourceFromRagCollections(...args),
  removeDatasourceFromAgentPins: (...args: unknown[]) =>
    mockRemoveDatasourceFromAgentPins(...args),
}));

jest.mock("@/lib/rbac/user-identity-directory", () => ({
  resolveUserIdentitiesBySubject: (...args: unknown[]) =>
    mockResolveUserIdentitiesBySubject(...args),
}));

function request(
  method: string,
  body?: Record<string, unknown>,
  query = "",
): NextRequest {
  return new NextRequest(
    new URL(
      `/api/rag/sources/slack-channel-C1${query}`,
      "http://localhost:3000",
    ),
    {
      method,
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    },
  );
}

function params(sourceId = "slack-channel-C1") {
  return { params: Promise.resolve({ sourceId }) };
}

const session = { sub: "alice-sub", role: "user", accessToken: "test-token" };
const user = { email: "alice@example.com" };

const baseSource = {
  source_id: "slack-channel-C1",
  source_type: "slack_channel",
  channel_id: "C1",
  name: "eng-general",
  description: "",
  status: "pending",
  default_chunk_size: 10000,
  default_chunk_overlap: 2000,
  reload_interval: 86400,
  config_driven: false,
  config_import_adopted: false,
  visibility: "team",
  owner_team_slug: "platform",
  shared_with_teams: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("PATCH /api/rag/sources/[sourceId]", () => {
  let sources: {
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    deleteOne: jest.Mock;
  };

  let teams: { findOne: jest.Mock };

beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user, session });
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockCanTransferResourceOwnership.mockResolvedValue(false);
    mockReconcileIngestionSourceRelationships.mockResolvedValue({
      enabled: true,
      writes: 1,
      deletes: 0,
    });
    mockReconcileKnowledgeBaseRelationships.mockResolvedValue({
      enabled: true,
      writes: 1,
      deletes: 0,
    });
    mockReconcileDataSourceRelationships.mockResolvedValue({
      enabled: true,
      writes: 1,
      deletes: 0,
    });
    mockGetRagIngestorLimits.mockResolvedValue({
      shared: { max_search_teams: 50 },
    });
    mockResolveUserIdentitiesBySubject.mockImplementation(
      async (subjects: string[]) =>
        new Map(
          subjects.map((subject) => [
            subject,
            {
              subject,
              email: `${subject}@example.com`,
              name: "Example User",
              display_name: `${subject}@example.com`,
            },
          ]),
        ),
    );
    mockRecordAutoApprovedPublication.mockResolvedValue(undefined);
    const publicationSettings = jest.requireActual(
      "@/lib/publication-approval-settings",
    );
    mockGetPublicationApprovalSettings.mockResolvedValue({
      ...publicationSettings.DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
      require_rag_publication_approval: false,
    });
    mockCreatePublicationRequest.mockImplementation(
      async (input: Record<string, unknown>) => ({
      _id: "request-primary",
      adapter_version: 1,
      authorization_policy_id:
        "publication.rag_datasource.0123456789abcdef01234567.request-primary",
      resource: input.resource,
      resource_revision: input.resourceRevision,
      requested_state: input.requestedState,
      effective_state: input.effectiveState,
      risk_facts: input.riskFacts,
      requester: input.requester,
      requester_team_slugs: input.requesterTeamSlugs,
      approver_team_slugs: input.approverTeamSlugs,
      status: "pending",
      history: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    mockInvalidatePublicationRequests.mockResolvedValue(0);
    mockInvalidatePublicationRequestsReferencingDatasource.mockResolvedValue(0);
    mockDatasourceCollectionAudience.mockResolvedValue({
      collectionIds: [],
      readerTeamSlugs: [],
      hasExternalPrincipal: false,
      organizationWide: false,
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    sources = {
      findOne: jest.fn().mockResolvedValue({ ...baseSource }),
      findOneAndUpdate: jest
        .fn()
        .mockImplementation(async (_filter, update) => ({
          ...baseSource,
          ...update.$set,
        })),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    };
    teams = {
      findOne: jest.fn().mockResolvedValue({ _id: "team-id", slug: "sre" }),
    };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "rag_ingestion_sources") return sources;
      if (name === "teams") return teams;
      throw new Error(`unexpected collection ${name}`);
    });
  });

  // T040
  it("applies mutable fields for an owner-team member and returns the updated record", async () => {
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", {
        description: "Updated description",
        default_chunk_size: 5000,
      }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({
      description: "Updated description",
      default_chunk_size: 5000,
    });
  });

  // T041
  it("returns 400 IMMUTABLE_FIELD_CHANGE and does not apply any field when an immutable field is present", async () => {
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", {
        description: "Updated description",
        channel_id: "C999",
      }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.code).toBe("IMMUTABLE_FIELD_CHANGE");
    expect(sources.findOneAndUpdate).not.toHaveBeenCalled();
  });

  // T042 (PATCH half)
  it("returns 403 FORBIDDEN_MANAGE for a caller without can_manage", async () => {
    mockRequireResourcePermission.mockRejectedValue(new Error("denied"));
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { description: "x" }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.code).toBe("FORBIDDEN_MANAGE");
    expect(sources.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects the retired management-sharing field", async () => {
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { shared_with_teams: ["sre", "ops"] }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.code).toBe("MANAGEMENT_SHARING_NOT_SUPPORTED");
    expect(mockReconcileIngestionSourceRelationships).not.toHaveBeenCalled();
  });

  it("removes legacy management shares on the next ordinary edit", async () => {
    sources.findOne.mockResolvedValue({
      ...baseSource,
      shared_with_teams: ["sre"],
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { description: "updated" }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "slack-channel-C1",
        nextSharedTeamSlugs: [],
        previousSharedTeamSlugs: ["sre"],
      }),
    );
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
    expect(mockReconcileDataSourceRelationships).not.toHaveBeenCalled();
    expect(sources.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ shared_with_teams: [] }),
      }),
      expect.anything(),
    );
  });

  it("persists and reconciles Search Access without granting source management", async () => {
    sources.findOne.mockResolvedValue({
      ...baseSource,
      search_with_teams: ["old-search"],
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { search_team_slugs: ["platform", "readers"] }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileIngestionSourceRelationships).not.toHaveBeenCalled();
    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "slack-channel-C1",
        ownerTeamSlug: null,
        nextSharedTeamSlugs: ["platform", "readers"],
        previousSharedTeamSlugs: ["old-search"],
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/datasource/slack-channel-C1/owner-team"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ search_with_teams: ["platform", "readers"] }),
      }),
    );
    expect(sources.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({
          search_with_teams: ["platform", "readers"],
        }),
      }),
      expect.anything(),
    );
  });

  it("grandfathers existing Search Access teams while blocking additions above a new cap", async () => {
    mockGetRagIngestorLimits.mockResolvedValue({
      shared: { max_search_teams: 0 },
    });
    sources.findOne.mockResolvedValue({
      ...baseSource,
      search_with_teams: ["everyone"],
    });
    const { PATCH } = await import("../route");

    const unchanged = await PATCH(
      request("PATCH", {
        description: "still shared",
        search_team_slugs: ["everyone"],
      }),
      params(),
    );
    expect(unchanged.status).toBe(200);

    const addition = await PATCH(
      request("PATCH", {
        search_team_slugs: ["everyone", "another-team"],
      }),
      params(),
    );
    const body = await addition.json();
    expect(addition.status).toBe(400);
    expect(body.code).toBe("RAG_INGESTOR_LIMIT_EXCEEDED");
  });

  it("includes the latest successful document count in a publication request", async () => {
    const publicationSettings = jest.requireActual(
      "@/lib/publication-approval-settings",
    );
    mockGetPublicationApprovalSettings.mockResolvedValue({
      ...publicationSettings.DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
      require_rag_publication_approval: true,
    });
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes("/v1/jobs/batch")) {
        return new Response(JSON.stringify({
          jobs: {
            "slack-channel-C1": [{
              status: "completed",
              created_at: 100,
              document_count: 17,
              chunk_count: 42,
            }],
          },
        }), { status: 200 });
      }
      return { ok: true, status: 200 };
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { search_team_slugs: ["everyone"] }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockCreatePublicationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        riskFacts: expect.objectContaining({ estimated_items: 17 }),
      }),
    );
  });

  it("keeps company-wide Search active while its removal waits for approval", async () => {
    const publicationSettings = jest.requireActual(
      "@/lib/publication-approval-settings",
    );
    mockGetPublicationApprovalSettings.mockResolvedValue({
      ...publicationSettings.DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
      require_rag_publication_approval: true,
    });
    sources.findOne.mockResolvedValue({
      ...baseSource,
      search_with_teams: ["everyone", "project-team"],
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { search_team_slugs: ["project-team"] }),
      params(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      search_with_teams: ["everyone", "project-team"],
      _publication_request: {
        id: "request-primary",
        status: "pending",
      },
    });
    expect(mockCreatePublicationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedState: expect.objectContaining({
          search_team_slugs: ["project-team"],
        }),
        effectiveState: expect.objectContaining({
          search_team_slugs: ["everyone", "project-team"],
        }),
        riskFacts: expect.objectContaining({
          removed_team_slugs: ["everyone"],
        }),
      }),
    );
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
  });

  // A pure metadata edit (no shared_with_teams / owner_team_slug change)
  // must not trigger any OpenFGA round-trip.
  it("does not reconcile any OpenFGA type when only metadata fields change", async () => {
    const { PATCH } = await import("../route");

    await PATCH(
      request("PATCH", { description: "just a description update" }),
      params(),
    );

    expect(mockReconcileIngestionSourceRelationships).not.toHaveBeenCalled();
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
    expect(mockReconcileDataSourceRelationships).not.toHaveBeenCalled();
  });

  it("makes a personal source team-managed and revokes only its personal grants", async () => {
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    sources.findOne.mockResolvedValue({
      ...baseSource,
      owner_team_slug: undefined,
      owner_subject: "alice-sub",
      creator_subject: "alice-sub",
      search_with_teams: ["everyone"],
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { owner_team_slug: "sre" }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerSubject: null,
        previousOwnerSubject: "alice-sub",
        ownerTeamSlug: "sre",
        previousOwnerTeamSlug: null,
      }),
    );
    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerSubject: null,
        previousOwnerSubject: "alice-sub",
        ownerTeamSlug: null,
        nextSharedTeamSlugs: ["everyone"],
      }),
    );
    expect(mockReconcileDataSourceRelationships).toHaveBeenCalledWith({
      dataSourceId: "slack-channel-C1",
      parentKnowledgeBaseId: "slack-channel-C1",
    });
    expect(sources.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $unset: { owner_subject: "" } }),
      expect.anything(),
    );
  });

  // Ownership transfer (US3): owner_team_slug differs from the stored value,
  // the caller can manage the current owner team (or is an org admin), and
  // is already a member of the destination — no confirmation required.
  it("transfers ownership without changing Search access", async () => {
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { owner_team_slug: "sre" }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({ owner_team_slug: "sre" });
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "slack-channel-C1",
        ownerTeamSlug: "sre",
        previousOwnerTeamSlug: "platform",
      }),
    );
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
    expect(mockReconcileDataSourceRelationships).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/datasource/slack-channel-C1/owner-team"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ owner_team_slug: "sre", owner_subject: null }),
      }),
    );
  });

  it("keeps the current Owner effective while a broadly published transfer waits for approval", async () => {
    const publicationSettings = jest.requireActual(
      "@/lib/publication-approval-settings",
    );
    mockGetPublicationApprovalSettings.mockResolvedValue({
      ...publicationSettings.DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
      require_rag_publication_approval: true,
    });
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    sources.findOne.mockResolvedValue({
      ...baseSource,
      search_with_teams: ["everyone"],
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { owner_team_slug: "sre" }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({
      owner_team_slug: "platform",
      _publication_request: {
        id: "request-primary",
        status: "pending",
      },
    });
    expect(mockReconcileIngestionSourceRelationships).not.toHaveBeenCalled();
    expect(sources.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.not.objectContaining({ owner_team_slug: "sre" }),
      }),
      expect.anything(),
    );
    expect(mockCreatePublicationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedState: expect.objectContaining({
          owner_update: {
            owner_team_slug: "sre",
            owner_subject: null,
          },
        }),
        effectiveState: expect.objectContaining({
          search_team_slugs: ["everyone"],
        }),
      }),
    );
  });

  it("transfers management ownership back to a person and gives that person implicit query ownership", async () => {
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", {
        owner_team_slug: null,
        owner_subject: "reader-sub",
        confirm_not_member: true,
      }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "slack-channel-C1",
        ownerSubject: "reader-sub",
        ownerTeamSlug: null,
        previousOwnerTeamSlug: "platform",
      }),
    );
    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerSubject: "reader-sub",
        previousOwnerSubject: null,
      }),
    );
    expect(sources.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ owner_subject: "reader-sub" }),
        $unset: expect.objectContaining({ owner_team_slug: "" }),
      }),
      expect.anything(),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/datasource/slack-channel-C1/owner-team"),
      expect.objectContaining({
        body: JSON.stringify({
          owner_team_slug: null,
          owner_subject: "reader-sub",
        }),
      }),
    );
  });

  // Only an owner-team admin or org admin may transfer ownership.
  it("returns 403 TRANSFER_FORBIDDEN when the caller cannot manage the current owner team", async () => {
    mockCanTransferResourceOwnership.mockResolvedValue(false);
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { owner_team_slug: "sre" }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.code).toBe("TRANSFER_FORBIDDEN");
    expect(mockReconcileIngestionSourceRelationships).not.toHaveBeenCalled();
    expect(sources.findOneAndUpdate).not.toHaveBeenCalled();
  });

  // Transferring to a team the caller does not belong to requires an
  // explicit not-a-member confirmation (mirrors the agent/KB transfer flow).
  it("returns 409 TRANSFER_NOT_MEMBER_UNCONFIRMED when the destination team is unconfirmed", async () => {
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    mockRequireResourcePermission.mockImplementation(
      async (_session: unknown, resource: { type: string; action: string }) => {
        if (resource.type === "team" || resource.type === "organization") {
          throw new Error("not a member or org admin");
        }
      },
    );
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { owner_team_slug: "sre" }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.code).toBe("TRANSFER_NOT_MEMBER_UNCONFIRMED");
    expect(sources.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("completes the transfer when confirm_not_member is set", async () => {
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    mockRequireResourcePermission.mockImplementation(
      async (_session: unknown, resource: { type: string; action: string }) => {
        if (resource.type === "team" || resource.type === "organization") {
          throw new Error("not a member or org admin");
        }
      },
    );
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { owner_team_slug: "sre", confirm_not_member: true }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerTeamSlug: "sre",
        previousOwnerTeamSlug: "platform",
      }),
    );
  });

  it("returns 404 OWNER_TEAM_NOT_FOUND when transferring to an unknown team", async () => {
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    teams.findOne.mockResolvedValue(null);
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { owner_team_slug: "no-such-team" }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.code).toBe("OWNER_TEAM_NOT_FOUND");
    expect(sources.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("restores the previous management policy when Mongo persistence fails", async () => {
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    sources.findOneAndUpdate.mockRejectedValue(new Error("mongo unavailable"));
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { owner_team_slug: "sre" }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.code).toBe("SOURCE_UPDATE_FAILED");
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledTimes(2);
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceId: "slack-channel-C1",
        ownerSubject: null,
        ownerTeamSlug: "platform",
        previousOwnerTeamSlug: "sre",
        nextSharedTeamSlugs: [],
        previousSharedTeamSlugs: [],
      }),
    );
    const ownerBodies = (global.fetch as jest.Mock).mock.calls
      .filter(([url]) => String(url).includes("/owner-team"))
      .map(([, init]) => JSON.parse(String(init.body)));
    expect(ownerBodies).toEqual([
      { owner_team_slug: "sre", owner_subject: null },
      { owner_team_slug: "platform", owner_subject: null },
    ]);
  });

  it("restores RAG metadata when Mongo persistence fails", async () => {
    sources.findOneAndUpdate.mockRejectedValue(new Error("mongo unavailable"));
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { description: "Updated description" }),
      params(),
    );

    expect(response.status).toBe(500);
    const configBodies = (global.fetch as jest.Mock).mock.calls
      .filter(([url]) =>
        String(url).includes("/v1/datasource/slack-channel-C1") &&
        !String(url).includes("/owner-team"),
      )
      .map(([, init]) => JSON.parse(String(init.body)));
    expect(configBodies).toEqual([
      { description: "Updated description" },
      { description: "" },
    ]);
  });

  it("restores RAG metadata and the old policy when policy reconciliation fails", async () => {
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    mockReconcileIngestionSourceRelationships
      .mockRejectedValueOnce(new Error("authorization service unavailable"))
      .mockResolvedValueOnce({ enabled: true, writes: 1, deletes: 1 });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", {
        description: "Updated description",
        owner_team_slug: "sre",
      }),
      params(),
    );

    expect(response.status).toBe(500);
    expect(sources.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledTimes(2);
    const configBodies = (global.fetch as jest.Mock).mock.calls
      .filter(([url]) =>
        String(url).includes("/v1/datasource/slack-channel-C1") &&
        !String(url).includes("/owner-team"),
      )
      .map(([, init]) => JSON.parse(String(init.body)));
    expect(configBodies).toEqual([
      { description: "Updated description" },
      { description: "" },
    ]);
    const ownerBodies = (global.fetch as jest.Mock).mock.calls
      .filter(([url]) => String(url).includes("/owner-team"))
      .map(([, init]) => JSON.parse(String(init.body)));
    expect(ownerBodies).toEqual([
      { owner_team_slug: "sre", owner_subject: null },
      { owner_team_slug: "platform", owner_subject: null },
    ]);
  });

  // T046
  it("returns 403 CONFIG_DRIVEN_IMMUTABLE before the can_manage check, even for an owner-team admin", async () => {
    sources.findOne.mockResolvedValue({ ...baseSource, config_driven: true });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("PATCH", { description: "x" }),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.code).toBe("CONFIG_DRIVEN_IMMUTABLE");
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/rag/sources/[sourceId]", () => {
  let sources: { findOne: jest.Mock; deleteOne: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user, session });
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockReconcileIngestionSourceRelationships.mockResolvedValue({
      enabled: true,
      writes: 0,
      deletes: 1,
    });
    mockReconcileKnowledgeBaseRelationships.mockResolvedValue({
      enabled: true,
      writes: 0,
      deletes: 1,
    });
    mockReconcileDataSourceRelationships.mockResolvedValue({
      enabled: true,
      writes: 0,
      deletes: 1,
    });
    mockDeleteAllDataSourceRelationshipTuples.mockResolvedValue({
      enabled: true,
      deletes: 1,
    });
    mockDeleteAllKnowledgeBaseRelationshipTuples.mockResolvedValue({
      enabled: true,
      deletes: 1,
    });
    mockDeleteAllIngestionSourceRelationshipTuples.mockResolvedValue({
      enabled: true,
      deletes: 1,
    });
    mockRemoveDatasourceFromRagCollections.mockResolvedValue([]);
    mockRemoveDatasourceFromAgentPins.mockResolvedValue(0);
    mockInvalidatePublicationRequests.mockResolvedValue(0);
    mockInvalidatePublicationRequestsReferencingDatasource.mockResolvedValue(0);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    sources = {
      findOne: jest.fn().mockResolvedValue({ ...baseSource }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    };
    mockGetCollection.mockResolvedValue(sources);
  });

  // T042 (DELETE half)
  it("returns 403 FORBIDDEN_MANAGE for a shared-team (reader-only) caller", async () => {
    mockRequireResourcePermission.mockRejectedValue(new Error("denied"));
    const { DELETE } = await import("../route");

    const response = await DELETE(request("DELETE"), params());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.code).toBe("FORBIDDEN_MANAGE");
    expect(sources.deleteOne).not.toHaveBeenCalled();
  });

  // The RAG server owns live job state; a stale Mongo status must not be used
  // as the delete lock. Surface the upstream active-job rejection instead.
  it("returns 409 when the RAG server rejects purging an active datasource", async () => {
    sources.findOne.mockResolvedValue({ ...baseSource, status: "ingesting" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue("Datasource has active jobs"),
    });
    const { DELETE } = await import("../route");

    const response = await DELETE(
      request("DELETE", undefined, "?purge_data=true"),
      params(),
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.code).toBe("RAG_DELETE_FAILED");
    expect(sources.deleteOne).not.toHaveBeenCalled();
  });

  // T045
  it("removes management tuples before the Mongo document on success", async () => {
    const { DELETE } = await import("../route");

    const response = await DELETE(request("DELETE"), params());

    expect(response.status).toBe(200);
    expect(sources.deleteOne).toHaveBeenCalledWith(
      expect.objectContaining({ source_id: "slack-channel-C1" }),
    );
    expect(mockDeleteAllIngestionSourceRelationshipTuples).toHaveBeenCalledWith(
      "slack-channel-C1",
    );
    expect(
      mockDeleteAllIngestionSourceRelationshipTuples.mock
        .invocationCallOrder[0],
    ).toBeLessThan(sources.deleteOne.mock.invocationCallOrder[0]);
    expect(mockDeleteAllKnowledgeBaseRelationshipTuples).not.toHaveBeenCalled();
    expect(mockDeleteAllDataSourceRelationshipTuples).not.toHaveBeenCalled();
    expect(mockInvalidatePublicationRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rag_datasource",
        id: "slack-channel-C1",
      }),
      expect.objectContaining({ subject: "alice-sub" }),
      expect.stringContaining("deleted before this proposal was approved"),
    );
    expect(
      mockInvalidatePublicationRequestsReferencingDatasource,
    ).toHaveBeenCalledWith(
      "slack-channel-C1",
      expect.objectContaining({ subject: "alice-sub" }),
      expect.stringContaining("referenced by this collection proposal"),
    );
  });

  // Deleting a source must also revoke the knowledge_base/data_source
  // grants, or the query-time visibility tuples strand pointing at a
  // source_id with no config row and no management grant.
  it("also revokes knowledge_base and data_source grants when data is purged", async () => {
    const { DELETE } = await import("../route");

    const response = await DELETE(
      request("DELETE", undefined, "?purge_data=true"),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mockDeleteAllDataSourceRelationshipTuples).toHaveBeenCalledWith(
      "slack-channel-C1",
    );
    expect(mockDeleteAllKnowledgeBaseRelationshipTuples).toHaveBeenCalledWith(
      "slack-channel-C1",
    );
    expect(mockRemoveDatasourceFromRagCollections).toHaveBeenCalledWith(
      "slack-channel-C1",
    );
    expect(mockRemoveDatasourceFromAgentPins).toHaveBeenCalledWith(
      "slack-channel-C1",
    );
    expect(mockDeleteAllIngestionSourceRelationshipTuples).toHaveBeenCalledWith(
      "slack-channel-C1",
    );
  });

  it("keeps the Mongo row and restores policy when management tuple deletion fails", async () => {
    mockDeleteAllIngestionSourceRelationshipTuples.mockRejectedValueOnce(
      new Error("authorization service unavailable"),
    );
    const { DELETE } = await import("../route");

    const response = await DELETE(request("DELETE"), params());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.code).toBe("SOURCE_DELETE_FAILED");
    expect(sources.deleteOne).not.toHaveBeenCalled();
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "slack-channel-C1",
        ownerTeamSlug: "platform",
        nextSharedTeamSlugs: [],
      }),
    );
  });

  it("restores management policy when Mongo deletion fails", async () => {
    sources.deleteOne.mockRejectedValue(new Error("mongo unavailable"));
    const { DELETE } = await import("../route");

    const response = await DELETE(request("DELETE"), params());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.code).toBe("SOURCE_DELETE_FAILED");
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "slack-channel-C1",
        ownerTeamSlug: "platform",
        nextSharedTeamSlugs: [],
      }),
    );
  });

  it("treats an ambiguous Mongo error as success when readback confirms deletion", async () => {
    sources.findOne
      .mockResolvedValueOnce({ ...baseSource })
      .mockResolvedValueOnce(null);
    sources.deleteOne.mockRejectedValue(
      new Error("connection lost after write"),
    );
    const { DELETE } = await import("../route");

    const response = await DELETE(request("DELETE"), params());

    expect(response.status).toBe(200);
    expect(mockReconcileIngestionSourceRelationships).not.toHaveBeenCalled();
  });

  it("treats a zero delete count as idempotent when the source is already absent", async () => {
    sources.findOne
      .mockResolvedValueOnce({ ...baseSource })
      .mockResolvedValueOnce(null);
    sources.deleteOne.mockResolvedValue({ deletedCount: 0 });
    const { DELETE } = await import("../route");

    const response = await DELETE(request("DELETE"), params());

    expect(response.status).toBe(200);
    expect(mockReconcileIngestionSourceRelationships).not.toHaveBeenCalled();
  });

  // T047
  it("returns 403 CONFIG_DRIVEN_IMMUTABLE before the can_manage check", async () => {
    sources.findOne.mockResolvedValue({ ...baseSource, config_driven: true });
    const { DELETE } = await import("../route");

    const response = await DELETE(request("DELETE"), params());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.code).toBe("CONFIG_DRIVEN_IMMUTABLE");
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
    expect(sources.deleteOne).not.toHaveBeenCalled();
  });
});
