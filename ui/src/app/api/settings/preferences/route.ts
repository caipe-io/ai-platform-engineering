// PATCH /api/settings/preferences - Update preferences only

import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from '@/lib/api-middleware';
import { parseChatHistoryOrganization } from "@/lib/chat-history-organization";
import { getCollection } from '@/lib/mongodb';
import type { UserSettings } from '@/types/mongodb';
import type { Document } from 'mongodb';
import { NextRequest } from 'next/server';

// PATCH /api/settings/preferences
export const PATCH = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (req, user) => {
    const body: Partial<UserSettings['preferences']> = await request.json();

    if (body.chat_history !== undefined) {
      try { body.chat_history = parseChatHistoryOrganization(body.chat_history); }
      catch (error) { throw new ApiError(error instanceof Error ? error.message : "Invalid chat organization", 400, "BAD_REQUEST"); }
    }
    const settings = await getCollection<UserSettings>('user_settings');

    const update: Document = {
      updated_at: new Date(),
    };

    // Update only provided preference keys
    Object.keys(body).forEach((key) => {
      update[`preferences.${key}`] = body[key];
    });

    await settings.updateOne(
      { user_id: user.email },
      { $set: update },
      { upsert: true }
    );

    const updated = await settings.findOne({ user_id: user.email });

    return successResponse(updated);
  });
});
