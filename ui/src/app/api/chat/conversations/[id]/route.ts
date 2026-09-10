// GET /api/chat/conversations/[id] - Get conversation details
// PUT /api/chat/conversations/[id] - Update conversation
// DELETE /api/chat/conversations/[id] - Delete conversation

import {
ApiError,
requireConversationAccess,
successResponse,
validateConversationId,
withAuth,
withErrorHandler,
} from '@/lib/api-middleware';
import { getCollection,isMongoDBConfigured } from '@/lib/mongodb';
import { requireConversationResourcePermission } from '@/lib/rbac/conversation-implicit-authz';
import type { Conversation,UpdateConversationRequest } from '@/types/mongodb';
import { NextRequest,NextResponse } from 'next/server';
import { deleteConversationsPermanently } from '../delete-permanently';

// GET /api/chat/conversations/[id]
export const GET = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => {
  // Check if MongoDB is configured
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: 'MongoDB not configured - use localStorage mode',
        code: 'MONGODB_NOT_CONFIGURED',
      },
      { status: 503 }
    );
  }

  return withAuth(request, async (req, user, session) => {
    const params = await context.params;
    const conversationId = params.id;

    if (!validateConversationId(conversationId)) {
      throw new ApiError('Invalid conversation ID format', 400);
    }

    const { conversation, access_level } = await requireConversationAccess(
      conversationId,
      user.email,
      getCollection,
      session
    );
    await requireConversationResourcePermission(session, user.email, conversation, 'read');

    return successResponse({ ...conversation, access_level });
  });
});

// PUT /api/chat/conversations/[id]
export const PUT = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => {
  // Check if MongoDB is configured
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: 'MongoDB not configured - use localStorage mode',
        code: 'MONGODB_NOT_CONFIGURED',
      },
      { status: 503 }
    );
  }

  return withAuth(request, async (req, user, session) => {
    const params = await context.params;
    const conversationId = params.id;
    const body: UpdateConversationRequest = await request.json();

    if (!validateConversationId(conversationId)) {
      throw new ApiError('Invalid conversation ID format', 400);
    }

    const conversations = await getCollection<Conversation>('conversations');
    const conversation = await conversations.findOne({ _id: conversationId });

    if (!conversation) {
      throw new ApiError('Conversation not found', 404);
    }

    await requireConversationResourcePermission(session, user.email, conversation, 'write');

    // Build update
    const update: Partial<Pick<Conversation, 'is_archived' | 'is_pinned' | 'participants' | 'tags' | 'title' | 'updated_at'>> & {
      updated_at: Date;
    } = {
      updated_at: new Date(),
    };

    if (body.title !== undefined) update.title = body.title;
    if (body.tags !== undefined) update.tags = body.tags;
    if (body.is_archived !== undefined) update.is_archived = body.is_archived;
    if (body.is_pinned !== undefined) update.is_pinned = body.is_pinned;
    if (body.participants !== undefined) update.participants = body.participants;

    await conversations.updateOne(
      { _id: conversationId },
      { $set: update }
    );

    const updated = await conversations.findOne({ _id: conversationId });

    return successResponse(updated);
  });
});

// DELETE /api/chat/conversations/[id]
// Soft-deletes the conversation (moves to archive).
// Pass ?permanent=true to hard-delete immediately.
export const DELETE = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => {
  // Check if MongoDB is configured
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: 'MongoDB not configured - use localStorage mode',
        code: 'MONGODB_NOT_CONFIGURED',
      },
      { status: 503 }
    );
  }

  return withAuth(request, async (req, user, session) => {
    const params = await context.params;
    const conversationId = params.id;
    const url = new URL(request.url);
    const permanent = url.searchParams.get('permanent') === 'true';

    if (!validateConversationId(conversationId)) {
      throw new ApiError('Invalid conversation ID format', 400);
    }

    const conversations = await getCollection<Conversation>('conversations');
    const conversation = await conversations.findOne({ _id: conversationId });

    if (!conversation) {
      throw new ApiError('Conversation not found', 404);
    }

    await requireConversationResourcePermission(session, user.email, conversation, 'delete');

    if (permanent) {
      await deleteConversationsPermanently([conversation]);
      return successResponse({ deleted: true, permanent: true });
    } else {
      // Soft delete: move to archive by setting deleted_at timestamp
      await conversations.updateOne(
        { _id: conversationId },
        { $set: { deleted_at: new Date(), is_archived: true, updated_at: new Date() } }
      );
      return successResponse({ deleted: true, permanent: false });
    }
  });
});
