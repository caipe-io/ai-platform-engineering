/**
 * Conversation-scoped Dynamic Agents file content proxy.
 *
 * GET    /api/dynamic-agents/conversations/[id]/files/content?agent_id=X&path=file.txt
 * DELETE /api/dynamic-agents/conversations/[id]/files/content?agent_id=X&path=file.txt
 *
 * Proxies to Dynamic Agents service: /api/v1/files/content
 */

import {
authenticateRequest,
getDynamicAgentsConfig,
proxyRequest,
} from "@/lib/da-proxy";
import { NextRequest,NextResponse } from "next/server";

async function proxyFileContent(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
  method: "GET" | "DELETE",
): Promise<Response> {
  const { id: conversationId } = await context.params;

  if (!conversationId) {
    return NextResponse.json(
      { success: false, error: "Conversation ID is required" },
      { status: 400 },
    );
  }

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agent_id");
  const filePath = searchParams.get("path");

  if (!agentId) {
    return NextResponse.json(
      { success: false, error: "agent_id query parameter is required" },
      { status: 400 },
    );
  }

  if (!filePath) {
    return NextResponse.json(
      { success: false, error: "path query parameter is required" },
      { status: 400 },
    );
  }

  const authResult = await authenticateRequest(request, {
    resource: "dynamic_agent",
    scope: "invoke",
  });
  if (authResult instanceof NextResponse) return authResult;

  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  const backendUrl = new URL("/api/v1/files/content", daConfig.dynamicAgentsUrl);
  backendUrl.searchParams.set("conversation_id", conversationId);
  backendUrl.searchParams.set("agent_id", agentId);
  backendUrl.searchParams.set("path", filePath);

  return proxyRequest(
    backendUrl.toString(),
    method,
    authResult,
    `[conversation-files/content:${method}]`,
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return proxyFileContent(request, context, "GET");
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return proxyFileContent(request, context, "DELETE");
}
