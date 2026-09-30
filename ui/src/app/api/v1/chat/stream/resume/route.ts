/**
 * POST /api/v1/chat/stream/resume — transparent proxy to Dynamic Agents.
 *
 * Body: { conversation_id, agent_id, resume_data, protocol?, trace_id? }
 * Response: SSE stream (text/event-stream)
 */

import { createAuthzTraceContext } from "@/lib/rbac/authz-tracing";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import { NextRequest,NextResponse } from "next/server";
import {
authorizeConversationWriteAccess,
resolveConversationRuntimeId,
} from "../../_conversation-authz";
import {
authenticateRequest,
getDynamicAgentsConfig,
proxySSEStream,
} from "../../_helpers";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes

export async function POST(request: NextRequest): Promise<Response> {
  // Authenticate caller (session cookie or Bearer token)
  const authResult = await authenticateRequest(request);
  if (authResult instanceof NextResponse) return authResult;

  // Check dynamic agents config
  const daConfig = getDynamicAgentsConfig();
  if (daConfig instanceof NextResponse) return daConfig;

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

  if (!body.conversation_id || !body.agent_id || body.resume_data === undefined) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: conversation_id, agent_id, resume_data" },
      { status: 400 },
    );
  }

  const traceContext = createAuthzTraceContext(request.headers.get("traceparent"));
  authResult.traceparent = traceContext.traceparent;

  const authzResponse = await requireAgentUsePermission({
    subject: authResult.subject,
    agentId: body.agent_id,
    email: authResult.email,
    tenantId: authResult.tenantId,
    traceparent: traceContext.traceparent,
    isServiceAccount: authResult.isServiceAccount,
  });
  if (authzResponse) return authzResponse;

  const conversationAuthz = await authorizeConversationWriteAccess(
    authResult,
    String(body.conversation_id),
  );
  if (conversationAuthz.denial) return conversationAuthz.denial;

  body = {
    ...body,
    conversation_id: await resolveConversationRuntimeId(
      conversationAuthz.conversation,
    ),
  };

  // Forward body as-is to DA backend (same path, same body format)
  const backendUrl = `${daConfig.dynamicAgentsUrl}/api/v1/chat/stream/resume`;

  return proxySSEStream(
    backendUrl,
    JSON.stringify(body),
    authResult,
    "[stream/resume]",
  );
}
