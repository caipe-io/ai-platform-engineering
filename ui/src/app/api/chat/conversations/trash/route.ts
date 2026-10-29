// GET /api/chat/conversations/trash - List soft-deleted conversations (archive)
// Retention runs independently through the server-side lifecycle worker.

import {
getPaginationParams,
paginatedResponse,
withAuth,
withErrorHandler,
} from '@/lib/api-middleware';
import { getCollection,isMongoDBConfigured } from '@/lib/mongodb';
import {
  conversationVisibilityCandidateQuery,
  filterConversationsByImplicitOrExplicitPermission,
  getDirectSharingAccessConversationIds,
} from '@/lib/rbac/conversation-implicit-authz';
import type { Conversation } from '@/types/mongodb';
import type { Document } from 'mongodb';
import { NextRequest,NextResponse } from 'next/server';

// GET /api/chat/conversations/trash
export const GET = withErrorHandler(async (request: NextRequest) => {
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
    const { page, pageSize, skip } = getPaginationParams(request);
    const conversations = await getCollection<Conversation>('conversations');
    const directShareConversationIds = await getDirectSharingAccessConversationIds(user.email, getCollection);

    // Query for soft-deleted conversation candidates, then filter by ReBAC.
    const query: Document = {
      $and: [
        { source: { $ne: 'slack' } },
        { deleted_at: { $exists: true, $ne: null } },
        conversationVisibilityCandidateQuery(user.email, directShareConversationIds),
      ],
    };

    const total = await conversations.countDocuments(query);

    const items = await conversations
      .find(query)
      .sort({ deleted_at: -1 }) // Most recently deleted first
      .skip(skip)
      .limit(pageSize)
      .toArray();

    const visibleItems = await filterConversationsByImplicitOrExplicitPermission(
      session,
      user.email,
      items,
      'discover',
      directShareConversationIds,
    );

    return paginatedResponse(
      visibleItems,
      visibleItems.length < items.length ? visibleItems.length : total,
      page,
      pageSize
    );
  });
});
