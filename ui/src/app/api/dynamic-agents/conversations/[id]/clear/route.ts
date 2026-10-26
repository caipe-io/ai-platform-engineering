import { proxyHarnessConversationOperation } from "@/lib/harness-gateway";
/**
 * Proxy route for clearing conversation checkpoint data (admin only).
 *
 * POST /api/dynamic-agents/conversations/[id]/clear
 *
 * This proxies to the Dynamic Agents service admin endpoint that clears
 * checkpoint data while keeping conversation metadata for audit purposes.
 */

import {
authenticateRequest,
getDynamicAgentsConfig,
proxyRequest,
} from "@/lib/da-proxy";
import { NextRequest,NextResponse } from "next/server";

/**
 * POST /api/dynamic-agents/conversations/[id]/clear
 * Proxy to Dynamic Agents service to clear checkpoint data (admin only).
 */
export async function POST(
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

  // Authenticate
  const authResult = await authenticateRequest(request, {
    resource: "dynamic_agent",
    scope: "invoke",
  });
  if (authResult instanceof NextResponse) return authResult;

  const body = await request.clone().json().catch(() => null);
  const requestedAgent = new URL(request.url).searchParams.get("agent_id") ?? (typeof body?.agent_id === "string" ? body.agent_id : undefined);
  const harness = await proxyHarnessConversationOperation(authResult, conversationId, requestedAgent, "clear");
  if (harness) return harness;

  // Check DA config
  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  // Build backend URL
  const backendUrl = new URL(
    `/api/v1/conversations/${conversationId}/clear`,
    daConfig.dynamicAgentsUrl,
  );

  return proxyRequest(backendUrl.toString(), "POST", authResult, "[clear]");
}
