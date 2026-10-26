/** @jest-environment node */
import { NextRequest } from "next/server";
import { errors as joseErrors } from "jose";
import { POST as create } from "../delegations/route";
import { GET as inspect, DELETE as revoke } from "../delegations/[id]/route";
import { POST as check } from "../delegations/[id]/check/route";
import type { DelegationRecord } from "@/lib/authz/delegation-contract";

const mockSession = jest.fn(); const mockJwt = jest.fn(); const mockCreate = jest.fn();
const mockInspect = jest.fn(); const mockRevoke = jest.fn(); const mockCheck = jest.fn();
jest.mock("@/lib/api-middleware", () => ({ getAuthenticatedUser: (...args: unknown[]) => mockSession(...args) }));
jest.mock("@/lib/jwt-validation", () => ({ validatePlatformBearerJWT: (...args: unknown[]) => mockJwt(...args) }));
jest.mock("@/lib/authz", () => ({ createDelegation: (...args: unknown[]) => mockCreate(...args),
  inspectDelegation: (...args: unknown[]) => mockInspect(...args), revokeDelegation: (...args: unknown[]) => mockRevoke(...args),
  authorizeDelegated: (...args: unknown[]) => mockCheck(...args) }));

const originalEnv = { ...process.env };
const issuer = "https://identity.example.test/realms/primary";
const id = "f7e577e0-1180-40d8-8d34-2b31a31a3aba";
const context = { params: Promise.resolve({ id }) };
const intent = { service: { id: "test-service", client_id: "example-service" }, job_id: "test-job",
  scope: [{ resource: { type: "agent", id: "example" }, action: "use" }], expires_at: new Date(Date.now() + 3600_000).toISOString() };
const record = { ...intent, _id: id, issuer, user_id: "test-user", created_at: new Date().toISOString(), revoked_at: null, version: 1 } as DelegationRecord;
const input = { resource: { type: "agent", id: "example" }, action: "use", job_id: "test-job" };
function request(value: unknown = intent, headers: Record<string, string> = {}, method = "POST") {
  return new NextRequest(`https://example.test/api/access/delegations/${id}`, {
    method, headers: { "content-type": "application/json", origin: "https://example.test", "idempotency-key": id, ...headers },
    ...(method !== "GET" ? { body: JSON.stringify(value) } : {}),
  });
}
beforeEach(() => {
  jest.clearAllMocks(); process.env.OIDC_ISSUER = issuer; process.env.OIDC_CLIENT_ID = "browser"; process.env.NEXTAUTH_URL = "https://example.test";
  mockSession.mockResolvedValue({ session: { principalType: "oidc_user", sub: "test-user", expiresAt: Date.now() / 1000 + 600 } });
  mockJwt.mockResolvedValue({ issuer, subject: { type: "service_account", id: "test-service" }, clientId: "example-service", expiresAt: Date.now() / 1000 + 600 });
  mockCreate.mockResolvedValue(record); mockInspect.mockResolvedValue(record); mockRevoke.mockResolvedValue(record);
  mockCheck.mockResolvedValue({ decision: "ALLOW", reason: "OK", retriable: false, ttl_seconds: 0, delegation_id: id, decision_id: "decision-1" });
});
afterAll(() => { process.env = originalEnv; });

it("creates a human-approved delegation without accepting a body owner", async () => {
  const response = await create(request());
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ delegation_id: id, user_ref: "user:test-user", service_ref: "service_account:test-service", version: 1 });
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ subject: { type: "user", id: "test-user" } }), intent, expect.anything(), id);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("requires a stable idempotency key and rejects bearer-created approvals, including user impersonation tokens", async () => {
  expect((await create(request(intent, { "idempotency-key": "" }))).status).toBe(400);
  expect((await create(request(intent, { authorization: "Bearer test" }))).status).toBe(403);
  expect(mockCreate).not.toHaveBeenCalled();
});
it.each(["subject", "user_id", "context", "trustedContext", "parent_delegation_id", "actor", "effectiveSubject", "evidence", "approval"])("rejects caller-selected %s", async (field) => {
  expect((await create(request({ ...intent, [field]: "forged" }))).status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
});
it.each([
  { ...intent, scope: [] }, { ...intent, scope: Array(17).fill(intent.scope[0]) },
  { ...intent, expires_at: new Date(0).toISOString() }, { ...intent, expires_at: new Date(Date.now() + 8 * 86400_000).toISOString() },
  { ...intent, expires_at: "tomorrow" }, { ...intent, service: { ...intent.service, subject: "forged" } },
  { ...intent, scope: [{ resource: { type: "agent", id: "*" }, action: "use" }] },
  { ...intent, scope: [{ resource: { type: "agent", id: "example", extra: "secret" }, action: "use" }] },
  { ...intent, scope: [{ resource: { type: "agent", id: "example" }, action: "not-an-action" }] },
  { ...intent, job_id: "../other" },
])("rejects malformed or unbounded approval %j", async (body) => {
  expect((await create(request(body))).status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
});
it("rejects oversized JSON before creating anything", async () => {
  expect((await create(request({ ...intent, job_id: "x".repeat(20000) }))).status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
});
it.each(["https://other.example.test", ""])("rejects cookie mutation with Origin=%s", async (origin) => {
  expect((await create(request(intent, { origin }))).status).toBe(403);
});
it("requires JSON for approvals", async () => {
  expect((await create(request(intent, { "content-type": "text/plain" }))).status).toBe(400);
});
it("rejects malformed JSON", async () => {
  const req = new NextRequest("https://example.test/api/access/delegations", { method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: "{" });
  expect((await create(req)).status).toBe(400);
});
it("does not silently use a cookie when a malformed bearer was supplied", async () => {
  expect((await create(request(intent, { authorization: "broken" }))).status).toBe(401);
  expect(mockSession).not.toHaveBeenCalled();
});
it("classifies rejected signed identity as 401 and validation outage as 503", async () => {
  mockJwt.mockRejectedValueOnce(new joseErrors.JWTClaimValidationFailed("bad audience", {}, "aud"));
  expect((await check(request(input, { authorization: "Bearer test" }), context)).status).toBe(401);
  mockJwt.mockRejectedValueOnce(new Error("discovery unavailable"));
  expect((await check(request(input, { authorization: "Bearer test" }), context)).status).toBe(503);
});
it.each([{}, { sub: "test-user" }, { principalType: "oidc_user", sub: "test-user", isServiceAccount: true }])("rejects anonymous or ambiguous cookie identity %j", async (session) => {
  mockSession.mockResolvedValue({ session });
  expect((await create(request())).status).toBe(401);
});
it("returns 503 when the primary issuer is not configured", async () => {
  delete process.env.OIDC_ISSUER;
  expect((await create(request())).status).toBe(503);
});
it("a service bearer can request only its bound job; the decision API does not accept an effective subject", async () => {
  const response = await check(request(input, { authorization: "Bearer test" }), context);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-caipe-decision-id")).toBe("decision-1");
  expect(mockCheck).toHaveBeenCalledWith(id, expect.objectContaining({ subject: { type: "service_account", id: "test-service" } }), input, expect.anything());
  expect((await check(request({ ...input, subject: { id: "other-user" } }, { authorization: "Bearer test" }), context)).status).toBe(400);
});
it("does not accept browser cookies or human bearer tokens as service delegation execution", async () => {
  expect((await check(request(input), context)).status).toBe(401);
  mockJwt.mockResolvedValue({ issuer, subject: { type: "user", id: "test-user" }, clientId: "browser", expiresAt: Date.now() / 1000 + 600 });
  expect((await check(request(input, { authorization: "Bearer test" }), context)).status).toBe(403);
  expect(mockCheck).not.toHaveBeenCalled();
});
it("returns completed DENY as 200, unavailable as 503, and never caches either", async () => {
  for (const [reason, status] of [["DELEGATION_EXPIRED", 200], ["AUTHZ_UNAVAILABLE", 503]] as const) {
    mockCheck.mockResolvedValue({ decision: "DENY", reason, decision_id: "decision-1" });
    const response = await check(request(input, { authorization: "Bearer test" }), context);
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
  }
});
it("uses a server-generated correlation ID, not caller provenance claims", async () => {
  await check(request(input, { authorization: "Bearer test", "x-correlation-id": "forged-chain" }), context);
  expect(mockCheck.mock.calls[0][3].correlationId).not.toBe("forged-chain");
});
it("inspects and revokes the reference through owner-bound domain calls", async () => {
  expect((await inspect(request(undefined, {}, "GET"), context)).status).toBe(200);
  expect((await revoke(request(undefined, {}, "DELETE"), context)).status).toBe(200);
  expect(mockInspect).toHaveBeenCalledWith(id, expect.objectContaining({ subject: { id: "test-user", type: "user" } }));
  mockInspect.mockResolvedValue(null);
  expect((await inspect(request(undefined, {}, "GET"), context)).status).toBe(404);
});
it("rejects malformed references", async () => {
  expect((await inspect(request(undefined, {}, "GET"), { params: Promise.resolve({ id: "../invalid" }) })).status).toBe(400);
});
it("does not promise automatic retry after an unknown write outcome", async () => {
  mockCreate.mockRejectedValue(new Error("acknowledgement lost"));
  const response = await create(request());
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ code: "DELEGATION_WRITE_UNKNOWN", retriable: false });
});
