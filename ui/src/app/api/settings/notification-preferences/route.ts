// GET   /api/settings/notification-preferences - effective event preferences for the current user
// PATCH /api/settings/notification-preferences - update category and event overrides

import { ApiError } from "@/lib/api-error";
import {
  successResponse,
  withAuth,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import {
  isNotificationEnabled,
  parseNotificationPreferencePatch,
  type NotificationPreferences,
} from "@/lib/notifications/preferences";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENT_CATALOG,
  NOTIFICATION_EVENT_TYPES,
} from "@/lib/notifications/taxonomy";
import { updateNotificationPreferences } from "@/lib/notifications/preferences.server";
import type { UserSettings } from "@/types/mongodb";
import { NextRequest } from "next/server";

function effectiveView(preferences: NotificationPreferences | null) {
  return {
    categories: NOTIFICATION_CATEGORIES,
    events: NOTIFICATION_EVENT_TYPES.map((type) => ({
      type,
      category: NOTIFICATION_EVENT_CATALOG[type].category,
      enabled: isNotificationEnabled(type, preferences),
      explicit:
        preferences?.events?.[type] !== undefined ||
        preferences?.categories?.[NOTIFICATION_EVENT_CATALOG[type].category] !== undefined,
    })),
    preferences: preferences ?? { categories: {}, events: {} },
  };
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user) => {
    const settings = await getCollection<UserSettings>("user_settings");
    const doc = await settings.findOne(
      { user_id: user.email },
      { projection: { notification_preferences: 1 } },
    );
    return successResponse(effectiveView(doc?.notification_preferences ?? null));
  });
});

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (req, user) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new ApiError("Request body must be JSON", 400, "INVALID_JSON");
    }

    const parsed = parseNotificationPreferencePatch(body);
    if (parsed.ok === false) {
      throw new ApiError(parsed.error, 400, "INVALID_PREFERENCES");
    }

    const merged = await updateNotificationPreferences(user.email, parsed.patch);

    return successResponse(effectiveView(merged));
  });
});
