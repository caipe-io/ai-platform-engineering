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
import { authorizeConversationReadAccess, resolveConversationRuntimeId } from "@/app/api/v1/chat/_conversation-authz";
import { getPinnedHarnessGatewayTarget, getHarnessGatewayNativeThread } from "@/lib/harness-gateway";
import { getHarnessEngineConfig, lookupHarnessSession } from "@/lib/harness-engine-proxy";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";

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

  const denied = await requireAgentUsePermission({ subject: authResult.subject, agentId,
    email: authResult.email, isServiceAccount: authResult.isServiceAccount });
  if (denied) return denied;
  const access = await authorizeConversationReadAccess(authResult, conversationId, agentId);
  if (access.denial) return access.denial;
  const runtimeId = await resolveConversationRuntimeId(access.conversation);
  const pinned = authResult.subject ? await getPinnedHarnessGatewayTarget(agentId, authResult.subject, runtimeId) : null;
  if (pinned?.kind === "harness_engine") {
    const config = getHarnessEngineConfig();
    if (config instanceof NextResponse) return config;
    const saved = await lookupHarnessSession(config, authResult, agentId, runtimeId);
    if (saved instanceof NextResponse) return saved;
    return NextResponse.json({ success: true, has_pending_interrupt: Boolean(saved.pending_interrupt), interrupt_data: saved.pending_interrupt,
      active_run: saved.active_run, conversation_id: conversationId, agent_id: agentId });
  }

  // Check DA config
  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

  // Build backend URL
  const backendUrl = new URL(
    `/api/v1/conversations/${await getHarnessGatewayNativeThread(agentId, authResult.subject, runtimeId)}/interrupt-state`,
    daConfig.dynamicAgentsUrl,
  );
  backendUrl.searchParams.set("agent_id", agentId);

  return proxyRequest(backendUrl.toString(), "GET", authResult, "[interrupt-state]");
}
