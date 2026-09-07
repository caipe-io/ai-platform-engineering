/**
 * Conversation-scoped Dynamic Agents file list proxy.
 *
 * GET /api/dynamic-agents/conversations/[id]/files/list?agent_id=X
 *
 * Proxies to Dynamic Agents service: GET /api/v1/files/list
 */

import {
authenticateRequest,
getDynamicAgentsConfig,
proxyRequest,
} from "@/lib/da-proxy";
import { NextRequest,NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
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

  if (!agentId) {
    return NextResponse.json(
      { success: false, error: "agent_id query parameter is required" },
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

  const backendUrl = new URL("/api/v1/files/list", daConfig.dynamicAgentsUrl);
  backendUrl.searchParams.set("conversation_id", conversationId);
  backendUrl.searchParams.set("agent_id", agentId);

  return proxyRequest(backendUrl.toString(), "GET", authResult, "[conversation-files/list]");
}
