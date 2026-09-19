/**
 * Invoke a saved MCP server tool for post-save testing.
 */

// assisted-by Codex Codex-sonnet-4-6

import crypto from "crypto";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import {
  readMcpToolApplicationSuccess,
  resolveMcpHeaderCredentials,
  isMcpCredentialUnavailableError,
} from "@/lib/mcp-credential-headers";
import {
  grantDiagnosticAgentAccess,
  revokeDiagnosticAgentAccess,
} from "@/lib/mcp-http-server-client";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type { MCPServerConfig } from "@/types/dynamic-agent";
import { NextRequest } from "next/server";

const COLLECTION_NAME = "mcp_servers";
const AGENT_CONTEXT_TTL_SECONDS = 300;

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(`${field} is required`, 400, "VALIDATION_ERROR");
  }
  return value.trim();
}

function readParams(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("params must be a JSON object", 400, "VALIDATION_ERROR");
  }
  return value as Record<string, unknown>;
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

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function b64url(data: string): string {
  return Buffer.from(data, "utf8").toString("base64url");
}

function diagnosticAgentId(serverId: string, session: Awaited<ReturnType<typeof getAuthFromBearerOrSession>>["session"]): string {
  const subject = typeof session?.sub === "string" && session.sub.trim() ? session.sub.trim() : "unknown";
  const hash = crypto.createHash("sha256").update(`${serverId}\n${subject}`).digest("hex").slice(0, 16);
  return `mcp-test-${serverId}-${hash}`.replace(/[^A-Za-z0-9._~@|*+=,/-]/g, "-").slice(0, 191);
}

function buildAgentContextHeaders(agentId: string): Record<string, string> {
  const secret = process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET?.trim();
  if (!secret) return {};

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    agent_id: agentId,
    iat: issuedAt,
    exp: issuedAt + AGENT_CONTEXT_TTL_SECONDS,
  };
  const encoded = b64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("hex");
  return {
    "X-CAIPE-Agent-Context": encoded,
    "X-CAIPE-Agent-Context-Signature": signature,
  };
}

function isAgentGatewayEndpoint(server: MCPServerConfig): boolean {
  if (server.source === "agentgateway" || server.agentgateway_discovered) return true;
  if (!server.endpoint) return false;

  const base = stripTrailingSlash(process.env.AGENT_GATEWAY_URL || "http://agentgateway:4000");
  try {
    const endpointUrl = new URL(server.endpoint);
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
}): Promise<{ ok: boolean; status: number; payload: unknown; sessionId?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
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

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const body = (await request.json()) as Record<string, unknown>;
  const serverId = readString(body.serverId, "serverId");
  const toolName = readString(body.toolName, "toolName");
  const params = readParams(body.params);

  await requireResourcePermission(session, { type: "mcp_server", id: serverId, action: "invoke" });

  const collection = await getCollection<MCPServerConfig>(COLLECTION_NAME);
  const server = await collection.findOne({ _id: serverId });
  if (!server) throw new ApiError("MCP server not found", 404);
  if (!server.enabled) throw new ApiError("MCP server is disabled", 400);
  if (server.transport !== "http" || !server.endpoint) {
    throw new ApiError("Tool testing currently supports HTTP MCP servers", 400, "UNSUPPORTED_TRANSPORT");
  }

  const viaAgentGateway = isAgentGatewayEndpoint(server);
  const diagnosticAgent = diagnosticAgentId(serverId, session);

  let credentialResolution;
  try {
    credentialResolution = await resolveMcpHeaderCredentials({
      request,
      session,
      server,
      viaAgentGateway,
      retrievalCaller: "mcp-test-tool",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "MCP_AUTH_REQUIRED") {
      throw new ApiError(
        "A signed-in user token is required to test AgentGateway-routed MCP tools",
        401,
        "MCP_TEST_AUTH_REQUIRED",
      );
    }
    if (isMcpCredentialUnavailableError(error)) {
      throw new ApiError(
        error instanceof Error ? error.message : "MCP provider credential is unavailable",
        401,
        "MCP_CREDENTIAL_UNAVAILABLE",
      );
    }
    throw error;
  }

  const diagnosticTuples = viaAgentGateway
    ? await grantDiagnosticAgentAccess(
        serverId,
        diagnosticAgent,
        session,
        credentialResolution.authorizationSubject,
      )
    : [];

  try {
    const headers = {
      ...credentialResolution.headers,
      ...buildAgentContextHeaders(diagnosticAgent),
    };

    const initialized = await mcpJsonRpc({
      endpoint: server.endpoint,
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
    });
    if (!initialized.ok || !initialized.sessionId) {
      throw new ApiError(`MCP initialize failed with HTTP ${initialized.status}`, 502, "MCP_INIT_FAILED");
    }

    const invoked = await mcpJsonRpc({
      endpoint: server.endpoint,
      headers,
      sessionId: initialized.sessionId,
      payload: {
        jsonrpc: "2.0",
        id: `tools-call-${Date.now()}`,
        method: "tools/call",
        params: { name: toolName, arguments: params },
      },
    });
    const payload = invoked.payload as { error?: { message?: unknown }; result?: unknown } | null;
    const errorMessage = typeof payload?.error?.message === "string" ? payload.error.message : undefined;
    const toolResult = payload?.result ?? invoked.payload;
    const applicationSuccess = readMcpToolApplicationSuccess(toolResult);
    const transportSuccess = invoked.ok && !payload?.error;

    return successResponse({
      server_id: serverId,
      tool_name: toolName,
      success: transportSuccess,
      application_success: applicationSuccess ?? transportSuccess,
      status: invoked.status,
      result: toolResult,
      credential_resolution: credentialResolution.sources,
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  } finally {
    await revokeDiagnosticAgentAccess(diagnosticTuples, "mcp-servers/test-tool");
  }
});
