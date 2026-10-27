import type { UnifiedAuditEvent } from "@/lib/rbac/types";
import { ACCESS_DECISION_COLOURS } from "./access-decision-description";
import { AuditReference } from "./AuditReference";

const GATES = {
  binding: "Service, issuer, client and job binding", approval: "Approval is active",
  scope: "Requested action is in the approved scope", service_permission: "Service still has access",
  user_permission: "User still has access", approval_recheck: "Approval remains active after permission checks",
};

export function DelegationDecisionChain({ event }: { event: UnifiedAuditEvent }) {
  const approval = event.delegation;
  return (
    <section aria-label="Recorded delegation chain" className="mb-4 space-y-3 rounded-md border p-3 text-sm">
      <h4 className="font-semibold">Recorded delegation chain</h4>
      <p className="break-words"><span className="text-muted-foreground">{event.delegation_operation === "check" || event.type === "cas_decision" ? "Acting principal: " : "Approval requested by: "}</span>
        {event.actor_ref ? <AuditReference kind="principal" value={event.actor_ref} /> : "Not recorded"}
        {approval && <><span className="text-muted-foreground"> → on behalf of </span><AuditReference kind="principal" value={approval.user_ref} /></>}
        {event.resource_ref && <><span className="text-muted-foreground"> → </span><AuditReference kind="resource" value={event.resource_ref} /></>}
      </p>
      <p className="break-all">Approval: {event.delegation_id}{approval ? ` · version ${approval.version}` : " · no matching approval verified"}</p>
      {approval && event.delegation_evidence && <p>Authority evidence: CAS job approval · {event.delegation_evidence.reference}</p>}
      {approval && <>
        <p>Approved service: <AuditReference kind="principal" value={approval.service_ref} /> · client {approval.service.client_id}</p>
        <p>Approved at: {approval.created_at} · expires: {approval.expires_at}</p>
        {approval.revoked_at && <p className="text-red-600 dark:text-red-400">Revoked at: {approval.revoked_at}</p>}
        <p className="break-all">Job binding: {approval.job_id} <span className="text-muted-foreground">(application-supplied label, not execution proof)</span></p>
        <ul aria-label="Approved scope" className="space-y-1">{approval.scope.map((item, index) => <li key={index}>
          <AuditReference kind="action" value={item.action} /> <AuditReference kind="resource" value={`${item.resource.type}:${item.resource.id}`} />
        </li>)}</ul>
      </>}
      {event.delegation_policy && <p>Rule at the time: {event.delegation_policy}</p>}
      {!!event.delegation_checks?.length && <ol aria-label="Delegation checks" className="space-y-2">{event.delegation_checks.map((check, index) => {
        const tone = check.reason === "AUTHZ_UNAVAILABLE" ? "warning" : check.decision === "ALLOW" ? "positive" : "negative";
        return <li key={index} className={`rounded border border-l-4 p-2 ${ACCESS_DECISION_COLOURS[tone]}`}>
          {index + 1}. {GATES[check.gate]} — {check.decision === "ALLOW" ? "Passed" : "Blocked"}: {check.reason}
        </li>;
      })}</ol>}
      <p>Recorded outcome: {event.outcome} · {event.reason_code}</p>
      <p className="text-xs text-muted-foreground">CAS records the authenticated caller and its approval snapshot. This is not proof that downstream work executed, nor a signed or lossless audit trail.</p>
    </section>
  );
}
