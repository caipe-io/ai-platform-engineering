import { NextRequest, NextResponse } from "next/server";

import { authenticateRequest, getDynamicAgentsConfig, type AuthResult } from "@/lib/da-proxy";
import { createAuthzTraceContext } from "@/lib/rbac/authz-tracing";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";

import { authorizeConversationReadAccess, resolveConversationRuntimeId } from "../_conversation-authz";

export async function authorizeRunReadRequest(request: NextRequest): Promise<NextResponse | {
  authResult: AuthResult;
  backendUrl: URL;
  agentId: string;
  runtimeId: string;
}> {
  const authResult = await authenticateRequest(request);
  if (authResult instanceof NextResponse) return authResult;

  const query = new URL(request.url).searchParams;
  const conversationId = query.get("conversation_id");
  const agentId = query.get("agent_id");
  if (!conversationId?.trim() || !agentId?.trim()) {
    return NextResponse.json(
      { success: false, error: "conversation_id and agent_id are required" },
      { status: 400 },
    );
  }
  authResult.traceparent = createAuthzTraceContext(request.headers.get("traceparent")).traceparent;
  const agentDenial = await requireAgentUsePermission({
    subject: authResult.subject,
    agentId,
    email: authResult.email,
    tenantId: authResult.tenantId,
    traceparent: authResult.traceparent,
    isServiceAccount: authResult.isServiceAccount,
  });
  if (agentDenial) return agentDenial;
  const result = await authorizeConversationReadAccess(authResult, conversationId, agentId);
  if (result.denial) return result.denial;
  const config = getDynamicAgentsConfig();
  if (config instanceof NextResponse) return config;
  const runtimeId = await resolveConversationRuntimeId(result.conversation);
  const backendUrl = new URL("/api/v1/chat/runs", config.dynamicAgentsUrl);
  backendUrl.searchParams.set("agent_id", agentId);
  backendUrl.searchParams.set("conversation_id", runtimeId);
  return { authResult, backendUrl, agentId, runtimeId };
}
