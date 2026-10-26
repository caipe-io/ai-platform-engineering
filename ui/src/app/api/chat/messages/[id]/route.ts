// PUT /api/chat/messages/[id] - Update message (content, metadata, events)
// [id] can be either a MongoDB ObjectId or a client-generated message_id (UUID)

import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from '@/lib/api-middleware';
import { getCollection } from '@/lib/mongodb';
import { requireResourcePermission } from '@/lib/rbac/resource-authz';
import { requireConversationResourcePermission } from '@/lib/rbac/conversation-implicit-authz';
import { CONVERSATION_EVIDENCE_VISIBILITY_PATH } from '@/lib/conversation-evidence-privacy';
import type { Conversation,Message,UpdateMessageRequest } from '@/types/mongodb';
import { ObjectId,type Document,type Filter } from 'mongodb';
import { NextRequest } from 'next/server';

// PUT /api/chat/messages/[id]
export const PUT = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => {
  return withAuth(request, async (req, user, session) => {
    const params = await context.params;
    const messageId = params.id;
    const body: UpdateMessageRequest = await request.json();

    const messages = await getCollection<Message>('messages');

    // Look up by MongoDB _id first, then fall back to client-generated message_id.
    // This allows the chat store to update messages using the UUID it generated.
    let filter: Filter<Message>;
    if (ObjectId.isValid(messageId)) {
      filter = { _id: new ObjectId(messageId) };
    } else {
      filter = { message_id: messageId };
    }

    const message = await messages.findOne(filter);

    if (!message) {
      throw new ApiError('Message not found', 404);
    }
    await requireResourcePermission(session, {
      type: 'conversation',
      id: message.conversation_id,
      action: 'write',
    });

    // Private evidence remains owner-only even if an old writer tuple exists.
    const privateConversation = await (await getCollection<Conversation>('conversations')).findOne({
      _id: message.conversation_id,
      [CONVERSATION_EVIDENCE_VISIBILITY_PATH]: 'private',
    });
    if (privateConversation) {
      await requireConversationResourcePermission(session, user.email, privateConversation, 'write');
    }

    // Build update
    const update: Document = {};

    // Feedback is no longer written here — use POST /api/feedback instead.

    if (body.content !== undefined) {
      update.content = body.content;
    }

    if (body.metadata) {
      // Merge metadata fields (don't overwrite the whole metadata object)
      if (body.metadata.is_final !== undefined) {
        update['metadata.is_final'] = body.metadata.is_final;
      }
      if (body.metadata.is_interrupted !== undefined) {
        update['metadata.is_interrupted'] = body.metadata.is_interrupted;
      }
      if (body.metadata.task_id !== undefined) {
        update['metadata.task_id'] = body.metadata.task_id;
      }
    }

    if (Object.keys(update).length === 0) {
      return successResponse(message);
    }

    await messages.updateOne(filter, { $set: update });

    const updated = await messages.findOne(filter);

    return successResponse(updated);
  });
});
