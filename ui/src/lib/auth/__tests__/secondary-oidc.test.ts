/** @jest-environment node */
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { validateSecondaryOidcJWT, isSecondaryOidcConfigured, resetSecondaryOidcJWTCache } from "../secondary-oidc";

const mockLink = jest.fn();
let mockKeys: ReturnType<typeof createLocalJWKSet>;
jest.mock("../secondary-identity-link", () => ({ linkSecondaryOidcIdentity: (...args: unknown[]) => mockLink(...args) }));
jest.mock("jose", () => ({ ...jest.requireActual("jose"), createRemoteJWKSet: jest.fn(() => (...args: Parameters<typeof mockKeys>) => mockKeys(...args)) }));
const issuer = "https://identity.example.test";
const resource = "https://host.example.test/apps/example/api/mcp";
let privateKey: CryptoKey;
const originalEnv = { ...process.env };
beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  mockKeys = createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] });
});
beforeEach(() => {
  process.env = { ...originalEnv, CAIPE_SECONDARY_OIDC_JWKS_URI: `${issuer}/jwks`, CAIPE_SECONDARY_OIDC_ISSUER: issuer,
    CAIPE_SECONDARY_OIDC_AUDIENCES: "example-api", CAIPE_SECONDARY_OIDC_PROVIDER_ID: "example",
    CAIPE_SECONDARY_AUTH_RESOURCES: JSON.stringify({ [resource]: ["example-api"] }) };
  delete process.env.CAIPE_SECONDARY_OIDC_REQUIRE_VERIFIED_EMAIL;
  mockLink.mockReset().mockImplementation(async input => input.identity);
  resetSecondaryOidcJWTCache();
});
afterAll(() => { process.env = originalEnv; });
async function token(claims: Record<string, unknown> = {}) {
  return new SignJWT({ iss: issuer, sub: "external-user", aud: "example-api", exp: Math.floor(Date.now()/1000)+60,
    email: "user@example.test", email_verified: true, groups: ["admin"], org: "external", ...claims })
    .setProtectedHeader({ alg: "RS256" }).sign(privateKey);
}
it("is disabled when no trust configuration is set", () => {
  for (const key of Object.keys(process.env)) if (key.startsWith("CAIPE_SECONDARY_")) delete process.env[key];
  expect(isSecondaryOidcConfigured()).toBe(false);
});
it("verifies a signed token and strips external authorization claims", async () => {
  expect(await validateSecondaryOidcJWT(await token(), resource)).toEqual({ email: "user@example.test", name: "user@example.test", sub: "external-user", groups: [] });
  expect(mockLink).toHaveBeenCalledWith(expect.objectContaining({ requireVerifiedEmail: true, emailVerified: true }));
});
it.each([{ iss: "https://other.example.test" }, { aud: "platform" }, { exp: 1 }, { exp: undefined }, { sub: undefined }])("rejects invalid claims %j", async claims => {
  await expect(validateSecondaryOidcJWT(await token(claims), resource)).rejects.toThrow();
  expect(mockLink).not.toHaveBeenCalled();
});
it("rejects a tampered signature", async () => {
  const parts = (await token()).split(".");
  parts[1] = Buffer.from(JSON.stringify({ iss: issuer, sub: "attacker", aud: "example-api", exp: 9999999999 })).toString("base64url");
  await expect(validateSecondaryOidcJWT(parts.join("."), resource)).rejects.toThrow();
});
it.each(["https://other.example.test/api/mcp", "http://host.example.test/api/mcp", `${resource}?x=1`])("rejects unbound resource %s", async target => {
  await expect(validateSecondaryOidcJWT(await token(), target)).rejects.toThrow();
  expect(mockLink).not.toHaveBeenCalled();
});
it("rejects a binding outside the issuer audience allowlist", async () => {
  process.env.CAIPE_SECONDARY_AUTH_RESOURCES = JSON.stringify({ [resource]: ["platform"] });
  await expect(validateSecondaryOidcJWT(await token(), resource)).rejects.toThrow();
});
it("supports explicit trusted-provider email policy", async () => {
  process.env.CAIPE_SECONDARY_OIDC_REQUIRE_VERIFIED_EMAIL = "false";
  await validateSecondaryOidcJWT(await token({ email_verified: false }), resource);
  expect(mockLink).toHaveBeenCalledWith(expect.objectContaining({ requireVerifiedEmail: false }));
});
