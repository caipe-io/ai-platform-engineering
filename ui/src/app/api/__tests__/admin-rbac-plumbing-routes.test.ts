/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetServerSession = jest.fn();
const mockValidateBearerJWT = jest.fn();
const mockValidateLocalSkillsJWT = jest.fn();
const mockCheckPermission = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
const mockListRealmRoles = jest.fn();
const mockCreateRealmRole = jest.fn();
const mockGetRoleByName = jest.fn();
const mockDeleteRealmRole = jest.fn();
const mockListIdpAliases = jest.fn();
const mockListIdpMappers = jest.fn();
const mockCreateGroupRoleMapper = jest.fn();
const mockDeleteIdpMapper = jest.fn();
const mockListRealmUsersPage = jest.fn();
const mockGetRealmUserById = jest.fn();
const mockMergeUserAttributes = jest.fn();
const mockGetCollection = jest.fn();

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

jest.mock("@/lib/jwt-validation", () => ({
  validateBearerJWT: (...args: unknown[]) => mockValidateBearerJWT(...args),
  validateLocalSkillsJWT: (...args: unknown[]) => mockValidateLocalSkillsJWT(...args),
}));

jest.mock("@/lib/rbac/keycloak-authz", () => ({
  checkPermission: (...args: unknown[]) => mockCheckPermission(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

jest.mock("@/lib/rbac/audit", () => ({
  logAuthzDecision: jest.fn(),
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  BUILT_IN_ROLES: ["admin", "user"],
  listRealmRoles: (...args: unknown[]) => mockListRealmRoles(...args),
  createRealmRole: (...args: unknown[]) => mockCreateRealmRole(...args),
  getRoleByName: (...args: unknown[]) => mockGetRoleByName(...args),
  deleteRealmRole: (...args: unknown[]) => mockDeleteRealmRole(...args),
  listIdpAliases: (...args: unknown[]) => mockListIdpAliases(...args),
  listIdpMappers: (...args: unknown[]) => mockListIdpMappers(...args),
  createGroupRoleMapper: (...args: unknown[]) => mockCreateGroupRoleMapper(...args),
  deleteIdpMapper: (...args: unknown[]) => mockDeleteIdpMapper(...args),
  listRealmUsersPage: (...args: unknown[]) => mockListRealmUsersPage(...args),
  listRealmRoleMappingsForUser: jest.fn(),
  getRealmUserById: (...args: unknown[]) => mockGetRealmUserById(...args),
  mergeUserAttributes: (...args: unknown[]) => mockMergeUserAttributes(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  get isMongoDBConfigured() {
    return true;
  },
}));

jest.spyOn(console, "error").mockImplementation(() => {});
jest.spyOn(console, "log").mockImplementation(() => {});
jest.spyOn(console, "warn").mockImplementation(() => {});

import { GET as rolesGET, POST as rolesPOST } from "../admin/roles/route";
import { GET as roleGET, DELETE as roleDELETE } from "../admin/roles/[name]/route";
import {
  GET as roleMappingsGET,
  POST as roleMappingsPOST,
} from "../admin/role-mappings/route";
import { DELETE as roleMappingDELETE } from "../admin/role-mappings/[id]/route";
import { GET as slackUsersGET } from "../admin/slack/users/route";
import { DELETE as slackUserDELETE } from "../admin/slack/users/[id]/route";

function makeRequest(path: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

async function expectPdpDenied(
  responsePromise: Promise<Response>,
  capability: string,
): Promise<void> {
  const res = await responsePromise;
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.reason).toBe("pdp_denied");
  expect(body.code).toBe(capability);
}

describe("admin RBAC plumbing routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetServerSession.mockResolvedValue(null);
    mockValidateLocalSkillsJWT.mockResolvedValue(null);
    mockValidateBearerJWT.mockResolvedValue({
      email: "bob@example.com",
      name: "Bob Chat",
      sub: "bob-sub",
      org: "default",
    });
    mockCheckPermission.mockResolvedValue({
      allowed: false,
      reason: "DENY_NO_CAPABILITY",
    });
    mockCheckOpenFgaTuple.mockResolvedValue({
      allowed: false,
      reason: "DENY_NO_CAPABILITY",
    });
  });

  it("denies roles and role detail reads without admin_ui#view", async () => {
    await expectPdpDenied(
      rolesGET(makeRequest("/api/admin/roles", { headers: { Authorization: "Bearer bob" } })),
      "admin_ui#view",
    );
    await expectPdpDenied(
      roleGET(makeRequest("/api/admin/roles/custom", { headers: { Authorization: "Bearer bob" } }), {
        params: Promise.resolve({ name: "custom" }),
      }),
      "admin_ui#view",
    );
    expect(mockListRealmRoles).not.toHaveBeenCalled();
    expect(mockGetRoleByName).not.toHaveBeenCalled();
  });

  it("denies role mutations without admin_ui#admin", async () => {
    await expectPdpDenied(
      rolesPOST(makeRequest("/api/admin/roles", {
        method: "POST",
        headers: { Authorization: "Bearer bob" },
        body: JSON.stringify({ name: "custom" }),
      })),
      "admin_ui#admin",
    );
    await expectPdpDenied(
      roleDELETE(makeRequest("/api/admin/roles/custom", {
        method: "DELETE",
        headers: { Authorization: "Bearer bob" },
      }), { params: Promise.resolve({ name: "custom" }) }),
      "admin_ui#admin",
    );
    expect(mockCreateRealmRole).not.toHaveBeenCalled();
    expect(mockDeleteRealmRole).not.toHaveBeenCalled();
  });

  it("denies role mapping routes without their method scope", async () => {
    await expectPdpDenied(
      roleMappingsGET(makeRequest("/api/admin/role-mappings", {
        headers: { Authorization: "Bearer bob" },
      })),
      "admin_ui#view",
    );
    await expectPdpDenied(
      roleMappingsPOST(makeRequest("/api/admin/role-mappings", {
        method: "POST",
        headers: { Authorization: "Bearer bob" },
        body: JSON.stringify({ idpAlias: "okta", groupName: "dev", roleName: "admin" }),
      })),
      "admin_ui#admin",
    );
    await expectPdpDenied(
      roleMappingDELETE(makeRequest("/api/admin/role-mappings/mapper-1?alias=okta", {
        method: "DELETE",
        headers: { Authorization: "Bearer bob" },
      }), { params: Promise.resolve({ id: "mapper-1" }) }),
      "admin_ui#admin",
    );
    expect(mockListIdpAliases).not.toHaveBeenCalled();
    expect(mockCreateGroupRoleMapper).not.toHaveBeenCalled();
    expect(mockDeleteIdpMapper).not.toHaveBeenCalled();
  });

  it("denies Slack admin user routes without admin_ui#admin", async () => {
    await expectPdpDenied(
      slackUsersGET(makeRequest("/api/admin/slack/users", {
        headers: { Authorization: "Bearer bob" },
      })),
      "admin_ui#admin",
    );
    await expectPdpDenied(
      slackUserDELETE(makeRequest("/api/admin/slack/users/kc-user-1", {
        method: "DELETE",
        headers: { Authorization: "Bearer bob" },
      }), { params: Promise.resolve({ id: "kc-user-1" }) }),
      "admin_ui#admin",
    );
    expect(mockListRealmUsersPage).not.toHaveBeenCalled();
    expect(mockGetRealmUserById).not.toHaveBeenCalled();
    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

});
