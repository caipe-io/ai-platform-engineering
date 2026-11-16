/**
 * POST /api/v1/chat/assistant-actions — run an app-declared action on a finished assistant answer.
 *
 * Body: { conversation_id, agent_id, message_id, action_id, input?: { text?: string } }
 * Response: { success: true, data } or { success: false, error, code }
 */

import { NextRequest, NextResponse } from "next/server";

import { runAgenticAppMessageAction, type MessageActionRequest } from "@/lib/agentic-apps/assistant-actions";
import { createAuthzTraceContext } from "@/lib/rbac/authz-tracing";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import { readBodyWithLimit } from "@/lib/request-body";
import { MAX_MESSAGE_ACTION_TEXT } from "../../../../../../app-sdk/assistant-options.mjs";

import { authorizeConversationWriteAccess } from "../_conversation-authz";
import { authenticateChatStreamRequest } from "../_stream-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Text is bounded in characters; allow four bytes per character plus the other fields. */
const MAX_REQUEST_BYTES = MAX_MESSAGE_ACTION_TEXT * 4 + 4096;
const MAX_ID_LENGTH = 256;

function invalid(error: string, status = 400): NextResponse {
  return NextResponse.json({ success: false, error }, { status });
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

export async function POST(request: NextRequest): Promise<Response> {
  const authResult = await authenticateChatStreamRequest(request);
  if (authResult instanceof NextResponse) return authResult;
  // Actions act as a person; automation uses the app's own APIs.
  if (authResult.isServiceAccount || !authResult.subject || !authResult.authenticatedUser) {
    return NextResponse.json({ success: false, error: "Interactive user identity required" }, { status: 403 });
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return invalid("Request body too large", 413);
  const raw = await readBodyWithLimit(request, MAX_REQUEST_BYTES);
  if (raw === null) return invalid("Request body too large", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return invalid("Invalid request body");
  }
  const body = parsed as Record<string, unknown> | null;
  const input = body?.input;
  if (!body || typeof body !== "object" || !identifier(body.conversation_id) || !identifier(body.agent_id) ||
      !identifier(body.message_id) || !identifier(body.action_id) ||
      (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) ||
        ((input as Record<string, unknown>).text !== undefined && typeof (input as Record<string, unknown>).text !== "string")))) {
    return invalid("Missing or invalid fields: conversation_id, agent_id, message_id, action_id, input.text");
  }
  // Only these fields are forwarded; a client-supplied path or turn is never read.
  const action: MessageActionRequest = {
    conversation_id: body.conversation_id, agent_id: body.agent_id,
    message_id: body.message_id, action_id: body.action_id,
    ...(input ? { input: { text: (input as { text?: string }).text } } : {}),
  };

  const traceContext = createAuthzTraceContext(request.headers.get("traceparent"));
  authResult.traceparent = traceContext.traceparent;

  const authzResponse = await requireAgentUsePermission({
    subject: authResult.subject,
    agentId: action.agent_id,
    email: authResult.email,
    tenantId: authResult.tenantId,
    traceparent: traceContext.traceparent,
    isServiceAccount: authResult.isServiceAccount,
  });
  if (authzResponse) return authzResponse;

  const conversationAuthz = await authorizeConversationWriteAccess(authResult, action.conversation_id, action.agent_id);
  if (conversationAuthz.denial) return conversationAuthz.denial;

  return runAgenticAppMessageAction(request, authResult, conversationAuthz.conversation, action);
}
