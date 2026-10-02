const mockEnsurePermissions = jest.fn();
const mockGetRealmUser = jest.fn();
const mockGetUserFederatedIdentities = jest.fn();
const mockListIdpAliases = jest.fn();
const mockDecodeJwt = jest.fn();

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  ensureUiUserImpersonationPermissions: (...args: unknown[]) => mockEnsurePermissions(...args),
  getRealmUserByIdOrNull: (...args: unknown[]) => mockGetRealmUser(...args),
  getUserFederatedIdentities: (...args: unknown[]) => mockGetUserFederatedIdentities(...args),
  listIdpAliases: (...args: unknown[]) => mockListIdpAliases(...args),
}));

jest.mock("jose", () => ({
  decodeJwt: (...args: unknown[]) => mockDecodeJwt(...args),
}));

import { mintImpersonatedUserToken } from "../user-impersonation";

describe("user impersonation token exchange", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.KEYCLOAK_URL = "https://identity.example.test";
    process.env.KEYCLOAK_REALM = "example";
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = "platform-client";
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = "client-secret";
    process.env.CAIPE_PLATFORM_AUDIENCE = "platform-api";
    mockEnsurePermissions.mockResolvedValue(undefined);
    mockGetUserFederatedIdentities.mockResolvedValue([
      { identityProvider: "example-idp", userId: "external-user", userName: "test-user@example.com" },
    ]);
    mockListIdpAliases.mockResolvedValue([
      { alias: "example-idp", providerId: "oidc", enabled: true },
    ]);
    mockGetRealmUser.mockResolvedValue({
      id: "target-sub",
      username: "test-user",
      email: "test-user@example.com",
      firstName: "Test",
      lastName: "User",
      enabled: true,
      attributes: { idp_groups: ["Everyone"] },
    });
    mockDecodeJwt.mockReturnValue({ sub: "target-sub", exp: 2_000_000_000 });
    global.fetch = jest.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/token")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ access_token: "exchanged-token", expires_in: 300 }),
        });
      }
      if (url.endsWith("/userinfo")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sub: "target-sub", groups: ["Everyone"] }),
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as jest.Mock;
  });

  afterEach(() => {
    delete process.env.KEYCLOAK_URL;
    delete process.env.KEYCLOAK_REALM;
    delete process.env.KEYCLOAK_ADMIN_CLIENT_ID;
    delete process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
    delete process.env.CAIPE_PLATFORM_AUDIENCE;
  });

  it("mints a bearer for an enabled human user", async () => {
    await expect(mintImpersonatedUserToken("target-sub")).resolves.toMatchObject({
      accessToken: "exchanged-token",
      expiresAt: 2_000_000_000,
      target: {
        sub: "target-sub",
        name: "Test User",
        email: "test-user@example.com",
      },
      claims: {
        sub: "target-sub",
        groups: ["Everyone"],
      },
    });
    expect(mockEnsurePermissions).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      "https://identity.example.test/realms/example/protocol/openid-connect/token",
      expect.objectContaining({ method: "POST" }),
    );
    const request = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = new URLSearchParams(String(request.body));
    expect(body.get("requested_subject")).toBe("target-sub");
    expect(body.get("audience")).toBe("platform-api");
    expect(body.get("scope")).toContain("groups");
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://identity.example.test/realms/example/protocol/openid-connect/userinfo",
      { headers: { Authorization: "Bearer exchanged-token" } },
    );
  });

  it("falls back to the target's imported groups when userinfo omits them", async () => {
    (global.fetch as jest.Mock).mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/token")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ access_token: "exchanged-token", expires_in: 300 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ sub: "target-sub" }),
      });
    });

    await expect(mintImpersonatedUserToken("target-sub")).resolves.toMatchObject({
      claims: { groups: ["Everyone"] },
    });
  });

  it.each([
    [{ enabled: false }, "enabled human user"],
    [{ serviceAccountClientId: "machine-client" }, "enabled human user"],
  ])("rejects ineligible targets", async (override, message) => {
    mockGetRealmUser.mockResolvedValue({
      id: "target-sub",
      username: "test-user",
      email: "test-user@example.com",
      enabled: true,
      ...override,
    });

    await expect(mintImpersonatedUserToken("target-sub")).rejects.toThrow(message);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects an unlinked Keycloak shell before token exchange", async () => {
    mockGetUserFederatedIdentities.mockResolvedValue([]);

    await expect(mintImpersonatedUserToken("target-sub")).rejects.toThrow(
      "linked to an identity provider",
    );
    expect(mockEnsurePermissions).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a token issued for a different subject", async () => {
    mockDecodeJwt.mockReturnValue({ sub: "different-sub", exp: 2_000_000_000 });

    await expect(mintImpersonatedUserToken("target-sub")).rejects.toThrow(
      "wrong subject",
    );
  });
});
