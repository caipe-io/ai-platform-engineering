import { enqueuePlatformNotificationExports } from "./exports.server";
import { enqueueNotification } from "@/lib/notifications/delivery.server";
import { getCollection } from "@/lib/mongodb";
import {
  notificationEventKey,
  parseNotificationEnvelope,
  type NotificationEnvelope,
} from "@/lib/notifications/envelope";
import {
  isNotificationEnabled,
  type NotificationPreferences,
} from "@/lib/notifications/preferences";
import { NOTIFICATION_EVENT_CATALOG } from "@/lib/notifications/taxonomy";
import type { UserSettings } from "@/types/mongodb";

export type NotificationPublishOutcome =
  "delivered" | "disabled" | "invalid" | "failed" | "queued";

/**
 * Producer entry point. Validates the envelope, then hands it to the active
 * direct MongoDB transport: persists a delivery job in MongoDB. Storage errors are logged and
 *   reported as "failed", never thrown.
 *
 * Callers never need a try/catch. Notifications must not break the job that
 * produced the event.
 */
export async function publishNotificationEvent(
  input: unknown,
): Promise<NotificationPublishOutcome> {
  if (!notificationEventsEnabled()) {
    return "disabled";
  }

  const parsed = parseNotificationEnvelope(input);
  if (parsed.ok === false) {
    console.warn("[notifications] dropped invalid event:", parsed.error);
    return "invalid";
  }
  const envelope = parsed.envelope;
  if (process.env.NOTIFICATIONS_TRANSPORT === "jetstream") {
    console.error("[notifications] JetStream transport is not installed");
    return "failed";
  }


  try {
    return await storeNotificationEnvelope(envelope);
  } catch (error) {
    console.error(
      "[notifications] failed to store event",
      envelope.type,
      error,
    );
    return "failed";
  }
}

/**
 * Queues delivery for an already-validated envelope. Throws on storage
 * failure, so the JetStream consumer can nak and let NATS redeliver.
 */
export async function storeNotificationEnvelope(
  envelope: NotificationEnvelope,
): Promise<NotificationPublishOutcome> {
  await enqueuePlatformNotificationExports(envelope);
  const preferences = await loadNotificationPreferences(
    envelope.recipient_email,
  );
  if (!isNotificationEnabled(envelope.type, preferences)) {
    return "disabled";
  }

  const definition = NOTIFICATION_EVENT_CATALOG[envelope.type];
  await enqueueNotification({
    id: notificationEventKey(envelope, envelope.recipient_subject),
    sourceId: "platform",
    sourceLabel: definition.category,
    eventType: envelope.type,
    recipient: {
      subject: envelope.recipient_subject,
      email: envelope.recipient_email,
    },
    title: envelope.data.title,
    message: envelope.data.summary,
    href: envelope.data.href,
    severity: definition.severity,
    retentionDays: notificationRetentionDays(),
    correlationKey: envelope.correlation_id,
  });
  return "queued";
}

const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 3650;

/**
 * How long event notifications are kept. NOTIFICATION_RETENTION_DAYS=0 keeps
 * them forever. A missing or invalid value uses the default.
 */
export function notificationRetentionDays(): number | undefined {
  const raw = process.env.NOTIFICATION_RETENTION_DAYS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_RETENTION_DAYS)
    return DEFAULT_RETENTION_DAYS;
  return parsed === 0 ? undefined : parsed;
}

/**
 * Operator kill switch. Defaults to on. Setting NOTIFICATION_EVENTS_ENABLED=false
 * makes every producer a no-op, so workflow and ingestion behavior matches the
 * pre-notification release.
 */
function notificationEventsEnabled(): boolean {
  return process.env.NOTIFICATION_EVENTS_ENABLED !== "false";
}

async function loadNotificationPreferences(
  userId: string,
): Promise<NotificationPreferences | null> {
  const settings = await getCollection<UserSettings>("user_settings");
  const doc = await settings.findOne(
    { user_id: userId },
    { projection: { notification_preferences: 1 } },
  );
  return doc?.notification_preferences ?? null;
}
