import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import {
  mergeNotificationPreferences,
  type NotificationPreferencePatch,
  type NotificationPreferences,
} from "@/lib/notifications/preferences";
import { DEFAULT_USER_SETTINGS } from "@/types/mongodb";
import type { UserSettings } from "@/types/mongodb";

const MAX_ATTEMPTS = 8;
const DUPLICATE_KEY = 11000;
const NAMESPACE_NOT_FOUND = 26;

/**
 * Applies a validated patch to one user's stored preferences without losing a
 * concurrent writer's changes.
 *
 * Two tabs, devices, or server replicas can read the same document and edit
 * different events. A plain read, merge, then overwrite would let the second
 * write erase the first. Instead each write is guarded by a revision number:
 * it only succeeds if the document is still at the revision that was read.
 * On a conflict the merge is recomputed from the fresh document and retried.
 *
 * Event names contain dots, so an in-place `$set` on a dotted path would nest
 * them. Merging in code and swapping the whole object, guarded by the
 * revision, keeps literal keys safe on MongoDB and compatible stores alike.
 *
 * Creating the first document is covered too: `user_id` has a unique index, so
 * two first writers cannot both insert. The loser gets a duplicate-key error
 * and retries against the document that won.
 */
export async function updateNotificationPreferences(
  userId: string,
  patch: NotificationPreferencePatch,
): Promise<NotificationPreferences> {
  const settings = await getCollection<UserSettings>("user_settings");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const current = await settings.findOne(
      { user_id: userId },
      {
        projection: {
          notification_preferences: 1,
          notification_preferences_rev: 1,
        },
      },
    );
    if (!current) {
      // Database bootstrap may continue after a failed index build. Never
      // upsert a first settings document without its uniqueness guarantee.
      const indexes = await settings.listIndexes().toArray().catch((error: unknown) => {
        if ((error as { code?: number }).code === NAMESPACE_NOT_FOUND) return [];
        throw error;
      });
      const hasUniqueUserIndex = indexes.some((index) =>
        index.unique === true &&
        Object.keys(index.key).length === 1 &&
        index.key.user_id === 1 &&
        !index.partialFilterExpression &&
        !index.buildUUID,
      );
      if (!hasUniqueUserIndex) {
        throw new ApiError(
          "Notification settings are temporarily unavailable. Try again later.",
          503,
          "PREFERENCES_STORAGE_UNAVAILABLE",
        );
      }
    }
    const revision = current?.notification_preferences_rev ?? 0;
    const merged = mergeNotificationPreferences(
      current?.notification_preferences ?? null,
      patch,
    );

    // Documents written before revisions existed have no field, which counts as 0.
    const guard =
      revision === 0
        ? {
            $or: [
              { notification_preferences_rev: { $exists: false } },
              { notification_preferences_rev: 0 },
            ],
          }
        : { notification_preferences_rev: revision };

    try {
      const result = await settings.updateOne(
        { user_id: userId, ...guard } as never,
        {
          $setOnInsert: { ...DEFAULT_USER_SETTINGS, user_id: userId },
          $set: {
            notification_preferences: merged,
            notification_preferences_rev: revision + 1,
            updated_at: new Date(),
          },
        },
        { upsert: !current },
      );
      if (result.matchedCount > 0 || result.upsertedCount > 0) return merged;
    } catch (error) {
      // Someone else changed or created the document between our read and write.
      if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error;
    }
  }

  throw new ApiError(
    "Your notification settings changed in another tab or device. Reload and try again.",
    409,
    "PREFERENCES_CONFLICT",
  );
}
