import { randomUUID } from "crypto";

import type { AuthorizeResult, Subject } from "../contract";
import type { GatewayCheck, GatewayGate, GatewayRequest, GatewayResult } from "../gateway-contract";
import { isGatewayIdentifier, verifyGatewayContext } from "../gateway-context";
import { checkGatewayPermission } from "../engines/openfga";
import { OPENFGA_READ_TIMEOUT_MS } from "../engines/openfga-client";

const TRANSPORT_OPERATIONS = new Set([
  "initialize", "notifications/initialized", "ping", "tools/list", "http:get", "http:delete",
]);
const SEARCH_SERVERS = new Set(["knowledge-base"]);
export const GATEWAY_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** Complete policy owner; no request handler or gateway implements these gates. */
export async function evaluateGateway(req: GatewayRequest): Promise<GatewayResult> {
  const decisionId = randomUUID();
  let agentId: string | undefined;
  const checks: GatewayCheck[] = [];
  let policyRule = "The gateway MCP request must be valid.";
  const result = (value: AuthorizeResult, message: string, gate?: GatewayGate): GatewayResult => ({
    ...value, ttl_seconds: 0, message, decision_id: decisionId, checks, policy_rule: policyRule,
    ...(gate ? { failed_gate: gate } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
  });
  const invalid = (message: string) => result({ decision: "DENY", reason: "INVALID_REQUEST", retriable: false }, message);
  if ((req.caller.type !== "user" && req.caller.type !== "service_account") ||
      !isGatewayIdentifier(req.caller.id) || !isGatewayIdentifier(req.serverId)) return invalid("Invalid caller or MCP server");
  const toolCall = req.operation === "tools/call";
  if (toolCall ? !req.toolName || !GATEWAY_TOOL_NAME.test(req.toolName) :
      !TRANSPORT_OPERATIONS.has(req.operation) || req.toolName !== undefined) return invalid("Unsupported or malformed MCP operation");
  const restricted = new Set((process.env.CAIPE_RESTRICTED_MCP_SERVERS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  const organization = process.env.CAIPE_ORG_KEY?.trim() || "caipe";
  if ([...restricted].some((id) => !isGatewayIdentifier(id)) || !isGatewayIdentifier(organization)) {
    return result({ decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true }, "Gateway authorization policy is misconfigured");
  }

  policyRule = toolCall
    ? `Valid caller-bound context AND gateway access AND caller ${SEARCH_SERVERS.has(req.serverId) ? "Search access (can_search)" : "tool access (can_call)"}. Agent execution also requires caller can_use agent AND agent can_call tool. Tool checks accept an exact OR server-wide grant.`
    : "Caller can_call the gateway. Transport setup does not grant permission to execute tools.";
  if (restricted.has(req.serverId)) policyRule += " Caller must also can_invoke this restricted MCP server.";

  if (toolCall) {
    try {
      const context = verifyGatewayContext(req.signedContext, req.caller);
      if (!context) {
        checks.push({ gate: "context", subject_ref: `${req.caller.type}:${req.caller.id}`, decision: "DENY", reason: "NO_CAPABILITY" });
        return result({ decision: "DENY", reason: "NO_CAPABILITY", retriable: false },
          "Missing, expired or incorrectly bound execution context", "context");
      }
      agentId = context.agent_id;
      checks.push({ gate: "context", subject_ref: `${req.caller.type}:${req.caller.id}`, decision: "ALLOW", reason: "OK",
        ...(agentId ? { resource_ref: `agent:${agentId}` } : {}) });
    } catch {
      checks.push({ gate: "context", subject_ref: `${req.caller.type}:${req.caller.id}`, decision: "DENY", reason: "AUTHZ_UNAVAILABLE" });
      return result({ decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true },
        "Execution context verification is not configured", "context");
    }
  }

  // One deadline for the whole decision, including discovery and wildcard checks.
  const signal = AbortSignal.timeout(OPENFGA_READ_TIMEOUT_MS);
  const check = async (subject: Subject | { type: "agent"; id: string }, relation: "can_call" | "can_use" | "can_invoke" | "can_search", object: string, gate: GatewayGate) => {
    const value = await checkGatewayPermission(subject, relation, object, signal);
    checks.push({ gate, subject_ref: `${subject.type}:${subject.id}`, relation, resource_ref: object,
      decision: value.decision, reason: value.reason });
    return value;
  };
  const toolCheck = async (subject: Subject | { type: "agent"; id: string }, gate: GatewayGate) => {
    const exact = await check(subject, "can_call", `tool:${req.serverId}/${req.toolName}`, gate);
    if (exact.decision === "ALLOW" || exact.reason === "AUTHZ_UNAVAILABLE") return exact;
    return check(subject, "can_call", `tool:${req.serverId}/*`, gate);
  };
  const stopped = (value: AuthorizeResult, gate: GatewayGate, message: string) =>
    value.decision === "ALLOW" ? null : result(value,
      value.reason === "AUTHZ_UNAVAILABLE" ? "Authorization service temporarily unavailable" : message, gate);

  let denied = stopped(await check(req.caller, "can_call", "mcp_gateway:list", "gateway"), "gateway", "Caller cannot access the MCP gateway");
  if (denied) return denied;
  if (restricted.has(req.serverId)) {
    denied = stopped(await check(req.caller, "can_invoke", `mcp_server:${req.serverId}`, "server"), "server", "Caller cannot invoke this MCP server");
    if (denied) return denied;
  }
  if (toolCall) {
    if (agentId) {
      denied = stopped(await check(req.caller, "can_use", `agent:${agentId}`, "agent"), "agent", "Caller cannot use this agent");
      if (denied) return denied;
      denied = stopped(await toolCheck({ type: "agent", id: agentId }, "agent_tool"), "agent_tool", "Agent cannot invoke this tool");
      if (denied) return denied;
    }
    const callerTool = SEARCH_SERVERS.has(req.serverId)
      ? await check(req.caller, "can_search", `organization:${organization}`, "caller_tool")
      : await toolCheck(req.caller, "caller_tool");
    denied = stopped(callerTool, "caller_tool", SEARCH_SERVERS.has(req.serverId)
      ? "Caller lacks Search access" : "Caller cannot invoke this tool");
    if (denied) return denied;
  }
  return result({ decision: "ALLOW", reason: "OK", retriable: false }, "All required permissions passed");
}
