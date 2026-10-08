/**
 * Mint caller-bound direct context for clients invoking tools through
 * AgentGateway. Signing keys stay server-side; context never creates grants.
 * CAS contexts expire after five minutes and clients must renew them before
 * expires_at. Flag-off deployments retain the bridge's existing local format.
 */

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { buildAgentContextHeaders, localAgentContextId } from "@/lib/mcp-http-server-client";
import { gatewayCasEnabled } from "@/lib/authz";
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
  });

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
  const headers = buildAgentContextHeaders(agentId, "local", session);
  if (Object.keys(headers).length === 0) {
    throw new ApiError(
      "Agent context signing is not configured on this deployment.",
      503,
      "AGENT_CONTEXT_UNAVAILABLE",
    );
  }
  // Read the expiry from the server-signed payload, not a second clock read.
  let expiresAt: string | undefined;
  if (gatewayCasEnabled()) {
    const context = JSON.parse(
      Buffer.from(headers["X-CAIPE-Agent-Context"], "base64url").toString("utf8"),
    ) as { exp: number };
    expiresAt = new Date(context.exp * 1000).toISOString();
  }
  return successResponse({
    headers,
    server_ids: serverIds,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  });
});
