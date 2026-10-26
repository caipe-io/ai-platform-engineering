import { Badge } from "@/components/ui/badge";
import type { UnifiedAuditEvent } from "@/lib/rbac/types";
import { ACCESS_DECISION_COLOURS, ACCESS_GATE_LABELS } from "./access-decision-description";
import { AuditReference } from "./AuditReference";
import { DelegationDecisionChain } from "./DelegationDecisionChain";

export function AccessDecisionChain({ event }: { event: UnifiedAuditEvent }) {
  if (event.delegation_id) return <DelegationDecisionChain event={event} />;
  const aggregate = event.count !== undefined || event.batch || event.list_objects;
  const checks = aggregate ? undefined : event.gateway_checks;
  return (
    <section aria-label="Recorded access chain" className="mb-4 space-y-3 rounded-md border p-3 text-sm">
      <h4 className="font-semibold">Recorded access chain</h4>
      <p className="break-words">
        <span className="text-muted-foreground">Starting principal: </span>{event.subject_ref ? <AuditReference kind="principal" value={event.subject_ref} /> : "Not recorded"}
        {event.agent_ref && <><span className="text-muted-foreground"> → </span><AuditReference kind="resource" value={event.agent_ref} /></>}
        {event.resource_ref && <><span className="text-muted-foreground"> → </span><AuditReference kind="resource" value={event.resource_ref} /></>}
      </p>
      <p><span className="text-muted-foreground">Requested by: </span>{event.actor_ref ? <AuditReference kind="workload" value={event.actor_ref} /> : "Not recorded"}</p>
      <p className="text-xs text-muted-foreground">This chain starts at CAS. Earlier sign-in or delegation steps are not recorded here.</p>
      {aggregate ? <p>No individual chain is available for this rollup or catalog lookup.</p>
        : !checks?.length ? <p>Full check sequence not recorded. Only the event&apos;s reported outcome and failed check are available.</p>
          : <>
            {event.gateway_policy && <p><span className="font-medium">Rule at the time: </span>{event.gateway_policy}</p>}
            <ol className="space-y-2">
              {checks.map((check, index) => {
                const stoppingDenial = event.outcome === "deny" && event.failed_gate === check.gate && index === checks.length - 1;
                const status = check.reason === "AUTHZ_UNAVAILABLE" ? "Unavailable" : check.decision === "ALLOW" ? "Passed"
                  : check.gate === "context" ? "Rejected" : stoppingDenial ? "Denied" : "No match";
                const tone = check.reason === "AUTHZ_UNAVAILABLE" ? "warning" : check.decision === "ALLOW" ? "positive"
                  : check.gate === "context" || stoppingDenial ? "negative" : "neutral";
                return (
                  <li key={index} className={`rounded border border-l-4 p-2 ${ACCESS_DECISION_COLOURS[tone]}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{index + 1}. {ACCESS_GATE_LABELS[check.gate]}</span>
                      <Badge variant="outline" className={ACCESS_DECISION_COLOURS[tone]}>{status}</Badge>
                    </div>
                    <div className="mt-1 break-words font-mono text-xs">
                      <AuditReference kind="principal" value={check.subject_ref} />
                      <span className="text-muted-foreground"> · </span>
                      <AuditReference kind="action" value={check.relation || "verify signed caller-bound context"} />
                      {check.resource_ref && <><span className="text-muted-foreground"> · </span><AuditReference kind="resource" value={check.resource_ref} /></>}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">Recorded reason: {check.reason}</div>
                  </li>
                );
              })}
            </ol>
            {checks.some((check) => check.resource_ref?.endsWith("/*")) && <p className="text-xs text-muted-foreground">Exact and server-wide tool grants are alternatives. “No match” is a candidate result, not the final request verdict.</p>}
            <p className="font-medium">{event.failed_gate
              ? `Stopped at ${ACCESS_GATE_LABELS[event.failed_gate] || event.failed_gate}.`
              : event.outcome === "allow" ? "All required checks passed." : "See the recorded outcome above."}</p>
            <p className="text-xs text-muted-foreground">OpenFGA&apos;s answer does not identify the particular team, inherited relationship or grant that produced it.</p>
          </>}
    </section>
  );
}
