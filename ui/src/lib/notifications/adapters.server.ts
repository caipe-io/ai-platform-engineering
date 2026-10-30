import { browserPushPublicKey, sendBrowserPush, type BrowserPushDevice } from "./web-push.server";
import { getCollection } from "@/lib/mongodb";
import { notificationCallbackPath } from "./callback";
import { ApiError } from "@/lib/api-error";
import type { NotificationDelivery } from "./delivery-types";
import { NotificationDeliveryError } from "./delivery-types";
import type { ChannelChoices, NotificationChannel } from "./channels";

type ExternalChannel = Exclude<NotificationChannel, "in_app">;
export interface NotificationChannelAdapter {
  send?(delivery: NotificationDelivery): Promise<void>;
  available(subject: string): Promise<boolean>;
  validateEnable?(subject: string): Promise<void>;
  publicKey?(): string | null;
}
/** Optional channel integrations extend this registry; core has no provider dependency. */
export const notificationChannelAdapters: Partial<Record<ExternalChannel, NotificationChannelAdapter>> = {
  web_push: {
    available: async () => Boolean(browserPushPublicKey()),
    publicKey: browserPushPublicKey,
    validateEnable: async (subject) => {
      if (!(await (await getCollection<BrowserPushDevice>("notification_push_devices")).findOne({ subject, expiresAt: { $gt: new Date() } }))) throw new ApiError("Subscribe this browser before enabling web push", 400);
    },
    send: async (delivery) => {
      const device = await (await getCollection<BrowserPushDevice>("notification_push_devices")).findOne({ _id: delivery.targetId, subject: delivery.recipient.subject, expiresAt: { $gt: new Date() } });
      if (!device) throw new NotificationDeliveryError("Browser subscription has expired or was removed", false);
      await sendBrowserPush(device, delivery._id, notificationCallbackPath(delivery._id));
    },
  },
};

export async function notificationChannelAvailability(subject: string): Promise<ChannelChoices> {
  const choices: ChannelChoices = { in_app: true, web_push: false, webex: false, slack: false };
  for (const [channel, adapter] of Object.entries(notificationChannelAdapters)) {
    try { choices[channel as ExternalChannel] = await adapter.available(subject); }
    catch { choices[channel as ExternalChannel] = false; }
  }
  return choices;
}
export function notificationWebPushPublicKey(): string | null {
  return notificationChannelAdapters.web_push?.publicKey?.() ?? null;
}
export async function validateNotificationChannelChoices(subject: string, choices: Record<string, unknown>): Promise<void> {
  for (const [channel, enabled] of Object.entries(choices)) {
    if (channel === "in_app" || enabled !== true) continue;
    const adapter = notificationChannelAdapters[channel as ExternalChannel];
    if (!adapter || !await adapter.available(subject)) throw new ApiError("Notification channel is not configured or linked", 400);
    await adapter.validateEnable?.(subject);
  }
}

export async function sendExternalNotification(delivery: NotificationDelivery): Promise<void> {
  if (delivery.channel === "in_app") throw new NotificationDeliveryError("Inbox uses its own adapter", false);
  const adapter = notificationChannelAdapters[delivery.channel];
  if (!adapter?.send) throw new NotificationDeliveryError("Notification channel is not installed", false);
  await adapter.send(delivery);
}
