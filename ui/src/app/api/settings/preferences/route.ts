// PATCH /api/settings/preferences - Update preferences only

import {
ApiError,
successResponse,
withAuth,
withErrorHandler,
} from '@/lib/api-middleware';
import { parseChatHistoryOrganization } from "@/lib/chat-history-organization";
import { isAssistantFontScale } from "@/lib/appearance-preferences";
import { parseFavoriteAppIds } from "@/lib/agentic-apps/favorites";
import { getCollection } from '@/lib/mongodb';
import type { UserSettings } from '@/types/mongodb';
import type { Document } from 'mongodb';
import { NextRequest } from 'next/server';

// PATCH /api/settings/preferences
export const PATCH = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (req, user) => {
    const body: Partial<UserSettings['preferences']> = await request.json();
    if (Object.keys(body).some((key) => key.includes('.'))) {
      throw new ApiError('Preference keys must not contain dots', 400, 'BAD_REQUEST');
    }
    if (body.shadows_enabled !== undefined && typeof body.shadows_enabled !== 'boolean') {
      throw new ApiError('shadows_enabled must be a boolean', 400, 'BAD_REQUEST');
    }
    if (body.assistant_glass_enabled !== undefined && typeof body.assistant_glass_enabled !== 'boolean') {
      throw new ApiError('assistant_glass_enabled must be a boolean', 400, 'BAD_REQUEST');
    }
    if (body.assistant_font_scale !== undefined && !isAssistantFontScale(body.assistant_font_scale)) {
      throw new ApiError('Invalid assistant_font_scale', 400, 'BAD_REQUEST');
    }
    if (body.favorite_agentic_apps !== undefined) {
      try { body.favorite_agentic_apps = parseFavoriteAppIds(body.favorite_agentic_apps); }
      catch { throw new ApiError('Invalid favorite_agentic_apps', 400, 'BAD_REQUEST'); }
    }

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
