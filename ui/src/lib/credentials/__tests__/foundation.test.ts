import {
  CREDENTIAL_COLLECTIONS,
  isCredentialCollectionName,
} from "@/lib/credentials/collections";
import {
  createCredentialError,
  CREDENTIAL_REASON_CODES,
  isCredentialReasonCode,
} from "@/lib/credentials/errors";

describe("credential foundation constants", () => {
  it("defines stable MongoDB collection names for credential storage", () => {
    expect(CREDENTIAL_COLLECTIONS).toEqual({
      secretRefs: "credential_secret_refs",
      encryptedPayloads: "credential_encrypted_payloads",
      oauthConnectors: "oauth_connectors",
      providerConnections: "provider_connections",
      migrationPreviews: "credential_migration_previews",
      ingestPreviewGrants: "credential_ingest_preview_grants",
    });
  });

  it("recognizes only credential collection names", () => {
    expect(isCredentialCollectionName("credential_secret_refs")).toBe(true);
    expect(isCredentialCollectionName("mcp_servers")).toBe(false);
  });

  it("defines stable non-secret reason codes for audit and API responses", () => {
    expect(CREDENTIAL_REASON_CODES.browserRequestDenied).toBe("browser_request_denied");
    expect(CREDENTIAL_REASON_CODES.wrongAudience).toBe("wrong_audience");
    expect(CREDENTIAL_REASON_CODES.credentialStoreUnavailable).toBe(
      "credential_store_unavailable",
    );
    expect(isCredentialReasonCode("browser_request_denied")).toBe(true);
    expect(isCredentialReasonCode("raw_secret_value")).toBe(false);
  });

  it("creates credential errors without embedding sensitive material", () => {
    const error = createCredentialError({
      reasonCode: "browser_request_denied",
      message: "Browser clients cannot retrieve credential material",
      status: 403,
      correlationId: "req-123",
    });

    expect(error).toMatchObject({
      name: "CredentialError",
      reasonCode: "browser_request_denied",
      status: 403,
      correlationId: "req-123",
    });
    expect(error.message).not.toContain("secret");
  });
});
