/**
 * @jest-environment node
 *
 * Issue #1509 regression suite — scoped team admins (members with
 * role=owner|admin) must be able to edit, delete, and reconfigure their
 * OWN team without holding the platform-wide `organization:<org>#admin`
 * tuple. Non-team-admin users editing the same team must still get 403.
 */

import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";

const mockGetServerSession = jest.fn();
const mockCheckPermission = jest.fn();

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

jest.mock("@/lib/rbac/audit", () => ({
  logAuthzDecision: jest.fn(),
}));

const mockListOpenFgaObjects = jest.fn(async () => ({ objects: [] as string[] }));
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: jest.fn(async () => ({ allowed: false })),
  writeOpenFgaTuples: jest.fn(async () => ({ enabled: true, writes: 0, deletes: 0 })),
  writeOpenFgaTupleDiff: jest.fn(async () => ({ enabled: true, writes: 0, deletes: 0 })),
  buildTeamResourceTupleDiff: jest.fn(() => ({ writes: [], deletes: [] })),
  isOpenFgaConfigured: jest.fn(() => true),
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...(args as [])),
  TEAM_TOOL_WILDCARD_SENTINEL_OBJECT: "tool:*",
  teamToolWildcardSentinelTuple: (slug: string) => ({
    user: `team:${slug}#member`,
    relation: "caller",
    object: "tool:*",
  }),
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  findUserIdByEmail: jest.fn(async () => null),
  assignRealmRolesToUser: jest.fn(async () => undefined),
  removeRealmRolesFromUser: jest.fn(async () => undefined),
  ensureRealmRole: jest.fn(async (name: string) => ({ id: `role-${name}`, name })),
  listRealmRoles: jest.fn(async () => []),
  isValidTeamSlug: jest.fn((slug: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)),
}));

jest.mock("@/lib/rbac/team-membership-source-store", () => ({
  listTeamMembershipSources: jest.fn(async () => []),
}));

jest.mock("@/lib/rbac/team-openfga-sync-status", () => ({
  computeTeamMembershipSyncReport: jest.fn(() => null),
  readTeamOpenFgaTuples: jest.fn(async () => []),
}));

const mockCollections: Record<string, ReturnType<typeof createMockCollection>> = {};

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async (name: string) => mockCollections[name] ?? createMockCollection([])),
}));

const TEAM_ID = "507f1f77bcf86cd799439011";
const TEAM_DOC = {
  _id: new ObjectId(TEAM_ID),
  slug: "platform",
  name: "Platform",
  description: "the platform team",
  owner_id: "owner@example.com",
  members: [
    { user_id: "owner@example.com", role: "owner", added_at: new Date(), added_by: "owner@example.com" },
    { user_id: "team-admin@example.com", role: "admin", added_at: new Date(), added_by: "owner@example.com" },
    { user_id: "regular-member@example.com", role: "member", added_at: new Date(), added_by: "owner@example.com" },
  ],
  keycloak_roles: ["chat_user"],
  resources: { agents: [], agent_admins: [], tools: [], tool_wildcard: false },
};

function seedCanonicalMembers(
  rows: Array<{ user_email: string; relationship: "member" | "admin" }>,
  teamSlug = TEAM_DOC.slug,
) {
  const fixtureRows = rows.map((row) => ({
    team_id: TEAM_ID,
    team_slug: teamSlug,
    user_email: row.user_email,
    relationship: row.relationship,
    source_type: "manual",
    status: "active",
  }));
  const collection = createMockCollection(fixtureRows);
  collection.find = jest.fn((filter: Record<string, unknown> = {}) => {
    const filteredRows = fixtureRows.filter((row) => {
      if (filter.team_slug && row.team_slug !== filter.team_slug) return false;
      if (filter.status && row.status !== filter.status) return false;
      const clauses = Array.isArray(filter.$or) ? (filter.$or as Array<Record<string, unknown>>) : [];
      if (clauses.length === 0) return true;
      return clauses.some((clause) =>
        Object.entries(clause).every(([key, value]) => row[key as keyof typeof row] === value)
      );
    });
    return {
      sort: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue(filteredRows),
    };
  });
  mockCollections.team_membership_sources = collection;
}

function createMockCollection(rows: Array<Record<string, unknown>>) {
  return {
    rows,
    find: jest.fn(() => ({
      sort: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue(rows),
    })),
    findOne: jest.fn(async (filter: Record<string, unknown> = {}) => {
      if (filter._id) {
        return rows.find((r) => String((r as { _id?: unknown })._id) === String(filter._id)) ?? null;
      }
      if (filter.name) {
        return rows.find((r) => (r as { name?: unknown }).name === filter.name) ?? null;
      }
      return null;
    }),
    insertOne: jest.fn(async () => ({ insertedId: new ObjectId() })),
    updateOne: jest.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    updateMany: jest.fn(async () => ({ matchedCount: 0, modifiedCount: 0 })),
    deleteOne: jest.fn(async () => ({ deletedCount: 1 })),
  };
}

function accessTokenWithRoles(roles: string[]): string {
  const payload = Buffer.from(JSON.stringify({ realm_access: { roles } }), "utf8").toString("base64url");
  return `h.${payload}.s`;
}

function session(email: string, role: "admin" | "user" = "user") {
  return {
    user: { email, name: email },
    role,
    accessToken: accessTokenWithRoles(role === "admin" ? ["admin"] : ["chat_user"]),
  };
}

function makeRequest(url: string, options: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), options);
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: the team owns no service accounts (FR-025 guard passes).
  mockListOpenFgaObjects.mockResolvedValue({ objects: [] });
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
  // Fresh deep-cloned team doc so PATCH/updateOne side effects don't leak.
  mockCollections.teams = createMockCollection([{ ...TEAM_DOC }]);
  mockCollections.conversations = createMockCollection([]);
  seedCanonicalMembers([
    { user_email: "owner@example.com", relationship: "admin" },
    { user_email: "team-admin@example.com", relationship: "admin" },
    { user_email: "regular-member@example.com", relationship: "member" },
  ]);
  // Default: platform-admin path denies. Scoped team admins must reach the
  // route purely through `isScopedTeamAdmin` inside team-admin-guards.
  mockCheckPermission.mockResolvedValue({ allowed: false, reason: "DENY_NO_CAPABILITY" });
});

const makeContext = () => ({ params: Promise.resolve({ id: TEAM_ID }) });

describe("PATCH /api/admin/teams/[id] (issue #1509)", () => {
  it("allows scoped team admins to rename their own team", async () => {
    mockGetServerSession.mockResolvedValue(session("team-admin@example.com"));
    const { PATCH } = await import("../route");

    const response = await PATCH(
      makeRequest(`/api/admin/teams/${TEAM_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Platform (renamed)", description: "still us" }),
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockCollections.teams.updateOne).toHaveBeenCalledWith(
      { _id: expect.anything() },
      expect.objectContaining({
        $set: expect.objectContaining({
          name: "Platform (renamed)",
          description: "still us",
        }),
      })
    );
  });

  it("denies regular members editing their own team", async () => {
    mockGetServerSession.mockResolvedValue(session("regular-member@example.com"));
    const { PATCH } = await import("../route");

    const response = await PATCH(
      makeRequest(`/api/admin/teams/${TEAM_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "hostile takeover" }),
      }),
      makeContext()
    );

    expect(response.status).toBe(403);
    expect(mockCollections.teams.updateOne).not.toHaveBeenCalled();
  });

  it("does not let a scoped team admin edit the reserved Everyone team", async () => {
    mockCollections.teams = createMockCollection([{ ...TEAM_DOC, slug: "everyone", name: "Everyone" }]);
    seedCanonicalMembers(
      [{ user_email: "team-admin@example.com", relationship: "admin" }],
      "everyone",
    );
    mockGetServerSession.mockResolvedValue(session("team-admin@example.com"));
    const { PATCH } = await import("../route");

    const response = await PATCH(
      makeRequest(`/api/admin/teams/${TEAM_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Changed by team admin" }),
      }),
      makeContext(),
    );

    expect(response.status).toBe(403);
    expect(mockCollections.teams.updateOne).not.toHaveBeenCalled();
  });

  it("allows a platform admin to edit the reserved Everyone team", async () => {
    mockCollections.teams = createMockCollection([{ ...TEAM_DOC, slug: "everyone", name: "Everyone" }]);
    mockGetServerSession.mockResolvedValue(session("admin@example.com", "admin"));
    const { PATCH } = await import("../route");

    const response = await PATCH(
      makeRequest(`/api/admin/teams/${TEAM_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Updated defaults" }),
      }),
      makeContext(),
    );

    expect(response.status).toBe(200);
  });
});

describe("DELETE /api/admin/teams/[id] (issue #1509)", () => {
  it("allows scoped team admins to delete their own team", async () => {
    mockGetServerSession.mockResolvedValue(session("team-admin@example.com"));
    const { DELETE } = await import("../route");

    const response = await DELETE(
      makeRequest(`/api/admin/teams/${TEAM_ID}`, { method: "DELETE" }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockCollections.teams.deleteOne).toHaveBeenCalledWith({ _id: expect.anything() });
  });

  it("denies regular members from deleting their own team", async () => {
    mockGetServerSession.mockResolvedValue(session("regular-member@example.com"));
    const { DELETE } = await import("../route");

    const response = await DELETE(
      makeRequest(`/api/admin/teams/${TEAM_ID}`, { method: "DELETE" }),
      makeContext()
    );

    expect(response.status).toBe(403);
    expect(mockCollections.teams.deleteOne).not.toHaveBeenCalled();
  });

  it("blocks deletion while the team still owns service accounts (FR-025)", async () => {
    mockGetServerSession.mockResolvedValue(session("team-admin@example.com"));
    mockListOpenFgaObjects.mockResolvedValue({
      objects: ["service_account:sa-1", "service_account:sa-2"],
    });
    const { DELETE } = await import("../route");

    const response = await DELETE(
      makeRequest(`/api/admin/teams/${TEAM_ID}`, { method: "DELETE" }),
      makeContext()
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("TEAM_OWNS_SERVICE_ACCOUNTS");
    // The guard queries OpenFGA with the team's owner_team relation.
    expect(mockListOpenFgaObjects).toHaveBeenCalledWith({
      user: `team:${TEAM_DOC.slug}#member`,
      relation: "owner_team",
      type: "service_account",
    });
    // The team is NOT deleted.
    expect(mockCollections.teams.deleteOne).not.toHaveBeenCalled();
  });

  it("fails closed (503) when the ownership check errors", async () => {
    mockGetServerSession.mockResolvedValue(session("team-admin@example.com"));
    mockListOpenFgaObjects.mockRejectedValue(new Error("openfga down"));
    const { DELETE } = await import("../route");

    const response = await DELETE(
      makeRequest(`/api/admin/teams/${TEAM_ID}`, { method: "DELETE" }),
      makeContext()
    );

    expect(response.status).toBe(503);
    expect(mockCollections.teams.deleteOne).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/teams/[id]/roles (issue #1509)", () => {
  it("allows scoped team admins to update realm roles on their own team", async () => {
    mockGetServerSession.mockResolvedValue(session("team-admin@example.com"));
    const { PUT } = await import("../roles/route");

    const response = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: ["chat_user", "skill_user"] }),
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockCollections.teams.updateOne).toHaveBeenCalledWith(
      { _id: expect.anything() },
      expect.objectContaining({
        $set: expect.objectContaining({
          keycloak_roles: ["chat_user", "skill_user"],
        }),
      })
    );
  });

  it("denies regular members from updating realm roles", async () => {
    mockGetServerSession.mockResolvedValue(session("regular-member@example.com"));
    const { PUT } = await import("../roles/route");

    const response = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: ["admin"] }),
      }),
      makeContext()
    );

    expect(response.status).toBe(403);
    expect(mockCollections.teams.updateOne).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/teams/[id]/resources (issue #1509)", () => {
  it("allows scoped team admins to update agent/tool resource grants", async () => {
    mockGetServerSession.mockResolvedValue(session("team-admin@example.com"));
    const { PUT } = await import("../resources/route");

    const response = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agents: ["argocd"],
          agent_admins: [],
          tools: ["argocd:list"],
          tool_wildcard: false,
        }),
      }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(mockCollections.teams.updateOne).toHaveBeenCalled();
  });

  it("denies regular members from updating resource grants", async () => {
    mockGetServerSession.mockResolvedValue(session("regular-member@example.com"));
    const { PUT } = await import("../resources/route");

    const response = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agents: ["argocd"],
          agent_admins: [],
          tools: [],
          tool_wildcard: true,
        }),
      }),
      makeContext()
    );

    expect(response.status).toBe(403);
    expect(mockCollections.teams.updateOne).not.toHaveBeenCalled();
  });
});
