/**
 * Test MCP server credential_sources by making a live probe request with resolved headers.
 */

// assisted-by claude code claude-sonnet-4-6

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { isMcpCredentialUnavailableError, resolveMcpHeaderCredentials } from "@/lib/mcp-credential-headers";
import { isAgentGatewayEndpoint, listHttpMcpTools } from "@/lib/mcp-http-server-client";
import { getCollection } from "@/lib/mongodb";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type { McpCredentialResolution } from "@/lib/mcp-credential-headers";
import type { MCPCredentialSource, MCPServerConfig } from "@/types/dynamic-agent";
import { NextRequest } from "next/server";

const COLLECTION_NAME = "mcp_servers";

interface CredentialProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
  credentialOrigins: { name: string; origin: string; provider?: string }[];
  missingCredentials: string[];
}

function requiredServerId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(
      "Save the MCP server before testing its AgentGateway connection",
      400,
      "MCP_SERVER_SAVE_REQUIRED",
    );
  }
  return value.trim();
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const body = await request.json();
  const serverId = requiredServerId(body.server_id);
  await requireResourcePermission(
    session,
    { type: "mcp_server", id: serverId, action: "manage" },
  );

  const collection = await getCollection<MCPServerConfig>(COLLECTION_NAME);
  const server = await collection.findOne({ _id: serverId });
  if (!server) throw new ApiError("MCP server not found", 404);
  if (!server.enabled) throw new ApiError("MCP server is disabled", 400);
  if (server.transport !== "http" || !server.endpoint) {
    throw new ApiError(
      "Connection testing requires a saved Streamable HTTP MCP server",
      400,
      "MCP_PROBE_UNSUPPORTED_TRANSPORT",
    );
  }
  if (!isAgentGatewayEndpoint(server)) {
    throw new ApiError(
      "Connection testing requires a registered AgentGateway route",
      409,
      "MCP_GATEWAY_ROUTE_REQUIRED",
    );
  }

  const credentialSources = (body.credential_sources ?? []) as MCPCredentialSource[];
  const diagnosticServer: MCPServerConfig & { endpoint: string } = {
    ...server,
    endpoint: server.endpoint,
    credential_sources: credentialSources,
  };

  let resolution: McpCredentialResolution;
  try {
    resolution = await resolveMcpHeaderCredentials({
      request,
      session,
      server: diagnosticServer,
      viaAgentGateway: true,
      retrievalCaller: "mcp-credential-probe",
    });
  } catch (error) {
    if (isMcpCredentialUnavailableError(error)) {
      return successResponse<CredentialProbeResult>({
        ok: false,
        error: "One or more credentials could not be resolved. Check that connected apps are authorized.",
        credentialOrigins: [],
        missingCredentials: [],
      });
    }
    throw error;
  }

  const missingCredentials = resolution.sources
    .filter((s) => s.origin === "none")
    .map((s) => s.name);

  const credentialOrigins = resolution.sources.map((s) => ({
    name: s.name,
    origin: s.origin,
    ...(s.provider ? { provider: s.provider } : {}),
  }));
  if (missingCredentials.length > 0) {
    return successResponse<CredentialProbeResult>({
      ok: false,
      error: "One or more credentials could not be resolved. Check that connected apps are authorized.",
      credentialOrigins,
      missingCredentials,
    });
  }

  await listHttpMcpTools({
    request,
    session,
    server: diagnosticServer,
    serverId,
    credentialResolution: resolution,
  });

  return successResponse<CredentialProbeResult>({
    ok: true,
    status: 200,
    credentialOrigins,
    missingCredentials,
  });
});
