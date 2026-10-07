/**
 * @jest-environment node
 *
 * Tests for `GET /api/rag/sources` (spec 2026-07-21-rag-source-config-db,
 * US2 List/Read).
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockRequireResourcePermission = jest.fn();

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
  reconcileIngestionSourceRelationships: jest.fn(),
}));

jest.mock("@/lib/rbac/organization", () => ({
  caipeOrgKey: () => "caipe",
}));

const mockAllowedSourceTypesForIngestorServiceAccount = jest.fn();
jest.mock("@/lib/rbac/ingestor-service-accounts", () => ({
  allowedSourceTypesForIngestorServiceAccount: (...args: unknown[]) =>
    mockAllowedSourceTypesForIngestorServiceAccount(...args),
}));

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

const session = { sub: "alice-sub", role: "user" };
const user = { email: "alice@example.com" };

const teamARecord = {
  source_id: "slack-channel-team-a",
  source_type: "slack_channel",
  owner_team_slug: "team-a",
  shared_with_teams: [],
  visibility: "team",
};
const teamASharedRecord = {
  source_id: "slack-channel-shared",
  source_type: "slack_channel",
  owner_team_slug: "team-b",
  shared_with_teams: ["team-a"],
  visibility: "team",
};
const teamBOnlyRecord = {
  source_id: "slack-channel-team-b",
  source_type: "slack_channel",
  owner_team_slug: "team-b",
  shared_with_teams: [],
  visibility: "team",
};
const globalRecord = {
  source_id: "web-url-global",
  source_type: "web_url",
  owner_team_slug: "team-c",
  shared_with_teams: [],
  visibility: "global",
};

describe("GET /api/rag/sources", () => {
  let sources: { find: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user, session });
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockAllowedSourceTypesForIngestorServiceAccount.mockReturnValue(null);

    sources = {
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([teamARecord, teamASharedRecord, teamBOnlyRecord]),
      }),
    };
    mockGetCollection.mockResolvedValue(sources);
  });

  // T032
  it("returns exactly the owned + shared records for a Team A member, excluding Team B-only records", async () => {
    mockFilterResourcesByPermission.mockImplementation(async (_session, items: typeof teamARecord[]) =>
      items.filter((item) => item.owner_team_slug === "team-a" || item.shared_with_teams.includes("team-a")),
    );
    const { GET } = await import("../route");

    const response = await GET(request("/api/rag/sources"));
    const json = await response.json();

    expect(json.data.sources.map((s: { source_id: string }) => s.source_id)).toEqual([
      "slack-channel-team-a",
      "slack-channel-shared",
    ]);
  });

  // T033
  it("returns all records for an org admin (filter is a no-op bypass)", async () => {
    mockFilterResourcesByPermission.mockImplementation(async (_session, items) => items);
    const { GET } = await import("../route");

    const response = await GET(request("/api/rag/sources"));
    const json = await response.json();

    expect(json.data.sources).toHaveLength(3);
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      session,
      expect.anything(),
      expect.objectContaining({ type: "ingestion_source", action: "read" }),
      { bypassForOrgAdmin: true },
    );
  });

  // T034
  it("includes a visibility:global record for a caller with no team relationship to it", async () => {
    sources.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([globalRecord]),
    });
    // filterResourcesByPermission delegates to OpenFGA can_read, which the
    // user:* wildcard on a global record satisfies for any caller — the
    // route itself does no extra branching (contract T038).
    mockFilterResourcesByPermission.mockImplementation(async (_session, items) => items);
    const { GET } = await import("../route");

    const response = await GET(request("/api/rag/sources"));
    const json = await response.json();

    expect(json.data.sources.map((s: { source_id: string }) => s.source_id)).toEqual(["web-url-global"]);
  });

  // T037
  it("filters the list by source_type query param", async () => {
    mockFilterResourcesByPermission.mockImplementation(async (_session, items) => items);
    const { GET } = await import("../route");

    await GET(request("/api/rag/sources?source_type=web_url"));

    expect(sources.find).toHaveBeenCalledWith(expect.objectContaining({ source_type: "web_url" }));
  });

  it("returns pagination metadata and advances the Mongo cursor", async () => {
    const cursor = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      toArray: jest
        .fn()
        .mockResolvedValue([teamARecord, teamASharedRecord]),
    };
    sources.find.mockReturnValue(cursor);
    mockFilterResourcesByPermission.mockImplementation(
      async (_session, items) => items,
    );
    const { GET } = await import("../route");

    const response = await GET(request("/api/rag/sources?limit=2&offset=2"));
    const json = await response.json();

    expect(cursor.skip).toHaveBeenCalledWith(2);
    expect(cursor.limit).toHaveBeenCalledWith(2);
    expect(json.data.pagination).toEqual({
      offset: 2,
      limit: 2,
      has_more: true,
      next_offset: 4,
    });
  });

  it("adds _permissions.can_manage per record, true for an org admin bypass", async () => {
    mockFilterResourcesByPermission.mockImplementation(async (_session, items) => items);
    mockRequireResourcePermission.mockResolvedValue(undefined);
    const { GET } = await import("../route");

    const response = await GET(request("/api/rag/sources"));
    const json = await response.json();

    expect(
      json.data.sources.every((s: { _permissions?: { can_manage: boolean } }) => s._permissions?.can_manage === true),
    ).toBe(true);
  });

  it("sets _permissions.can_manage: false for a record the caller cannot manage", async () => {
    mockFilterResourcesByPermission.mockImplementation(async (_session, items) => items);
    mockRequireResourcePermission.mockImplementation(async (_session, target: { id: string }) => {
      if (target.id === "slack-channel-team-b") {
        throw Object.assign(new Error("denied"), { statusCode: 403 });
      }
      return undefined;
    });
    const { GET } = await import("../route");

    const response = await GET(request("/api/rag/sources"));
    const json = await response.json();

    const teamB = json.data.sources.find((s: { source_id: string }) => s.source_id === "slack-channel-team-b");
    expect(teamB._permissions.can_manage).toBe(false);
  });

  describe("recognized ingestor service account bypass", () => {
    it("does not affect a non-service-account caller (bypass returns null)", async () => {
      mockAllowedSourceTypesForIngestorServiceAccount.mockReturnValue(null);
      mockFilterResourcesByPermission.mockImplementation(async (_session, items) =>
        items.filter((item: typeof teamARecord) => item.owner_team_slug === "team-a"),
      );
      const { GET } = await import("../route");

      await GET(request("/api/rag/sources"));

      expect(mockFilterResourcesByPermission).toHaveBeenCalled();
      expect(sources.find).toHaveBeenCalledWith({});
    });

    it("forces source_type to the SA's allow-listed set and skips the OpenFGA filter", async () => {
      mockAllowedSourceTypesForIngestorServiceAccount.mockReturnValue(new Set(["slack_channel"]));
      const { GET } = await import("../route");

      const response = await GET(request("/api/rag/sources"));
      const json = await response.json();

      expect(sources.find).toHaveBeenCalledWith(expect.objectContaining({ source_type: "slack_channel" }));
      expect(mockFilterResourcesByPermission).not.toHaveBeenCalled();
      expect(json.data.sources).toHaveLength(3);
    });

    it("intersects an explicit source_type query param with the SA's allow-list rather than widening it", async () => {
      mockAllowedSourceTypesForIngestorServiceAccount.mockReturnValue(new Set(["slack_channel"]));
      const { GET } = await import("../route");

      await GET(request("/api/rag/sources?source_type=web_url"));

      // web_url is not in the SA's allow-list, so the effective query
      // matches nothing rather than falling back to the caller-supplied type.
      expect(sources.find).toHaveBeenCalledWith(expect.objectContaining({ source_type: { $in: [] } }));
    });

    it("scopes the query to multiple allow-listed types when no source_type param is given", async () => {
      mockAllowedSourceTypesForIngestorServiceAccount.mockReturnValue(
        new Set(["slack_channel", "web_url"]),
      );
      const { GET } = await import("../route");

      await GET(request("/api/rag/sources"));

      expect(sources.find).toHaveBeenCalledWith(
        expect.objectContaining({ source_type: { $in: ["slack_channel", "web_url"] } }),
      );
    });
  });
});
