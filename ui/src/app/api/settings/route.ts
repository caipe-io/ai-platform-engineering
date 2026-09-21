// GET /api/settings - Get all user settings
// PUT /api/settings - Update all settings

import {
successResponse,
withAuth,
withErrorHandler,
} from '@/lib/api-middleware';
import { getCollection } from '@/lib/mongodb';
import type { UpdateSettingsRequest,UserSettings } from '@/types/mongodb';
import { DEFAULT_USER_SETTINGS } from '@/types/mongodb';
import type { Document } from 'mongodb';
import { NextRequest } from 'next/server';

// GET /api/settings
export const GET = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (req, user) => {
    const settings = await getCollection<UserSettings>('user_settings');

    // Atomic get-or-create. A plain find-then-insert races on the unique
    // user_id index when concurrent requests both miss the read and insert
    // the same user_id (E11000) — guaranteed in dev-anonymous mode where
    // every request shares user_id "anonymous@local". $setOnInsert only
    // writes the defaults on first creation.
    const userSettings = await settings.findOneAndUpdate(
      { user_id: user.email },
      {
        $setOnInsert: {
          user_id: user.email,
          ...DEFAULT_USER_SETTINGS,
          updated_at: new Date(),
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    return successResponse(userSettings);
  });
});

// PUT /api/settings
export const PUT = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (req, user) => {
    const body: UpdateSettingsRequest = await request.json();

    const settings = await getCollection<UserSettings>('user_settings');

    const update: Document = {
      updated_at: new Date(),
    };

    if (body.preferences) {
      Object.keys(body.preferences).forEach((key) => {
        update[`preferences.${key}`] = body.preferences![key as keyof typeof body.preferences];
      });
    }

    if (body.notifications) {
      Object.keys(body.notifications).forEach((key) => {
        update[`notifications.${key}`] = body.notifications![key as keyof typeof body.notifications];
      });
    }

    if (body.defaults) {
      Object.keys(body.defaults).forEach((key) => {
        update[`defaults.${key}`] = body.defaults![key as keyof typeof body.defaults];
      });
    }

    await settings.updateOne(
      { user_id: user.email },
      { $set: update },
      { upsert: true }
    );

    const updated = await settings.findOne({ user_id: user.email });

    return successResponse(updated);
  });
});
