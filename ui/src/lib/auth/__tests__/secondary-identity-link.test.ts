import { SecondaryIdentityClaimConflict } from "../secondary-identity-store";
import { linkSecondaryOidcIdentity } from "../secondary-identity-link";

const mockClaimSecondaryIdentity = jest.fn().mockResolvedValue(undefined);
jest.mock("../secondary-identity-store", () => ({ SecondaryIdentityClaimConflict: class extends Error {}, claimSecondaryIdentity: (...args: unknown[]) => mockClaimSecondaryIdentity(...args) }));

const mockAssertAdminOnly = jest.fn();
const mockFindRealmUserIdsByAttribute = jest.fn();
const mockGetRealmUserByIdOrNull = jest.fn();
const mockMergeUserAttributes = jest.fn();
const mockResolveUserIdentitiesByEmail = jest.fn();
const mockResolveUserIdentitiesBySubject = jest.fn();

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  assertAdminOnlyUserAttributes: (...args: unknown[]) => mockAssertAdminOnly(...args),
  findRealmUserIdsByAttribute: (...args: unknown[]) =>
    mockFindRealmUserIdsByAttribute(...args),
  getRealmUserByIdOrNull: (...args: unknown[]) =>
    mockGetRealmUserByIdOrNull(...args),
  mergeUserAttributes: (...args: unknown[]) => mockMergeUserAttributes(...args),
}));

jest.mock("@/lib/rbac/user-identity-directory", () => ({
  resolveUserIdentitiesByEmail: (...args: unknown[]) =>
    mockResolveUserIdentitiesByEmail(...args),
  resolveUserIdentitiesBySubject: (...args: unknown[]) =>
    mockResolveUserIdentitiesBySubject(...args),
}));


const identity = {
  sub: "external-subject",
  email: "USER@EXAMPLE.TEST",
  name: "External Name",
  groups: ["external-users"],
};

const caipeUser = {
  subject: "keycloak-subject",
  email: "user@example.test",
  name: "CAIPE User",
  display_name: "user@example.test",
};

describe("secondary OIDC identity linking", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClaimSecondaryIdentity.mockResolvedValue(undefined);
    mockAssertAdminOnly.mockResolvedValue(undefined);
    mockFindRealmUserIdsByAttribute.mockResolvedValue([]);
    mockGetRealmUserByIdOrNull.mockResolvedValue({
      id: "keycloak-subject", email: "user@example.test",
      attributes: {},
    });
    mockMergeUserAttributes.mockResolvedValue(undefined);
    mockResolveUserIdentitiesByEmail.mockResolvedValue(
      new Map([["user@example.test", caipeUser]]),
    );
    mockResolveUserIdentitiesBySubject.mockResolvedValue(
      new Map([["keycloak-subject", caipeUser]]),
    );
  });

  it("creates a one-time link from normalized corporate email", async () => {
    mockFindRealmUserIdsByAttribute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["keycloak-subject"]);

    const result = await linkSecondaryOidcIdentity({
      providerId: "example-corporate",
      issuer: "https://identity.example.test/oauth2",
      externalSub: "external-subject",
      email: " USER@EXAMPLE.TEST ",
      emailVerified: true,
      identity,
    });

    expect(mockResolveUserIdentitiesByEmail).toHaveBeenCalledWith([
      "user@example.test",
    ], { requireUnique: true });
    expect(mockMergeUserAttributes).toHaveBeenCalledWith(
      "keycloak-subject",
      expect.objectContaining({
        caipe_secondary_oidc_identity_key: [expect.stringMatching(/^[a-f0-9]{64}$/)],
        caipe_secondary_oidc_provider_id: ["example-corporate"],
        caipe_secondary_oidc_issuer: ["https://identity.example.test/oauth2"],
        caipe_secondary_oidc_sub: ["external-subject"],
        caipe_secondary_oidc_email: ["user@example.test"],
        caipe_secondary_oidc_linked_at: [expect.any(String)],
      }),
    );
    expect(result).toMatchObject({
      sub: "keycloak-subject",
      email: "user@example.test",
      name: "CAIPE User",
    });
  });

  it("uses an existing issuer-subject link without consulting email", async () => {
    mockFindRealmUserIdsByAttribute.mockResolvedValue(["keycloak-subject"]);

    const result = await linkSecondaryOidcIdentity({
      providerId: "example-corporate",
      issuer: "https://identity.example.test/oauth2",
      externalSub: "external-subject",
      identity,
    });

    expect(mockFindRealmUserIdsByAttribute).toHaveBeenCalledWith(
      "caipe_secondary_oidc_identity_key",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(mockResolveUserIdentitiesByEmail).not.toHaveBeenCalled();
    expect(mockResolveUserIdentitiesBySubject).toHaveBeenCalledWith([
      "keycloak-subject",
    ]);
    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
    expect(result.sub).toBe("keycloak-subject");
  });

  it("rejects an existing link when the Keycloak user is disabled", async () => {
    mockFindRealmUserIdsByAttribute.mockResolvedValue(["keycloak-subject"]);
    mockGetRealmUserByIdOrNull.mockResolvedValue({
      id: "keycloak-subject", email: "user@example.test",
      enabled: false,
    });

    await expect(
      linkSecondaryOidcIdentity({
        providerId: "example-corporate",
        issuer: "https://identity.example.test/oauth2",
        externalSub: "external-subject",
        identity,
      }),
    ).rejects.toMatchObject({
      code: "SECONDARY_OIDC_IDENTITY_LINK_STALE",
    });

    expect(mockResolveUserIdentitiesBySubject).not.toHaveBeenCalled();
  });

  it("rejects an identity linked to multiple Keycloak users", async () => {
    mockFindRealmUserIdsByAttribute.mockResolvedValue([
      "keycloak-subject",
      "different-keycloak-subject",
    ]);

    await expect(
      linkSecondaryOidcIdentity({
        providerId: "example-corporate",
        issuer: "https://identity.example.test/oauth2",
        externalSub: "external-subject",
        identity,
      }),
    ).rejects.toMatchObject({
      code: "SECONDARY_OIDC_IDENTITY_LINK_CONFLICT",
    });

    expect(mockGetRealmUserByIdOrNull).not.toHaveBeenCalled();
  });

  it("rejects an explicitly unverified email on first link", async () => {
    await expect(
      linkSecondaryOidcIdentity({
        providerId: "example-corporate",
        issuer: "https://identity.example.test/oauth2",
        externalSub: "external-subject",
        email: "user@example.test",
        emailVerified: false,
        identity,
      }),
    ).rejects.toMatchObject({
      code: "SECONDARY_OIDC_IDENTITY_EMAIL_UNVERIFIED",
    });

    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

  it("rejects a first link when email_verified is absent", async () => {
    await expect(
      linkSecondaryOidcIdentity({
        providerId: "example-corporate",
        issuer: "https://identity.example.test/oauth2",
        externalSub: "external-subject",
        email: "user@example.test",
        identity,
      }),
    ).rejects.toMatchObject({
      code: "SECONDARY_OIDC_IDENTITY_EMAIL_UNVERIFIED",
    });

    expect(mockResolveUserIdentitiesByEmail).not.toHaveBeenCalled();
    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

  it("automatically links a trusted provider without email_verified", async () => {
    mockFindRealmUserIdsByAttribute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["keycloak-subject"]);

    const result = await linkSecondaryOidcIdentity({
      providerId: "example-corporate",
      issuer: "https://identity.example.test/oauth2",
      externalSub: "external-subject",
      email: "user@example.test",
      emailVerified: false,
      requireVerifiedEmail: false,
      identity,
    });

    expect(mockResolveUserIdentitiesByEmail).toHaveBeenCalledWith([
      "user@example.test",
    ], { requireUnique: true });
    expect(mockMergeUserAttributes).toHaveBeenCalled();
    expect(result.sub).toBe("keycloak-subject");
  });

  it("rejects a subject with surrounding whitespace instead of normalizing it", async () => {
    await expect(
      linkSecondaryOidcIdentity({
        providerId: "example-corporate",
        issuer: "https://identity.example.test/oauth2",
        externalSub: " external-subject ",
        email: "user@example.test",
        emailVerified: true,
        identity,
      }),
    ).rejects.toMatchObject({
      code: "SECONDARY_OIDC_IDENTITY_INVALID_SUBJECT",
    });

    expect(mockFindRealmUserIdsByAttribute).not.toHaveBeenCalled();
    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

  it("rejects an unlinked identity without a matching CAIPE profile", async () => {
    mockResolveUserIdentitiesByEmail.mockResolvedValue(new Map());

    await expect(
      linkSecondaryOidcIdentity({
        providerId: "example-corporate",
        issuer: "https://identity.example.test/oauth2",
        externalSub: "external-subject",
        email: "missing@example.test",
        emailVerified: true,
        identity,
      }),
    ).rejects.toThrow("No existing user matches");

    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

  it("rejects a matching CAIPE profile without an active Keycloak user", async () => {
    mockGetRealmUserByIdOrNull.mockResolvedValue(null);

    await expect(
      linkSecondaryOidcIdentity({
        providerId: "example-corporate",
        issuer: "https://identity.example.test/oauth2",
        externalSub: "external-subject",
        email: "user@example.test",
        emailVerified: true,
        identity,
      }),
    ).rejects.toMatchObject({
      code: "SECONDARY_OIDC_IDENTITY_USER_NOT_FOUND",
    });

    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

  it("rejects a first link when the token has no corporate email", async () => {
    await expect(
      linkSecondaryOidcIdentity({
        providerId: "example-corporate",
        issuer: "https://identity.example.test/oauth2",
        externalSub: "external-subject",
        emailVerified: true,
        identity,
      }),
    ).rejects.toMatchObject({
      code: "SECONDARY_OIDC_IDENTITY_EMAIL_REQUIRED",
    });

    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

  it("does not overwrite another secondary identity on the same user", async () => {
    mockGetRealmUserByIdOrNull.mockResolvedValue({
      id: "keycloak-subject", email: "user@example.test",
      attributes: { caipe_secondary_oidc_identity_key: ["another-key"] },
    });

    await expect(
      linkSecondaryOidcIdentity({
        providerId: "example-corporate",
        issuer: "https://identity.example.test/oauth2",
        externalSub: "external-subject",
        email: "user@example.test",
        emailVerified: true,
        identity,
      }),
    ).rejects.toMatchObject({
      code: "SECONDARY_OIDC_IDENTITY_LINK_CONFLICT",
    });

    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });

  it("rolls back its claim when another user owns the identity after writing", async () => {
    mockFindRealmUserIdsByAttribute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["different-keycloak-subject"]);
    mockGetRealmUserByIdOrNull
      .mockResolvedValueOnce({ id: "keycloak-subject", email: "user@example.test", attributes: {} })
      .mockResolvedValueOnce({
        id: "keycloak-subject", email: "user@example.test",
        attributes: {
          caipe_secondary_oidc_identity_key: [
            "237a63901f6fe29ef8330891b82fa94169d3c66b531fff7ca44b288f8d94c373",
          ],
        },
      });

    await expect(
      linkSecondaryOidcIdentity({
        providerId: "example-corporate",
        issuer: "https://identity.example.test/oauth2",
        externalSub: "external-subject",
        email: "user@example.test",
        emailVerified: true,
        identity,
      }),
    ).rejects.toMatchObject({
      code: "SECONDARY_OIDC_IDENTITY_LINK_CONFLICT",
    });

    expect(mockMergeUserAttributes).toHaveBeenCalledTimes(2);
    expect(mockMergeUserAttributes).toHaveBeenLastCalledWith(
      "keycloak-subject",
      {
        caipe_secondary_oidc_identity_key: undefined,
        caipe_secondary_oidc_provider_id: undefined,
        caipe_secondary_oidc_issuer: undefined,
        caipe_secondary_oidc_sub: undefined,
        caipe_secondary_oidc_email: undefined,
        caipe_secondary_oidc_linked_at: undefined,
      },
    );
  });
  it("rejects stale directory email before reserving a link", async () => {
    mockGetRealmUserByIdOrNull.mockResolvedValue({ id: "keycloak-subject", email: "different@example.test" });
    await expect(linkSecondaryOidcIdentity({ providerId: "example", issuer: "https://identity.example.test", externalSub: "external-user", email: "user@example.test", emailVerified: true, identity })).rejects.toMatchObject({ code: "SECONDARY_OIDC_IDENTITY_EMAIL_MISMATCH" });
    expect(mockClaimSecondaryIdentity).not.toHaveBeenCalled();
  });
  it("rejects a conflicting atomic reservation without writing Keycloak", async () => {
    mockClaimSecondaryIdentity.mockRejectedValue(new SecondaryIdentityClaimConflict("already bound"));
    await expect(linkSecondaryOidcIdentity({ providerId: "example", issuer: "https://identity.example.test", externalSub: "external-user", email: "user@example.test", emailVerified: true, identity })).rejects.toMatchObject({ code: "SECONDARY_OIDC_IDENTITY_LINK_CONFLICT" });
    expect(mockMergeUserAttributes).not.toHaveBeenCalled();
  });
  it("never propagates external groups or organization into canonical identity", async () => {
    mockFindRealmUserIdsByAttribute.mockResolvedValue(["keycloak-subject"]);
    const result = await linkSecondaryOidcIdentity({ providerId: "example", issuer: "https://identity.example.test", externalSub: "external-user", identity: { ...identity, org: "external-admin" } });
    expect(result.groups).toEqual([]);
    expect(result.org).toBeUndefined();
  });

  it("does not trust legacy links until profile attributes are admin-only", async () => {
    mockAssertAdminOnly.mockRejectedValue(new Error("profile migration required"));
    await expect(linkSecondaryOidcIdentity({ providerId: "example", issuer: "https://identity.example.test", externalSub: "external-user", identity })).rejects.toThrow("profile migration required");
    expect(mockFindRealmUserIdsByAttribute).not.toHaveBeenCalled();
    expect(mockClaimSecondaryIdentity).not.toHaveBeenCalled();
  });

});
