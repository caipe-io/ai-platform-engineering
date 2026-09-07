// POST /api/chat/conversations/[id]/pin - Toggle pin status

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

// POST /api/chat/conversations/[id]/pin
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

    // Toggle pin status
    const newStatus = !conversation.is_pinned;

    await conversations.updateOne(
      { _id: conversationId },
      {
        $set: {
          is_pinned: newStatus,
          updated_at: new Date(),
        },
      }
    );

    const updated = await conversations.findOne({ _id: conversationId });

    return successResponse(updated);
  });
});
