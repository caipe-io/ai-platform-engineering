import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-error";
import type { AuthResult } from "@/lib/da-proxy";
import { getCollection } from "@/lib/mongodb";
import { listHttpMcpTools } from "@/lib/mcp-http-server-client";
import { filterResourcesByPermission } from "@/lib/rbac/resource-authz";
import { normalizeMcpEndpointForServer } from "@/lib/rbac/mcp-endpoint-normalizer";
import type { AgentExecutionReadiness, MCPServerConfig } from "@/types/dynamic-agent";

/** Read-only catalog initialization, using the same caller/agent path as execution. */
export async function checkHarnessMcpReadiness(agentId: string, tools: string[], auth: AuthResult): Promise<AgentExecutionReadiness | undefined> {
  if (!tools.length) return;
  const session = auth.authenticatedUser?.session;
  const unavailable = (): AgentExecutionReadiness => ({ ready: false, code: "HARNESS_AGENT_NOT_READY", message: "This agent's selected MCP tools could not be initialized. Ask the agent owner to check the MCP connection and available tools before starting a new turn. No agent run or tool call was started." });
  const gateway = process.env.AGENT_GATEWAY_URL?.trim();
  if (!session || !gateway) return unavailable();
  const servers = await (await getCollection<MCPServerConfig>("mcp_servers")).find({ enabled: { $ne: false } }).toArray();
  const selected = new Map<string, MCPServerConfig>();
  const selectedTools = new Map<string, string[]>();
  for (const id of tools) {
    const server = servers.filter(item => id.startsWith(`${item._id}.`)).sort((a, b) => String(b._id).length - String(a._id).length)[0];
    if (!server) return unavailable();
    selected.set(String(server._id), server);
    selectedTools.set(String(server._id), [...(selectedTools.get(String(server._id)) ?? []), id]);
  }
  const permitted = await filterResourcesByPermission(session, [...selected.values()], { type: "mcp_server", action: "invoke", id: server => String(server._id) });
  const request = new NextRequest("http://localhost/api/harness-readiness", { headers: {
    ...(auth.bearerToken && { Authorization: `Bearer ${auth.bearerToken}` }),
    ...(auth.traceparent && { traceparent: auth.traceparent }),
  } });
  // Permission/credential denials retain the broker's existing unavailable-tool
  // behavior. Never substitute a diagnostic agent or another caller's identity.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    for (const server of permitted) {
      if (controller.signal.aborted) return unavailable();
      const serverId = String(server._id);
      try {
        const catalog = await listHttpMcpTools({ request, session, agentId, serverId, signal: controller.signal, server: { ...server, source: "agentgateway", endpoint: normalizeMcpEndpointForServer({ endpoint: gateway, serverId, agentGatewayBaseUrl: gateway })! } });
        if (selectedTools.get(serverId)!.some(id => !catalog.tools.some(tool => `${serverId}.${tool.name}` === id || `${serverId}.${tool.namespaced_name}` === id))) return unavailable();
      } catch (error) {
        if (error instanceof ApiError && ["MCP_AUTH_REQUIRED", "MCP_CREDENTIAL_UNAVAILABLE", "MCP_TOOL_ACCESS_DENIED"].includes(error.code ?? "")) continue;
        return unavailable();
      }
    }
  } finally { clearTimeout(timeout); }
}
