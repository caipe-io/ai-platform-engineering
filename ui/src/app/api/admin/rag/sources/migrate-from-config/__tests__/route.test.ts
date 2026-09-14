/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockGetCollection = jest.fn();
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

const EXISTING_TEAMS = [{ slug: "owner-team" }, { slug: "search-team" }];

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
  teams: Array<Record<string, unknown>> = EXISTING_TEAMS,
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
    if (name === "teams") {
      return {
        findOne: jest.fn(async ({ slug }: { slug: string }) =>
          teams.find((team) => team.slug === slug) ?? null,
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

  it("adopts selected seeded sources with the given owner and no search access", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["slack-channel-C1"],
        owner_team_slug: "owner-team",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockAdoptConfigImportedRagSources).toHaveBeenCalledWith(
      ["slack-channel-C1"],
      { ownerTeamSlug: "owner-team", ownerSubject: null },
      { teamSlugs: [], userSubjects: [] },
    );
    expect(body.data.adopted).toEqual(["slack-channel-C1"]);
  });

  it("adopts selected sources with an owner subject and search access", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["slack-channel-C1"],
        owner_subject: "owner-person",
        search_team_slugs: ["search-team"],
        search_user_subjects: ["reader-person"],
      }),
    );

    expect(response.status).toBe(200);
    expect(mockAdoptConfigImportedRagSources).toHaveBeenCalledWith(
      ["slack-channel-C1"],
      { ownerTeamSlug: null, ownerSubject: "owner-person" },
      { teamSlugs: ["search-team"], userSubjects: ["reader-person"] },
    );
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
        owner_team_slug: "owner-team",
      }),
    );
    const body = await response.json();

    expect(mockAdoptConfigImportedRagSources).toHaveBeenCalledWith(
      [],
      { ownerTeamSlug: "owner-team", ownerSubject: null },
      { teamSlugs: [], userSubjects: [] },
    );
    expect(body.data.skipped).toEqual([
      { source_id: "unknown-source", reason: "not_in_config" },
      { source_id: "slack-channel-C3", reason: "not_seeded" },
    ]);
  });

  it("rejects adoption when neither an owner team nor an owner person is given", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      postRequest({ dry_run: false, source_ids: ["slack-channel-C1"] }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("OWNER_REQUIRED");
    expect(mockAdoptConfigImportedRagSources).not.toHaveBeenCalled();
  });

  it("rejects an owner team that does not exist", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["slack-channel-C1"],
        owner_team_slug: "missing-team",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.code).toBe("OWNER_TEAM_NOT_FOUND");
    expect(mockAdoptConfigImportedRagSources).not.toHaveBeenCalled();
  });

  it("rejects a search team that does not exist", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      postRequest({
        dry_run: false,
        source_ids: ["slack-channel-C1"],
        owner_team_slug: "owner-team",
        search_team_slugs: ["missing-team"],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.code).toBe("SEARCH_TEAM_NOT_FOUND");
    expect(mockAdoptConfigImportedRagSources).not.toHaveBeenCalled();
  });
});
