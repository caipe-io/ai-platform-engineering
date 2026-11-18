import { authorizeConversationWriteAccess, resolveConversationRuntimeId } from "@/app/api/v1/chat/_conversation-authz";
import { authenticateRequest } from "@/lib/da-proxy";
import { getHarnessEngineConfig, proxyHarnessEngine } from "@/lib/harness-engine-proxy";
import { createAuthzTraceContext } from "@/lib/rbac/authz-tracing";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/** Resolve only this caller's previously admitted delivery, without starting work. */
export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }
  if (!body || ["agent_id", "conversation_id", "client_request_id"].some(
    key => typeof body[key] !== "string" || !(body[key] as string).trim(),
  )) {
    return NextResponse.json({ success: false, error: "agent_id, conversation_id and client_request_id are required" }, { status: 400 });
  }

  auth.traceparent = createAuthzTraceContext(request.headers.get("traceparent")).traceparent;
  const denial = await requireAgentUsePermission({
    subject: auth.subject, agentId: body.agent_id, email: auth.email,
    tenantId: auth.tenantId, traceparent: auth.traceparent, isServiceAccount: auth.isServiceAccount,
  });
  if (denial) return denial;
  const conversation = await authorizeConversationWriteAccess(auth, String(body.conversation_id), body.agent_id);
  if (conversation.denial) return conversation.denial;

  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  return proxyHarnessEngine(config, auth, "/api/v1/run-requests/lookup", {
    method: "POST",
    body: JSON.stringify({
      agent_id: body.agent_id,
      conversation_id: await resolveConversationRuntimeId(conversation.conversation),
      client_request_id: body.client_request_id,
    }),
  });
}
