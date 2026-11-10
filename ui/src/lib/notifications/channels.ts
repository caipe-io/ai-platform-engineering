export const NOTIFICATION_CHANNELS = [
  "in_app",
  "web_push",
  "webex",
  "slack",
] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type ChannelChoices = Partial<Record<NotificationChannel, boolean>>;
export const DEFAULT_NOTIFICATION_CHANNELS: Record<
  NotificationChannel,
  boolean
> = {
  in_app: true,
  web_push: false,
  webex: false,
  slack: false,
};

export interface NotificationSubscription {
  enabled?: boolean;
  pausedUntil?: string | null;
  channels?: ChannelChoices;
  quietHours?: {
    enabled: boolean;
    start: string;
    end: string;
    timeZone: string;
  };
}

/** Find the first permitted minute using the recipient's zone, including DST. */
export function quietHoursEnd(
  preferences: NotificationSubscription | null,
  now = Date.now(),
): Date | null {
  const hours = preferences?.quietHours;
  if (!hours?.enabled || hours.start === hours.end) return null;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: hours.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const [startHour, startMinute] = hours.start.split(":").map(Number);
  const [endHour, endMinute] = hours.end.split(":").map(Number);
  const start = startHour * 60 + startMinute,
    end = endHour * 60 + endMinute;
  for (let offset = 0; offset <= 1500; offset++) {
    const at = now + offset * 60_000;
    const parts = formatter.formatToParts(at);
    const minute =
      Number(parts.find((part) => part.type === "hour")!.value) * 60 +
      Number(parts.find((part) => part.type === "minute")!.value);
    const quiet =
      start < end
        ? minute >= start && minute < end
        : minute >= start || minute < end;
    if (!quiet) return offset === 0 ? null : new Date(at);
  }
  return new Date(now + 24 * 60 * 60_000);
}

export interface NotificationTypeRegistration {
  id: string;
  label: string;
  description?: string;
}

export interface NotificationSourceView {
  id: string;
  label: string;
  subscription: NotificationSubscription;
  events: Array<
    NotificationTypeRegistration & { subscription: NotificationSubscription }
  >;
}

export function isPaused(
  value: NotificationSubscription | null,
  now = Date.now(),
): boolean {
  return Boolean(value?.pausedUntil && Date.parse(value.pausedUntil) > now);
}

export function channelEnabled(
  channel: NotificationChannel,
  global: NotificationSubscription | null,
  source: NotificationSubscription | null,
  event: NotificationSubscription | null,
  sourceDefault = true,
  now = Date.now(),
): boolean {
  if (
    [global, source, event].some(
      (setting) => isPaused(setting, now) || setting?.enabled === false,
    )
  )
    return false;
  if (!sourceDefault && source?.enabled !== true) return false;
  const globallyEnabled =
    global?.channels?.[channel] ?? DEFAULT_NOTIFICATION_CHANNELS[channel];
  if (!globallyEnabled) return false;
  return event?.channels?.[channel] ?? source?.channels?.[channel] ?? true;
}

export function safeNotificationHref(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > 500 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("href must be a relative application path");
  }
  return value;
}
