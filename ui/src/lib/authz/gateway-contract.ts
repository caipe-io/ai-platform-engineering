import type { AuthorizeResult, Subject } from "./contract";

/** Internal gateway domain input, not a public cross-subject check API. */
export interface GatewayRequest {
  caller: Subject;
  serverId: string;
  operation: string;
  toolName?: string;
  signedContext?: { encoded: string; signature: string };
}

export type GatewayGate = "context" | "gateway" | "server" | "agent" | "agent_tool" | "caller_tool";

/** One executed check; no tokens, signatures, arguments or inferred grant path. */
export interface GatewayCheck {
  gate: GatewayGate;
  subject_ref: string;
  relation?: "can_call" | "can_use" | "can_invoke" | "can_search";
  resource_ref?: string;
  decision: AuthorizeResult["decision"];
  reason: AuthorizeResult["reason"];
}

export interface GatewayResult extends AuthorizeResult {
  checks: GatewayCheck[];
  /** Snapshot of the applied CAS rule, not a reconstructed current policy. */
  policy_rule: string;
  failed_gate?: GatewayGate;
  message: string;
  decision_id: string;
  agent_id?: string;
}

export interface GatewayContext {
  version: 1;
  audience: "caipe-gateway";
  caller: Subject;
  kind: "dynamic" | "direct";
  agent_id?: string;
  iat: number;
  exp: number;
}
