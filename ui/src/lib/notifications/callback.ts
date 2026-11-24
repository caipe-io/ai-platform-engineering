import { safeNotificationHref } from "./channels";

export const NOTIFICATION_CALLBACK_FALLBACK = "/settings/notifications";

/** The public callbackUri field and legacy href represent the same destination. */
export function notificationCallbackUri(
  callbackUri: unknown,
  href?: unknown,
): string | undefined {
  const callback = safeNotificationHref(callbackUri);
  const legacy = safeNotificationHref(href);
  if (callback !== undefined && legacy !== undefined && callback !== legacy)
    throw new Error("callbackUri and href must identify the same destination");
  return callback ?? legacy;
}

/** The marker carries no destination or credentials; the host resolves it after sign-in. */
export function notificationCallbackPath(deliveryId: string): string {
  if (!/^[a-f0-9]{64}$/.test(deliveryId))
    throw new Error("Invalid notification callback marker");
  return `/notifications/open/${deliveryId}`;
}
