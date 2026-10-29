// POST /api/chat/conversations/[id]/restore - Restore a soft-deleted conversation from archive

import {
ApiError,
successResponse,
validateConversationId,
withAuth,
withErrorHandler,
} from '@/lib/api-middleware';
import { getCollection } from '@/lib/mongodb';
import { requireConversationResourcePermission } from '@/lib/rbac/conversation-implicit-authz';
import type { Conversation } from '@/types/mongodb';
import { NextRequest } from 'next/server';
import { conversationPurgingError } from '../../delete-permanently';

// POST /api/chat/conversations/[id]/restore
export const POST = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => {
  return withAuth(request, async (req, user, session) => {
    const params = await context.params;
    const conversationId = params.id;

    if (!validateConversationId(conversationId)) {
      throw new ApiError('Invalid conversation ID format', 400);
    }

    const conversations = await getCollection<Conversation>('conversations');
    const conversation = await conversations.findOne({ _id: conversationId });

    if (!conversation) {
      throw new ApiError('Conversation not found', 404);
    }

    try {
      await requireConversationResourcePermission(session, user.email, conversation, 'write');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONVERSATION_PURGING') throw conversationPurgingError();
      throw error;
    }
    if (conversation.purge) throw conversationPurgingError();

    if (!conversation.deleted_at) {
      throw new ApiError('Conversation is not in archive', 400);
    }

    // Restore: clear deleted_at and un-archive
    const restored = await conversations.updateOne(
      { _id: conversationId, deleted_at: conversation.deleted_at, purge: { $exists: false } },
      {
        $set: {
          is_archived: false,
          updated_at: new Date(),
        },
        $unset: {
          deleted_at: '',
        },
      }
    );

    if (restored.matchedCount !== 1) {
      const current = await conversations.findOne({ _id: conversationId });
      if (current?.purge) throw conversationPurgingError();
      if (!current) throw new ApiError('Conversation not found', 404);
      throw new ApiError('The archived conversation changed. Reload and try again.', 409, 'CONVERSATION_CHANGED');
    }

    const updated = await conversations.findOne({ _id: conversationId });

    return successResponse(updated);
  });
});
