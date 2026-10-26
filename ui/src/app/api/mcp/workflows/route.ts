/**
 * Workflows MCP endpoint (MCP streamable HTTP, stateless).
 *
 * Lets agents and MCP clients define, run and monitor workflows without a
 * separate MCP container. Reached through AgentGateway like other MCP servers,
 * which forwards the caller's `Authorization: Bearer` token. Every tool call
 * runs the existing workflow route handlers as that caller, so their
 * authorization applies unchanged.
 *
 * Returns 404 unless `WORKFLOWS_ENABLED=true`, and requires a bearer token (not a
 * browser session cookie) so the endpoint cannot be driven by cross-site requests.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextRequest, NextResponse } from "next/server";

import { getAuthFromBearerOrSession, handleApiError } from "@/lib/api-middleware";
import { config } from "@/lib/config";
import { createWorkflowsMcpServer } from "@/lib/server/workflows-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BEARER = /^Bearer\s+\S+/i;

function jsonRpcError(status: number, message: string, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status, headers });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!config.workflowsEnabled) {
    return jsonRpcError(404, "Workflows are not enabled on this instance.");
  }

  const authorization = request.headers.get("authorization") ?? "";
  if (!BEARER.test(authorization)) {
    return jsonRpcError(401, "A bearer token is required.", { "WWW-Authenticate": "Bearer" });
  }

  try {
    await getAuthFromBearerOrSession(request);
  } catch (error) {
    return handleApiError(error);
  }

  // Stateless: a fresh server and transport per request, nothing kept between calls.
  const server = createWorkflowsMcpServer({ authorization, origin: request.nextUrl.origin });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}

// Stateless server: no standalone SSE stream (GET) and no sessions to terminate (DELETE).
const methodNotAllowed = () => jsonRpcError(405, "Method not allowed.", { Allow: "POST" });
export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
