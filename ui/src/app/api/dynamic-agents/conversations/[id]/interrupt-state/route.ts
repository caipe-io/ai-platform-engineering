import { proxyHarnessConversationOperation } from "@/lib/harness-gateway";
/**
 * Proxy route for fetching dynamic agent HITL interrupt state.
 *
 * GET /api/dynamic-agents/conversations/[id]/interrupt-state?agent_id=X
 *
 * This is a lightweight endpoint that only checks for pending human-in-the-loop
 * interrupts. Messages are loaded separately from the MongoDB messages collection
 * via the standard /api/chat/conversations/[id]/messages endpoint.
 */

import {
authenticateRequest,
getDynamicAgentsConfig,
proxyRequest,
} from "@/lib/da-proxy";
import { NextRequest,NextResponse } from "next/server";

/**
 * GET /api/dynamic-agents/conversations/[id]/interrupt-state
 * Proxy to Dynamic Agents service to check for HITL interrupt state.
 */
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

  // Authenticate
  const authResult = await authenticateRequest(request, {
    resource: "dynamic_agent",
    scope: "invoke",
  });
  if (authResult instanceof NextResponse) return authResult;
  const harness = await proxyHarnessConversationOperation(authResult, conversationId, agentId, "interrupt");
  if (harness) return harness;

  // Check DA config
  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  // Build backend URL
  const backendUrl = new URL(
    `/api/v1/conversations/${conversationId}/interrupt-state`,
    daConfig.dynamicAgentsUrl,
  );
  backendUrl.searchParams.set("agent_id", agentId);

  return proxyRequest(backendUrl.toString(), "GET", authResult, "[interrupt-state]");
}
