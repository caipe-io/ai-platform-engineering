/**
 * POST /api/v1/chat/stream/resume — agent operation routed by server-owned bindings.
 *
 * Body: { conversation_id, agent_id, resume_data, protocol?, trace_id? }
 * Response: SSE stream (text/event-stream)
 */

import { NextRequest, NextResponse } from "next/server";

import { authenticateChatStreamRequest } from "../../_stream-auth";
import { createAuthzTraceContext } from "@/lib/rbac/authz-tracing";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import { addTrustedInteractionToBody, trustedInteractionFromRequest } from "@/lib/authz/trusted-interaction";

import { authorizeConversationWriteAccess } from "../../_conversation-authz";
import { dispatchChatStream } from "../../_stream-gateway";

export const runtime = "nodejs";
export const maxDuration = 960; // App deadlines may exceed the default agent deadline.

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

  if (!body || typeof body.conversation_id !== "string" || !body.conversation_id || typeof body.agent_id !== "string" || !body.agent_id || body.resume_data === undefined) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: conversation_id, agent_id, resume_data" },
      { status: 400 },
    );
  }

  const traceContext = createAuthzTraceContext(request.headers.get("traceparent"));
  authResult.traceparent = traceContext.traceparent;

  const interaction = trustedInteractionFromRequest(request);
  const authzResponse = await requireAgentUsePermission({
    subject: authResult.subject,
    agentId: body.agent_id,
    email: authResult.email,
    tenantId: authResult.tenantId,
    traceparent: traceContext.traceparent,
    isServiceAccount: authResult.isServiceAccount,
    trustedContext: { interaction },
  });
  if (authzResponse) return authzResponse;
  addTrustedInteractionToBody(body, interaction, authResult.subject);

  const conversationAuthz = await authorizeConversationWriteAccess(
    authResult,
    String(body.conversation_id),
    body.agent_id,
  );
  if (conversationAuthz.denial) return conversationAuthz.denial;

  return dispatchChatStream(
    forwardedRequest, authResult, conversationAuthz.conversation, body, "resume",
  );
}
