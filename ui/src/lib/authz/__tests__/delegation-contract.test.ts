/** @jest-environment node */
import { safeDelegationChecks, safeDelegationEvidence, safeDelegationSnapshot } from "../delegation-contract";
const snapshot = { user_ref: "user:test-user", service_ref: "service_account:test-service", issuer: "https://identity.example.test",
  service: { id: "test-service", client_id: "example-service", secret: "do-not-return" }, job_id: "test-job", version: 1,
  created_at: "2026-10-21T11:00:00Z", expires_at: "2026-10-22T11:00:00Z", revoked_at: null,
  scope: [{ resource: { type: "agent", id: "example", secret: "do-not-return" }, action: "use", secret: "do-not-return" }], secret: "do-not-return" };
it("allowlists nested approval audit fields rather than forwarding credentials", () => {
  expect(safeDelegationSnapshot(snapshot)).toMatchObject({ user_ref: "user:test-user", scope: [{ action: "use", resource: { id: "example" } }] });
  expect(JSON.stringify(safeDelegationSnapshot(snapshot))).not.toContain("do-not-return");
  expect(safeDelegationChecks([{ gate: "binding", decision: "DENY", reason: "DELEGATION_BINDING_MISMATCH", token: "do-not-return" }]))
    .toEqual([{ gate: "binding", decision: "DENY", reason: "DELEGATION_BINDING_MISMATCH" }]);
});
it("allowlists recorded evidence metadata, without treating unknown token formats as supported", () => {
  expect(safeDelegationEvidence({ kind: "cas_approval", reference: "approval-1", access_token: "do-not-return" }))
    .toEqual({ kind: "cas_approval", reference: "approval-1" });
  for (const value of [null, {}, { kind: "keycloak_token_exchange", reference: "approval-1" }, { kind: "cas_approval", reference: "" }]) {
    expect(safeDelegationEvidence(value)).toBeUndefined();
  }
});
it.each([null, [], {}, { ...snapshot, scope: [null] }, { ...snapshot, scope: Array(17).fill(snapshot.scope[0]) }])("rejects malformed approval snapshots", (value) => {
  expect(safeDelegationSnapshot(value)).toBeUndefined();
});
it.each([null, [{ gate: "untrusted", decision: "ALLOW", reason: "OK" }], [{ gate: "scope", decision: "ALLOW" }]])("rejects malformed check evidence", (value) => {
  expect(safeDelegationChecks(value)).toBeUndefined();
});
