import { NextRequest, NextResponse } from "next/server";

import { authorizeConversationWriteAccess } from "@/app/api/v1/chat/_conversation-authz";
import { authenticateChatStreamRequest } from "@/app/api/v1/chat/_stream-auth";
import { ApiError, validateConversationId, withErrorHandler } from "@/lib/api-middleware";
import { admitPersonalEvidenceConversation } from "@/lib/conversation-evidence-privacy";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";

/** Reserve owner-only history before an app retrieves personal context. No unmark operation exists. */
export const POST = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => {
  const auth = await authenticateChatStreamRequest(request);
  if (auth instanceof NextResponse) return auth;
  const principal = auth.authenticatedUser?.session.principalType;
  if (auth.isServiceAccount || principal === "service_account" || principal === "catalog_api_key" || principal === "skills_api_key") {
    throw new ApiError("A user identity is required", 403, "PERSONAL_CONTEXT_USER_REQUIRED");
  }
  const { id } = await context.params;
  if (!validateConversationId(id)) throw new ApiError("Invalid conversation ID", 400);
  let body: { agent_id?: unknown };
  try { body = await request.json(); }
  catch { throw new ApiError("A JSON object is required", 400); }
  if (!body || typeof body.agent_id !== "string" || !body.agent_id.trim()) {
    throw new ApiError("agent_id is required", 400);
  }
  const denial = await requireAgentUsePermission({ subject: auth.subject, agentId: body.agent_id,
    tenantId: auth.tenantId, isServiceAccount: auth.isServiceAccount });
  if (denial) return denial;
  const access = await authorizeConversationWriteAccess(auth, id, body.agent_id);
  if (access.denial) return access.denial;
  await admitPersonalEvidenceConversation(id, auth.subject, auth.email, body.agent_id);
  return NextResponse.json({ success: true, data: { conversation_id: id, personal_context: "private" } },
    { headers: { "Cache-Control": "no-store" } });
});
