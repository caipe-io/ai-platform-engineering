import { randomUUID } from "node:crypto";
import type { Collection, ObjectId } from "mongodb";
import { createAuthzTraceContext } from "@/lib/rbac/authz-tracing";
import {
  successResponse,
  validateConversationId,
} from "@/lib/api-middleware";
import {
  type AuthResult,
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

interface RewindResult {
  agent_id: string;
  message_id: string;
  turn_id: string;
  checkpoint_id: string;
  removed_messages: number;
}

interface RewindReceipt extends RewindResult {
  operation_id: string;
  epoch: number;
  owner_subject: string | null;
  owner_email: string;
  phase: "completed";
}

interface PendingRewind extends Omit<RewindReceipt, "phase"> {
  phase: "pending_history" | "history_applied";
  message_content: string;
  content_occurrence: number;
  target_index: number;
  removed_ids: ObjectId[];
  removed_message_ids: string[];
  removed_turn_ids: string[];
}

type RewindOperation = PendingRewind | RewindReceipt;
// This server-owned top-level field cannot be supplied through client metadata
// when a conversation is created or updated.
type RewindConversation = Conversation & { native_rewind?: RewindOperation; native_rewind_epoch?: number };

function epochFilter(epoch: number) {
  return epoch === 0 ? { $or: [{ native_rewind_epoch: { $exists: false } }, { native_rewind_epoch: 0 }] }
    : { native_rewind_epoch: epoch };
}

function result(conversationId: string, operation: RewindResult): Response {
  return successResponse({
    conversation_id: conversationId,
    turn_id: operation.turn_id,
    removed_messages: operation.removed_messages,
    checkpoint_id: operation.checkpoint_id,
  });
}

function matchesRequest(operation: RewindOperation, body: RewindRequest): boolean {
  return operation.agent_id === body.agent_id && operation.message_id === body.message_id;
}

async function removeHistory(
  conversationId: string,
  operation: Pick<PendingRewind, "removed_ids" | "removed_turn_ids" | "removed_message_ids">,
): Promise<void> {
  const messages = await getCollection<Message>("messages");
  await messages.deleteMany({ conversation_id: conversationId, _id: { $in: operation.removed_ids } });
  if (operation.removed_turn_ids.length > 0) {
    const turns = await getCollection<Turn>("turns");
    await turns.deleteMany({ conversation_id: conversationId, client_type: "ui", turn_id: { $in: operation.removed_turn_ids } });
  }
  if (operation.removed_message_ids.length > 0) {
    const feedback = await getCollection("feedback");
    const bookmarks = await getCollection("conversation_bookmarks");
    await feedback.deleteMany({ conversation_id: conversationId, message_id: { $in: operation.removed_message_ids } });
    await bookmarks.deleteMany({ conversation_id: conversationId, message_id: { $in: operation.removed_message_ids } });
  }
}

async function finishSandboxRewind(
  conversationId: string,
  original: RewindOperation,
  conversations: Collection<RewindConversation>,
  backendUrl: URL,
  auth: AuthResult,
): Promise<Response> {
  let operation = original;
  if (operation.phase === "completed") return result(conversationId, operation);
  try {
    if (operation.phase === "pending_history") {
      await removeHistory(conversationId, operation);
      const applied = await conversations.updateOne(
        { _id: conversationId, ...epochFilter(operation.epoch), "native_rewind.operation_id": operation.operation_id, "native_rewind.phase": "pending_history" },
        { $set: { "native_rewind.phase": "history_applied", updated_at: new Date(), "metadata.total_messages": operation.target_index } },
      );
      // Another request may have completed the same edit. Read its durable
      // phase; never reset a later branch's message count from stale state.
      if (applied.matchedCount === 0) {
        const current = (await conversations.findOne({ _id: conversationId }))?.native_rewind;
        if (!current || current.operation_id !== operation.operation_id) {
          return NextResponse.json({ success: false, error: "The conversation edit changed; reload before retrying." }, { status: 409 });
        }
        operation = current;
        if (operation.phase === "completed") return result(conversationId, operation);
        if (operation.phase !== "history_applied") throw new Error("History acknowledgement was not persisted");
      } else {
        operation = { ...operation, phase: "history_applied" };
      }
    }
    const confirmation = await fetch(new URL(`${backendUrl.pathname}/confirm`, backendUrl), {
      method: "POST",
      headers: buildBackendHeaders("application/json", auth),
      body: JSON.stringify({ agent_id: operation.agent_id, checkpoint_id: operation.checkpoint_id,
        turn_id: operation.turn_id, message_content: operation.message_content,
        content_occurrence: operation.content_occurrence }),
    });
    const confirmed = await confirmation.json().catch(() => null);
    if (!confirmation.ok || confirmed?.success !== true
        || confirmed?.data?.checkpoint_id !== operation.checkpoint_id
        || confirmed?.data?.conversation_id !== conversationId) {
      return NextResponse.json({ success: false, error: "History was updated, but native rewind confirmation is pending. Retry the same edit." },
        { status: confirmation.status >= 500 ? 503 : 409 });
    }
    const receipt: RewindReceipt = {
      operation_id: operation.operation_id, epoch: operation.epoch, owner_subject: operation.owner_subject, owner_email: operation.owner_email,
      agent_id: operation.agent_id, message_id: operation.message_id, turn_id: operation.turn_id,
      checkpoint_id: operation.checkpoint_id, removed_messages: operation.removed_messages, phase: "completed",
    };
    // Drop the removed text/IDs after confirmation. The compact receipt makes a
    // lost HTTP reply idempotent without retaining deleted message content.
    const completed = await conversations.updateOne(
      { _id: conversationId, ...epochFilter(operation.epoch), "native_rewind.operation_id": operation.operation_id, "native_rewind.phase": "history_applied" },
      { $set: { native_rewind: receipt } },
    );
    if (completed.matchedCount === 0) {
      const current = (await conversations.findOne({ _id: conversationId }))?.native_rewind;
      if (!current || current.operation_id !== operation.operation_id || current.phase !== "completed") {
        return NextResponse.json({ success: false, error: "The conversation edit changed; reload before retrying." }, { status: 409 });
      }
    }
    return result(conversationId, receipt);
  } catch {
    return NextResponse.json({ success: false, error: "Conversation edit recovery is pending. Retry the same edit before sending another message." }, { status: 503 });
  }
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
  if (typeof body.agent_id !== "string" || !body.agent_id || typeof body.message_id !== "string" || !body.message_id) {
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

  const conversations = await getCollection<RewindConversation>("conversations");
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

  const dynamicAgentsConfig = getDynamicAgentsConfig();
  if (dynamicAgentsConfig instanceof NextResponse) return dynamicAgentsConfig;
  const backendUrl = new URL(`/api/v1/conversations/${conversationId}/rewind`, dynamicAgentsConfig.dynamicAgentsUrl);
  const epoch = conversation.native_rewind_epoch ?? 0;
  const existing = conversation.native_rewind;
  if (existing && existing.epoch !== epoch) {
    return NextResponse.json({ success: false, error: "This edit belongs to a cleared conversation context. Reload before retrying." }, { status: 409 });
  }
  if (existing && (existing.owner_subject !== (authResult.subject ?? null) || existing.owner_email !== authResult.email)) {
    return NextResponse.json({ success: false, error: "The saved conversation edit belongs to another identity." }, { status: 403 });
  }
  if (existing && matchesRequest(existing, body)) {
    return finishSandboxRewind(conversationId, existing, conversations, backendUrl, authResult);
  }
  if (existing && existing.phase !== "completed") {
    return NextResponse.json({ success: false, error: "Finish the pending conversation edit before selecting another message." }, { status: 409 });
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
  if (!backendResponse.ok || backendBody?.success !== true) {
    return NextResponse.json(
      {
        success: false,
        error:
          backendBody?.error ??
          backendBody?.detail ??
          "Unable to rewind conversation",
      },
      { status: backendResponse.ok ? 502 : backendResponse.status },
    );
  }

  const history = { removed_ids: removedIds, removed_message_ids: removedMessageIds, removed_turn_ids: removedTurnIds };
  const checkpointId = backendBody?.data?.checkpoint_id ?? backendBody?.checkpoint_id ?? null;
  if (backendBody?.data?.confirmation_required === true) {
    if (typeof checkpointId !== "string" || !checkpointId) {
      return NextResponse.json({ success: false, error: "The native rewind acknowledgement is incomplete." }, { status: 502 });
    }
    const operation: PendingRewind = {
      operation_id: randomUUID(), epoch, owner_subject: authResult.subject ?? null, owner_email: authResult.email,
      agent_id: body.agent_id, message_id: body.message_id, turn_id: turnId,
      checkpoint_id: checkpointId, removed_messages: removedMessages.length, phase: "pending_history",
      message_content: targetMessage.content, content_occurrence: contentOccurrence, target_index: targetIndex, ...history,
    };
    try {
      const reserved = await conversations.updateOne(
        { _id: conversationId, owner_id: authResult.email, ...epochFilter(epoch), ...(existing
          ? { "native_rewind.operation_id": existing.operation_id, "native_rewind.phase": "completed" }
          : { native_rewind: { $exists: false } }) },
        { $set: { native_rewind: operation } },
      );
      if (reserved.matchedCount === 0) {
        const current = (await conversations.findOne({ _id: conversationId }))?.native_rewind;
        if (!current || !matchesRequest(current, body) || current.owner_subject !== operation.owner_subject
            || current.owner_email !== operation.owner_email || current.checkpoint_id !== checkpointId) {
          return NextResponse.json({ success: false, error: "Another conversation edit is pending; retry the original edit." }, { status: 409 });
        }
        return finishSandboxRewind(conversationId, current, conversations, backendUrl, authResult);
      }
    } catch {
      return NextResponse.json({ success: false, error: "The native edit is saved, but history recovery could not be recorded. Retry the same edit." }, { status: 503 });
    }
    return finishSandboxRewind(conversationId, operation, conversations, backendUrl, authResult);
  }

  await removeHistory(conversationId, history);
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
