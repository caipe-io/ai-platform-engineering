import { ApiError } from "@/lib/api-error";
import {
  canLaunchAgenticApp,
  type AgenticAppUserContext,
} from "@/lib/agentic-apps/access";
import { getConfiguredAgenticApp } from "@/lib/agentic-apps/config";
import { getCollection } from "@/lib/mongodb";
import { originFromNextAuthUrl } from "@/lib/request-origin";
import { safeNotificationHref } from "./channels";
import {
  NOTIFICATION_CALLBACK_FALLBACK,
  notificationCallbackPath,
} from "./callback";
import type { InAppNotificationDocument } from "@/types/in-app-notification";
import type { NotificationDelivery } from "./delivery-types";

export function absoluteNotificationCallback(deliveryId: string): string {
  const origin = originFromNextAuthUrl();
  if (!origin)
    throw new Error("Set NEXTAUTH_URL before sending notification callbacks");
  return new URL(notificationCallbackPath(deliveryId), origin).href;
}

/** A callback is a locator, never a bearer grant or a replacement for page authorization. */
export async function resolveNotificationCallback(
  marker: string,
  subject: string,
  user: AgenticAppUserContext,
): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(marker))
    throw new ApiError("Notification unavailable", 404);
  const delivery = await (
    await getCollection<NotificationDelivery>("notification_deliveries")
  ).findOne({
    _id: marker,
    "recipient.subject": subject,
    expiresAt: { $gt: new Date() },
  });
  // Inbox retention can outlast the delivery queue's 90-day deduplication window.
  const inbox = delivery
    ? null
    : await (
        await getCollection<InAppNotificationDocument>("in_app_notifications")
      ).findOne({
        callback_marker: marker,
        recipient_user_subjects: subject,
        archived_at: { $exists: false },
        $or: [
          { expires_at: { $exists: false } },
          { expires_at: { $gt: new Date() } },
        ],
      } as never);
  if (!delivery && !inbox) throw new ApiError("Notification unavailable", 404);
  const sourceId = delivery?.sourceId ?? inbox?.source_id ?? "platform";
  if (sourceId.startsWith("app:")) {
    const app = getConfiguredAgenticApp(sourceId.slice(4));
    if (!app || !canLaunchAgenticApp(app, user))
      throw new ApiError("Notification unavailable", 404);
  }
  try {
    const target =
      safeNotificationHref(delivery?.href ?? inbox?.href) ??
      NOTIFICATION_CALLBACK_FALLBACK;
    // A producer must name a destination page, not another callback marker.
    if (
      decodeURIComponent(
        new URL(target, "https://example.test").pathname,
      ).startsWith("/notifications/open/")
    )
      throw new Error("Recursive notification callback");
    return target;
  } catch {
    throw new ApiError("Notification destination unavailable", 404);
  }
}
