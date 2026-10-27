/** @jest-environment node */
import { createLocalJWKSet, createRemoteJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { validatePlatformBearerJWT, _resetJWKSCache } from "../jwt-validation";

let mockKeysets: Map<string, ReturnType<typeof createLocalJWKSet>>;
jest.mock("jose", () => ({
  ...jest.requireActual("jose"),
  createRemoteJWKSet: jest.fn((url: URL) => mockKeysets.get(url.href)),
}));

const issuer = "https://identity.example.test/realms/primary";
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
let primary: Awaited<ReturnType<typeof generateKeyPair>>;
let secondary: Awaited<ReturnType<typeof generateKeyPair>>;
let elliptic: Awaited<ReturnType<typeof generateKeyPair>>;

async function token(overrides: Record<string, unknown> = {}, otherIssuer = false, ec = false): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer, aud: "caipe-access", sub: "test-subject", azp: "example-service",
    iat: now, exp: now + 300, typ: "Bearer", caipe_principal_type: "service_account",
    ...overrides,
  }).setProtectedHeader({ alg: ec ? "ES256" : "RS256", kid: otherIssuer ? "secondary" : ec ? "elliptic" : "primary" })
    .sign((otherIssuer ? secondary : ec ? elliptic : primary).privateKey);
}

beforeAll(async () => {
  primary = await generateKeyPair("RS256");
  secondary = await generateKeyPair("RS256");
  elliptic = await generateKeyPair("ES256");
  mockKeysets = new Map([
    ["https://identity.example.test/jwks", createLocalJWKSet({ keys: [
      { ...await exportJWK(primary.publicKey), kid: "primary", alg: "RS256" },
      { ...await exportJWK(elliptic.publicKey), kid: "elliptic", alg: "ES256" },
    ] })],
    ["https://secondary.example.test/jwks", createLocalJWKSet({ keys: [
      { ...await exportJWK(secondary.publicKey), kid: "secondary", alg: "RS256" },
    ] })],
  ]);
});

beforeEach(() => {
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_DISCOVERY_URL = issuer;
  process.env.OIDC_ADDITIONAL_JWKS = "https://secondary.example.test/jwks";
  process.env.OIDC_CLIENT_ID = "legacy-client";
  process.env.OIDC_ACCEPTED_AUDIENCES = "legacy-audience";
  process.env.OIDC_EXTRA_AUDIENCES = "gateway";
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ jwks_uri: "https://identity.example.test/jwks" })));
  jest.mocked(createRemoteJWKSet).mockClear();
  _resetJWKSCache();
});
afterEach(() => { process.env = { ...originalEnv }; global.fetch = originalFetch; _resetJWKSCache(); });

it.each([false, true])("verifies the signature and preserves canonical identity (ES256=%s)", async (ec) => {
  const result = await validatePlatformBearerJWT(await token({ email: "display@example.test", preferred_username: "not-a-service-prefix" }, false, ec));
  expect(result).toEqual({
    issuer, subject: { type: "service_account", id: "test-subject" },
    clientId: "example-service", expiresAt: expect.any(Number),
  });
  expect(result).not.toHaveProperty("email");
  expect(result).not.toHaveProperty("accessToken");
  expect(jest.mocked(global.fetch).mock.calls[0][1]).toHaveProperty("signal");
});

it("does not classify a human by their username or email", async () => {
  expect(await validatePlatformBearerJWT(await token({
    caipe_principal_type: "user", preferred_username: "service-account-example", email: "display@example.test",
  }))).toMatchObject({ subject: { type: "user", id: "test-subject" } });
});

it("accepts the explicit audience among other audiences", async () => {
  expect(await validatePlatformBearerJWT(await token({ aud: ["another-api", "caipe-access"] })))
    .toMatchObject({ subject: { type: "service_account", id: "test-subject" } });
});

it.each(["iss", "sub", "aud", "exp", "iat", "azp", "typ", "caipe_principal_type"])("requires signed %s", async (claim) => {
  await expect(validatePlatformBearerJWT(await token({ [claim]: undefined }))).rejects.toMatchObject({
    code: "ERR_JWT_CLAIM_VALIDATION_FAILED", claim,
  });
});

it.each(["legacy-client", "legacy-audience", "gateway"])("does not inherit legacy audience acceptance: %s", async (aud) => {
  await expect(validatePlatformBearerJWT(await token({ aud }))).rejects.toMatchObject({ claim: "aud" });
});

it("requires the configured issuer even when the signing key matches", async () => {
  await expect(validatePlatformBearerJWT(await token({ iss: "https://secondary.example.test" }))).rejects.toMatchObject({ claim: "iss" });
});

it("never falls back to an additional keyset", async () => {
  await expect(validatePlatformBearerJWT(await token({}, true))).rejects.toMatchObject({ code: "ERR_JWKS_NO_MATCHING_KEY" });
  expect(createRemoteJWKSet).toHaveBeenCalledTimes(1);
});

describe("issuance clock skew does not relax validity bounds", () => {
  const now = Date.UTC(2026, 9, 21, 12) / 1000;
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(now * 1000); });
  afterEach(() => { jest.useRealTimers(); });

  it.each([0, 1, 29, 30])("accepts an issuer clock lead of %s seconds without extending expiry", async (offset) => {
    expect(await validatePlatformBearerJWT(await token({ iat: now + offset, exp: now + 300 })))
      .toMatchObject({ subject: { type: "service_account", id: "test-subject" }, expiresAt: now + 300 });
  });

  it.each([31, 60])("rejects issuance %s seconds ahead", async (offset) => {
    await expect(validatePlatformBearerJWT(await token({ iat: now + offset, exp: now + 300 })))
      .rejects.toMatchObject({ claim: "iat" });
  });

  it.each([-1, 0])("rejects expiry %s seconds from now with no grace period", async (offset) => {
    await expect(validatePlatformBearerJWT(await token({ iat: now - 300, exp: now + offset })))
      .rejects.toMatchObject({ code: "ERR_JWT_EXPIRED" });
  });

  it.each([1, 30])("rejects not-before %s seconds ahead even within issuance skew", async (offset) => {
    await expect(validatePlatformBearerJWT(await token({ nbf: now + offset })))
      .rejects.toMatchObject({ claim: "nbf" });
  });

  it("accepts not-before exactly at the validation time", async () => {
    expect(await validatePlatformBearerJWT(await token({ nbf: now }))).toHaveProperty("expiresAt", now + 300);
  });

  it("accepts a token one second before its unchanged expiry", async () => {
    expect(await validatePlatformBearerJWT(await token({ exp: now + 1 }))).toHaveProperty("expiresAt", now + 1);
  });
});

it("rejects a tampered signature even when the key ID and claims match", async () => {
  const parts = (await token()).split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  await expect(validatePlatformBearerJWT(parts.join("."))).rejects.toMatchObject({ code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" });
});

it("rejects a shared-secret signature even with otherwise valid profile claims", async () => {
  const now = Math.floor(Date.now() / 1000);
  const signed = await new SignJWT({
    iss: issuer, aud: "caipe-access", sub: "test-subject", azp: "example-service",
    iat: now, exp: now + 300, typ: "Bearer", caipe_principal_type: "service_account",
  }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("example-test-secret-with-at-least-32-characters"));
  await expect(validatePlatformBearerJWT(signed)).rejects.toMatchObject({ code: "ERR_JOSE_ALG_NOT_ALLOWED" });
});

it("rejects an ID token even if configured with the new audience/type claims", async () => {
  await expect(validatePlatformBearerJWT(await token({ typ: "ID", caipe_principal_type: "user" }))).rejects.toMatchObject({ claim: "typ" });
});

it.each(["", " user ", "agent", "catalog_api_key", null])("rejects ambiguous principal type %j", async (type) => {
  await expect(validatePlatformBearerJWT(await token({ caipe_principal_type: type }))).rejects.toMatchObject({ claim: "caipe_principal_type" });
});

it.each(["", " test-subject", "user:test-subject", "team#member", "*", null])("does not normalize invalid subjects %j into another identity", async (sub) => {
  await expect(validatePlatformBearerJWT(await token({ sub }))).rejects.toMatchObject({ claim: "sub" });
});

it.each([null, "", " example-service", 123])("rejects missing or malformed client identity %j", async (azp) => {
  await expect(validatePlatformBearerJWT(await token({ azp }))).rejects.toMatchObject({ claim: "azp" });
});

it("does not flatten an actor-bearing token into ordinary self-access", async () => {
  await expect(validatePlatformBearerJWT(await token({ act: { sub: "other-service" } }))).rejects.toMatchObject({ claim: "act" });
});

it("fails unavailable when the primary issuer is not configured", async () => {
  delete process.env.OIDC_ISSUER;
  await expect(validatePlatformBearerJWT(await token())).rejects.toThrow("OIDC_ISSUER is required");
  expect(createRemoteJWKSet).not.toHaveBeenCalled();
});

it("propagates discovery failures instead of treating another issuer as a fallback", async () => {
  global.fetch = jest.fn(async () => new Response("", { status: 503 }));
  await expect(validatePlatformBearerJWT(await token())).rejects.toThrow("OIDC discovery failed");
  expect(createRemoteJWKSet).not.toHaveBeenCalled();
});
