/** @jest-environment node */
import { bindStoredDelegation } from "../delegation-authority";
import { evaluateDelegationAuthority } from "../delegation-policy";
import type { DelegationCheck, DelegationIdentity, DelegationRecord } from "../delegation-contract";

const mockPermission = jest.fn();
jest.mock("../engines/openfga", () => ({ checkDelegationPermission: (...args: unknown[]) => mockPermission(...args) }));
jest.mock("../delegation-store", () => { throw new Error("Normalized policy must not load Mongo persistence"); });
jest.mock("@/lib/jwt-validation", () => { throw new Error("Normalized policy must not parse tokens"); });

const id = "approval-1";
const identity: DelegationIdentity = { issuer: "https://identity.example.test", subject: { type: "service_account", id: "test-service" },
  clientId: "example-service", expiresAt: 10 ** 10 };
const record: DelegationRecord = { _id: id, issuer: identity.issuer, user_id: "test-user",
  service: { id: "test-service", client_id: "example-service" }, job_id: "test-job", version: 1,
  created_at: "2026-10-21T11:00:00Z", expires_at: "2026-10-22T11:00:00Z", revoked_at: null,
  scope: [{ resource: { type: "agent", id: "example" }, action: "use" }] };
const request = { ...record.scope[0], job_id: record.job_id };
beforeEach(() => {
  jest.clearAllMocks(); jest.useFakeTimers(); jest.setSystemTime(new Date("2026-10-21T12:00:00Z"));
  mockPermission.mockResolvedValue({ decision: "ALLOW", reason: "OK", retriable: false });
});
afterEach(() => jest.useRealTimers());

it("keeps actor, effective user, credential lifetime and approval evidence separate", () => {
  const authority = bindStoredDelegation(id, identity, record)!;
  expect(authority).toMatchObject({ actor: identity.subject, effectiveSubject: { type: "user", id: "test-user" },
    issuer: identity.issuer, clientId: identity.clientId, credentialExpiresAt: identity.expiresAt,
    evidence: { kind: "cas_approval", reference: id }, approval: { job_id: "test-job", version: 1, expires_at: record.expires_at } });
  expect(authority).not.toHaveProperty("_id");
  expect(authority).not.toHaveProperty("user_id");
});

it.each([
  { ...identity, issuer: "https://other.example.test" },
  { ...identity, clientId: "other-client" },
  { ...identity, subject: { type: "service_account" as const, id: "other-service" } },
  { ...identity, subject: { type: "user" as const, id: "test-user" } },
])("does not turn an unbound identity into authority: %j", (caller) => {
  expect(bindStoredDelegation(id, caller, record)).toBeNull();
});
it("cannot bind another approval reference", () => {
  expect(bindStoredDelegation("other-approval", identity, record)).toBeNull();
});
it("evaluates the normalized context without reading storage or decoding credentials", async () => {
  const authority = bindStoredDelegation(id, identity, record)!;
  const checks: DelegationCheck[] = [];
  expect(await evaluateDelegationAuthority(authority, request, checks)).toBe("OK");
  expect(mockPermission.mock.calls.map(([req]) => req.subject)).toEqual([authority.actor, authority.effectiveSubject]);
  expect(checks.map((item) => item.gate)).toEqual(["approval", "scope", "service_permission", "user_permission"]);
});
it("does not let an evidence adapter widen the approved job binding", async () => {
  const authority = bindStoredDelegation(id, identity, record)!;
  expect(await evaluateDelegationAuthority(authority, { ...request, job_id: "other-job" }, []))
    .toBe("DELEGATION_BINDING_MISMATCH");
  expect(mockPermission).not.toHaveBeenCalled();
});
it.each([
  [{ revoked_at: "2026-10-21T11:30:00Z" }, "DELEGATION_REVOKED"],
  [{ expires_at: "2026-10-21T12:00:00Z" }, "DELEGATION_EXPIRED"],
  [{ scope: [] }, "DELEGATION_SCOPE_MISMATCH"],
] as const)("retains job boundaries independently of the identity credential: %j", async (change, reason) => {
  const authority = bindStoredDelegation(id, identity, { ...record, ...change, scope: "scope" in change ? [...change.scope] : record.scope })!;
  expect(await evaluateDelegationAuthority(authority, request, [])).toBe(reason);
  expect(mockPermission).not.toHaveBeenCalled();
});
