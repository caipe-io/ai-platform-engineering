import { createAuthzTraceContext } from "@/lib/rbac/authz-tracing";
import {
  successResponse,
  validateConversationId,
} from "@/lib/api-middleware";
import {
  authenticateRequest,
  buildBackendHeaders,
  getDynamicAgentsConfig,
} from "@/lib/da-proxy";
import { getCollection } from "@/lib/mongodb";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import type { Conversation, Message, Turn } from "@/types/mongodb";
import { NextRequest, NextResponse } from "next/server";
import { authorizeConversationWriteAccess } from "@/app/api/v1/chat/_conversation-authz";

interface RewindRequest {
  agent_id?: string;
  message_id?: string;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const authResult = await authenticateRequest(request);
  if (authResult instanceof NextResponse) return authResult;

  const { id: conversationId } = await context.params;
  if (!validateConversationId(conversationId)) {
    return NextResponse.json(
      { success: false, error: "Invalid conversation ID format" },
      { status: 400 },
    );
  }

  let body: RewindRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 },
    );
  }
  if (!body.agent_id || !body.message_id) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: agent_id, message_id" },
      { status: 400 },
    );
  }

  const traceContext = createAuthzTraceContext(request.headers.get("traceparent"));
  authResult.traceparent = traceContext.traceparent;
  const agentAuthzResponse = await requireAgentUsePermission({
    subject: authResult.subject,
    agentId: body.agent_id,
    email: authResult.email,
    tenantId: authResult.tenantId,
    traceparent: traceContext.traceparent,
    isServiceAccount: authResult.isServiceAccount,
  });
  if (agentAuthzResponse) return agentAuthzResponse;

  const conversationAuthz = await authorizeConversationWriteAccess(
    authResult,
    conversationId,
  );
  if (conversationAuthz.denial) return conversationAuthz.denial;

  const conversations = await getCollection<Conversation>("conversations");
  const conversation = await conversations.findOne({ _id: conversationId });
  if (!conversation) {
    return NextResponse.json(
      { success: false, error: "Conversation not found" },
      { status: 404 },
    );
  }
  if (!authResult.email || conversation.owner_id !== authResult.email) {
    return NextResponse.json(
      {
        success: false,
        error: "Only the conversation owner can edit its history",
      },
      { status: 403 },
    );
  }

  const messages = await getCollection<Message>("messages");
  const orderedMessages = await messages
    .find({ conversation_id: conversationId })
    .sort({ created_at: 1 })
    .toArray();
  const targetIndex = orderedMessages.findIndex(
    (message) =>
      message.message_id === body.message_id ||
      message._id?.toString() === body.message_id,
  );
  if (targetIndex < 0) {
    return NextResponse.json(
      { success: false, error: "Message not found" },
      { status: 404 },
    );
  }

  const targetMessage = orderedMessages[targetIndex];
  if (targetMessage.role !== "user") {
    return NextResponse.json(
      { success: false, error: "Only user messages can be edited" },
      { status: 400 },
    );
  }
  const targetOwner = targetMessage.sender_email ?? conversation.owner_id;
  if (targetOwner !== authResult.email) {
    return NextResponse.json(
      { success: false, error: "You can only edit your own messages" },
      { status: 403 },
    );
  }

  const turnId = targetMessage.metadata?.turn_id;
  if (!turnId) {
    return NextResponse.json(
      { success: false, error: "Message is missing turn metadata" },
      { status: 409 },
    );
  }
  const contentOccurrence = orderedMessages
    .slice(0, targetIndex + 1)
    .filter(
      (message) =>
        message.role === "user" && message.content === targetMessage.content,
    ).length;
  const removedMessages = orderedMessages.slice(targetIndex);
  const removedIds = removedMessages.flatMap((message) =>
    message._id ? [message._id] : [],
  );
  if (removedIds.length !== removedMessages.length) {
    return NextResponse.json(
      {
        success: false,
        error: "Conversation contains messages without database IDs",
      },
      { status: 500 },
    );
  }
  const removedMessageIds = removedMessages.flatMap((message) =>
    message.message_id ? [message.message_id] : [],
  );
  const removedTurnIds = [
    ...new Set(
      removedMessages.flatMap((message) =>
        message.metadata?.turn_id ? [message.metadata.turn_id] : [],
      ),
    ),
  ];

  const dynamicAgentsConfig = getDynamicAgentsConfig();
  if (dynamicAgentsConfig instanceof NextResponse) return dynamicAgentsConfig;
  const backendUrl = new URL(
    `/api/v1/conversations/${conversationId}/rewind`,
    dynamicAgentsConfig.dynamicAgentsUrl,
  );

  let backendResponse: Response;
  try {
    backendResponse = await fetch(backendUrl, {
      method: "POST",
      headers: buildBackendHeaders("application/json", authResult),
      body: JSON.stringify({
        agent_id: body.agent_id,
        turn_id: turnId,
        message_content: targetMessage.content,
        content_occurrence: contentOccurrence,
      }),
    });
  } catch (error) {
    console.error("[chat/rewind] Dynamic agents service is unavailable", error);
    return NextResponse.json(
      { success: false, error: "Dynamic agents service is not available" },
      { status: 503 },
    );
  }

  const backendBody = await backendResponse.json().catch(() => null);
  if (!backendResponse.ok) {
    return NextResponse.json(
      {
        success: false,
        error:
          backendBody?.error ??
          backendBody?.detail ??
          "Unable to rewind conversation",
      },
      { status: backendResponse.status },
    );
  }

  await messages.deleteMany({ _id: { $in: removedIds } });
  if (removedTurnIds.length > 0) {
    const turns = await getCollection<Turn>("turns");
    await turns.deleteMany({
      conversation_id: conversationId,
      client_type: "ui",
      turn_id: { $in: removedTurnIds },
    });
  }
  if (removedMessageIds.length > 0) {
    const feedback = await getCollection("feedback");
    const bookmarks = await getCollection("conversation_bookmarks");
    await feedback.deleteMany({
      conversation_id: conversationId,
      message_id: { $in: removedMessageIds },
    });
    await bookmarks.deleteMany({
      conversation_id: conversationId,
      message_id: { $in: removedMessageIds },
    });
  }
  await conversations.updateOne(
    { _id: conversationId },
    {
      $set: {
        updated_at: new Date(),
        "metadata.total_messages": targetIndex,
      },
    },
  );

  return successResponse({
    conversation_id: conversationId,
    turn_id: turnId,
    removed_messages: removedMessages.length,
    checkpoint_id:
      backendBody?.data?.checkpoint_id ?? backendBody?.checkpoint_id ?? null,
  });
}
