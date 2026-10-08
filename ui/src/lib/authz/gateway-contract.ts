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

export interface GatewayResult extends AuthorizeResult {
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
