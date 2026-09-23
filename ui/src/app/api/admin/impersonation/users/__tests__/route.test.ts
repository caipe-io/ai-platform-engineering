/** @jest-environment node */

import { NextRequest } from "next/server";

const mockGetAuth = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockSearchRealmUsers = jest.fn();
const mockGetUserFederatedIdentities = jest.fn();
const mockListIdpAliases = jest.fn();
const mockExtractGroups = jest.fn((claims: { groups?: unknown }) => (
  Array.isArray(claims.groups) ? claims.groups.map(String) : []
));
const mockHasRequiredGroup = jest.fn(() => true);

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuth(...args),
  requireRbacPermission: (...args: unknown[]) => mockRequireRbacPermission(...args),
  withErrorHandler: (handler: unknown) => handler,
}));

jest.mock("@/lib/auth-config", () => ({
  extractGroups: (...args: unknown[]) => mockExtractGroups(...args),
  hasRequiredGroup: (...args: unknown[]) => mockHasRequiredGroup(...args),
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  searchRealmUsers: (...args: unknown[]) => mockSearchRealmUsers(...args),
  getUserFederatedIdentities: (...args: unknown[]) => mockGetUserFederatedIdentities(...args),
  listIdpAliases: (...args: unknown[]) => mockListIdpAliases(...args),
}));

import { GET } from "../route";

describe("GET /api/admin/impersonation/users", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuth.mockResolvedValue({
      session: {
        sub: "admin-sub",
        user: { email: "admin@example.com" },
      },
    });
    mockRequireRbacPermission.mockResolvedValue(undefined);
    mockGetUserFederatedIdentities.mockResolvedValue([
      { identityProvider: "example-idp", userId: "external-user", userName: "target@example.com" },
    ]);
    mockListIdpAliases.mockResolvedValue([
      { alias: "example-idp", providerId: "oidc", enabled: true },
    ]);
  });

  it("returns only enabled human targets and excludes the current actor", async () => {
    mockSearchRealmUsers.mockResolvedValue([
      {
        id: "target-sub",
        username: "target-user",
        email: "target@example.com",
        firstName: "Target",
        lastName: "User",
        enabled: true,
      },
      {
        id: "disabled-sub",
        username: "disabled-user",
        email: "disabled@example.com",
        enabled: false,
      },
      {
        id: "service-sub",
        username: "service-account-example",
        email: "service@example.com",
        enabled: true,
        serviceAccountClientId: "example-client",
      },
      {
        id: "admin-sub",
        username: "admin-user",
        email: "admin@example.com",
        enabled: true,
      },
    ]);

    const response = await GET(new NextRequest(
      "http://localhost:3000/api/admin/impersonation/users?search=target&pageSize=25",
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireRbacPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "admin-sub" }),
      "admin_ui",
      "admin",
    );
    expect(mockSearchRealmUsers).toHaveBeenCalledWith({
      search: "target",
      enabled: true,
      first: 0,
      max: 25,
    });
    expect(mockGetUserFederatedIdentities).toHaveBeenCalledWith("target-sub");
    expect(body.users).toEqual([
      {
        id: "target-sub",
        name: "Target User",
        email: "target@example.com",
        username: "target-user",
      },
    ]);
  });

  it("excludes Keycloak shell users that have not linked an identity provider", async () => {
    mockSearchRealmUsers.mockResolvedValue([
      {
        id: "shell-sub",
        username: "shell-user",
        email: "shell@example.com",
        enabled: true,
      },
    ]);
    mockGetUserFederatedIdentities.mockResolvedValue([]);

    const response = await GET(new NextRequest(
      "http://localhost:3000/api/admin/impersonation/users?pageSize=25",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ users: [] });
  });
});
