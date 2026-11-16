/**
 * API route for probing MCP servers to discover available tools.
 *
 * This endpoint proxies to the dynamic-agents backend service which
 * actually connects to the MCP server and retrieves the tool list.
 * Auth is forwarded via X-User-Context header (same as chat routes).
 */

import {
ApiError,
getAuthFromBearerOrSession,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { authenticateRequest,buildBackendHeaders } from "@/lib/da-proxy";
import { isAgentGatewayEndpoint, listHttpMcpTools } from "@/lib/mcp-http-server-client";
import { getCollection } from "@/lib/mongodb";
import { cacheMcpToolCatalog } from "@/lib/rbac/mcp-tool-catalog";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type { MCPServerConfig,MCPToolInfo } from "@/types/dynamic-agent";
import { NextRequest,NextResponse } from "next/server";

const COLLECTION_NAME = "mcp_servers";

// Dynamic agents backend URL
const DYNAMIC_AGENTS_URL = process.env.DYNAMIC_AGENTS_URL || "http://localhost:8100";

interface DirectMcpToolInfo extends MCPToolInfo {
  inputSchema?: unknown;
}

interface DirectToolsResult {
  tools: DirectMcpToolInfo[];
  sessionId?: string;
}

interface ToolSmokeTest {
  toolName: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
}

function isHttpMcpServer(server: MCPServerConfig): server is MCPServerConfig & { endpoint: string } {
  return server.transport === "http" && typeof server.endpoint === "string" && server.endpoint.trim().length > 0;
}

function normalizeTool(tool: unknown): DirectMcpToolInfo | null {
  if (!tool || typeof tool !== "object") return null;
  const candidate = tool as {
    name?: unknown;
    namespaced_name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    input_schema?: unknown;
  };
  if (typeof candidate.name !== "string" || !candidate.name.trim()) return null;
  const name = candidate.name.trim();
  const namespacedName = typeof candidate.namespaced_name === "string" && candidate.namespaced_name.trim()
    ? candidate.namespaced_name.trim()
    : name;
  return {
    name,
    namespaced_name: namespacedName,
    description: typeof candidate.description === "string" ? candidate.description : "",
    inputSchema: candidate.inputSchema ?? candidate.input_schema,
  };
}

function extractTools(payload: unknown): DirectMcpToolInfo[] | null {
  const body = payload as { result?: { tools?: unknown }; tools?: unknown } | null;
  const tools = Array.isArray(body?.result?.tools)
    ? body.result.tools
    : Array.isArray(body?.tools)
      ? body.tools
      : null;
  if (!tools) return null;
  return tools.map(normalizeTool).filter((tool): tool is DirectMcpToolInfo => Boolean(tool));
}

function parseSseJson(text: string): unknown | null {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    try {
      return JSON.parse(data);
    } catch {
      continue;
    }
  }
  return null;
}

async function readJsonOrSse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  const sseJson = contentType.includes("text/event-stream") ? parseSseJson(text) : null;
  if (sseJson) return sseJson;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function mcpJsonRpc(
  endpoint: string,
  payload: Record<string, unknown>,
  sessionId?: string,
): Promise<{ ok: boolean; payload: unknown; sessionId?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        accept: "application/json, text/event-stream;q=0.9, */*;q=0.1",
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(payload),
    });
    return {
      ok: response.ok,
      payload: await readJsonOrSse(response),
      sessionId: response.headers.get("mcp-session-id") ?? undefined,
    };
  } catch {
    return { ok: false, payload: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function listToolsDirect(server: MCPServerConfig & { endpoint: string }): Promise<DirectToolsResult | null> {
  // assisted-by Codex Codex-sonnet-4-6
  // Direct HTTP MCP tool discovery avoids a runtime round trip when the
  // server exposes the standard tools/list method. Streamable HTTP servers
  // commonly require initialize first, so support both stateless and
  // session-bound variants.
  const first = await mcpJsonRpc(server.endpoint, {
    jsonrpc: "2.0",
    id: `tools-list-${Date.now()}`,
    method: "tools/list",
    params: {},
  });
  if (first.ok) {
    const tools = extractTools(first.payload);
    if (tools) return { tools, sessionId: first.sessionId };
  }

  const initialized = await mcpJsonRpc(server.endpoint, {
    jsonrpc: "2.0",
    id: `initialize-${Date.now()}`,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "caipe-ui",
        version: "0.5.16",
      },
    },
  });
  if (!initialized.ok || !initialized.sessionId) return null;

  const withSession = await mcpJsonRpc(
    server.endpoint,
    {
      jsonrpc: "2.0",
      id: `tools-list-${Date.now()}`,
      method: "tools/list",
      params: {},
    },
    initialized.sessionId,
  );
  if (!withSession.ok) return null;
  const tools = extractTools(withSession.payload);
  return tools ? { tools, sessionId: initialized.sessionId } : null;
}

function hasRequiredArguments(tool: DirectMcpToolInfo): boolean {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object") return false;
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) && required.length > 0;
}

function pickSafeNoArgumentTool(tools: DirectMcpToolInfo[]): DirectMcpToolInfo | null {
  const noArgTools = tools.filter((tool) => !hasRequiredArguments(tool));
  const preferred = noArgTools.find((tool) => /(version|health|ping|status|about|info)/i.test(tool.name));
  return preferred ?? null;
}

async function smokeTestNoArgumentTool(
  server: MCPServerConfig & { endpoint: string },
  tools: DirectMcpToolInfo[],
  sessionId?: string,
): Promise<ToolSmokeTest | undefined> {
  const tool = pickSafeNoArgumentTool(tools);
  if (!tool) return undefined;
  const response = await mcpJsonRpc(
    server.endpoint,
    {
      jsonrpc: "2.0",
      id: `tools-call-${Date.now()}`,
      method: "tools/call",
      params: {
        name: tool.name,
        arguments: {},
      },
    },
    sessionId,
  );
  if (!response.ok) {
    return { toolName: tool.name, success: false, error: "Tool call failed" };
  }
  const payload = response.payload as { error?: { message?: unknown } } | null;
  if (payload?.error) {
    return {
      toolName: tool.name,
      success: false,
      error: typeof payload.error.message === "string" ? payload.error.message : "Tool call failed",
    };
  }
  return { toolName: tool.name, success: true };
}

/**
 * POST /api/mcp-servers/probe?id=<server_id>
 * Probe an MCP server to discover available tools.
 *
 * Authorization model:
 *   Probing only enumerates the tools advertised by an MCP server — it is
 *   strictly less powerful than runtime tool *invocation*. Users who can
 *   read the server (because it's shared with them via team/channel/group
 *   membership, or because they are organization members or admins) need
 *   to be able to render the Probe button on the Create Agent → Tools
 *   step even if they don't yet have `can_invoke`. We therefore gate this
 *   route on `mcp_server:<id>#can_discover`. The authorization model
 *   defines `can_discover` as `can_read = reader ∪ can_use ∪ can_manage ∪
 *   owner`, which transitively grants discover to every direct relation
 *   (`reader`, `user`, `invoker`, `manager`, `owner`) and to indirect
 *   relations via `team#member`, `team#admin`, `external_group#member`,
 *   `slack_channel`, `webex_space`, `organization#member`, and
 *   `organization#admin`. Runtime tool invocation continues to enforce
 *   `can_invoke` separately on the agent execution path.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    throw new ApiError("Server ID is required", 400);
  }

  const { session } = await getAuthFromBearerOrSession(request);

    const collection = await getCollection<MCPServerConfig>(COLLECTION_NAME);

    // Check if server exists
    const server = await collection.findOne({ _id: id });
    if (!server) {
      throw new ApiError("MCP server not found", 404);
    }

    if (!server.enabled) {
      throw new ApiError("MCP server is disabled", 400);
    }
    await requireResourcePermission(session, { type: "mcp_server", id, action: "discover" });

    try {
      if (isHttpMcpServer(server)) {
        if (isAgentGatewayEndpoint(server)) {
          let listed: Awaited<ReturnType<typeof listHttpMcpTools>>;
          try {
            listed = await listHttpMcpTools({
              request,
              session,
              server,
              serverId: id,
            });
          } catch (gwErr: unknown) {
            if (gwErr instanceof ApiError) throw gwErr;
            const msg = gwErr instanceof Error ? gwErr.message : "";
            const code = gwErr instanceof Error && typeof (gwErr as NodeJS.ErrnoException).cause === "object"
              ? String(((gwErr as NodeJS.ErrnoException).cause as { code?: unknown })?.code ?? "")
              : "";
            if (code === "ECONNREFUSED" || msg.includes("fetch failed")) {
              throw new ApiError(
                "AgentGateway is not reachable. Check that the agentgateway service is running and healthy.",
                503,
              );
            }
            throw new ApiError(msg || "AgentGateway request failed", 502);
          }
          const toolTest = await smokeTestNoArgumentTool(server, listed.tools, listed.sessionId);
          try {
            await cacheMcpToolCatalog({
              serverId: id,
              tools: listed.tools,
              source: "probe",
            });
          } catch (cacheError) {
            console.warn("[mcp-servers/probe] failed to cache AgentGateway tool catalog:", cacheError);
          }
          return successResponse({
            server_id: id,
            success: true,
            tools: listed.tools,
            source: "agentgateway",
            ...(toolTest ? { tool_test: toolTest } : {}),
          });
        }

        const directResult = await listToolsDirect(server);
        if (directResult) {
          const toolTest = await smokeTestNoArgumentTool(server, directResult.tools, directResult.sessionId);
          try {
            await cacheMcpToolCatalog({
              serverId: id,
              tools: directResult.tools.map((tool) => ({
                ...tool,
                input_schema: tool.inputSchema,
              })),
              source: "probe",
            });
          } catch (cacheError) {
            console.warn("[mcp-servers/probe] failed to cache direct tool catalog:", cacheError);
          }
          return successResponse({
            server_id: id,
            success: true,
            tools: directResult.tools,
            source: "direct",
            ...(toolTest ? { tool_test: toolTest } : {}),
          });
        }
      }

      // Build headers with X-User-Context AND Authorization: Bearer
      // (Spec 102 Phase 11.4 — DA now requires Bearer; X-User-Context kept
      // for legacy claim hints but is no longer authoritative).
      const auth = await authenticateRequest(request);
      if (auth instanceof NextResponse) return auth;
      const headers = buildBackendHeaders("application/json", auth);

      // Call the dynamic agents backend to probe the server
      const response = await fetch(`${DYNAMIC_AGENTS_URL}/api/v1/mcp-servers/${id}/probe`, {
        method: "POST",
        headers,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new ApiError(
          errorData.detail || `Probe failed with status ${response.status}`,
          response.status,
        );
      }

      const probeResult = await response.json();

      // Forward the probe result from backend, preserving success/error status
      if (probeResult.success === false) {
        // Backend returned a probe failure (e.g., connection error)
        return successResponse({
          server_id: id,
          success: false,
          error: probeResult.error || "Probe failed",
          tools: [],
        });
      }

      try {
        await cacheMcpToolCatalog({
          serverId: id,
          tools: Array.isArray(probeResult.tools) ? probeResult.tools : [],
          source: "probe",
        });
      } catch (cacheError) {
        console.warn("[mcp-servers/probe] failed to cache tool catalog:", cacheError);
      }

      return successResponse({
        server_id: id,
        success: true,
        tools: probeResult.tools || [],
      });
    } catch (err: unknown) {
      // If it's already an ApiError, rethrow
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : "";
      const causeCode = err instanceof Error && typeof err.cause === "object" && err.cause !== null && "code" in err.cause
        ? String((err.cause as { code?: unknown }).code)
        : "";

      // Handle connection errors to the dynamic-agents backend
      if (causeCode === "ECONNREFUSED" || message.includes("fetch failed")) {
        throw new ApiError(
          "Dynamic agents service is not reachable. Check that the dynamic-agents container is running.",
          503,
        );
      }

      throw new ApiError(message || "Failed to probe MCP server", 500);
    }
});
