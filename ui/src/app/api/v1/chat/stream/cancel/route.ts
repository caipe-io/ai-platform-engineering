/**
 * POST /api/v1/chat/stream/cancel — transparent proxy to Dynamic Agents.
 *
 * Body: { conversation_id, agent_id }
 * Response: JSON { success, cancelled, agent_id, conversation_id }
 */

import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import { NextRequest,NextResponse } from "next/server";
import {
authorizeConversationWriteAccess,
resolveConversationRuntimeId,
} from "../../_conversation-authz";
import {
authenticateRequest,
getDynamicAgentsConfig,
proxyJSONRequest,
} from "../../_helpers";

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

  if (!body.conversation_id || !body.agent_id) {
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
  );
  if (conversationAuthz.denial) return conversationAuthz.denial;

  body = {
    ...body,
    conversation_id: await resolveConversationRuntimeId(
      conversationAuthz.conversation,
    ),
  };

  // Forward body as-is to DA backend (same path, same body format)
  const backendUrl = `${daConfig.dynamicAgentsUrl}/api/v1/chat/stream/cancel`;

  return proxyJSONRequest(
    backendUrl,
    JSON.stringify(body),
    authResult,
    "[stream/cancel]",
  );
}
