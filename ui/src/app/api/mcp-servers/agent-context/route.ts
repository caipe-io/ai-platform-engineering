/**
 * Mint a signed "local" agent context covering one or more MCP servers, for
 * CLI/local callers (e.g. a Claude Code or Codex MCP client) invoking tools
 * directly through AgentGateway under the caller's own identity.
 *
 * AgentGateway's openfga-authz-bridge rejects tools/call requests with
 * "missing or invalid signed agent context" once CAIPE_AGENT_CONTEXT_HMAC_SECRET
 * is set, because that header pair is normally only produced by the Dynamic
 * Agents runtime (or this UI's own diagnostic test-tool flow). A bare local
 * client authenticates with a user's bearer token but has no way to produce
 * that signature itself, since the HMAC secret must stay in-cluster.
 *
 * Unlike the Dynamic Agent / diagnostic flows, this route does NOT grant or
 * revoke any OpenFGA tuples: the minted context is marked `kind: "local"`,
 * and the bridge (deploy/openfga/bridge/main.py) skips the agent:<id>
 * can_use/can_call checks entirely for that kind, since a local context
 * grants no authority beyond what the signed-in caller already has via the
 * `can_invoke`/caller-keyed checks it performs unconditionally on every
 * request. That's what makes it safe to hand this context to a caller for
 * use in later, separate requests — there's no tuple to expire out from
 * under them (see the removed grant-then-immediately-revoke code this
 * replaced, which broke every tools/call after the mint request returned).
 * The signature's own `exp` (see buildAgentContextHeaders' "local" TTL) is
 * the only lifetime bound left, chosen long enough to outlast a normal MCP
 * client session/connection rather than to gate authorization.
 */

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { buildAgentContextHeaders, localAgentContextId } from "@/lib/mcp-http-server-client";
import {
  trustedInteractionFromRequest,
  trustedInteractionProofHeaders,
} from "@/lib/authz/trusted-interaction";
import { filterResourcesByPermission } from "@/lib/rbac/resource-authz";
import type { MCPServerConfig } from "@/types/dynamic-agent";
import { NextRequest } from "next/server";

const COLLECTION_NAME = "mcp_servers";

function readRequestedServerIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new ApiError("serverIds must be an array of strings", 400, "VALIDATION_ERROR");
  }
  const ids = value.map((entry) => entry.trim()).filter(Boolean);
  return [...new Set(ids)];
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const interaction = trustedInteractionFromRequest(request);
  const body = request.headers.get("content-length") === "0" ? {} : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
  const requestedServerIds = readRequestedServerIds(body.serverIds);

  const collection = await getCollection<MCPServerConfig>(COLLECTION_NAME);
  const candidateServers =
    requestedServerIds !== undefined
      ? await collection.find({ _id: { $in: requestedServerIds }, enabled: true }).toArray()
      : await collection.find({ enabled: true }).toArray();

  const invokableServers = await filterResourcesByPermission(session, candidateServers, {
    type: "mcp_server",
    action: "invoke",
    id: (server: MCPServerConfig) => String(server._id),
  }, { trustedContext: { interaction } });

  if (requestedServerIds !== undefined) {
    const invokableIds = new Set(invokableServers.map((server) => String(server._id)));
    const missing = requestedServerIds.filter((id) => !invokableIds.has(id));
    if (missing.length > 0) {
      throw new ApiError(
        `Not authorized to invoke MCP server(s): ${missing.join(", ")}`,
        403,
        "mcp_server#invoke",
      );
    }
  } else if (invokableServers.length === 0) {
    throw new ApiError("No invokable MCP servers found for this user.", 404, "NO_INVOKABLE_SERVERS");
  }

  const serverIds = invokableServers.map((server) => String(server._id));
  const agentId = localAgentContextId(session);
  const headers = {
    ...buildAgentContextHeaders(agentId, "local"),
    ...trustedInteractionProofHeaders(interaction),
  };
  if (Object.keys(headers).length === 0) {
    throw new ApiError(
      "Agent context signing is not configured on this deployment.",
      503,
      "AGENT_CONTEXT_UNAVAILABLE",
    );
  }
  return successResponse({ headers, server_ids: serverIds });
});
