/** @jest-environment node */
import { authorizeDelegated, createDelegation, inspectDelegation, revokeDelegation } from "../delegations";
import type { DelegationIdentity, DelegationRecord } from "../delegation-contract";

const mockRead = jest.fn();
const mockInsert = jest.fn();
const mockRevoke = jest.fn();
const mockPermission = jest.fn();
const mockAudit = jest.fn();
jest.mock("../delegation-store", () => ({ readDelegation: (...args: unknown[]) => mockRead(...args),
  insertDelegation: (...args: unknown[]) => mockInsert(...args), revokeDelegationRecord: (...args: unknown[]) => mockRevoke(...args) }));
jest.mock("../engines/openfga", () => ({ checkDelegationPermission: (...args: unknown[]) => mockPermission(...args) }));
jest.mock("../audit", () => ({ emitDelegationAudit: (...args: unknown[]) => mockAudit(...args) }));
jest.mock("../index", () => ({ authorize: jest.fn() }));

const issuer = "https://identity.example.test/realms/primary";
const id = "f7e577e0-1180-40d8-8d34-2b31a31a3aba";
const service: DelegationIdentity = { issuer, subject: { type: "service_account", id: "test-service" },
  clientId: "example-service", expiresAt: Date.now() / 1000 + 600 };
const user: DelegationIdentity = { ...service, subject: { type: "user", id: "test-user" }, clientId: "browser" };
const intent = { service: { id: "test-service", client_id: "example-service" }, job_id: "test-job",
  scope: [{ resource: { type: "agent" as const, id: "example" }, action: "use" as const }],
  expires_at: new Date(Date.now() + 3600_000).toISOString() };
const record: DelegationRecord = { ...intent, _id: id, issuer, user_id: "test-user",
  created_at: new Date().toISOString(), revoked_at: null, version: 1 };
const request = { ...intent.scope[0], job_id: "test-job" };
const ctx = { correlationId: "server-request" };
const allow = { decision: "ALLOW", reason: "OK", retriable: false };
beforeEach(() => {
  jest.clearAllMocks(); mockRead.mockResolvedValue(structuredClone(record));
  mockInsert.mockResolvedValue(structuredClone(record)); mockRevoke.mockResolvedValue({ ...record, revoked_at: new Date().toISOString(), version: 2 });
  mockPermission.mockResolvedValue(allow);
});

it("requires approval AND service permission AND current user permission, and audits once", async () => {
  expect(await authorizeDelegated(id, service, request, ctx)).toMatchObject({ decision: "ALLOW", reason: "OK", ttl_seconds: 0, delegation_id: id });
  expect(mockPermission.mock.calls.map(([req]) => req.subject)).toEqual([service.subject, user.subject]);
  expect(mockPermission.mock.calls.every(([, signal]) => signal instanceof AbortSignal)).toBe(true);
  expect(mockRead).toHaveBeenCalledTimes(2);
  expect(mockAudit).toHaveBeenCalledTimes(1);
  expect(mockAudit.mock.calls[0][6].map((check: { gate: string }) => check.gate))
    .toEqual(["binding", "approval", "scope", "service_permission", "user_permission", "approval_recheck"]);
});

it.each([
  ["service", { ...service, subject: { type: "service_account", id: "other-service" } }, request],
  ["client", { ...service, clientId: "other-client" }, request],
  ["issuer", { ...service, issuer: "https://other.example.test" }, request],
  ["user bearer", user, request],
  ["job", service, { ...request, job_id: "other-job" }],
] as const)("rejects a forged %s binding without graph checks", async (_name, identity, input) => {
  expect(await authorizeDelegated(id, identity, input, ctx)).toMatchObject({ decision: "DENY", reason: "DELEGATION_BINDING_MISMATCH" });
  expect(mockPermission).not.toHaveBeenCalled();
  expect(mockAudit.mock.calls[0][2]).toBeUndefined();
});

it("rejects a nonexistent approval", async () => {
  mockRead.mockResolvedValue(null);
  expect((await authorizeDelegated(id, service, request, ctx)).reason).toBe("DELEGATION_NOT_FOUND");
  expect(mockPermission).not.toHaveBeenCalled();
});
it.each([
  ["expired", { expires_at: new Date(0).toISOString() }, "DELEGATION_EXPIRED"],
  ["invalid expiry", { expires_at: "invalid" }, "DELEGATION_EXPIRED"],
  ["revoked", { revoked_at: new Date().toISOString() }, "DELEGATION_REVOKED"],
] as const)("rejects %s approval before permissions", async (_name, change, reason) => {
  mockRead.mockResolvedValue({ ...record, ...change });
  expect((await authorizeDelegated(id, service, request, ctx)).reason).toBe(reason);
  expect(mockPermission).not.toHaveBeenCalled();
});
it.each([
  { ...request, action: "manage" as const },
  { ...request, resource: { type: "agent" as const, id: "other" } },
  { ...request, resource: { type: "skill" as const, id: "example" } },
])("cannot widen the approved action/resource: %j", async (input) => {
  expect((await authorizeDelegated(id, service, input, ctx)).reason).toBe("DELEGATION_SCOPE_MISMATCH");
  expect(mockPermission).not.toHaveBeenCalled();
});
it.each(["SERVICE_NOT_ALLOWED", "USER_NOT_ALLOWED"])("fails closed when %s", async (reason) => {
  if (reason === "USER_NOT_ALLOWED") mockPermission.mockResolvedValueOnce(allow);
  mockPermission.mockResolvedValueOnce({ decision: "DENY", reason: "NO_CAPABILITY" });
  expect((await authorizeDelegated(id, service, request, ctx)).reason).toBe(reason);
});
it("does not cache permissions between calls or elevate a revoked user's authority", async () => {
  expect((await authorizeDelegated(id, service, request, ctx)).decision).toBe("ALLOW");
  mockPermission.mockResolvedValueOnce(allow).mockResolvedValueOnce({ decision: "DENY", reason: "NO_CAPABILITY" });
  expect((await authorizeDelegated(id, service, request, ctx)).reason).toBe("USER_NOT_ALLOWED");
});
it("observes another replica's revocation while OpenFGA was being checked", async () => {
  mockRead.mockResolvedValueOnce(record).mockResolvedValueOnce({ ...record, version: 2, revoked_at: new Date().toISOString() });
  expect((await authorizeDelegated(id, service, request, ctx)).reason).toBe("DELEGATION_REVOKED");
});
it("checks expiry again after the graph checks", async () => {
  mockRead.mockResolvedValueOnce(record).mockResolvedValueOnce({ ...record, expires_at: new Date(0).toISOString() });
  expect((await authorizeDelegated(id, service, request, ctx)).reason).toBe("DELEGATION_EXPIRED");
});
it("does not change the effective user or invent a new chain during the final approval read", async () => {
  mockRead.mockResolvedValueOnce(record).mockResolvedValueOnce({ ...record, user_id: "other-user" });
  expect((await authorizeDelegated(id, service, request, ctx)).reason).toBe("DELEGATION_REVOKED");
  expect(mockAudit.mock.calls[0][2].effectiveSubject).toEqual({ type: "user", id: "test-user" });
});
it("checks the service credential lifetime again before allowing", async () => {
  expect((await authorizeDelegated(id, { ...service, expiresAt: 0 }, request, ctx)).reason).toBe("NOT_AUTHENTICATED");
});
it.each(["read", "graph", "final read"])("fails closed and audits on %s outage", async (stage) => {
  if (stage === "read") mockRead.mockRejectedValueOnce(new Error("database down"));
  if (stage === "final read") mockRead.mockResolvedValueOnce(record).mockRejectedValueOnce(new Error("database down"));
  if (stage === "graph") mockPermission.mockResolvedValueOnce({ decision: "DENY", reason: "AUTHZ_UNAVAILABLE" });
  expect(await authorizeDelegated(id, service, request, ctx)).toMatchObject({ decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true });
  expect(mockAudit).toHaveBeenCalledTimes(1);
});

it("derives the owner from authentication, not a supplied owner, and checks both permissions before insert", async () => {
  await createDelegation(user, intent, ctx, id);
  expect(mockInsert).toHaveBeenCalledWith(user, intent, id);
  expect(mockPermission).toHaveBeenCalledTimes(2);
});
it("does not create child delegations as a service", async () => {
  await expect(createDelegation(service, intent, ctx, id)).rejects.toMatchObject({ status: 403 });
  expect(mockInsert).not.toHaveBeenCalled();
});
it("refuses approval if the service or user has no authority", async () => {
  mockPermission.mockResolvedValueOnce({ decision: "DENY", reason: "NO_CAPABILITY" });
  await expect(createDelegation(user, intent, ctx, id)).rejects.toMatchObject({ status: 403 });
  expect(mockInsert).not.toHaveBeenCalled();
});
it("does not require a browser session to run an existing approval", async () => {
  // Execution has only the service identity and durable approval; no user token.
  expect((await authorizeDelegated(id, service, request, ctx)).decision).toBe("ALLOW");
});
it("inspection is private to the owner and exact service/client/issuer binding", async () => {
  expect(await inspectDelegation(id, user)).toEqual(record);
  expect(await inspectDelegation(id, service)).toEqual(record);
  expect(await inspectDelegation(id, { ...service, clientId: "other" })).toBeNull();
  expect(await inspectDelegation(id, { ...user, subject: { type: "user", id: "other-user" } })).toBeNull();
});
it("only the approving user can revoke; can_audit is never consulted", async () => {
  await expect(revokeDelegation(id, service, ctx)).rejects.toMatchObject({ status: 403 });
  expect(mockRevoke).not.toHaveBeenCalled();
  await revokeDelegation(id, user, ctx);
  expect(mockRevoke).toHaveBeenCalledWith(id, user);
  expect(mockAudit.mock.calls[0][0]).toBe("revoke");
});
