/**
 * POST /api/v1/chat/stream/cancel — agent operation routed by server-owned bindings.
 *
 * Body: { conversation_id, agent_id }
 * Response: JSON { success, cancelled, agent_id, conversation_id }
 */

import { NextRequest, NextResponse } from "next/server";

import { authenticateChatStreamRequest } from "../../_stream-auth";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";

import { authorizeConversationWriteAccess } from "../../_conversation-authz";
import { dispatchChatStream } from "../../_stream-gateway";

export async function POST(request: NextRequest): Promise<Response> {
  // Authenticate caller (session cookie or Bearer token)
  const authResult = await authenticateChatStreamRequest(request);
  if (authResult instanceof NextResponse) return authResult;

  const forwardedRequest = request.clone();
  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 },
    );
  }

  if (!body || typeof body.conversation_id !== "string" || !body.conversation_id || typeof body.agent_id !== "string" || !body.agent_id) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: conversation_id, agent_id" },
      { status: 400 },
    );
  }

  const authzResponse = await requireAgentUsePermission({
    subject: authResult.subject,
    agentId: body.agent_id,
    email: authResult.email,
    tenantId: authResult.tenantId,
    traceparent: authResult.traceparent,
    isServiceAccount: authResult.isServiceAccount,
  });
  if (authzResponse) return authzResponse;

  const conversationAuthz = await authorizeConversationWriteAccess(
    authResult,
    String(body.conversation_id),
    body.agent_id,
  );
  if (conversationAuthz.denial) return conversationAuthz.denial;

  return dispatchChatStream(
    forwardedRequest, authResult, conversationAuthz.conversation, body, "cancel",
  );
}
