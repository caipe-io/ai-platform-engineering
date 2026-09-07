/**
 * @jest-environment node
 *
 * Tests for `POST /api/rag/sources` (spec 2026-07-21-rag-source-config-db,
 * US1 Create). Mirrors the RBAC route test style used by
 * `ui/src/app/api/dynamic-agents/__tests__/route-rbac.test.ts`.
 */

import { NextRequest } from "next/server";
import {
  confluenceSpaceSourceId,
  jiraProjectSourceId,
  slackChannelSourceId,
  webexSpaceSourceId,
  webUrlSourceId,
} from "@/lib/ingestion-source-id";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockReconcileIngestionSourceRelationships = jest.fn();
const mockReconcileKnowledgeBaseRelationships = jest.fn();
const mockReconcileDataSourceRelationships = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
const mockDeleteAllDataSourceRelationshipTuples = jest.fn();
const mockDeleteAllIngestionSourceRelationshipTuples = jest.fn();
const mockDeleteAllKnowledgeBaseRelationshipTuples = jest.fn();
const mockGetRagDefaultSearchTeamSlug = jest.fn();
const mockGetRagIngestorLimits = jest.fn();
const mockEnforceRagIngestorLimits = jest.fn();
const mockCreatePublicationRequest = jest.fn();
const mockRecordAutoApprovedPublication = jest.fn();
const mockPrepareRagPublication = jest.fn();
const mockRagPublicationRevision = jest.fn();

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
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T,>(handler: (request: NextRequest) => Promise<T>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
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

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
  filterResourcesByPermission: (...args: unknown[]) => mockFilterResourcesByPermission(...args),
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

jest.mock("@/lib/rbac/organization", () => ({
  caipeOrgKey: () => "caipe",
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

jest.mock("@/lib/rag-settings", () => ({
  getRagDefaultSearchTeamSlug: (...args: unknown[]) =>
    mockGetRagDefaultSearchTeamSlug(...args),
}));

jest.mock("@/lib/rag-ingestor-limits.server", () => ({
  getRagIngestorLimits: (...args: unknown[]) =>
    mockGetRagIngestorLimits(...args),
  enforceRagIngestorLimits: (...args: unknown[]) =>
    mockEnforceRagIngestorLimits(...args),
}));

jest.mock("@/lib/publication-approval.server", () => ({
  createPublicationRequest: (...args: unknown[]) =>
    mockCreatePublicationRequest(...args),
  recordAutoApprovedPublication: (...args: unknown[]) =>
    mockRecordAutoApprovedPublication(...args),
}));

jest.mock("@/lib/rag-publication-approval.server", () => ({
  prepareRagPublication: (...args: unknown[]) =>
    mockPrepareRagPublication(...args),
  ragPublicationRevision: (...args: unknown[]) =>
    mockRagPublicationRevision(...args),
}));

function request(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

const session = { sub: "alice-sub", role: "user", accessToken: "alice-token" };
const user = { email: "alice@example.com" };

function postBody(overrides: Record<string, unknown> = {}) {
  return {
    source_type: "slack_channel",
    channel_id: "C1234567890",
    name: "eng-general",
    owner_team_slug: "platform",
    reload_interval: 86400,
    ...overrides,
  };
}

function mockDatasourceExists(exists = false) {
  (global.fetch as jest.Mock).mockImplementation((url: unknown, init?: RequestInit) => {
    const requestUrl = String(url);
    const payload = init?.method === "POST" && typeof init.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    let datasourceId: string | undefined;
    if (payload && requestUrl.endsWith("/v1/ingest/slack/channel")) {
      datasourceId = slackChannelSourceId(String(payload.channel_id));
    } else if (payload && requestUrl.endsWith("/v1/ingest/confluence/page")) {
      const pageUrl = String(payload.url);
      const spaceKey = pageUrl.match(/\/spaces\/([^/]+)/)?.[1] ?? "";
      const pageId = pageUrl.match(/\/pages\/(\d+)/)?.[1];
      datasourceId = confluenceSpaceSourceId(pageUrl, spaceKey, pageId);
    } else if (payload && requestUrl.endsWith("/v1/ingest/jira/project")) {
      datasourceId = jiraProjectSourceId(
        String(payload.project_key),
        String(payload.source_slug),
      );
    } else if (payload && requestUrl.endsWith("/v1/ingest/webloader/url")) {
      datasourceId = webUrlSourceId(String(payload.url));
    } else if (payload && requestUrl.endsWith("/v1/ingest/webex/space")) {
      datasourceId = webexSpaceSourceId(String(payload.space_id));
    }
    return {
      ok: true,
      status: init?.method === "POST" ? 202 : 200,
      json: jest.fn().mockResolvedValue(
        init?.method === "POST"
          ? { datasource_id: datasourceId, job_id: "job-1" }
          : { exists },
      ),
    };
  });
}

describe("POST /api/rag/sources", () => {
  let sources: {
    findOne: jest.Mock;
    insertOne: jest.Mock;
    updateOne: jest.Mock;
    deleteOne: jest.Mock;
  };
  let teams: { findOne: jest.Mock };
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user, session });
    // `canManageOrganization` treats a resolved `requireResourcePermission` as
    // org-admin, which bypasses the ingest-capability gate — matches most of
    // these tests' intent (caller is authorized some other way). Tests that
    // specifically exercise the non-admin gate override this.
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockReconcileIngestionSourceRelationships.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
    mockReconcileKnowledgeBaseRelationships.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
    mockReconcileDataSourceRelationships.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
    mockDeleteAllDataSourceRelationshipTuples.mockResolvedValue({ enabled: true });
    mockDeleteAllIngestionSourceRelationshipTuples.mockResolvedValue({ enabled: true });
    mockDeleteAllKnowledgeBaseRelationshipTuples.mockResolvedValue({ enabled: true });
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    mockGetRagDefaultSearchTeamSlug.mockResolvedValue(null);
    mockGetRagIngestorLimits.mockResolvedValue({
      shared: { max_search_teams: 50 },
    });
    mockPrepareRagPublication.mockImplementation(async (input: {
      source: { source_id: string; name?: string };
      requestedSearchTeamSlugs: string[];
      requestedSearchUserSubjects: string[];
    }) => {
      const requestedState = {
        search_team_slugs: input.requestedSearchTeamSlugs,
        search_user_subjects: input.requestedSearchUserSubjects,
      };
      return {
        actor: { subject: "alice-sub", email: "alice@example.com" },
        requesterTeamSlugs: ["platform"],
        requestedState,
        plan: {
          requires_approval: false,
          reason: "Published immediately within the configured policy.",
          effective_state: requestedState,
          risk_facts: {
            organization_wide: false,
            target_team_slugs: [],
            added_team_slugs: input.requestedSearchTeamSlugs,
            added_user_subjects: input.requestedSearchUserSubjects,
            reasons: [],
          },
          approver_team_slugs: [],
        },
        resource: {
          kind: "rag_datasource",
          id: input.source.source_id,
          label: input.source.name ?? input.source.source_id,
        },
        resourceRevision: "revision-before-create",
      };
    });
    mockRagPublicationRevision.mockReturnValue("revision-after-create");
    mockRecordAutoApprovedPublication.mockResolvedValue({ status: "approved" });
    mockCreatePublicationRequest.mockResolvedValue({
      _id: "request-primary",
      status: "pending",
    });
    global.fetch = jest.fn();
    mockDatasourceExists(false);

    sources = {
      findOne: jest.fn().mockResolvedValue(null),
      insertOne: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({}),
      deleteOne: jest.fn().mockResolvedValue({}),
    };
    teams = { findOne: jest.fn().mockResolvedValue({ _id: "team-id", slug: "platform" }) };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "rag_ingestion_sources") return sources;
      if (name === "teams") return teams;
      throw new Error(`unexpected collection ${name}`);
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  // T023
  it("creates a slack_channel source with correct source_id, config_driven false, visibility team", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody()),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.data).toMatchObject({
      source_id: "slack-channel-C1234567890",
      source_type: "slack_channel",
      config_driven: false,
      config_import_adopted: false,
      visibility: "team",
      owner_team_slug: "platform",
      status: "ingesting",
      ingestion_job_id: "job-1",
    });
    expect(sources.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ source_id: "slack-channel-C1234567890" }),
    );
    expect(mockEnforceRagIngestorLimits).toHaveBeenCalledWith(
      "slack_channel",
      expect.objectContaining({
        lookback_days: 30,
        search_team_slugs: [],
      }),
      expect.objectContaining({ shared: { max_search_teams: 50 } }),
    );
  });

  it("rejects a source before persistence when the platform ingestor policy denies it", async () => {
    mockEnforceRagIngestorLimits.mockImplementationOnce(() => {
      throw Object.assign(new Error("Slack lookback exceeds the platform limit"), {
        statusCode: 400,
        code: "RAG_INGESTOR_LIMIT_EXCEEDED",
      });
    });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody({ lookback_days: 500 })),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.code).toBe("RAG_INGESTOR_LIMIT_EXCEEDED");
    expect(sources.insertOne).not.toHaveBeenCalled();
  });

  // T024
  it("returns 409 SOURCE_ALREADY_EXISTS for a duplicate channel_id", async () => {
    sources.findOne.mockResolvedValue({ source_id: "slack-channel-C1234567890" });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody()),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.code).toBe("SOURCE_ALREADY_EXISTS");
    expect(sources.insertOne).not.toHaveBeenCalled();
  });

  // A source already ingested on the RAG server (e.g. adopted by a prior
  // migrate run, or ingested via env config before this DB-backed path
  // existed) has no Mongo row, so the Mongo-only collision check would miss
  // it without also checking the RAG server's privileged existence endpoint.
  it("returns 409 SOURCE_ALREADY_EXISTS when the id is already known to the RAG server but has no Mongo row", async () => {
    mockDatasourceExists(true);
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody()),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.code).toBe("SOURCE_ALREADY_EXISTS");
    expect(sources.insertOne).not.toHaveBeenCalled();
  });

  // The collision probe must fail CLOSED — an unreachable/erroring RAG
  // server must never be silently treated as "id available", since that
  // would let a caller claim a hidden datasource id (finding: collision
  // probe fail-open on hidden datasources).
  it("returns 503 and blocks creation when the RAG server existence check fails", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody()),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.code).toBe("COLLISION_CHECK_UNAVAILABLE");
    expect(sources.insertOne).not.toHaveBeenCalled();
  });

  // T025
  it("returns 403 FORBIDDEN_OWNER_TEAM when the caller is not a member of owner_team_slug", async () => {
    mockRequireResourcePermission.mockImplementation(
      async (_session: unknown, resource: { type: string; action: string }) => {
        if (resource.type === "organization" && resource.action === "manage") {
          throw new Error("not admin");
        }
        if (resource.type === "team") throw new Error("not a member");
      },
    );
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody()),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.code).toBe("FORBIDDEN_OWNER_TEAM");
    expect(sources.insertOne).not.toHaveBeenCalled();
  });

  // Team membership on the owner team alone must not be enough to author a
  // source — the team also needs the org-admin-granted ingest capability
  // (mirrors the RAG server's `authorize_datasource_create`).
  it("returns 403 FORBIDDEN_INGEST_CAPABILITY when the owner team lacks the ingest capability", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    // Caller is a non-admin member of the owner team: reject the org-level
    // `manage` check (so `canManageOrganization` is false) but resolve the
    // team-level `use` check (so `canUseTeamSlug` is true).
    mockRequireResourcePermission.mockImplementation(
      async (_session: unknown, resource: { type: string; action: string }) => {
        if (resource.type === "organization" && resource.action === "manage") {
          throw new Error("not admin");
        }
      },
    );
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody()),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.code).toBe("FORBIDDEN_INGEST_CAPABILITY");
    expect(sources.insertOne).not.toHaveBeenCalled();
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: "team:platform#member",
      relation: "ingestor",
      object: "organization:caipe",
    });
  });

  // An org admin bypasses the per-team ingest-capability gate entirely.
  it("does not check the ingest capability for an org admin", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody()),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockCheckOpenFgaTuple).not.toHaveBeenCalled();
  });

  it("keeps the source retryable when the ingestor omits a job id", async () => {
    (global.fetch as jest.Mock).mockImplementation((_url: unknown, init?: RequestInit) => ({
      ok: true,
      status: init?.method === "POST" ? 202 : 200,
      json: jest.fn().mockResolvedValue(
        init?.method === "POST"
          ? { datasource_id: "slack-channel-C1234567890" }
          : { exists: false },
      ),
    }));
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody()),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.data).toMatchObject({
      source_id: "slack-channel-C1234567890",
      status: "failed",
    });
    expect(json.data.last_error).toContain("without returning an ingestion job id");
    expect(sources.updateOne).toHaveBeenCalledWith(
      { source_id: "slack-channel-C1234567890" },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "failed" }),
      }),
    );
  });

  // T026
  it("returns 404 OWNER_TEAM_NOT_FOUND for an unknown owner_team_slug", async () => {
    teams.findOne.mockResolvedValue(null);
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody({ owner_team_slug: "no-such-team" })),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.code).toBe("OWNER_TEAM_NOT_FOUND");
    expect(sources.insertOne).not.toHaveBeenCalled();
  });

  // T027 — source_id formula per source_type
  it.each([
    [
      postBody({
        source_type: "confluence_space",
        channel_id: undefined,
        confluence_url: "https://example.com/wiki",
        space_key: "ENG",
        start_page_url: "https://example.com/wiki/spaces/ENG/pages/123/start",
      }),
      "src_confluence___example_com__ENG__123",
    ],
    [
      postBody({ source_type: "jira_project", channel_id: undefined, project_key: "SDPL", source_slug: "eng-board", jql: "project = SDPL" }),
      "jira-sdpl-eng-board",
    ],
    [
      postBody({ source_type: "web_url", channel_id: undefined, url: "https://example.com/docs" }),
      null, // hash-based; asserted via regex below instead of exact match
    ],
    [
      postBody({ source_type: "webex_space", channel_id: undefined, space_id: "space-123" }),
      "webex-space-space-123",
    ],
  ])("computes the documented source_id formula for %#", async (body, expectedId) => {
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    if (expectedId) {
      expect(json.data.source_id).toBe(expectedId);
    } else {
      expect(json.data.source_id).toMatch(/^src_https___example_com_docs_[a-f0-9]{12}$/);
    }
  });

  it("accepts one Confluence page URL and derives the stored base URL", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          postBody({
            source_type: "confluence_space",
            channel_id: undefined,
            url: "https://example.com/wiki/spaces/ENG/pages/123/start",
            space_key: "ENG",
          }),
        ),
      }),
    );

    expect(response.status).toBe(201);
    expect(sources.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        source_id: "src_confluence___example_com__ENG__123",
        confluence_url: "https://example.com/wiki",
        start_page_url: "https://example.com/wiki/spaces/ENG/pages/123/start",
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/ingest/confluence/page"),
      expect.objectContaining({
        body: expect.stringContaining(
          '"preprovisioned_datasource_id":"src_confluence___example_com__ENG__123"',
        ),
      }),
    );
  });

  // T028
  it("returns 400 INVALID_SOURCE_PAYLOAD when a required type-specific field is missing", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          postBody({ source_type: "confluence_space", channel_id: undefined, confluence_url: "https://example.com/wiki" }),
        ),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.code).toBe("INVALID_SOURCE_PAYLOAD");
    expect(sources.insertOne).not.toHaveBeenCalled();
  });

  it("requires a per-datasource reload interval", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody({ reload_interval: undefined })),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.code).toBe("INVALID_SOURCE_PAYLOAD");
    expect(json.error).toBe("reload_interval is required");
    expect(sources.insertOne).not.toHaveBeenCalled();
  });

  // T029
  it("reconciles owner-team tuples without a user:* wildcard when visibility defaults to team", async () => {
    const { POST } = await import("../route");

    await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody()),
      }),
    );

    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "slack-channel-C1234567890",
        ownerTeamSlug: "platform",
        globalUserAccess: false,
      }),
    );
  });

  // Search-only teams are independent from the management owner and never
  // become knowledge-base managers.
  it("reconciles explicit Search Access teams independently", async () => {
    const { POST } = await import("../route");

    await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody({ search_team_slugs: ["everyone"] })),
      }),
    );

    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "slack-channel-C1234567890",
        ownerTeamSlug: null,
        ownerSubject: null,
        nextSharedTeamSlugs: ["everyone"],
      }),
    );
    expect(mockReconcileDataSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        dataSourceId: "slack-channel-C1234567890",
        parentKnowledgeBaseId: "slack-channel-C1234567890",
      }),
    );
  });

  it("starts ingestion immediately while broader Search waits for approval", async () => {
    mockPrepareRagPublication.mockResolvedValueOnce({
      actor: { subject: "alice-sub", email: "alice@example.com" },
      requesterTeamSlugs: ["platform"],
      requestedState: {
        search_team_slugs: ["everyone"],
        search_user_subjects: [],
      },
      plan: {
        requires_approval: true,
        reason: "Approval required: new organization-wide audience.",
        effective_state: {
          search_team_slugs: [],
          search_user_subjects: [],
        },
        risk_facts: {
          organization_wide: true,
          target_team_slugs: ["everyone"],
          added_team_slugs: ["everyone"],
          added_user_subjects: [],
          reasons: ["new organization-wide audience"],
        },
        approver_team_slugs: ["knowledge-approvers"],
      },
      resource: {
        kind: "rag_datasource",
        id: "slack-channel-C1234567890",
        label: "eng-general",
      },
      resourceRevision: "revision-effective",
    });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody({ search_team_slugs: ["everyone"] })),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.data).toMatchObject({
      status: "ingesting",
      ingestion_job_id: "job-1",
      search_with_teams: [],
      _publication_request: {
        id: "request-primary",
        status: "pending",
      },
    });
    expect(sources.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ search_with_teams: [] }),
    );
    expect(mockCreatePublicationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedState: expect.objectContaining({
          search_team_slugs: ["everyone"],
        }),
        effectiveState: expect.objectContaining({
          search_team_slugs: [],
        }),
      }),
    );
    const ingestCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/v1/ingest/slack/channel") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(ingestCall).toBeTruthy();
    expect(JSON.parse(String(ingestCall?.[1]?.body))).toEqual(
      expect.objectContaining({ search_team_slugs: [] }),
    );
  });

  // T030
  it("ignores caller-supplied config_driven/visibility and always produces config_driven:false, visibility:team", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/rag/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody({ config_driven: true, visibility: "global" })),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.data.config_driven).toBe(false);
    expect(json.data.visibility).toBe("team");
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({ globalUserAccess: false }),
    );
  });
});
