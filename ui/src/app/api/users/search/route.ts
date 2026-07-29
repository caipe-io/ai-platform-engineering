// GET /api/users/search - Search users by email (for sharing)

import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from '@/lib/api-middleware';
import { getCollection } from '@/lib/mongodb';
import {
shareableUserIdentityFilter,
type ShareableUserDocument,
} from '@/lib/rbac/shareable-users';
import type { UserPublicInfo } from '@/types/mongodb';
import { NextRequest } from 'next/server';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /api/users/search
export const GET = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (req) => {
    const url = new URL(req.url);
    const query = url.searchParams.get('q')?.trim();

    if (!query || query.length < 2) {
      throw new ApiError('Search query must be at least 2 characters', 400);
    }

    const users = await getCollection<ShareableUserDocument>('users');
    const escapedQuery = escapeRegExp(query);

    // Only return users with a stable Keycloak subject. Conversation access is
    // enforced by OpenFGA, so an unlinked Mongo profile is not shareable.
    const results = await users
      .find({
        $and: [
          {
            $or: [
              { email: { $regex: escapedQuery, $options: 'i' } },
              { name: { $regex: escapedQuery, $options: 'i' } },
            ],
          },
          shareableUserIdentityFilter(),
        ],
      })
      .limit(10)
      .toArray();

    // Return only public info
    const publicResults: UserPublicInfo[] = results.map((u) => ({
      email: u.email,
      name: u.name,
      avatar_url: u.avatar_url,
      subject: u.keycloak_sub ?? u.metadata?.keycloak_sub,
    }));

    return successResponse(publicResults);
  });
});
