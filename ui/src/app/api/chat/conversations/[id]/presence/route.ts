import { NextRequest, NextResponse } from "next/server";

import { authorizeConversationReadAccess } from "@/app/api/v1/chat/_conversation-authz";
import { authenticateChatStreamRequest } from "@/app/api/v1/chat/_stream-auth";
import { validateConversationId, withErrorHandler } from "@/lib/api-middleware";
import { conversationPresenceStream } from "@/lib/conversation-presence";
import { isMongoDBConfigured } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => {
  if (!isMongoDBConfigured) return NextResponse.json({ error: "Presence requires persistent storage" }, { status: 503 });
  const auth = await authenticateChatStreamRequest(request);
  if (auth instanceof NextResponse) return auth;
  if (!auth.subject) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { id } = await context.params;
  if (!validateConversationId(id)) return NextResponse.json({ error: "Invalid conversation ID" }, { status: 400 });
  const access = await authorizeConversationReadAccess(auth, id);
  if (access.denial) return access.denial;

  const stream = conversationPresenceStream(id, auth, request.signal, async () => {
    const current = await authenticateChatStreamRequest(request);
    if (current instanceof NextResponse && current.status >= 500) throw new Error("Presence authentication temporarily unavailable");
    if (current instanceof NextResponse || current.subject !== auth.subject) return false;
    const access = await authorizeConversationReadAccess(current, id);
    if (access.denial && access.denial.status >= 500) throw new Error("Presence authorization temporarily unavailable");
    return !access.denial;
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  } });
});
