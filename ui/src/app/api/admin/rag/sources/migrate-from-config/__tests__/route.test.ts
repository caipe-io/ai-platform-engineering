/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockGetCollection = jest.fn();
const mockCreateIngestionSource = jest.fn();
const mockDeleteAllDataSourceRelationshipTuples = jest.fn();
const mockDeleteAllIngestionSourceRelationshipTuples = jest.fn();
const mockDeleteAllKnowledgeBaseRelationshipTuples = jest.fn();
const mockReconcileDataSourceRelationships = jest.fn();
const mockReconcileIngestionSourceRelationships = jest.fn();
const mockReconcileKnowledgeBaseRelationships = jest.fn();
const mockBootstrapPlatformRagCollection = jest.fn();
const mockReplaceCollectionSources = jest.fn();
const mockAdoptConfigImportedRagSources = jest.fn();
const mockUpdateLegacyAgents = jest.fn();

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
      <T>(handler: (request: NextRequest) => Promise<T>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (err) {
          const { ApiError } = actual;
          if (err instanceof ApiError) {
            return Response.json(
              { success: false, error: err.message, code: err.code },
              { status: err.statusCode },
            );
          }
          throw err;
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rag-collections.server", () => ({
  RAG_COLLECTION_ID_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  RAG_COLLECTIONS_COLLECTION: "rag_collections",
  bootstrapPlatformRagCollection: (...args: unknown[]) =>
    mockBootstrapPlatformRagCollection(...args),
  replaceCollectionSources: (...args: unknown[]) =>
    mockReplaceCollectionSources(...args),
}));

jest.mock("@/lib/seed-config", () => ({
  adoptConfigImportedRagSources: (...args: unknown[]) =>
    mockAdoptConfigImportedRagSources(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  caipeOrgKey: () => "example-org",
  organizationObjectId: () => "organization:example-org",
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  deleteAllDataSourceRelationshipTuples: (...args: unknown[]) =>
    mockDeleteAllDataSourceRelationshipTuples(...args),
  deleteAllIngestionSourceRelationshipTuples: (...args: unknown[]) =>
    mockDeleteAllIngestionSourceRelationshipTuples(...args),
  deleteAllKnowledgeBaseRelationshipTuples: (...args: unknown[]) =>
    mockDeleteAllKnowledgeBaseRelationshipTuples(...args),
  reconcileDataSourceRelationships: (...args: unknown[]) =>
    mockReconcileDataSourceRelationships(...args),
  reconcileIngestionSourceRelationships: (...args: unknown[]) =>
    mockReconcileIngestionSourceRelationships(...args),
  reconcileKnowledgeBaseRelationships: (...args: unknown[]) =>
    mockReconcileKnowledgeBaseRelationships(...args),
}));

jest.mock("@/app/api/rag/sources/route", () => ({
  createIngestionSource: (...args: unknown[]) =>
    mockCreateIngestionSource(...args),
}));

const session = {
  sub: "admin-sub",
  accessToken: "token-123",
  org: "example-org",
};
const user = { email: "admin@example.com" };

function postRequest(body: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/rag/sources/migrate-from-config",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

function redisDs(overrides: Record<string, unknown> = {}) {
  return {
    datasource_id: "slack-channel-C1",
    name: "eng-general",
    source_type: "slack",
    metadata: { channel_id: "C1" },
    ...overrides,
  };
}

function mockFetchDatasources(datasources: unknown[]) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({
      success: true,
      datasources,
      count: datasources.length,
    }),
  });
}

function mockCollections(
  existingSources: Array<Record<string, unknown>> = [],
  ragCollections: Array<Record<string, unknown>> = [],
) {
  mockGetCollection.mockImplementation(async (name: string) => {
    if (name === "rag_ingestion_sources") {
      return {
        find: jest.fn().mockReturnValue({
          project: jest.fn().mockReturnThis(),
          toArray: jest.fn().mockResolvedValue(existingSources),
        }),
      };
    }
    if (name === "dynamic_agents") {
      return {
        updateMany: (...args: unknown[]) => mockUpdateLegacyAgents(...args),
      };
    }
    if (name === "rag_collections") {
      return {
        findOne: jest.fn(async ({ _id }: { _id: string }) =>
          ragCollections.find((collection) => collection._id === _id) ?? null,
        ),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  });
}

describe("POST /api/admin/rag/sources/migrate-from-config", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user, session });
    mockRequireRbacPermission.mockResolvedValue(undefined);
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockDeleteAllDataSourceRelationshipTuples.mockResolvedValue({
      enabled: true,
    });
    mockDeleteAllIngestionSourceRelationshipTuples.mockResolvedValue({
      enabled: true,
    });
    mockDeleteAllKnowledgeBaseRelationshipTuples.mockResolvedValue({
      enabled: true,
    });
    mockReconcileDataSourceRelationships.mockResolvedValue({ enabled: true });
    mockReconcileIngestionSourceRelationships.mockResolvedValue({
      enabled: true,
    });
    mockReconcileKnowledgeBaseRelationships.mockResolvedValue({
      enabled: true,
    });
    mockAdoptConfigImportedRagSources.mockResolvedValue({
      adopted: [],
      skipped: [],
    });
    mockBootstrapPlatformRagCollection.mockResolvedValue({
      _id: "platform-rag",
      source_ids: [],
      maintainer_team_slugs: ["manage-team"],
      reader_team_slugs: ["search-team"],
    });
    mockReplaceCollectionSources.mockImplementation(
      async (id: string, sourceIds: string[]) => ({
        _id: id,
        source_ids: sourceIds,
      }),
    );
    mockUpdateLegacyAgents.mockResolvedValue({ modifiedCount: 2 });
    mockCollections();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("requires admin_ui admin permission", async () => {
    mockRequireRbacPermission.mockRejectedValue(new Error("forbidden"));

    const { POST } = await import("../route");
    await expect(POST(postRequest({ dry_run: true }))).rejects.toThrow(
      "forbidden",
    );
    expect(mockRequireRbacPermission).toHaveBeenCalledWith(
      session,
      "admin_ui",
      "admin",
    );
  });

  it("also requires organization management permission", async () => {
    mockRequireResourcePermission.mockRejectedValue(new Error("forbidden"));

    const { POST } = await import("../route");
    await expect(POST(postRequest({ dry_run: true }))).rejects.toThrow(
      "forbidden",
    );
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(session, {
      type: "organization",
      id: "example-org",
      action: "manage",
    });
  });

  it("dry_run: true excludes existing UI-managed sources", async () => {
    mockFetchDatasources([
      redisDs({ datasource_id: "slack-channel-C1", name: "eng-general" }),
      redisDs({
        datasource_id: "slack-channel-C2",
        name: "eng-random",
        metadata: { channel_id: "C2" },
      }),
    ]);
    mockCollections([
      { source_id: "slack-channel-C1", config_import_adopted: false },
    ]);

    const { POST } = await import("../route");
    const response = await POST(postRequest({ dry_run: true }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.sources).toEqual([
      {
        source_id: "slack-channel-C2",
        name: "eng-random",
        source_type: "slack_channel",
        in_db: false,
        already_adopted: false,
        importable: true,
      },
    ]);
    expect(mockCreateIngestionSource).not.toHaveBeenCalled();
  });

  it("excludes datasources whose source_type has no self-service equivalent", async () => {
    mockFetchDatasources([
      redisDs({ datasource_id: "gh-1", source_type: "github", metadata: {} }),
    ]);
    mockCollections();

    const { POST } = await import("../route");
    const response = await POST(postRequest({ dry_run: true }));
    const body = await response.json();

    expect(body.data.sources).toEqual([]);
    expect(body.data.legacy_source_count).toBe(1);
    expect(body.data.destination_collection).toEqual({
      id: "platform-rag",
      source_count: 0,
      agents_updated: 0,
    });
  });

  it("flags legacy source ids that cannot use managed access", async () => {
    mockFetchDatasources([
      redisDs({
        datasource_id: "src_confluence___wiki_example_com__Control Plane",
        name: "Confluence: Control Plane",
        source_type: "confluence",
        metadata: {
          confluence_url: "https://wiki.example.com/wiki",
          space_key: "Control Plane",
        },
      }),
    ]);
    mockCollections();

    const { POST } = await import("../route");
    const response = await POST(postRequest({ dry_run: true }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.sources).toEqual([
      {
        source_id: "src_confluence___wiki_example_com__Control Plane",
        name: "Confluence: Control Plane",
        source_type: "confluence_space",
        in_db: false,
        already_adopted: false,
        importable: false,
        unavailable_reason: "unsupported_legacy_id",
      },
    ]);
    expect(body.data.legacy_source_count).toBe(1);
    expect(body.data.compatible_source_count).toBe(0);
  });

  it("skips an unsafe legacy id while importing the remaining sources", async () => {
    const unsafeId = "src_confluence___wiki_example_com__Control Plane";
    mockFetchDatasources([
      redisDs(),
      redisDs({
        datasource_id: unsafeId,
        name: "Confluence: Control Plane",
        source_type: "confluence",
        metadata: {
          confluence_url: "https://wiki.example.com/wiki",
          space_key: "Control Plane",
        },
      }),
    ]);
    mockCollections();
    mockCreateIngestionSource.mockResolvedValue({
      source_id: "slack-channel-C1",
    });

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["slack-channel-C1", unsafeId],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.adopted).toEqual(["slack-channel-C1"]);
    expect(body.data.skipped).toContainEqual({
      source_id: unsafeId,
      reason: "unsupported_legacy_id",
    });
    expect(mockReplaceCollectionSources).toHaveBeenCalledWith(
      "platform-rag",
      ["slack-channel-C1"],
    );
    expect(mockDeleteAllDataSourceRelationshipTuples).not.toHaveBeenCalledWith(
      unsafeId,
    );
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeBaseId: unsafeId }),
    );
  });

  it("does not treat scoped direct datasources without Mongo config rows as legacy-global", async () => {
    mockFetchDatasources([
      redisDs({
        datasource_id: "local-file-personal",
        name: "Personal files",
        source_type: "local_file",
        creator_subject: "user-sub",
        owner_subject: "user-sub",
        metadata: { files: [{ filename: "notes.pdf" }] },
      }),
      redisDs({
        datasource_id: "slack-channel-C2",
        name: "Team channel",
        metadata: { channel_id: "C2", config_managed: true },
        creator_subject: "user-sub",
        owner_team_slug: "manage-team",
        search_with_teams: ["search-team"],
      }),
    ]);
    mockCollections();

    const { POST } = await import("../route");
    const response = await POST(postRequest({ dry_run: true }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.sources).toEqual([]);
    expect(body.data.legacy_source_count).toBe(0);
  });

  it("does not replace policy or publish scoped direct datasources during apply", async () => {
    mockFetchDatasources([
      redisDs({
        datasource_id: "local-file-personal",
        source_type: "local_file",
        creator_subject: "user-sub",
        owner_subject: "user-sub",
        search_with_users: ["reader-sub"],
        metadata: { files: [{ filename: "notes.pdf" }] },
      }),
    ]);
    mockCollections();

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({ dry_run: false, source_ids: [] }),
    );

    expect(response.status).toBe(200);
    expect(mockDeleteAllDataSourceRelationshipTuples).not.toHaveBeenCalled();
    expect(mockDeleteAllKnowledgeBaseRelationshipTuples).not.toHaveBeenCalled();
    expect(
      mockDeleteAllIngestionSourceRelationshipTuples,
    ).not.toHaveBeenCalled();
    expect(mockReconcileDataSourceRelationships).not.toHaveBeenCalled();
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
    expect(mockReconcileIngestionSourceRelationships).not.toHaveBeenCalled();
    expect(mockCreateIngestionSource).not.toHaveBeenCalled();
    expect(mockReplaceCollectionSources).toHaveBeenCalledWith(
      "platform-rag",
      [],
    );
  });

  it("keeps config-driven rows importable and in Platform RAG", async () => {
    mockFetchDatasources([redisDs()]);
    mockCollections([
      {
        source_id: "slack-channel-C1",
        config_driven: true,
        config_import_adopted: false,
      },
    ]);

    const { POST } = await import("../route");
    const response = await POST(postRequest({ dry_run: true }));
    const body = await response.json();

    expect(body.data.sources).toEqual([
      expect.objectContaining({
        source_id: "slack-channel-C1",
        in_db: true,
        already_adopted: false,
        importable: true,
      }),
    ]);
    expect(body.data.legacy_source_count).toBe(1);
  });

  it("keeps previously imported environment sources visible but disabled", async () => {
    mockFetchDatasources([redisDs()]);
    mockCollections([
      {
        source_id: "slack-channel-C1",
        config_driven: false,
        config_import_adopted: true,
      },
    ]);

    const { POST } = await import("../route");
    const response = await POST(postRequest({ dry_run: true }));
    const body = await response.json();

    expect(body.data.sources).toEqual([
      expect.objectContaining({
        source_id: "slack-channel-C1",
        in_db: true,
        already_adopted: true,
        importable: false,
      }),
    ]);
  });

  it("adopts an existing config-driven row without inserting a duplicate", async () => {
    mockFetchDatasources([redisDs()]);
    mockCollections([
      {
        source_id: "slack-channel-C1",
        config_driven: true,
        config_import_adopted: false,
      },
    ]);
    mockAdoptConfigImportedRagSources.mockResolvedValue({
      adopted: ["slack-channel-C1"],
      skipped: [],
    });

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["slack-channel-C1"],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockCreateIngestionSource).not.toHaveBeenCalled();
    expect(mockAdoptConfigImportedRagSources).toHaveBeenCalledWith(
      ["slack-channel-C1"],
      { ownerTeamSlug: "manage-team", ownerSubject: null },
    );
    expect(body.data.adopted).toEqual(["slack-channel-C1"]);
  });

  it("gives unsupported legacy sources management policy without direct search grants", async () => {
    mockFetchDatasources([
      redisDs({
        datasource_id: "legacy-source",
        source_type: "example_connector",
        metadata: {},
      }),
    ]);
    mockCollections();

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({ dry_run: false, source_ids: [] }),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "legacy-source",
        ownerTeamSlug: "manage-team",
      }),
    );
    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "legacy-source",
        ownerTeamSlug: null,
        nextSharedTeamSlugs: [],
      }),
    );
    expect(mockReplaceCollectionSources).toHaveBeenCalledWith(
      "platform-rag",
      ["legacy-source"],
    );
  });

  it("does not replace source-level grants again after an unsupported source policy was adopted", async () => {
    mockFetchDatasources([
      redisDs({
        datasource_id: "legacy-source",
        source_type: "example_connector",
        metadata: {
          config_managed: true,
          config_import_adopted: true,
        },
      }),
    ]);
    mockCollections();

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({ dry_run: false, source_ids: [] }),
    );

    expect(response.status).toBe(200);
    expect(mockDeleteAllDataSourceRelationshipTuples).not.toHaveBeenCalled();
    expect(mockDeleteAllKnowledgeBaseRelationshipTuples).not.toHaveBeenCalled();
    expect(
      mockDeleteAllIngestionSourceRelationshipTuples,
    ).not.toHaveBeenCalled();
    expect(mockReconcileDataSourceRelationships).not.toHaveBeenCalled();
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
    expect(mockReconcileIngestionSourceRelationships).not.toHaveBeenCalled();
    expect(mockReplaceCollectionSources).toHaveBeenCalledWith(
      "platform-rag",
      ["legacy-source"],
    );
  });

  it("apply (dry_run: false) creates config rows for the requested, not-yet-in-db source ids", async () => {
    mockFetchDatasources([
      redisDs({
        description: "Existing Slack source",
        metadata: {
          channel_id: "C1",
          lookback_days: 14,
          include_bots: true,
          last_ts: "123.456",
        },
      }),
    ]);
    mockCollections();
    mockCreateIngestionSource.mockResolvedValue({
      source_id: "slack-channel-C1",
    });

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["slack-channel-C1"],
        management_shared_with_teams: ["shared-team"],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockCreateIngestionSource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "slack-channel-C1",
        fields: {
          source_type: "slack_channel",
          channel_id: "C1",
          lookback_days: 14,
          include_bots: true,
        },
        name: "eng-general",
        description: "Existing Slack source",
        ownerTeamSlug: "manage-team",
        sharedWithTeams: [],
        searchWithTeams: [],
        configImportAdopted: true,
      }),
    );
    expect(mockBootstrapPlatformRagCollection).toHaveBeenCalledTimes(1);
    expect(mockReplaceCollectionSources).toHaveBeenCalledWith(
      "platform-rag",
      ["slack-channel-C1"],
    );
    expect(mockUpdateLegacyAgents).toHaveBeenCalledWith(
      {
        "allowed_tools.knowledge-base": { $exists: true, $ne: false },
        $and: [
          {
            $or: [
              { rag_collection_ids: { $exists: false } },
              { rag_collection_ids: null },
            ],
          },
          {
            $or: [
              { datasource_ids: { $exists: false } },
              { datasource_ids: null },
            ],
          },
        ],
      },
      {
        $set: {
          rag_collection_ids: ["platform-rag"],
          updated_at: expect.any(String),
        },
      },
    );
    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "slack-channel-C1",
        ownerTeamSlug: null,
        nextSharedTeamSlugs: [],
      }),
    );
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "slack-channel-C1",
        ownerTeamSlug: "manage-team",
        nextSharedTeamSlugs: [],
      }),
    );
    expect(mockReconcileDataSourceRelationships).toHaveBeenCalledWith({
      dataSourceId: "slack-channel-C1",
      parentKnowledgeBaseId: "slack-channel-C1",
    });
    expect(mockDeleteAllIngestionSourceRelationshipTuples).toHaveBeenCalledWith(
      "slack-channel-C1",
    );
    expect(mockDeleteAllKnowledgeBaseRelationshipTuples).toHaveBeenCalledWith(
      "slack-channel-C1",
    );
    expect(mockDeleteAllDataSourceRelationshipTuples).toHaveBeenCalledWith(
      "slack-channel-C1",
    );
    const persistCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]) =>
        url === "http://localhost:9446/v1/datasource" &&
        init?.method === "POST",
    );
    expect(JSON.parse(persistCall?.[1]?.body as string)).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          last_ts: "123.456",
          config_managed: true,
          config_import_adopted: true,
        }),
        owner_team_slug: "manage-team",
        owner_subject: null,
        shared_with_teams: [],
        search_with_teams: [],
      }),
    );
    expect(body.data.adopted).toEqual(["slack-channel-C1"]);
    expect(body.data.skipped).toEqual([]);
  });

  it("apply defaults source_ids to importable (not-yet-in-db) sources when omitted", async () => {
    mockFetchDatasources([
      redisDs({ datasource_id: "slack-channel-C1" }),
      redisDs({
        datasource_id: "slack-channel-C2",
        name: "eng-random",
        metadata: { channel_id: "C2" },
      }),
    ]);
    mockCollections([
      { source_id: "slack-channel-C2", config_import_adopted: true },
    ]);
    mockCreateIngestionSource.mockResolvedValue({
      source_id: "slack-channel-C1",
    });

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({ dry_run: false }),
    );
    const body = await response.json();

    // slack-channel-C2 already has a config row, so only C1 is eligible by default.
    expect(mockCreateIngestionSource).toHaveBeenCalledTimes(1);
    expect(mockCreateIngestionSource).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "slack-channel-C1" }),
    );
    expect(body.data.adopted).toEqual(["slack-channel-C1"]);
  });

  it("preserves connector-specific Jira, web, and Confluence configuration", async () => {
    mockFetchDatasources([
      redisDs({
        datasource_id: "jira-example-primary",
        name: "Primary issues",
        source_type: "jira",
        metadata: {
          project_key: "EXAMPLE",
          jql: "project = EXAMPLE ORDER BY updated DESC",
          include_comments: false,
          include_links: false,
          custom_fields: { service: "customfield_123" },
        },
      }),
      redisDs({
        datasource_id: "src_web___example_com_docs",
        name: "Example docs",
        source_type: "web",
        metadata: {
          url_ingest_request: {
            url: "https://example.com/docs",
            settings: {
              crawl_mode: "recursive",
              max_depth: 4,
              max_pages: 250,
              render_javascript: true,
              allow_non_public_urls: true,
              allowed_url_patterns: ["^https://example\\.com/docs"],
            },
          },
        },
      }),
      redisDs({
        datasource_id: "src_confluence___example_atlassian_net__DOCS",
        name: "Documentation space",
        source_type: "confluence",
        metadata: {
          confluence_url: "https://example.atlassian.net/wiki",
          space_key: "DOCS",
          page_configs: [
            { page_id: "101", get_child_pages: true },
            {
              page_id: "202",
              source:
                "https://example.atlassian.net/wiki/spaces/DOCS/pages/202/Secondary",
              get_child_pages: false,
            },
          ],
          allowed_title_patterns: ["^Public"],
        },
      }),
    ]);
    mockCollections();
    mockCreateIngestionSource.mockResolvedValue({});

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: [
          "jira-example-primary",
          "src_web___example_com_docs",
          "src_confluence___example_atlassian_net__DOCS",
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(mockCreateIngestionSource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "jira-example-primary",
        fields: expect.objectContaining({
          include_comments: false,
          include_links: false,
          custom_fields: { service: "customfield_123" },
        }),
      }),
    );
    expect(mockCreateIngestionSource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "src_web___example_com_docs",
        fields: expect.objectContaining({
          settings: expect.objectContaining({
            crawl_mode: "recursive",
            max_depth: 4,
            render_javascript: true,
            allow_non_public_urls: true,
          }),
        }),
      }),
    );
    expect(mockCreateIngestionSource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "src_confluence___example_atlassian_net__DOCS",
        fields: expect.objectContaining({
          start_page_url:
            "https://example.atlassian.net/wiki/spaces/DOCS/pages/101",
          get_child_pages: true,
          allowed_title_patterns: ["^Public"],
          page_configs: [
            { page_id: "101", source: null, get_child_pages: true },
            {
              page_id: "202",
              source:
                "https://example.atlassian.net/wiki/spaces/DOCS/pages/202/Secondary",
              get_child_pages: false,
            },
          ],
        }),
      }),
    );
  });

  it("adopts a whole-space Confluence config with no synthetic root page", async () => {
    mockFetchDatasources([
      redisDs({
        datasource_id: "src_confluence___example_atlassian_net__DOCS",
        name: "Documentation space",
        source_type: "confluence",
        metadata: {
          confluence_url: "https://example.atlassian.net/wiki",
          space_key: "DOCS",
          page_configs: [],
        },
      }),
    ]);
    mockCollections();
    mockCreateIngestionSource.mockResolvedValue({});

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["src_confluence___example_atlassian_net__DOCS"],
      }),
    );

    expect(response.status).toBe(200);
    expect(mockCreateIngestionSource).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: expect.objectContaining({
          whole_space: true,
          page_configs: [],
        }),
      }),
    );
    const fields = mockCreateIngestionSource.mock.calls[0][0].fields;
    expect(fields).not.toHaveProperty("start_page_url");
  });

  it("skips a requested id that already has a config row instead of re-creating it", async () => {
    mockFetchDatasources([redisDs({ datasource_id: "slack-channel-C1" })]);
    mockCollections([
      { source_id: "slack-channel-C1", config_import_adopted: true },
    ]);

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["slack-channel-C1"],
      }),
    );
    const body = await response.json();

    expect(mockCreateIngestionSource).not.toHaveBeenCalled();
    expect(body.data.adopted).toEqual([]);
    expect(body.data.skipped).toEqual([
      { source_id: "slack-channel-C1", reason: "already_in_db" },
    ]);
  });

  it("skips a requested id with no matching Redis datasource", async () => {
    mockFetchDatasources([]);
    mockCollections();

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["ghost-source"],
      }),
    );
    const body = await response.json();

    expect(mockCreateIngestionSource).not.toHaveBeenCalled();
    expect(body.data.skipped).toEqual([
      { source_id: "ghost-source", reason: "not_found_in_redis" },
    ]);
  });

  it("uses Platform RAG's current Owner without migration team inputs", async () => {
    mockFetchDatasources([
      redisDs({
        datasource_id: "legacy-source",
        source_type: "example_connector",
        metadata: {},
      }),
    ]);
    mockCollections();
    mockBootstrapPlatformRagCollection.mockResolvedValue({
      _id: "platform-rag",
      source_ids: ["existing-source"],
      maintainer_team_slugs: ["platform-owners"],
      reader_team_slugs: ["organization-readers"],
    });

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: [],
      }),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "legacy-source",
        ownerTeamSlug: "platform-owners",
      }),
    );
    expect(mockReplaceCollectionSources).toHaveBeenCalledWith(
      "platform-rag",
      ["existing-source", "legacy-source"],
    );
  });

  it("imports into the selected collection and uses its Owner", async () => {
    mockFetchDatasources([
      redisDs({
        datasource_id: "legacy-source",
        source_type: "example_connector",
        metadata: {},
      }),
    ]);
    mockCollections([], [
      {
        _id: "engineering-docs",
        source_ids: ["existing-source"],
        owner_subject: null,
        maintainer_team_slugs: ["engineering"],
        reader_team_slugs: ["engineering"],
      },
    ]);

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: [],
        destination_collection_id: "engineering-docs",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockBootstrapPlatformRagCollection).not.toHaveBeenCalled();
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "legacy-source",
        ownerSubject: null,
        ownerTeamSlug: "engineering",
      }),
    );
    expect(mockReplaceCollectionSources).toHaveBeenCalledWith(
      "engineering-docs",
      ["existing-source", "legacy-source"],
    );
    expect(mockUpdateLegacyAgents).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          rag_collection_ids: ["engineering-docs"],
        }),
      }),
    );
    expect(body.data.destination_collection).toEqual({
      id: "engineering-docs",
      source_count: 2,
      agents_updated: 2,
    });
  });

  it("rejects an unknown destination collection", async () => {
    mockCollections();

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: true,
        destination_collection_id: "missing-collection",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.code).toBe("DESTINATION_COLLECTION_NOT_FOUND");
  });
});
