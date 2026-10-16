import { getCollection } from "@/lib/mongodb";
import {
  isNotificationEnabled,
  type NotificationPreferences,
} from "@/lib/notifications/preferences";
import type { NotificationEventType } from "@/lib/notifications/taxonomy";
import type { UserSettings } from "@/types/mongodb";

/**
 * Events stored once for a whole audience, such as every org admin, rather
 * than once per person. They cannot be skipped when written, so each viewer's
 * preferences filter them when the inbox is read.
 */
export const SHARED_INBOX_EVENT_TYPES: NotificationEventType[] = [
  "service.degraded",
  "service.recovered",
];

export async function platformHealthNotificationsEnabled(
  userEmail: string,
): Promise<boolean> {
  const normalizedEmail = userEmail.trim();
  if (!normalizedEmail) return true;

  const settings = await getCollection<UserSettings>("user_settings");
  const userSettings = await settings.findOne({ user_id: normalizedEmail });
  return userSettings?.notifications?.platform_health !== false;
}

export interface InboxViewOptions {
  includePlatformNotifications: boolean;
  excludedEventTypes: string[];
}

/** What this user has chosen to hide from their inbox, in one settings read. */
export async function inboxViewOptions(userEmail: string): Promise<InboxViewOptions> {
  const normalizedEmail = userEmail.trim();
  if (!normalizedEmail) return { includePlatformNotifications: true, excludedEventTypes: [] };

  const settings = await getCollection<UserSettings>("user_settings");
  const userSettings = await settings.findOne(
    { user_id: normalizedEmail },
    { projection: { "notifications.platform_health": 1, notification_preferences: 1 } },
  );
  const preferences: NotificationPreferences | null = userSettings?.notification_preferences ?? null;
  return {
    includePlatformNotifications: userSettings?.notifications?.platform_health !== false,
    excludedEventTypes: SHARED_INBOX_EVENT_TYPES.filter(
      (type) => !isNotificationEnabled(type, preferences),
    ),
  };
}
