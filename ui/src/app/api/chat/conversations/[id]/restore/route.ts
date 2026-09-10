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

    await requireConversationResourcePermission(session, user.email, conversation, 'write');

    if (!conversation.deleted_at) {
      throw new ApiError('Conversation is not in archive', 400);
    }

    // Restore: clear deleted_at and un-archive
    await conversations.updateOne(
      { _id: conversationId },
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

    const updated = await conversations.findOne({ _id: conversationId });

    return successResponse(updated);
  });
});
