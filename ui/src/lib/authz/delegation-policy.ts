import type { Subject } from "./contract";
import type { DelegatedRequest, DelegationAuthority, DelegationCheck, DelegationReason } from "./delegation-contract";
import { checkDelegationPermission } from "./engines/openfga";

export function approvalReason(approval: DelegationAuthority["approval"]): DelegationReason {
  if (approval.revoked_at) return "DELEGATION_REVOKED";
  return Date.parse(approval.expires_at) > Date.now() ? "OK" : "DELEGATION_EXPIRED";
}

export async function checkDelegationPermissions(
  actor: Subject, effectiveSubject: Subject, request: DelegatedRequest,
  signal: AbortSignal, checks: DelegationCheck[],
): Promise<DelegationReason> {
  const principals: [DelegationCheck["gate"], Subject, DelegationReason][] = [
    ["service_permission", actor, "SERVICE_NOT_ALLOWED"],
    ["user_permission", effectiveSubject, "USER_NOT_ALLOWED"],
  ];
  for (const [gate, subject, denied] of principals) {
    const result = await checkDelegationPermission({ subject, resource: request.resource, action: request.action }, signal);
    const reason = result.reason === "AUTHZ_UNAVAILABLE" ? result.reason : result.decision === "ALLOW" ? "OK" : denied;
    checks.push({ gate, decision: result.decision, reason });
    if (reason !== "OK") return reason;
  }
  return "OK";
}

/** Common policy consumes normalized authority, not JWT claims or Mongo rows.
 * The caller must bind evidence first and revalidate it after these checks. */
export async function evaluateDelegationAuthority(
  authority: DelegationAuthority, request: DelegatedRequest, checks: DelegationCheck[],
): Promise<DelegationReason> {
  const approval = authority.approval;
  if (approval.job_id !== request.job_id) {
    checks.push({ gate: "binding", decision: "DENY", reason: "DELEGATION_BINDING_MISMATCH" });
    return "DELEGATION_BINDING_MISMATCH";
  }
  const state = approvalReason(approval);
  checks.push({ gate: "approval", decision: state === "OK" ? "ALLOW" : "DENY", reason: state });
  if (state !== "OK") return state;
  const scoped = approval.scope.some((item) => item.action === request.action &&
    item.resource.type === request.resource.type && item.resource.id === request.resource.id);
  const reason = scoped ? "OK" : "DELEGATION_SCOPE_MISMATCH";
  checks.push({ gate: "scope", decision: scoped ? "ALLOW" : "DENY", reason });
  if (!scoped) return reason;
  return checkDelegationPermissions(authority.actor, authority.effectiveSubject, request, AbortSignal.timeout(5000), checks);
}
