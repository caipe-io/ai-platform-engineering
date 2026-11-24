import { ApiError } from "@/lib/api-error";
import type { NotificationDelivery } from "./delivery-types";
import { NotificationDeliveryError } from "./delivery-types";
import type { ChannelChoices, NotificationChannel } from "./channels";

type ExternalChannel = Exclude<NotificationChannel, "in_app">;

export const EXTERNAL_NOTIFICATION_TIMEOUT_MS = 30_000;

interface NotificationSendOptions {
  signal: AbortSignal;
  idempotencyKey: string;
}
export interface NotificationChannelAdapter {
  /** Honor cancellation and forward the key if the provider supports idempotency. */
  send?(delivery: NotificationDelivery, options: NotificationSendOptions): Promise<void>;
  available(subject: string): Promise<boolean>;
  validateEnable?(subject: string): Promise<void>;
  publicKey?(): string | null;
}
/** Optional channel integrations extend this registry; core has no provider dependency. */
export const notificationChannelAdapters: Partial<Record<ExternalChannel, NotificationChannelAdapter>> = {};

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
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new NotificationDeliveryError("Notification adapter timed out");
      reject(error);
      controller.abort(error);
    }, EXTERNAL_NOTIFICATION_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      adapter.send(delivery, { signal: controller.signal, idempotencyKey: delivery._id }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
