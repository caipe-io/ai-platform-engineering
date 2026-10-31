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
import { authorizeConversationWriteAccess, resolveConversationRuntimeId } from "@/app/api/v1/chat/_conversation-authz";
import { getCollection } from "@/lib/mongodb";
import { getAgentId } from "@/types/a2a";
import type { Conversation } from "@/types/mongodb";
import { resolveHarnessGatewayTarget, getHarnessGatewayNativeThread } from "@/lib/harness-gateway";
import { POST as clearEngineSession } from "@/app/api/harness-engine/sessions/clear/route";
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

  const conversation = await (await getCollection<Conversation>("conversations")).findOne({ _id: conversationId });
  const agentId = conversation ? getAgentId(conversation) : undefined;
  if (!agentId || !authResult.subject) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  const access = await authorizeConversationWriteAccess(authResult, conversationId, agentId);
  if (access.denial) return access.denial;
  const runtimeId = await resolveConversationRuntimeId(access.conversation);
  const pinned = await resolveHarnessGatewayTarget(agentId, { subject: authResult.subject, conversationId: runtimeId });
  if (pinned instanceof NextResponse) return pinned;
  if (pinned?.kind === "harness_engine") {
    if (authResult.role !== "admin") return NextResponse.json({ error: "Admin permission is required" }, { status: 403 });
    return clearEngineSession(new NextRequest(new URL("/api/harness-engine/sessions/clear", request.url), {
      method: "POST", headers: request.headers, body: JSON.stringify({ agent_id: agentId, conversation_id: conversationId }),
    }));
  }
  const nativeId = agentId && authResult.subject ? await getHarnessGatewayNativeThread(agentId, authResult.subject, runtimeId) : conversationId;

  // Check DA config
  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  // Build backend URL
  const backendUrl = new URL(
    `/api/v1/conversations/${nativeId}/clear`,
    daConfig.dynamicAgentsUrl,
  );

  return proxyRequest(backendUrl.toString(), "POST", authResult, "[clear]");
}
