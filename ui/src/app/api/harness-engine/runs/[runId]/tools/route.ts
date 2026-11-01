import { NextRequest, NextResponse } from "next/server";

import { authorizeHarnessRunAccess } from "../../../_run-authz";
import { ApiError, withErrorHandler } from "@/lib/api-middleware";
import { proxyHarnessEngine } from "@/lib/harness-engine-proxy";
import { callHttpMcpTool, listHttpMcpTools } from "@/lib/mcp-http-server-client";
import { getCollection } from "@/lib/mongodb";
import { normalizeMcpEndpointForServer } from "@/lib/rbac/mcp-endpoint-normalizer";
import { filterResourcesByPermission } from "@/lib/rbac/resource-authz";
import type { DynamicAgentConfig, MCPServerConfig } from "@/types/dynamic-agent";
import type { AgentBlueprint } from "@/types/harness-engine";

export const runtime = "nodejs";
export const maxDuration = 960;

/** SDK tool calls retain the user's identity and the real agent's current policy. */
export const POST = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) => {
  const { runId } = await context.params;
  const access = await authorizeHarnessRunAccess(request, runId, "write");
  if (access instanceof NextResponse) return access;
  const session = access.auth.authenticatedUser?.session;
  if (!session) throw new ApiError("An authenticated caller session is required", 401);
  const body = await request.json().catch(() => null);
  if (!body || !["list", "call"].includes(body.operation)) throw new ApiError("Expected list or call", 400);
  const run = (await access.response.json()).data;
  if (run.status !== "running" || !["claude_agent_sdk", "claude_agent_sdk_remote"].includes(run.harness_id)) {
    throw new ApiError("Tools require an active SDK run", 409);
  }
  const saved = await proxyHarnessEngine(access.config, access.auth,
    `/api/v1/agents/${encodeURIComponent(run.agent_id)}?version=${run.agent_version}`);
  if (!saved.ok) throw new ApiError("Pinned execution configuration is unavailable", 503);
  const blueprint = (await saved.json()).data?.version?.blueprint as AgentBlueprint | undefined;
  if (!blueprint || blueprint.id !== run.agent_id || blueprint.tools?.approval_policy !== "never") {
    throw new ApiError("SDK tools require an explicit policy without per-call approvals", 409);
  }
  const agent = await (await getCollection<DynamicAgentConfig>("dynamic_agents")).findOne({ _id: run.agent_id });
  if (!agent?.enabled) throw new ApiError("Agent is disabled or unavailable", 403);
  const gateway = process.env.AGENT_GATEWAY_URL?.trim();
  if (!gateway) throw new ApiError("AgentGateway is required for SDK tools", 503);
  const servers = await (await getCollection<MCPServerConfig>("mcp_servers")).find({ enabled: true }).toArray();
  const bindings = blueprint.tools.bindings.map(binding => {
    const matches = servers.filter(server => binding.tool_id.startsWith(`${server._id}.`));
    matches.sort((a, b) => String(b._id).length - String(a._id).length);
    const server = matches[0];
    if (!server) throw new ApiError("A selected MCP server is unavailable", 403);
    const serverId = String(server._id);
    const toolName = binding.tool_id.slice(serverId.length + 1);
    const allowed = agent.allowed_tools?.[serverId];
    if (!toolName || !(allowed === true || Array.isArray(allowed) && (!allowed.length || allowed.includes(toolName)))) {
      throw new ApiError("A selected tool is no longer allowed for this agent", 403);
    }
    return { tool_id: binding.tool_id, server, serverId, toolName };
  });
  const selected = [...new Map(bindings.map(binding => [binding.serverId, binding.server])).values()];
  const permitted = await filterResourcesByPermission(session, selected, {
    type: "mcp_server", action: "invoke", id: server => String(server._id),
  });
  if (permitted.length !== selected.length) throw new ApiError("MCP server access denied", 403);
  const connection = (binding: typeof bindings[number]) => ({
    request, session, agentId: run.agent_id, serverId: binding.serverId,
    server: { ...binding.server, source: "agentgateway" as const,
      endpoint: normalizeMcpEndpointForServer({ endpoint: gateway, serverId: binding.serverId, agentGatewayBaseUrl: gateway })! },
  });
  if (body.operation === "call") {
    const binding = bindings.find(item => item.tool_id === body.tool_id);
    if (!binding) throw new ApiError("Tool is not in the pinned execution allowlist", 403);
    if (!body.arguments || typeof body.arguments !== "object" || Array.isArray(body.arguments)) {
      throw new ApiError("Tool arguments must be an object", 400);
    }
    const result = await callHttpMcpTool({ ...connection(binding), toolName: binding.toolName, args: body.arguments });
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  }
  const schemas = new Map<string, Awaited<ReturnType<typeof listHttpMcpTools>>["tools"]>();
  for (const binding of bindings) {
    if (!schemas.has(binding.serverId)) schemas.set(binding.serverId, (await listHttpMcpTools(connection(binding))).tools);
  }
  const tools = bindings.map(binding => {
    const schema = schemas.get(binding.serverId)?.find(tool => tool.name === binding.toolName || tool.namespaced_name === binding.toolName);
    if (!schema) throw new ApiError("A selected MCP tool is unavailable", 409);
    return { tool_id: binding.tool_id, description: schema.description ?? "", input_schema: schema.inputSchema ?? { type: "object" } };
  });
  return NextResponse.json({ success: true, data: { tools } }, { headers: { "Cache-Control": "no-store" } });
});
