import type { UnifiedAuditEvent } from "@/lib/rbac/types";

export const ACCESS_DECISION_COLOURS = {
  positive: "border-green-500/50 bg-green-500/10 text-foreground",
  negative: "border-red-500/50 bg-red-500/10 text-foreground",
  warning: "border-amber-500/50 bg-amber-500/10 text-foreground",
  info: "border-sky-500/50 bg-sky-500/10 text-foreground",
  neutral: "border-border bg-muted/30 text-foreground",
};

type AccessDecisionTone = keyof typeof ACCESS_DECISION_COLOURS;

export const ACCESS_GATE_LABELS: Record<string, string> = {
  context: "Execution context",
  gateway: "Caller → gateway",
  server: "Caller → MCP server",
  agent: "Caller → agent",
  agent_tool: "Agent → tool",
  caller_tool: "Caller → tool / Search access",
};

/** Describe recorded evidence, not a fresh permission check or inferred grant. */
export function describeAccessDecision(event: UnifiedAuditEvent): { label: string; explanation: string; tone: AccessDecisionTone } {
  if (event.reason_code === "AUTHZ_UNAVAILABLE") {
    return { label: "Authorization unavailable", explanation: "CAS could not evaluate access. The request was blocked safely; this is not proof of a missing permission.", tone: "warning" };
  }
  if (event.batch || event.list_objects) {
    return { label: "Catalog lookup", explanation: "This summarizes accessible resources, not a blocked access attempt.", tone: "info" };
  }
  if (event.reason_code === "INVALID_REQUEST") {
    return { label: "Invalid request", explanation: "CAS rejected the request format. This does not identify a missing grant.", tone: "negative" };
  }
  if (event.reason_code === "NOT_AUTHENTICATED") {
    return { label: "Authentication rejected", explanation: "The recorded check rejected authentication. No resource-permission conclusion can be drawn.", tone: "negative" };
  }
  if (event.outcome === "allow") {
    if (event.count !== undefined) {
      return { label: "Allowed (rollup)", explanation: `This summarizes ${event.count} allowed checks, not an individual request receipt.`, tone: "info" };
    }
    return { label: "Allowed", explanation: "CAS allowed this check. This does not prove that the downstream tool ran or succeeded.", tone: "positive" };
  }
  if (event.outcome !== "deny") {
    return { label: "Check failed", explanation: "The recorded check failed without a permission verdict. Inspect the recorded reason; do not infer a missing grant.", tone: "warning" };
  }
  if (event.failed_gate === "context") {
    return { label: "Execution context rejected", explanation: "The execution context was missing, expired or incorrectly bound. The record does not identify which condition occurred.", tone: "negative" };
  }
  if (event.failed_gate && ACCESS_GATE_LABELS[event.failed_gate]) {
    return { label: "Denied", explanation: `The ${ACCESS_GATE_LABELS[event.failed_gate]} check did not allow access. The record does not identify a missing team or grant.`, tone: "negative" };
  }
  return { label: "Denied", explanation: "The recorded check did not allow access. No more specific failed check or missing grant was recorded.", tone: "negative" };
}
