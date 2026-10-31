/**
 * Shared HTTP MCP JSON-RPC helpers for BFF probe and test-tool routes.
 */

// assisted-by Codex Codex-sonnet-4-6

import crypto from "crypto";

import { ApiError } from "@/lib/api-middleware";
import {
  resolveMcpHeaderCredentials,
  type McpCredentialResolution,
} from "@/lib/mcp-credential-headers";
import type { MCPServerConfig, MCPToolInfo } from "@/types/dynamic-agent";
import type { NextRequest } from "next/server";

// "local" contexts (minted by POST /api/mcp-servers/agent-context for CLI/
// local callers, e.g. Claude Code's forge-rag MCP server) get a much longer
// TTL than "dynamic" ones (Dynamic Agents runtime, the diagnostic test-tool
// flow below). Those clients cache MCP headers for the life of a whole
// session/connection rather than refreshing per request, so a short TTL
// would force a re-auth or a failed-then-retried tool call every few
// minutes. A longer TTL is safe here because the openfga-authz-bridge skips
// the agent:<id> can_use/can_call checks entirely for "local" contexts —
// they carry no delegated authority beyond what the signed-in user already
// has, so there's no separate grant window to bound tightly. See the
// "kind" handling in deploy/openfga/bridge/main.py.
type AgentContextKind = "dynamic" | "local";
const AGENT_CONTEXT_TTL_SECONDS: Record<AgentContextKind, number> = {
  dynamic: 300,
  local: 60 * 60 * 8,
};

// Saved AgentGateway routes are reconciled asynchronously by the config
// bridge. A connection test can therefore reach the Gateway just before the
// new route is installed and receive a transient 404. Retry only that status;
// upstream failures and authorization denials must still fail immediately.
const AGENT_GATEWAY_ROUTE_RETRY_DELAYS_MS = [250, 500, 1_000, 1_500, 2_500] as const;

type AuthSession = {
  sub?: string;
  accessToken?: string;
} | null | undefined;

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

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function b64url(data: string): string {
  return Buffer.from(data, "utf8").toString("base64url");
}

export function diagnosticAgentId(serverId: string, session: AuthSession): string {
  const subject = typeof session?.sub === "string" && session.sub.trim() ? session.sub.trim() : "unknown";
  const hash = crypto.createHash("sha256").update(`${serverId}\n${subject}`).digest("hex").slice(0, 16);
  return `mcp-test-${serverId}-${hash}`.replace(/[^A-Za-z0-9._~@|*+=,/-]/g, "-").slice(0, 191);
}

export function localAgentContextId(session: AuthSession): string {
  const subject = typeof session?.sub === "string" && session.sub.trim() ? session.sub.trim() : "unknown";
  const hash = crypto.createHash("sha256").update(subject).digest("hex").slice(0, 16);
  return `mcp-local-agent-${hash}`.replace(/[^A-Za-z0-9._~@|*+=,/-]/g, "-").slice(0, 191);
}

export function buildAgentContextHeaders(
  agentId: string,
  kind: AgentContextKind = "dynamic",
): Record<string, string> {
  const secret = process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET?.trim();
  if (!secret) return {};

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    agent_id: agentId,
    iat: issuedAt,
    exp: issuedAt + AGENT_CONTEXT_TTL_SECONDS[kind],
    kind,
  };
  const encoded = b64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("hex");
  return {
    "X-CAIPE-Agent-Context": encoded,
    "X-CAIPE-Agent-Context-Signature": signature,
  };
}

export function isAgentGatewayEndpoint(server: MCPServerConfig): boolean {
  if (server.source === "agentgateway" || server.agentgateway_discovered) return true;
  if (!server.endpoint) return false;

  return isAgentGatewayRouteEndpoint(server.endpoint);
}

function isAgentGatewayRouteEndpoint(endpoint: string): boolean {
  const base = stripTrailingSlash(process.env.AGENT_GATEWAY_URL || "http://agentgateway:4000");
  try {
    const endpointUrl = new URL(endpoint);
    const baseUrl = new URL(base);
    return endpointUrl.origin === baseUrl.origin && endpointUrl.pathname.startsWith("/mcp");
  } catch {
    return false;
  }
}

async function readJsonOrSse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  const text = await response.text();
  const sseJson = contentType.includes("text/event-stream") ? parseSseJson(text) : null;
  if (sseJson) return sseJson;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function mcpJsonRpc(input: {
  endpoint: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  sessionId?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; payload: unknown; sessionId?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);
  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        accept: "application/json, text/event-stream;q=0.9, */*;q=0.1",
        "content-type": "application/json",
        ...input.headers,
        ...(input.sessionId ? { "mcp-session-id": input.sessionId } : {}),
      },
      body: JSON.stringify(input.payload),
    });
    return {
      ok: response.ok,
      status: response.status,
      payload: await readJsonOrSse(response),
      sessionId: response.headers.get("mcp-session-id") ?? input.sessionId,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function wait(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function normalizeTool(tool: unknown): MCPToolInfo | null {
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
  const namespacedName =
    typeof candidate.namespaced_name === "string" && candidate.namespaced_name.trim()
      ? candidate.namespaced_name.trim()
      : name;
  const inputSchema = candidate.inputSchema ?? candidate.input_schema;
  return {
    name,
    namespaced_name: namespacedName,
    description: typeof candidate.description === "string" ? candidate.description : "",
    ...(inputSchema !== undefined ? { inputSchema } : {}),
  };
}

function extractTools(payload: unknown): MCPToolInfo[] | null {
  const body = payload as { result?: { tools?: unknown }; tools?: unknown } | null;
  const tools = Array.isArray(body?.result?.tools)
    ? body.result.tools
    : Array.isArray(body?.tools)
      ? body.tools
      : null;
  if (!tools) return null;
  return tools.map(normalizeTool).filter((tool): tool is MCPToolInfo => Boolean(tool));
}

async function buildMcpRequestHeaders(input: {
  request: NextRequest;
  session: AuthSession;
  server: MCPServerConfig;
  viaAgentGateway: boolean;
  serverId: string;
  credentialResolution?: McpCredentialResolution;
}): Promise<Record<string, string>> {
  try {
    const resolution =
      input.credentialResolution ??
      (await resolveMcpHeaderCredentials({
        request: input.request,
        session: input.session,
        server: input.server,
        viaAgentGateway: input.viaAgentGateway,
        retrievalCaller: "mcp-http-server-client",
      }));
    return {
      ...resolution.headers,
      ...(input.viaAgentGateway
        ? buildAgentContextHeaders(diagnosticAgentId(input.serverId, input.session))
        : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.message === "MCP_AUTH_REQUIRED") {
      throw new ApiError(
        "A signed-in user token is required for AgentGateway-routed MCP servers",
        401,
        "MCP_AUTH_REQUIRED",
      );
    }
    throw error;
  }
}

export async function listHttpMcpTools(input: {
  request: NextRequest;
  session: AuthSession;
  server: MCPServerConfig & { endpoint: string };
  serverId: string;
  credentialResolution?: McpCredentialResolution;
}): Promise<{ tools: MCPToolInfo[]; sessionId?: string }> {
  const agentGatewayManaged = isAgentGatewayEndpoint(input.server);
  const endpoint = input.server.endpoint.trim();
  if (agentGatewayManaged && !isAgentGatewayRouteEndpoint(endpoint)) {
    throw new ApiError(
      "AgentGateway-managed MCP server is missing its Gateway route",
      502,
      "MCP_GATEWAY_ROUTE_MISSING",
    );
  }
  const headers = await buildMcpRequestHeaders({
    request: input.request,
    session: input.session,
    server: input.server,
    viaAgentGateway: agentGatewayManaged,
    serverId: input.serverId,
    credentialResolution: input.credentialResolution,
  });

  const initialize = () => mcpJsonRpc({
    endpoint,
    headers,
    payload: {
      jsonrpc: "2.0",
      id: `initialize-${Date.now()}`,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "caipe-ui", version: "0.5.16" },
      },
    },
    timeoutMs: 5_000,
  });
  let initialized = await initialize();
  if (agentGatewayManaged) {
    for (const delayMs of AGENT_GATEWAY_ROUTE_RETRY_DELAYS_MS) {
      if (initialized.status !== 404) break;
      await wait(delayMs);
      initialized = await initialize();
    }
  }
  if (!initialized.ok || !initialized.sessionId) {
    throw new ApiError(`MCP initialize failed with HTTP ${initialized.status}`, 502, "MCP_INIT_FAILED");
  }

  const listed = await mcpJsonRpc({
    endpoint,
    headers,
    sessionId: initialized.sessionId,
    payload: {
      jsonrpc: "2.0",
      id: `tools-list-${Date.now()}`,
      method: "tools/list",
      params: {},
    },
    timeoutMs: 5_000,
  });
  if (!listed.ok) {
    throw new ApiError(`MCP tools/list failed with HTTP ${listed.status}`, 502, "MCP_LIST_FAILED");
  }
  const tools = extractTools(listed.payload);
  if (!tools) {
    throw new ApiError("MCP tools/list returned an unexpected payload", 502, "MCP_LIST_INVALID");
  }
  return { tools, sessionId: initialized.sessionId };
}

export async function listDirectHttpMcpTools(input: {
  endpoint: string;
  timeoutMs?: number;
}): Promise<{ tools: MCPToolInfo[]; sessionId?: string }> {
  // assisted-by Codex Codex-sonnet-4-6
  // Health diagnostics are read-only: list tools directly without temporary
  // AgentGateway authorization tuples or tool invocation smoke tests.
  const headers: Record<string, string> = {};
  const first = await mcpJsonRpc({
    endpoint: input.endpoint,
    headers,
    payload: {
      jsonrpc: "2.0",
      id: `tools-list-${Date.now()}`,
      method: "tools/list",
      params: {},
    },
    timeoutMs: input.timeoutMs,
  });
  if (first.ok) {
    const tools = extractTools(first.payload);
    if (tools) return { tools, sessionId: first.sessionId };
  }

  const initialized = await mcpJsonRpc({
    endpoint: input.endpoint,
    headers,
    payload: {
      jsonrpc: "2.0",
      id: `initialize-${Date.now()}`,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "caipe-ui-health", version: "0.5.16" },
      },
    },
    timeoutMs: input.timeoutMs,
  });
  if (!initialized.ok || !initialized.sessionId) {
    throw new ApiError(`MCP initialize failed with HTTP ${initialized.status}`, 502, "MCP_INIT_FAILED");
  }

  const listed = await mcpJsonRpc({
    endpoint: input.endpoint,
    headers,
    sessionId: initialized.sessionId,
    payload: {
      jsonrpc: "2.0",
      id: `tools-list-${Date.now()}`,
      method: "tools/list",
      params: {},
    },
    timeoutMs: input.timeoutMs,
  });
  if (!listed.ok) {
    throw new ApiError(`MCP tools/list failed with HTTP ${listed.status}`, 502, "MCP_LIST_FAILED");
  }

  const tools = extractTools(listed.payload);
  if (!tools) {
    throw new ApiError("MCP tools/list returned an unexpected payload", 502, "MCP_LIST_INVALID");
  }
  return { tools, sessionId: initialized.sessionId };
}
