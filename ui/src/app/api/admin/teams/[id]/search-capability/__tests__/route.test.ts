/**
 * @jest-environment node
 */
/**
 * Tests for /api/admin/teams/[id]/search-capability — the explicit "search"
 * capability grant (spec 2026-06-03-explicit-search-capability).
 *
 * Verifies: GET reports state from OpenFGA; PUT/DELETE are org-admin-only and
 * write/delete the single `team:<slug>#member -> searcher -> organization`
 * tuple; idempotency (no write when already in desired state); and fail-closed
 * 503 when OpenFGA is unconfigured.
 */

import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();
const mockReadOpenFgaTuples = jest.fn();
const mockCollections: Record<string, unknown> = {};

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 500) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    ApiError,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    requireRbacPermission: (...args: unknown[]) => mockRequireRbacPermission(...args),
    successResponse: (data: unknown) => NextResponse.json({ success: true, data }),
    withErrorHandler:
      (handler: (...args: unknown[]) => Promise<Response>) =>
      async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (error) {
          return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : "error" },
            {
              status:
                error && typeof error === "object" && "statusCode" in error
                  ? Number((error as { statusCode: number }).statusCode)
                  : 500,
            },
          );
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(async (name: string) => mockCollections[name]),
  isMongoDBConfigured: true,
}));

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: () => "organization:caipe",
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
}));

import { GET, PUT, DELETE } from "@/app/api/admin/teams/[id]/search-capability/route";

const TEAM_ID = new ObjectId().toHexString();
const TEAM_SLUG = "platform-eng";
const CAP_TUPLE = {
  user: `team:${TEAM_SLUG}#member`,
  relation: "searcher",
  object: "organization:caipe",
};

function teamsCollection() {
  return {
    findOne: jest.fn(async () => ({ _id: new ObjectId(TEAM_ID), slug: TEAM_SLUG })),
  };
}

function ctx() {
  return { params: Promise.resolve({ id: TEAM_ID }) };
}

function req() {
  return new NextRequest("http://localhost/api/admin/teams/x/search-capability");
}

describe("/api/admin/teams/[id]/search-capability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollections.teams = teamsCollection();
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "admin@example.com" },
      session: {},
    });
    mockRequireRbacPermission.mockResolvedValue(undefined);
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
    mockReadOpenFgaTuples.mockResolvedValue({ tuples: [] });
  });

  it("GET reports can_search=false when no tuple exists", async () => {
    const res = await GET(req(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.can_search).toBe(false);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      {},
      { type: "team", id: TEAM_SLUG, action: "read" },
      { bypassForOrgAdmin: true },
    );
  });

  it("GET reports true when the capability tuple exists", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({ tuples: [{ key: CAP_TUPLE }] });
    const res = await GET(req(), ctx());
    const body = await res.json();
    expect(body.data.can_search).toBe(true);
  });

  it("GET denies callers who cannot view the team", async () => {
    const { ApiError } = jest.requireMock("@/lib/api-middleware");
    mockRequireResourcePermission.mockRejectedValue(new ApiError("Forbidden", 403));
    const res = await GET(req(), ctx());
    expect(res.status).toBe(403);
    expect(mockReadOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("PUT grants the capability (org-admin only) and writes the member tuple", async () => {
    const res = await PUT(req(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.can_search).toBe(true);
    expect(mockRequireRbacPermission).toHaveBeenCalledWith({}, "admin_ui", "admin");
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({ writes: [CAP_TUPLE], deletes: [] });
  });

  it("PUT is idempotent — no write when the capability already exists", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({ tuples: [{ key: CAP_TUPLE }] });
    await PUT(req(), ctx());
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("DELETE revokes the capability and deletes the member tuple", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({ tuples: [{ key: CAP_TUPLE }] });
    const res = await DELETE(req(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.can_search).toBe(false);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({ writes: [], deletes: [CAP_TUPLE] });
  });

  it("non-org-admin is rejected (403)", async () => {
    const { ApiError } = jest.requireMock("@/lib/api-middleware");
    mockRequireRbacPermission.mockRejectedValue(new ApiError("Forbidden", 403));
    const res = await PUT(req(), ctx());
    expect(res.status).toBe(403);
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("PUT surfaces 503 when OpenFGA is not configured", async () => {
    mockWriteOpenFgaTuples.mockResolvedValue({ enabled: false, writes: 0, deletes: 0 });
    const res = await PUT(req(), ctx());
    expect(res.status).toBe(503);
  });

  it("invalid team id format returns 400", async () => {
    const badCtx = { params: Promise.resolve({ id: "not-an-objectid" }) };
    const res = await GET(req(), badCtx);
    expect(res.status).toBe(400);
  });
});
