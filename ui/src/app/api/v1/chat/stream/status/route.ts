/** Read-only app turn status; same caller and conversation boundary as start. */
import { NextRequest, NextResponse } from "next/server";

import { dispatchChatStream } from "../../_stream-gateway";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import { authorizeConversationWriteAccess } from "../../_conversation-authz";
import { authenticateChatStreamRequest } from "../../_stream-auth";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authenticateChatStreamRequest(request);
  if (auth instanceof NextResponse) return auth;
  const forwarded = request.clone();
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }); }
  if (!body || typeof body.conversation_id !== "string" || !body.conversation_id ||
      typeof body.agent_id !== "string" || !body.agent_id) {
    return NextResponse.json({ error: "conversation_id and agent_id are required" }, { status: 400 });
  }
  const denied = await requireAgentUsePermission({ subject: auth.subject, email: auth.email,
    agentId: body.agent_id, isServiceAccount: auth.isServiceAccount, tenantId: auth.tenantId });
  if (denied) return denied;
  const access = await authorizeConversationWriteAccess(auth, body.conversation_id, body.agent_id);
  if (access.denial) return access.denial;
  return dispatchChatStream(forwarded, auth, access.conversation, body, "status");
}
