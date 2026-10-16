import { conversationForViewer } from "@/lib/conversation-view";
// GET /api/chat/conversations/trash - List soft-deleted conversations (archive)
// Also auto-purges conversations deleted more than 7 days ago

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
import { deleteConversationsPermanently } from '../delete-permanently';

const ARCHIVE_RETENTION_DAYS = 7;

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

    // Auto-purge: permanently delete conversations that have been in the
    // archive for more than 7 days. This runs on every trash listing
    // request as a lightweight cleanup mechanism.
    const purgeThreshold = new Date();
    purgeThreshold.setDate(purgeThreshold.getDate() - ARCHIVE_RETENTION_DAYS);

    const expired = await conversations.find({
      owner_id: user.email,
      deleted_at: { $exists: true, $ne: null, $lte: purgeThreshold },
    }).toArray();

    if (expired.length > 0) {
      await deleteConversationsPermanently(expired, req);
      console.log(`[Trash] Auto-purged ${expired.length} conversations older than ${ARCHIVE_RETENTION_DAYS} days for ${user.email}`);
    }

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
      visibleItems.map((conversation) => conversationForViewer(conversation)),
      visibleItems.length < items.length ? visibleItems.length : total,
      page,
      pageSize
    );
  });
});
