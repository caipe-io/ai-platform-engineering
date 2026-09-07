// GET /api/chat/conversations/[id]/messages - Get all messages in conversation
//   Reads persisted message rows for conversation history and audit views.
// POST /api/chat/conversations/[id]/messages - Add message to conversation
//   Used by integrations and maintenance tooling that write message rows through
//   the BFF instead of the chat turn endpoint.

import {
ApiError,
getAuthFromBearerOrSession,
getPaginationParams,
paginatedResponse,
requireConversationAccess,
successResponse,
validateRequired,
validateConversationId,
withErrorHandler,
} from '@/lib/api-middleware';
import type { ConversationAccessLevel } from '@/lib/api-middleware';
import { getCollection } from '@/lib/mongodb';
import { requireConversationResourcePermission } from '@/lib/rbac/conversation-implicit-authz';
import type { AddMessageRequest,Conversation,Message } from '@/types/mongodb';
import { NextRequest } from 'next/server';

// GET /api/chat/conversations/[id]/messages
export const GET = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => {
  // Authenticate directly (like the create and metadata routes) rather than via
  // `withAuth`, whose coarse `chat#invoke` org gate (`can_chat` = org member/admin)
  // rejects first-party service-account callers that aren't org members — e.g. the
  // unlinked Slack SA. Access is instead scoped per-conversation below.
  const { user, session } = await getAuthFromBearerOrSession(request);

  const params = await context.params;
  const conversationId = params.id;

  if (!validateConversationId(conversationId)) {
    throw new ApiError('Invalid conversation ID format', 400);
  }

  // Verify user has access (admins get read-only audit access)
  const { conversation } = await requireConversationAccess(
    conversationId, user.email, getCollection, session
  );
  await requireConversationResourcePermission(session, user.email, conversation, 'read');

  const { page, pageSize, skip } = getPaginationParams(request);

  const messages = await getCollection<Message>('messages');

  const total = await messages.countDocuments({ conversation_id: conversationId });

  const items = await messages
    .find({ conversation_id: conversationId })
    .sort({ created_at: 1 })
    .skip(skip)
    .limit(pageSize)
    .toArray();

  return paginatedResponse(items, total, page, pageSize);
});

// POST /api/chat/conversations/[id]/messages
// Uses UPSERT on message_id: if a message with this client-generated ID already
// exists, it is updated (content, metadata, events). Idempotent — safe to call
// multiple times for the same message without duplicating rows.
export const POST = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => {
  // Authenticate directly (like the create and metadata routes) rather than via
  // `withAuth`, whose coarse `chat#invoke` org gate (`can_chat` = org member/admin)
  // rejects first-party service-account callers that aren't org members — e.g. the
  // unlinked Slack SA, whose message turns would otherwise never persist. Access
  // is instead gated per-conversation by the `write` permission below.
  const { user, session } = await getAuthFromBearerOrSession(request);

  const params = await context.params;
  const conversationId = params.id;
  const body: AddMessageRequest = await request.json();

  if (!validateConversationId(conversationId)) {
    throw new ApiError('Invalid conversation ID format', 400);
  }

  // `content` may be empty for integration turns that persist metadata only
  // (e.g. the Slack bot records message stats/linking without duplicating the
  // Slack-hosted content), so only `role` is strictly required.
  validateRequired(body, ['role']);

  // First-party service callers (e.g. the Slack bot) authenticate via Bearer
  // JWT and are NOT the human owner-by-email, so requireConversationAccess
  // would 403 them. They're instead authorized by their OpenFGA `writer` grant
  // on the conversation — the same gate the metadata PATCH route relies on.
  // For those callers we skip the human-ownership resolution and gate solely
  // on the write permission.
  let conversation: Conversation | null;
  let access_level: ConversationAccessLevel | undefined;
  if (session.isServiceAccount) {
    conversation = await (await getCollection<Conversation>('conversations'))
      .findOne({ _id: conversationId });
    if (!conversation) {
      throw new ApiError('Conversation not found', 404, 'NOT_FOUND');
    }
  } else {
    const access = await requireConversationAccess(
      conversationId, user.email, getCollection, session
    );
    conversation = access.conversation;
    access_level = access.access_level;
  }
  await requireConversationResourcePermission(session, user.email, conversation, 'write');

  // Read-only access — block writes (service accounts are gated above by their
  // writer grant, so access_level is undefined and this does not apply to them)
  if (access_level === 'admin_audit' || access_level === 'shared_readonly') {
    throw new ApiError('Read-only access — cannot add messages', 403, 'FORBIDDEN');
  }

  const conversations = await getCollection<Conversation>('conversations');
  const ownerId = conversation?.owner_id || user.email;

  const messages = await getCollection<Message>('messages');

  const now = new Date();

  // Store the agent display name on assistant messages, resolved from the
  // conversation's agent participant — the authoritative record of the agent
  // a conversation targets. The client's agent_name is unreliable (dropped
  // when the agent config isn't loaded at stream-finalize), so it is only a
  // last resort. `dynamic_agents._id → name` yields one label per agent, so
  // admin stats and RBAC agent-owner scoping (both keyed on display name)
  // agree across web and Slack.
  let agentName: string | undefined;
  if (body.role === 'assistant') {
    const agentId =
      conversation?.participants?.find((p) => p.type === 'agent')?.id ??
      body.metadata?.agent_id;
    if (agentId) {
      const agents = await getCollection<{ _id: string; name?: string }>('dynamic_agents');
      const agentDoc = await agents.findOne(
        { _id: agentId },
        { projection: { _id: 1, name: 1 } },
      );
      agentName = agentDoc?.name ?? body.metadata?.agent_name ?? agentId;
    } else {
      agentName = body.metadata?.agent_name;
    }
  }

  // Resolve sender identity for user messages.
  // If the client provides sender fields, use them. Otherwise, fall back to
  // the authenticated session user. This ensures shared conversations correctly
  // attribute each message to the person who typed it.
  const senderEmail = body.sender_email || (body.role === 'user' ? user.email : undefined);
  const senderName = body.sender_name || (body.role === 'user' ? user.name : undefined);
  const senderImage = body.sender_image || undefined;

  // Upsert: update if message_id exists, insert otherwise.
  // $set updates content/metadata/events on every call (idempotent).
  // $setOnInsert sets immutable fields only on first insert.
  const result = await messages.updateOne(
    { message_id: body.message_id, conversation_id: conversationId },
    {
      $set: {
        content: body.content ?? '',
        metadata: {
          // Source defaults to 'web' for backward compat; integrations (Slack
          // bot, scheduler) pass their own so stats can attribute per-surface.
          source: body.metadata?.source || 'web',
          turn_id: body.metadata?.turn_id || `turn-${Date.now()}`,
          model: body.metadata?.model,
          latency_ms: body.metadata?.latency_ms,
          agent_name: agentName,
          is_final: body.metadata?.is_final,
          ...(body.metadata?.turn_status && { turn_status: body.metadata.turn_status }),
          ...(body.metadata?.is_interrupted && { is_interrupted: body.metadata.is_interrupted }),
          ...(body.metadata?.task_id && { task_id: body.metadata.task_id }),
          ...(body.metadata?.timeline_segments && { timeline_segments: body.metadata.timeline_segments }),
          // Slack linking metadata (deep-link back to the source thread)
          ...(body.metadata?.channel_id && { channel_id: body.metadata.channel_id }),
          ...(body.metadata?.channel_name && { channel_name: body.metadata.channel_name }),
          ...(body.metadata?.thread_ts && { thread_ts: body.metadata.thread_ts }),
          ...(body.metadata?.slack_permalink && { slack_permalink: body.metadata.slack_permalink }),
        },
        ...(body.stream_events !== undefined && { stream_events: body.stream_events }),
        ...(body.artifacts !== undefined && { artifacts: body.artifacts }),
        updated_at: now,
      },
      $setOnInsert: {
        message_id: body.message_id,
        conversation_id: conversationId,
        owner_id: ownerId,
        role: body.role,
        created_at: now,
        // Sender identity — set only on insert (immutable per message)
        ...(senderEmail && { sender_email: senderEmail }),
        ...(senderName && { sender_name: senderName }),
        ...(senderImage && { sender_image: senderImage }),
      },
    },
    { upsert: true }
  );

  // Only increment total_messages on new inserts (not updates)
  if (result.upsertedId) {
    await conversations.updateOne(
      { _id: conversationId },
      {
        $set: { updated_at: now },
        $inc: { 'metadata.total_messages': 1 },
      }
    );
  } else {
    // Just update timestamp for updates
    await conversations.updateOne(
      { _id: conversationId },
      { $set: { updated_at: now } }
    );
  }

  const upserted = await messages.findOne(
    { message_id: body.message_id, conversation_id: conversationId }
  );

  return successResponse(upserted, result.upsertedId ? 201 : 200);
});
