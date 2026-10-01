/**
 * PATCH /api/chat/conversations/[id]/metadata
 *
 * Shallow-merge caller-provided keys into the conversation's metadata.
 * Only metadata is mutable via this endpoint — no other fields are touched.
 *
 * Supports Bearer JWT (Slack bot service account) and session cookies.
 */

import {
ApiError,
getAuthFromBearerOrSession,
successResponse,
validateConversationId,
withErrorHandler,
} from '@/lib/api-middleware';
import { getCollection,isMongoDBConfigured } from '@/lib/mongodb';
import { requireConversationResourcePermission } from '@/lib/rbac/conversation-implicit-authz';
import type { Conversation,PatchConversationMetadataRequest } from '@/types/mongodb';
import { NextRequest,NextResponse } from 'next/server';

export const PATCH = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => {
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      { success: false, error: 'MongoDB not configured', code: 'MONGODB_NOT_CONFIGURED' },
      { status: 503 },
    );
  }

  const { user, session } = await getAuthFromBearerOrSession(request);

  const params = await context.params;
  const conversationId = params.id;

  if (!validateConversationId(conversationId)) {
    throw new ApiError('Invalid conversation ID format', 400);
  }

  const body: PatchConversationMetadataRequest = await request.json();

  if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
    throw new ApiError('Request body must contain a "metadata" object', 400);
  }

  const conversations = await getCollection<Conversation>('conversations');
  const conversation = await conversations.findOne({ _id: conversationId });

  if (!conversation) {
    throw new ApiError('Conversation not found', 404);
  }
  await requireConversationResourcePermission(session, user.email, conversation, 'write');

  // Shallow-merge provided keys into existing metadata using dot notation
  // so MongoDB only updates the specified fields without replacing the entire
  // metadata object (avoids TypeScript intersection type issues).
  const setFields: Record<string, unknown> = { updated_at: new Date() };
  for (const [key, value] of Object.entries(body.metadata)) {
    setFields[`metadata.${key}`] = value;
  }

  await conversations.updateOne(
    { _id: conversationId },
    { $set: setFields },
  );

  const updated = await conversations.findOne({ _id: conversationId });
  return successResponse(updated);
});
