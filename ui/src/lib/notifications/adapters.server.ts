import { ApiError } from "@/lib/api-error";
import type { ChannelChoices, NotificationChannel } from "./channels";

type ExternalChannel = Exclude<NotificationChannel, "in_app">;
export interface NotificationChannelAdapter {
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
