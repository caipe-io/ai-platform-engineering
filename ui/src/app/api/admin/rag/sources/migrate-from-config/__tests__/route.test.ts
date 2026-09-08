/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockGetCollection = jest.fn();
const mockBootstrapPlatformRagCollection = jest.fn();
const mockReplaceCollectionSources = jest.fn();
const mockAdoptConfigImportedRagSources = jest.fn();
const mockLoadSeedConfig = jest.fn();

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
  loadSeedConfig: (...args: unknown[]) => mockLoadSeedConfig(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  caipeOrgKey: () => "example-org",
}));

const session = {
  sub: "admin-sub",
  accessToken: "token-123",
  org: "example-org",
};

const CONFIG_SOURCES = [
  {
    source_type: "slack_channel",
    channel_id: "C1",
    name: "primary",
  },
  {
    source_type: "slack_channel",
    channel_id: "C2",
    name: "secondary",
  },
  {
    source_type: "slack_channel",
    channel_id: "C3",
    name: "example",
  },
];

function postRequest(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/admin/rag/sources/migrate-from-config",
    { method: "POST", body: JSON.stringify(body) },
  );
}

function mockCollections(
  existingSources: Array<Record<string, unknown>> = [
    {
      source_id: "slack-channel-C1",
      config_driven: true,
      config_import_adopted: false,
    },
    {
      source_id: "slack-channel-C2",
      config_driven: false,
      config_import_adopted: true,
    },
  ],
  ragCollections: Array<Record<string, unknown>> = [],
): void {
  mockGetCollection.mockImplementation(async (name: string) => {
    if (name === "rag_ingestion_sources") {
      return {
        find: jest.fn().mockReturnValue({
          project: jest.fn().mockReturnThis(),
          toArray: jest.fn().mockResolvedValue(existingSources),
        }),
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
  const originalConfigPath = process.env.APP_CONFIG_PATH;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_CONFIG_PATH = "/config/app-config.yaml";
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session });
    global.fetch = jest.fn();
    mockRequireRbacPermission.mockResolvedValue(undefined);
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockLoadSeedConfig.mockReturnValue({ rag_sources: CONFIG_SOURCES });
    mockBootstrapPlatformRagCollection.mockResolvedValue({
      _id: "platform-rag",
      source_ids: ["existing-source"],
      maintainer_team_slugs: ["owner-team"],
      reader_team_slugs: ["reader-team"],
    });
    mockReplaceCollectionSources.mockImplementation(
      async (id: string, sourceIds: string[]) => ({
        _id: id,
        source_ids: sourceIds,
      }),
    );
    mockAdoptConfigImportedRagSources.mockResolvedValue({
      adopted: ["slack-channel-C1"],
      skipped: [],
    });
    mockCollections();
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalConfigPath === undefined) {
      delete process.env.APP_CONFIG_PATH;
    } else {
      process.env.APP_CONFIG_PATH = originalConfigPath;
    }
  });

  it("requires admin and organization management permissions", async () => {
    const { POST } = await import("../route");
    const response = await POST(postRequest({ dry_run: true }));

    expect(response.status).toBe(200);
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

  it("previews only app-config sources and their current seed state", async () => {
    const { POST } = await import("../route");
    const response = await POST(postRequest({ dry_run: true }));
    const body = await response.json();

    expect(mockLoadSeedConfig).toHaveBeenCalledWith("/config/app-config.yaml");
    expect(body.data.sources).toEqual([
      {
        source_id: "slack-channel-C1",
        name: "primary",
        source_type: "slack_channel",
        in_db: true,
        already_adopted: false,
        importable: true,
      },
      {
        source_id: "slack-channel-C2",
        name: "secondary",
        source_type: "slack_channel",
        in_db: true,
        already_adopted: true,
        importable: false,
      },
      {
        source_id: "slack-channel-C3",
        name: "example",
        source_type: "slack_channel",
        in_db: false,
        already_adopted: false,
        importable: false,
        unavailable_reason: "not_seeded",
      },
    ]);
    expect(body.data.configured_source_count).toBe(3);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns an empty preview when no app config is mounted", async () => {
    delete process.env.APP_CONFIG_PATH;

    const { POST } = await import("../route");
    const response = await POST(postRequest({ dry_run: true }));
    const body = await response.json();

    expect(body.data.sources).toEqual([]);
    expect(mockLoadSeedConfig).not.toHaveBeenCalled();
  });

  it("adopts selected seeded sources and adds only those sources to the collection", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["slack-channel-C1"],
        destination_collection_id: "platform-rag",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockAdoptConfigImportedRagSources).toHaveBeenCalledWith(
      ["slack-channel-C1"],
      { ownerTeamSlug: "owner-team", ownerSubject: null },
    );
    expect(mockReplaceCollectionSources).toHaveBeenCalledWith(
      "platform-rag",
      ["existing-source", "slack-channel-C1"],
    );
    expect(body.data.adopted).toEqual(["slack-channel-C1"]);
  });

  it("does not adopt ids outside app config or entries that were not seeded", async () => {
    mockAdoptConfigImportedRagSources.mockResolvedValue({
      adopted: [],
      skipped: [],
    });
    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["unknown-source", "slack-channel-C3"],
      }),
    );
    const body = await response.json();

    expect(mockAdoptConfigImportedRagSources).toHaveBeenCalledWith([], {
      ownerTeamSlug: "owner-team",
      ownerSubject: null,
    });
    expect(mockReplaceCollectionSources).not.toHaveBeenCalled();
    expect(body.data.skipped).toEqual([
      { source_id: "unknown-source", reason: "not_in_config" },
      { source_id: "slack-channel-C3", reason: "not_seeded" },
    ]);
  });

  it("uses the selected collection owner for adopted source management", async () => {
    mockCollections(undefined, [
      {
        _id: "primary-collection",
        source_ids: [],
        owner_subject: "collection-owner",
        maintainer_team_slugs: [],
      },
    ]);

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["slack-channel-C1"],
        destination_collection_id: "primary-collection",
      }),
    );

    expect(response.status).toBe(200);
    expect(mockAdoptConfigImportedRagSources).toHaveBeenCalledWith(
      ["slack-channel-C1"],
      { ownerTeamSlug: null, ownerSubject: "collection-owner" },
    );
  });

  it("rejects an adoption destination without an Owner", async () => {
    mockBootstrapPlatformRagCollection.mockResolvedValue({
      _id: "platform-rag",
      source_ids: [],
      maintainer_team_slugs: [],
      owner_subject: null,
    });

    const { POST } = await import("../route");
    const response = await POST(
      postRequest({ dry_run: false, source_ids: ["slack-channel-C1"] }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("DESTINATION_COLLECTION_HAS_NO_OWNER");
    expect(mockAdoptConfigImportedRagSources).not.toHaveBeenCalled();
  });
});
