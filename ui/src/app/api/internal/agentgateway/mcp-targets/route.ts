// assisted-by Codex Codex-sonnet-4-6

import { getCollection } from "@/lib/mongodb";
import { agentGatewayMcpEndpointUrl } from "@/lib/rbac/agentgateway-mcp-discovery";
import type { MCPCredentialSource, MCPServerConfig } from "@/types/dynamic-agent";
import { timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";

const COLLECTION_NAME = "mcp_servers";
const SAFE_TARGET_ID = /^[A-Za-z0-9._-]+$/;

interface AgentGatewayBridgeTarget {
  id: string;
  target_endpoint: string;
  credential_sources?: MCPCredentialSource[];
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function authorizeBridgeRequest(request: NextRequest): Response | null {
  const expected = process.env.AGENTGATEWAY_TARGETS_TOKEN?.trim();
  if (!expected) {
    return Response.json({ error: "AgentGateway targets token is not configured" }, { status: 503 });
  }

  const authorization = request.headers.get("authorization") ?? "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!actual || !tokenMatches(actual, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

function isNetworkTransport(server: MCPServerConfig): boolean {
  return server.transport === "http" || server.transport === "sse";
}

function isAgentGatewayEndpoint(endpoint: string): boolean {
  const gatewayBase = agentGatewayMcpEndpointUrl();
  try {
    const endpointUrl = new URL(endpoint);
    const gatewayUrl = new URL(gatewayBase);
    const endpointPath = endpointUrl.pathname.replace(/\/+$/, "");
    const gatewayPath = gatewayUrl.pathname.replace(/\/+$/, "");
    return endpointUrl.origin === gatewayUrl.origin && endpointPath.startsWith(gatewayPath || "/mcp");
  } catch {
    return false;
  }
}

function canonicalAgentGatewayTargetEndpoint(endpoint: string): string {
  // Streamable HTTP session negotiation cannot safely cross an HTTP redirect:
  // the upstream session id belongs to the redirected URL, while AgentGateway
  // wraps sessions against the configured target URL. FastMCP serves the
  // canonical endpoint at `/mcp`, so remove only that path's trailing slash.
  return endpoint.replace(/\/mcp\/(?=([?#]|$))/, "/mcp");
}

function upstreamEndpointFor(server: MCPServerConfig): string {
  const targetEndpoint =
    typeof server.agentgateway_target_endpoint === "string"
      ? server.agentgateway_target_endpoint.trim()
      : "";
  if (targetEndpoint) return canonicalAgentGatewayTargetEndpoint(targetEndpoint);

  const endpoint = typeof server.endpoint === "string" ? server.endpoint.trim() : "";
  return endpoint && !isAgentGatewayEndpoint(endpoint)
    ? canonicalAgentGatewayTargetEndpoint(endpoint)
    : "";
}

function toBridgeTarget(server: MCPServerConfig): AgentGatewayBridgeTarget | null {
  if (server.enabled === false || !isNetworkTransport(server)) return null;

  const id = typeof server._id === "string" ? server._id.trim() : "";
  const targetEndpoint = upstreamEndpointFor(server);
  if (!id || !SAFE_TARGET_ID.test(id) || !targetEndpoint) return null;

  return {
    id,
    target_endpoint: targetEndpoint,
    // Always send the array so the config bridge can tell "no credentials" ([])
    // from servers that should use their own upstream configuration.
    credential_sources: Array.isArray(server.credential_sources) ? server.credential_sources : [],
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  const unauthorized = authorizeBridgeRequest(request);
  if (unauthorized) return unauthorized;

  const collection = await getCollection<MCPServerConfig>(COLLECTION_NAME);
  const servers = await collection
    .find({
      enabled: { $ne: false },
      transport: { $in: ["http", "sse"] },
    } as never)
    .toArray();
  const targets = servers.flatMap((server) => {
    const target = toBridgeTarget(server);
    return target ? [target] : [];
  });

  return Response.json({ targets });
}
