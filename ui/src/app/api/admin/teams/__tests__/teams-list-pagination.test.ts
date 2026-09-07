/**
 * @jest-environment node
 *
 * Tests for GET /api/admin/teams pagination. Pagination + server-side search
 * are opt-in via the `page` query param: with it, the route returns a
 * `{ teams, total, page, page_size, has_more }` envelope and pushes
 * skip/limit + a search filter into Mongo; without it, the route returns the
 * full list exactly as before (so the shared filter dropdowns keep working).
 */

import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";

const mockGetServerSession = jest.fn();
const mockCheckPermission = jest.fn();
const mockRequireBaselineAdminSurfaceRead = jest.fn();
const mockLoadTeamMemberCounts = jest.fn();
const mockLoadTeamIdpSourceTypes = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
const mockListOpenFgaObjects = jest.fn();
const mockGetRealmUserByIdOrNull = jest.fn();

jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: "",
}));

jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => key === "ssoEnabled",
}));

jest.mock("@/lib/rbac/keycloak-authz", () => ({
  checkPermission: (...args: unknown[]) => mockCheckPermission(...args),
}));

jest.mock("@/lib/rbac/audit", () => ({ logAuthzDecision: jest.fn() }));

jest.mock("@/lib/rbac/require-openfga", () => ({
  requireBaselineAdminSurfaceRead: (...args: unknown[]) =>
    mockRequireBaselineAdminSurfaceRead(...args),
  requireAdminSurfaceManage: jest.fn(),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
}));

jest.mock("@/lib/rbac/team-membership-store", () => ({
  loadTeamMemberCounts: (...args: unknown[]) => mockLoadTeamMemberCounts(...args),
  loadTeamIdpSourceTypes: (...args: unknown[]) => mockLoadTeamIdpSourceTypes(...args),
}));

jest.mock("@/lib/rbac/team-membership-source-store", () => ({
  upsertTeamMembershipSource: jest.fn(),
}));

jest.mock("@/lib/rbac/team-membership-sync", () => ({
  mongoRoleToOpenFgaRelations: jest.fn(() => []),
  resolveKeycloakUserSubject: jest.fn(),
  writeTeamMembershipTuples: jest.fn(),
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  getRealmUserByIdOrNull: (...args: unknown[]) => mockGetRealmUserByIdOrNull(...args),
  isValidTeamSlug: jest.fn(() => true),
}));

const mockCollections: Record<string, unknown> = {};
let mockIsMongoDBConfigured = true;

jest.mock("@/lib/mongodb", () => ({
  get isMongoDBConfigured() {
    return mockIsMongoDBConfigured;
  },
  getCollection: jest.fn(async (name: string) => mockCollections[name] ?? createMockCollection()),
}));

function createMockCollection() {
  return {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
      toArray: jest.fn().mockResolvedValue([]),
    }),
    findOne: jest.fn().mockResolvedValue(null),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
}

// A teams collection that records the query/skip/limit it was asked for and
// supports BOTH the paginated chain (find().sort().skip().limit().toArray())
// and the unpaginated chain (find().sort().toArray()).
function seedTeamsCollection(rows: Array<Record<string, unknown>>, total: number) {
  const calls: { query?: Record<string, unknown>; skip?: number; limit?: number } = {};
  const cursor: unknown = {
    sort: jest.fn().mockReturnValue(cursorChain()),
  };
  function cursorChain() {
    const chain: unknown = {
      skip: jest.fn((n: number) => {
        calls.skip = n;
        return chain;
      }),
      limit: jest.fn((n: number) => {
        calls.limit = n;
        return chain;
      }),
      toArray: jest.fn().mockResolvedValue(rows),
    };
    return chain;
  }
  const teamsCol = {
    find: jest.fn((query: Record<string, unknown>) => {
      calls.query = query;
      return cursor;
    }),
    countDocuments: jest.fn().mockResolvedValue(total),
    findOne: jest.fn().mockResolvedValue(null),
  };
  mockCollections.teams = teamsCol;
  return { teamsCol, calls };
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

function accessTokenWithRoles(roles: string[]): string {
  const payload = Buffer.from(JSON.stringify({ realm_access: { roles } }), "utf8").toString(
    "base64url",
  );
  return `h.${payload}.s`;
}

function adminSession() {
  return {
    user: { email: "admin@example.com", name: "Admin" },
    role: "admin",
    sub: "admin-sub",
    accessToken: accessTokenWithRoles(["admin"]),
  };
}

const teamRow = (slug: string) => ({
  _id: new ObjectId(),
  slug,
  name: slug,
  owner_id: "owner@example.com",
  created_at: new Date(),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMongoDBConfigured = true;
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
  mockGetServerSession.mockResolvedValue(adminSession());
  mockCheckPermission.mockResolvedValue({ allowed: true, reason: "OK" });
  mockRequireBaselineAdminSurfaceRead.mockResolvedValue(undefined);
  // Platform-wide visibility is probed with the actual admin capability.
  mockLoadTeamMemberCounts.mockResolvedValue(new Map());
  mockLoadTeamIdpSourceTypes.mockResolvedValue(new Map());
  mockCheckOpenFgaTuple.mockImplementation(
    async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:admin-sub"
        && tuple.relation === "can_manage"
        && tuple.object === "organization:caipe",
    }),
  );
  mockListOpenFgaObjects.mockResolvedValue({ objects: [] });
  mockGetRealmUserByIdOrNull.mockResolvedValue({
    id: "preview-user",
    email: "preview@example.com",
  });
});

async function callGet(url: string) {
  const { GET } = await import("../route");
  const response = await GET(makeRequest(url));
  return { response, body: await response.json() };
}

describe("GET /api/admin/teams pagination", () => {
  it("returns a paginated envelope and pushes skip/limit + search into Mongo", async () => {
    const { calls } = seedTeamsCollection([teamRow("alpha")], 60);

    const { response, body } = await callGet(
      "/api/admin/teams?page=2&page_size=24&search=alp",
    );

    expect(response.status).toBe(200);
    expect(body.data.page).toBe(2);
    expect(body.data.page_size).toBe(24);
    expect(body.data.total).toBe(60);
    expect(body.data.has_more).toBe(true); // 2*24=48 < 60
    expect(body.data.teams).toHaveLength(1);

    // skip = (page-1)*pageSize, limit = pageSize
    expect(calls.skip).toBe(24);
    expect(calls.limit).toBe(24);
    // search builds a case-insensitive $or over name/slug/description/owner_id.
    // The clauses hold RegExp objects (which JSON.stringify flattens to {}),
    // so assert on the structure + the compiled regex source/flags directly.
    const and = (calls.query as { $and?: Array<{ $or?: Array<Record<string, RegExp>> }> })?.$and;
    const orClause = and?.find((clause) => Array.isArray(clause.$or))?.$or;
    expect(orClause).toBeDefined();
    const fields = orClause!.map((entry) => Object.keys(entry)[0]);
    expect(fields).toEqual(["name", "slug", "description", "owner_id"]);
    const nameRx = orClause!.find((entry) => entry.name)!.name;
    expect(nameRx).toBeInstanceOf(RegExp);
    expect(nameRx.source).toBe("alp");
    expect(nameRx.flags).toContain("i");
  });

  it("returns the full list (no pagination fields) when `page` is absent", async () => {
    seedTeamsCollection([teamRow("alpha"), teamRow("beta")], 2);

    const { response, body } = await callGet("/api/admin/teams");

    expect(response.status).toBe(200);
    expect(body.data.teams).toHaveLength(2);
    expect(body.data.total).toBe(2);
    // The legacy (unpaginated) envelope omits page / page_size / has_more.
    expect(body.data.page).toBeUndefined();
    expect(body.data.has_more).toBeUndefined();
  });

  it("filters out archived teams by default", async () => {
    const { calls } = seedTeamsCollection([], 0);

    await callGet("/api/admin/teams");

    const and = (calls.query as { $and?: Array<Record<string, unknown>> })?.$and;
    expect(and).toContainEqual({ status: { $ne: "archived" } });
  });

  it("includes archived teams when include_archived=true", async () => {
    const { calls } = seedTeamsCollection([], 0);

    await callGet("/api/admin/teams?include_archived=true");

    const and = (calls.query as { $and?: Array<Record<string, unknown>> })?.$and;
    expect(and ?? []).not.toContainEqual({ status: { $ne: "archived" } });
  });

  it("filters a user preview to teams visible to the selected user", async () => {
    const { calls } = seedTeamsCollection([teamRow("platform")], 1);
    mockListOpenFgaObjects.mockImplementation(
      async (query: { user: string; relation: string }) => ({
        objects:
          query.user === "user:preview-user" && query.relation === "member"
            ? ["team:platform"]
            : [],
      }),
    );

    const { response } = await callGet(
      "/api/admin/teams?page=1&simulate_type=user&simulate_id=preview-user",
    );

    expect(response.status).toBe(200);
    expect(mockListOpenFgaObjects).toHaveBeenCalledWith({
      user: "user:preview-user",
      relation: "member",
      type: "team",
    });
    const and = (calls.query as { $and?: Array<Record<string, unknown>> }).$and;
    expect(and).toContainEqual({ slug: { $in: ["platform"] } });
  });

  it("keeps the full team list for an organization-admin preview", async () => {
    const { calls } = seedTeamsCollection([teamRow("platform")], 1);
    mockCheckOpenFgaTuple.mockImplementation(
      async (tuple: { user: string; relation: string; object: string }) => ({
        allowed:
          (tuple.user === "user:admin-sub" && tuple.relation === "can_manage")
          || (
            tuple.user === "user:target-admin"
            && tuple.relation === "can_manage"
            && tuple.object === "admin_surface:teams"
          ),
      }),
    );

    const { response } = await callGet(
      "/api/admin/teams?page=1&simulate_type=user&simulate_id=target-admin",
    );

    expect(response.status).toBe(200);
    const and = (calls.query as { $and?: Array<Record<string, unknown>> }).$and ?? [];
    expect(and).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: expect.anything() }),
    ]));
    expect(mockListOpenFgaObjects).not.toHaveBeenCalled();
  });

  it("keeps Everyone read-only for a scoped team admin", async () => {
    seedTeamsCollection([teamRow("everyone"), teamRow("platform")], 2);
    mockGetServerSession.mockResolvedValue({
      user: { email: "member@example.com", name: "Member" },
      role: "user",
      sub: "member-sub",
      accessToken: accessTokenWithRoles(["chat_user"]),
    });
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    mockListOpenFgaObjects.mockImplementation(
      async (query: { relation: string }) => ({
        objects:
          query.relation === "member" || query.relation === "admin"
            ? ["team:everyone", "team:platform"]
            : [],
      }),
    );

    const { body } = await callGet("/api/admin/teams?page=1&page_size=24");
    const bySlug = new Map(
      body.data.teams.map((team: { slug: string; can_manage: boolean }) => [
        team.slug,
        team.can_manage,
      ]),
    );

    expect(bySlug.get("everyone")).toBe(false);
    expect(bySlug.get("platform")).toBe(true);
  });
});
