import type { DelegationApproval, DelegationAuthority, DelegationIdentity, DelegationRecord } from "./delegation-contract";
import { delegationSnapshot } from "./delegation-contract";

export function storedApproval(record: DelegationRecord): DelegationApproval {
  return { effectiveSubject: { type: "user", id: record.user_id },
    evidence: { kind: "cas_approval", reference: record._id }, approval: delegationSnapshot(record) };
}

/** Current evidence adapter: bind a verified service identity to a stored approval.
 * A token-exchange adapter must validate its own evidence before producing this
 * context; an act claim alone cannot establish consent or job authorization. */
export function bindStoredDelegation(
  id: string, identity: DelegationIdentity, record: DelegationRecord,
): DelegationAuthority | null {
  if (record._id !== id || identity.subject.type !== "service_account" || record.issuer !== identity.issuer ||
    record.service.id !== identity.subject.id || record.service.client_id !== identity.clientId) return null;
  return {
    issuer: identity.issuer, actor: { type: "service_account", id: identity.subject.id },
    clientId: identity.clientId, credentialExpiresAt: identity.expiresAt, ...storedApproval(record),
  };
}
