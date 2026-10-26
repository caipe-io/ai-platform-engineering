import { authorizeConversationWriteAccess, resolveConversationRuntimeId } from "@/app/api/v1/chat/_conversation-authz";
import { authenticateRequest } from "@/lib/da-proxy";
import { getHarnessEngineConfig, proxyHarnessEngine } from "@/lib/harness-engine-proxy";
import { createAuthzTraceContext } from "@/lib/rbac/authz-tracing";
import { resolveHarnessGatewayTarget } from "@/lib/harness-gateway";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }
  if (!body.agent_id || !body.conversation_id) {
    return NextResponse.json(
      { success: false, error: "agent_id and conversation_id are required" },
      { status: 400 },
    );
  }

  auth.traceparent = createAuthzTraceContext(request.headers.get("traceparent")).traceparent;
  const conversationAuthz = await authorizeConversationWriteAccess(
    auth,
    String(body.conversation_id),
    body.agent_id,
  );
  if (conversationAuthz.denial) return conversationAuthz.denial;
  body.conversation_id = await resolveConversationRuntimeId(conversationAuthz.conversation);
  const target = await resolveHarnessGatewayTarget(String(body.agent_id), { conversationId: String(body.conversation_id) });
  if (target instanceof NextResponse) return target;
  if (target.kind !== "harness_engine") return NextResponse.json(
    { success: false, error: "This conversation uses the native checkpoint clear operation" }, { status: 409 },
  );

  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  return proxyHarnessEngine(config, auth, "/api/v1/sessions/clear", {
    method: "POST",
    body: JSON.stringify({
      agent_id: String(body.agent_id),
      conversation_id: String(body.conversation_id),
    }),
  });
}
