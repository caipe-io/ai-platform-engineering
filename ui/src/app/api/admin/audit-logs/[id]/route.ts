/**
 * Admin audit-log single conversation operations.
 * DELETE permanently removes conversation + messages + checkpoints + GridFS files.
 */

import {
ApiError,
getAuthFromBearerOrSession,
requireRbacPermission,
successResponse,
withErrorHandler,
} from '@/lib/api-middleware';
import { getServerConfig } from '@/lib/config';
import { getCollection,isMongoDBConfigured } from '@/lib/mongodb';
import type { Conversation } from '@/types/mongodb';
import { NextRequest,NextResponse } from 'next/server';
import { deleteConversationsPermanently } from '@/app/api/chat/conversations/delete-permanently';

export const DELETE = withErrorHandler(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    if (!isMongoDBConfigured) {
      return NextResponse.json(
        { success: false, error: 'MongoDB not configured', code: 'MONGODB_NOT_CONFIGURED' },
        { status: 503 },
      );
    }

    if (!getServerConfig().auditLogsEnabled) {
      return NextResponse.json(
        { success: false, error: 'Audit logs feature is not enabled', code: 'FEATURE_DISABLED' },
        { status: 403 },
      );
    }

    const { session } = await getAuthFromBearerOrSession(request);
    await requireRbacPermission(session, 'admin_ui', 'admin');

      const { id: conversationId } = await params;
      if (!conversationId) {
        throw new ApiError('Conversation ID is required', 400);
      }

      const conversations = await getCollection<Conversation>('conversations');
      const conversation = await conversations.findOne({ _id: conversationId });

      if (!conversation) {
        throw new ApiError('Conversation not found', 404, 'NOT_FOUND');
      }

      const result = await deleteConversationsPermanently([conversation]);

      return successResponse({
        deleted: result.deleted > 0,
        ...(result.pending ? { pending: true } : {}),
        conversation_id: conversationId,
        messages_deleted: result.messagesDeleted,
        checkpoints_deleted: result.checkpointsDeleted,
        checkpoint_writes_deleted: result.checkpointWritesDeleted,
        files_deleted: result.filesDeleted,
      }, result.pending ? 202 : 200);
  },
);
