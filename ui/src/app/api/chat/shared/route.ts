import { conversationForViewer } from "@/lib/conversation-view";
// GET /api/chat/shared - Get conversations shared with current user
//
// SECURITY INVARIANT (issue #1979): this route must NEVER query all non-owner
// conversations. Doing so would expose private conversations from other users
// to the OpenFGA permission pipeline and produce an inflated total count.
//
// The MongoDB query MUST include an $or pre-filter that restricts candidates to
// conversations with at least one sharing signal before passing them to
// filterConversationsByImplicitOrExplicitPermission. That filter accepts
// Mongo direct-share grants for backward compatibility and OpenFGA grants for
// ReBAC-managed sharing. Both layers are required — removing either breaks the
// security model.

import {
getPaginationParams,
paginatedResponse,
withAuth,
withErrorHandler,
} from '@/lib/api-middleware';
import { getCollection } from '@/lib/mongodb';
import {
  filterConversationsByImplicitOrExplicitPermission,
  getDirectSharingAccessConversationIds,
} from '@/lib/rbac/conversation-implicit-authz';
import type { Conversation } from '@/types/mongodb';
import { NextRequest } from 'next/server';

// GET /api/chat/shared
export const GET = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (req, user, session) => {
    const { page, pageSize, skip } = getPaginationParams(request);

    const conversations = await getCollection<Conversation>('conversations');
    const directShareConversationIds = await getDirectSharingAccessConversationIds(user.email, getCollection);
    const directShareCandidate =
      directShareConversationIds.length > 0 ? [{ _id: { $in: directShareConversationIds } }] : [];

    // Pre-filter to conversations that carry some sharing configuration.
    // This prevents private conversations from other users from leaking into
    // the authorization pipeline and from inflating the total count.
    const query = {
      owner_id: { $ne: user.email },
      $or: [
        { 'sharing.shared_with': user.email },
        ...directShareCandidate,
        { 'sharing.share_link_enabled': true },
        // Array has at least one element — user's team membership is checked by OpenFGA below
        { 'sharing.shared_with_teams.0': { $exists: true } },
      ],
    };

    const total = await conversations.countDocuments(query);

    const items = await conversations
      .find(query)
      .sort({ updated_at: -1 })
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
