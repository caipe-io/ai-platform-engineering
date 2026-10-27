import { getAuditClient } from "@/lib/audit";
import { writeCredentialAuditEvent } from "@/lib/credentials/audit";
import { getCredentialDependencyHealth } from "@/lib/credentials/health";
import {
  isOpaqueMaskedPreview,
  maskCredentialValue,
  redactCredentialDetails,
} from "@/lib/credentials/masking";

jest.mock("@/lib/audit", () => ({
  getAuditClient: jest.fn(),
}));

describe("credential masking", () => {
  it("masks credential values without exposing the full value", () => {
    expect(maskCredentialValue("ghp_1234567890abcdef")).toBe("ghp_...cdef");
    expect(maskCredentialValue("short")).toBe("s...t");
    expect(maskCredentialValue("abcd")).toBe("a***");
    expect(maskCredentialValue("a")).toBe("*");
    expect(isOpaqueMaskedPreview("*****")).toBe(true);
    expect(isOpaqueMaskedPreview("s...t")).toBe(false);
  });

  it("redacts sensitive detail keys before audit persistence", () => {
    expect(
      redactCredentialDetails({
        action: "rotate",
        secretValue: "github-token-value",
        refreshToken: "provider-refresh-token",
        resourceId: "secret-1",
      }),
    ).toEqual({
      action: "rotate",
      secretValue: "[redacted]",
      refreshToken: "[redacted]",
      resourceId: "secret-1",
    });
  });
});

describe("credential audit writer", () => {
  it("writes a redacted audit event via the backend (no secret values persisted)", () => {
    const mockWrite = jest.fn();
    (getAuditClient as jest.Mock).mockReturnValue({ append: mockWrite });

    writeCredentialAuditEvent({
      action: "credential.rotate",
      actor: { type: "user", id: "alice-sub" },
      resource: { type: "secret_ref", id: "secret-1" },
      result: "success",
      details: { plaintext: "github-token-value", reason: "user-requested" },
    });

    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "credential.rotate",
        actor: { type: "user", id: "alice-sub" },
        resource: { type: "secret_ref", id: "secret-1" },
        result: "success",
        details: { plaintext: "[redacted]", reason: "user-requested" },
      }),
    );
    expect(JSON.stringify(mockWrite.mock.calls)).not.toContain("github-token-value");
  });
});

describe("credential dependency health", () => {
  it("reports disabled without probing backing dependencies", async () => {
    await expect(
      getCredentialDependencyHealth({
        config: { enabled: false, keyProvider: "aws-kms", cmkId: null, nodeEnv: "test" },
        pingMongo: async () => {
          throw new Error("should not run");
        },
        pingPolicyService: async () => {
          throw new Error("should not run");
        },
      }),
    ).resolves.toMatchObject({
      feature_enabled: false,
      credential_store: "degraded",
      key_wrapper: "degraded",
      policy_service: "degraded",
    });
  });

  it("fails closed when AWS KMS is selected without a CMK", async () => {
    await expect(
      getCredentialDependencyHealth({
        config: { enabled: true, keyProvider: "aws-kms", cmkId: null, nodeEnv: "test" },
        pingMongo: async () => ({ ok: true }),
        pingPolicyService: async () => ({ ok: true }),
      }),
    ).resolves.toMatchObject({
      feature_enabled: true,
      credential_store: "healthy",
      key_wrapper: "unavailable",
      policy_service: "healthy",
      checks: expect.arrayContaining([
        { name: "kms-cmk", ok: false, reason: "missing_cmk_id" },
      ]),
    });
  });

  it("fails closed when local-cmk key wrapping is configured in production", async () => {
    await expect(
      getCredentialDependencyHealth({
        config: { enabled: true, keyProvider: "local-cmk", cmkId: "alias/local", nodeEnv: "production" },
        pingMongo: async () => ({ ok: true }),
        pingPolicyService: async () => ({ ok: true }),
      }),
    ).resolves.toMatchObject({
      key_wrapper: "unavailable",
      checks: expect.arrayContaining([
        { name: "key-wrapper", ok: false, reason: "local_cmk_forbidden_in_production" },
      ]),
    });
  });
});
