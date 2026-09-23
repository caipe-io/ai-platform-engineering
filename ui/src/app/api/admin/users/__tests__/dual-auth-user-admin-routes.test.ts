/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockCheckPermission = jest.fn();
const mockGetRealmUserById = jest.fn();
const mockGetRoleByName = jest.fn();
const mockAssignRealmRolesToUser = jest.fn();
const mockRemoveRealmRolesFromUser = jest.fn();
const mockDeleteRealmUser = jest.fn();
const mockListRealmRoleMappingsForUser = jest.fn();
const mockGetUserSessions = jest.fn();
const mockGetUserFederatedIdentities = jest.fn();
const mockGetCollection = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
const mockReadOpenFgaTuples = jest.fn();
const mockDeleteExactOpenFgaTuples = jest.fn();

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(async () => null),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: "",
}));

jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => key === "ssoEnabled",
}));

jest.mock("@/lib/jwt-validation", () => ({
  validateLocalSkillsJWT: jest.fn(async () => null),
  validateBearerJWT: jest.fn(async () => ({
    sub: "bob-sub",
    email: "bob@example.com",
    name: "Bob Chat User",
  })),
}));

jest.mock("@/lib/rbac/keycloak-authz", () => ({
  checkPermission: (...args: unknown[]) => mockCheckPermission(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
  deleteExactOpenFgaTuples: (...args: unknown[]) => mockDeleteExactOpenFgaTuples(...args),
}));

jest.mock("@/lib/rbac/audit", () => ({
  logAuthzDecision: jest.fn(),
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  getRealmUserById: (...args: unknown[]) => mockGetRealmUserById(...args),
  deleteRealmUser: (...args: unknown[]) => mockDeleteRealmUser(...args),
  getRoleByName: (...args: unknown[]) => mockGetRoleByName(...args),
  assignRealmRolesToUser: (...args: unknown[]) => mockAssignRealmRolesToUser(...args),
  removeRealmRolesFromUser: (...args: unknown[]) => mockRemoveRealmRolesFromUser(...args),
  searchRealmUsers: jest.fn(),
  countRealmUsers: jest.fn(),
  listUsersWithRole: jest.fn(),
  listRealmRoleMappingsForUser: (...args: unknown[]) => mockListRealmRoleMappingsForUser(...args),
  getUserSessions: (...args: unknown[]) => mockGetUserSessions(...args),
  getUserFederatedIdentities: (...args: unknown[]) => mockGetUserFederatedIdentities(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

function request(path: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    ...init,
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function expectDenied(response: Response, capability: string): Promise<void> {
  const body = await response.json();
  expect(response.status).toBe(403);
  expect(body.reason).toBe("pdp_denied");
  expect(body.code).toBe(capability);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckPermission.mockResolvedValue({ allowed: false, reason: "DENY_NO_CAPABILITY" });
  mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
    allowed:
      tuple.user === "user:bob-sub" &&
      tuple.relation === "can_read" &&
      (tuple.object === "admin_surface:users" || tuple.object === "user_profile:bob-sub"),
  }));
  mockGetRealmUserById.mockResolvedValue({
    id: "bob-sub",
    username: "bob@example.com",
    email: "bob@example.com",
    enabled: true,
    attributes: {},
  });
  mockListRealmRoleMappingsForUser.mockResolvedValue([]);
  mockGetUserSessions.mockResolvedValue([]);
  mockGetUserFederatedIdentities.mockResolvedValue([]);
  mockReadOpenFgaTuples.mockResolvedValue({ tuples: [], continuationToken: undefined });
  mockDeleteExactOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 0, deletes: 0 });
  mockDeleteRealmUser.mockResolvedValue(undefined);
  mockGetCollection.mockResolvedValue({
    find: jest.fn().mockReturnValue({
      project: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    }),
    countDocuments: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    findOne: jest.fn().mockResolvedValue({ email: "alice@example.com" }),
  });
});

describe("admin user sibling routes dual-auth PDP gates", () => {
  it("returns selected membership provenance without leaking arbitrary source fields", async () => {
    const { GET } = await import("../[id]/route");
    mockGetCollection.mockResolvedValue({ find: jest.fn().mockReturnValue({ project: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { team_slug: "example-team", team_id: "example", relationship: "member", source_type: "oidc_claim", provider_id: "primary", external_group_id: "example-group", user_subject: "old-subject", private_field: "must-not-leak" },
      ]),
    }) }) });
    const response = await GET(request("/api/admin/users/bob-sub"), { params: Promise.resolve({ id: "bob-sub" }) });
    const { data } = await response.json();
    expect(data.user.membershipSourcesAvailable).toBe(true);
    expect(data.user.membershipSources).toEqual([{ team: "example-team", relationship: "member", source: "oidc_claim", provider: "primary", externalGroup: "example-group", subject: "old-subject" }]);
    expect(JSON.stringify(data)).not.toContain("must-not-leak");
  });
  it("returns only the caller's own user row without admin_ui#view", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/users?page=1&pageSize=20", { method: "GET" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.users).toEqual([
      expect.objectContaining({
        id: "bob-sub",
        email: "bob@example.com",
      }),
    ]);
    expect(body.total).toBe(1);
    expect(mockGetRealmUserById).toHaveBeenCalledWith("bob-sub");
  });

  it("allows a bearer user without admin_ui#view to open their own user details", async () => {
    const { GET } = await import("../[id]/route");

    const response = await GET(
      request("/api/admin/users/bob-sub", { method: "GET" }),
      { params: Promise.resolve({ id: "bob-sub" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.user).toEqual(expect.objectContaining({
      id: "bob-sub",
      email: "bob@example.com",
    }));
    expect(mockGetRealmUserById).toHaveBeenCalledWith("bob-sub");
  });

  it("denies a bearer user without admin_ui#view from opening another user's details", async () => {
    const { GET } = await import("../[id]/route");

    const response = await GET(
      request("/api/admin/users/alice-sub", { method: "GET" }),
      { params: Promise.resolve({ id: "alice-sub" }) }
    );

    await expectDenied(response, "user_profile:alice-sub#can_read");
    expect(mockGetRealmUserById).not.toHaveBeenCalledWith("alice-sub");
  });

  it("allows an admin with users#can_manage to open another user's details", async () => {
    // Org/super admins hold can_manage on the users surface; that authorizes
    // reading any user's profile (the user_profile object is self-read only).
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:bob-sub" &&
        tuple.relation === "can_manage" &&
        tuple.object === "admin_surface:users",
    }));
    mockGetRealmUserById.mockResolvedValue({
      id: "alice-sub",
      username: "alice@example.com",
      email: "alice@example.com",
      enabled: true,
      attributes: {},
    });

    const { GET } = await import("../[id]/route");
    const response = await GET(
      request("/api/admin/users/alice-sub", { method: "GET" }),
      { params: Promise.resolve({ id: "alice-sub" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.user).toEqual(expect.objectContaining({ id: "alice-sub" }));
    expect(mockGetRealmUserById).toHaveBeenCalledWith("alice-sub");
  });

  it("requires admin_surface users read even when organization admin view is allowed", async () => {
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:bob-sub" &&
        tuple.relation === "can_audit" &&
        tuple.object === "organization:caipe",
    }));
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/users?page=1&pageSize=20", { method: "GET" }));

    await expectDenied(response, "admin_surface:users#can_read");
  });

  it("denies bearer users without admin_ui#admin before mutating team membership", async () => {
    const { POST } = await import("../[id]/teams/route");

    const response = await POST(
      request("/api/admin/users/user-1/teams", {
        method: "POST",
        body: JSON.stringify({ teamId: "team-1" }),
      }),
      { params: Promise.resolve({ id: "user-1" }) }
    );

    await expectDenied(response, "admin_ui#admin");
    expect(mockGetRealmUserById).not.toHaveBeenCalled();
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("denies bearer users without admin_ui#admin before assigning realm roles", async () => {
    const { POST } = await import("../[id]/roles/route");

    const response = await POST(
      request("/api/admin/users/user-1/roles", {
        method: "POST",
        body: JSON.stringify({ roles: [{ name: "admin" }] }),
      }),
      { params: Promise.resolve({ id: "user-1" }) }
    );

    await expectDenied(response, "admin_ui#admin");
    expect(mockGetRoleByName).not.toHaveBeenCalled();
    expect(mockAssignRealmRolesToUser).not.toHaveBeenCalled();
  });

  it("denies bearer users without admin_ui#admin before removing realm roles", async () => {
    const { DELETE } = await import("../[id]/roles/route");

    const response = await DELETE(
      request("/api/admin/users/user-1/roles", {
        method: "DELETE",
        body: JSON.stringify({ roles: [{ name: "admin" }] }),
      }),
      { params: Promise.resolve({ id: "user-1" }) }
    );

    await expectDenied(response, "admin_ui#admin");
    expect(mockGetRoleByName).not.toHaveBeenCalled();
    expect(mockRemoveRealmRolesFromUser).not.toHaveBeenCalled();
  });

  it("denies bearer users without admin_ui#admin before deleting a user", async () => {
    const { DELETE } = await import("../[id]/route");

    const response = await DELETE(
      request("/api/admin/users/user-1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "user-1" }) }
    );

    await expectDenied(response, "admin_ui#admin");
    expect(mockGetRealmUserById).not.toHaveBeenCalledWith("user-1");
    expect(mockDeleteRealmUser).not.toHaveBeenCalled();
  });

  it("rejects deleting the current session user", async () => {
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:bob-sub" &&
        tuple.relation === "can_manage" &&
        tuple.object === "organization:caipe",
    }));
    const { DELETE } = await import("../[id]/route");

    const response = await DELETE(
      request("/api/admin/users/bob-sub", { method: "DELETE" }),
      { params: Promise.resolve({ id: "bob-sub" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("CURRENT_USER_DELETE_FORBIDDEN");
    expect(mockDeleteRealmUser).not.toHaveBeenCalled();
  });

  it("deletes a user and cleans user-subject OpenFGA and membership-source rows", async () => {
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user: string; relation: string; object: string }) => ({
      allowed:
        tuple.user === "user:bob-sub" &&
        tuple.relation === "can_manage" &&
        tuple.object === "organization:caipe",
    }));
    mockGetRealmUserById.mockResolvedValue({
      id: "alice-sub",
      username: "alice@example.com",
      email: "alice@example.com",
      enabled: true,
      attributes: {},
    });
    const membershipSources = {
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
    };
    const users = {
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "team_membership_sources") return membershipSources;
      if (name === "users") return users;
      return {
        find: jest.fn().mockReturnValue({
          project: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
        }),
        updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
      };
    });
    mockReadOpenFgaTuples
      .mockResolvedValueOnce({
        tuples: [
          { key: { user: "user:alice-sub", relation: "member", object: "organization:caipe" } },
          { key: { user: "user:alice-sub", relation: "member", object: "team:ops" } },
        ],
        continuationToken: "next",
      })
      .mockResolvedValueOnce({
        tuples: [
          { key: { user: "user:alice-sub", relation: "caller", object: "mcp_gateway:list" } },
        ],
        continuationToken: undefined,
      });

    const { DELETE } = await import("../[id]/route");
    const response = await DELETE(
      request("/api/admin/users/alice-sub", { method: "DELETE" }),
      { params: Promise.resolve({ id: "alice-sub" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual(expect.objectContaining({
      id: "alice-sub",
      deleted: true,
      openfga_tuples_deleted: 3,
      membership_sources_removed: 2,
    }));
    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith({
      continuationToken: undefined,
      pageSize: 100,
    });
    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith({
      continuationToken: "next",
      pageSize: 100,
    });
    expect(mockDeleteExactOpenFgaTuples).toHaveBeenCalledWith([
      { user: "user:alice-sub", relation: "member", object: "organization:caipe" },
      { user: "user:alice-sub", relation: "member", object: "team:ops" },
      { user: "user:alice-sub", relation: "caller", object: "mcp_gateway:list" },
    ]);
    expect(membershipSources.updateMany).toHaveBeenCalled();
    expect(users.updateMany).toHaveBeenCalled();
    expect(mockDeleteRealmUser).toHaveBeenCalledWith("alice-sub");
  });

  it("denies bearer users without admin_ui#admin before updating legacy Mongo role", async () => {
    const { PATCH } = await import("../[id]/role/route");

    const response = await PATCH(
      request("/api/admin/users/user-1/role", {
        method: "PATCH",
        body: JSON.stringify({ role: "admin" }),
      }),
      { params: Promise.resolve({ id: "user-1" }) }
    );

    await expectDenied(response, "admin_ui#admin");
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed legacy Mongo role update JSON", async () => {
    mockCheckOpenFgaTuple.mockResolvedValueOnce({ allowed: true });
    const { PATCH } = await import("../[id]/role/route");

    const response = await PATCH(
      request("/api/admin/users/user-1/role", {
        method: "PATCH",
        body: "{",
      }),
      { params: Promise.resolve({ id: "user-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("allows activity stats with admin_surface users read instead of admin_ui view", async () => {
    const { GET } = await import("../stats/route");

    const response = await GET(request("/api/admin/users/stats", { method: "GET" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });
});
