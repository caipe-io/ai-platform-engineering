import { NextRequest, NextResponse } from "next/server";

import {
  authorizeConversationReadAccess,
  authorizeConversationWriteAccess,
} from "@/app/api/v1/chat/_conversation-authz";
import { authenticateRequest, type AuthResult } from "@/lib/da-proxy";
import {
  getHarnessEngineConfig,
  proxyHarnessEngine,
  type HarnessEngineConfig,
  harnessConversationReadHeaders,
  type HarnessConversationReadScope,
} from "@/lib/harness-engine-proxy";
import { getAgentId } from "@/types/a2a";
import { createAuthzTraceContext } from "@/lib/rbac/authz-tracing";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import { conversationHasAgent } from "@/lib/chat-coordination";

/** Authorize shared reads against the saved chat; execution controls remain owner-scoped. */
export async function authorizeHarnessRunAccess(
  request: NextRequest,
  runId: string,
  permission: "read" | "write",
): Promise<{ auth: AuthResult; config: HarnessEngineConfig; response: Response; readScope?: HarnessConversationReadScope } | NextResponse> {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  auth.traceparent = createAuthzTraceContext(request.headers.get("traceparent")).traceparent;
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  let readScope: HarnessConversationReadScope | undefined;
  const conversationId = request.nextUrl.searchParams.get("conversation_id");
  if (permission === "read" && conversationId) {
    const access = await authorizeConversationReadAccess(auth, conversationId);
    if (access.denial) return access.denial;
    const agentId = request.nextUrl.searchParams.get("agent_id") || getAgentId(access.conversation);
    if (!agentId) return NextResponse.json({ error: "Conversation has no agent" }, { status: 409 });
    if (!conversationHasAgent(access.conversation, agentId)) return NextResponse.json({ error: "Agent is not a participant in this chat" }, { status: 409 });
    readScope = { conversationId, agentId };
  }
  const response = await proxyHarnessEngine(config, auth, `/api/v1/runs/${encodeURIComponent(runId)}`, {
    method: "GET", ...(readScope && { headers: harnessConversationReadHeaders(readScope) }),
  });
  if (!response.ok) {
    return new NextResponse(response.body, { status: response.status, headers: response.headers });
  }
  const envelope = await response.clone().json().catch(() => null);
  const run = envelope?.data;
  if (!envelope?.success || run?.run_id !== runId || (!readScope && run?.owner_subject !== auth.subject) ||
      typeof run?.agent_id !== "string" || !run.agent_id ||
      typeof run?.conversation_id !== "string" || !run.conversation_id) {
    return NextResponse.json({ success: false, error: "Harness run could not be authorized" }, { status: 502 });
  }
  if (readScope) {
    if (run.agent_id !== readScope.agentId || run.conversation_id !== readScope.conversationId) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    return { auth, config, response, readScope };
  }
  const denied = await requireAgentUsePermission({
    subject: auth.subject, agentId: run.agent_id, email: auth.email,
    tenantId: auth.tenantId, isServiceAccount: auth.isServiceAccount, traceparent: auth.traceparent,
  });
  if (denied) return denied;
  const authorize = permission === "write" ? authorizeConversationWriteAccess : authorizeConversationReadAccess;
  const access = await authorize(auth, run.conversation_id, run.agent_id);
  if (access.denial) return access.denial;
  return { auth, config, response };
}
