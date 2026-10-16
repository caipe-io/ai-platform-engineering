import { createInAppNotification } from "@/lib/in-app-notifications.server";
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
import {
  closeNotificationConnection,
  ensureNotificationStream,
  getNatsConnection,
  NOTIFICATION_CONSUMER,
  NOTIFICATION_STREAM,
  notificationSubject,
  notificationTransportMode,
} from "@/lib/notifications/transport.server";
import type { UserSettings } from "@/types/mongodb";
import type { JsMsg } from "nats";

export type NotificationPublishOutcome =
  | "delivered"
  | "disabled"
  | "invalid"
  | "failed"
  | "queued";

/**
 * Producer entry point. Validates the envelope, then hands it to the active
 * transport:
 * - direct: stores the inbox entry in-process. Storage errors are logged and
 *   reported as "failed", never thrown.
 * - jetstream: publishes to the durable stream, and the consumer stores it.
 *   If NATS is unreachable this returns "failed". It does not fall back to
 *   direct, so the operator sees the outage.
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

  if (notificationTransportMode() === "jetstream") {
    return publishToJetStream(envelope);
  }

  try {
    return await storeNotificationEnvelope(envelope);
  } catch (error) {
    console.error("[notifications] failed to store event", envelope.type, error);
    return "failed";
  }
}

async function publishToJetStream(
  envelope: NotificationEnvelope,
): Promise<NotificationPublishOutcome> {
  try {
    const nc = await getNatsConnection();
    const js = nc.jetstream();
    await js.publish(notificationSubject(envelope.type), JSON.stringify(envelope), {
      // NATS rejects a repeat of this id within the stream's duplicate window,
      // so a producer retry cannot enqueue the event twice. The recipient is
      // part of the id because one event fans out to several recipients.
      msgID: `${envelope.id}:${envelope.attempt_id}:${envelope.recipient_subject}`,
    });
    return "queued";
  } catch (error) {
    console.error("[notifications] JetStream publish failed", envelope.type, error);
    return "failed";
  }
}

/**
 * Writes one inbox entry for an already-validated envelope. Throws on storage
 * failure, so the JetStream consumer can nak and let NATS redeliver.
 */
export async function storeNotificationEnvelope(
  envelope: NotificationEnvelope,
): Promise<NotificationPublishOutcome> {
  const preferences = await loadNotificationPreferences(envelope.recipient_email);
  if (!isNotificationEnabled(envelope.type, preferences)) {
    return "disabled";
  }

  const definition = NOTIFICATION_EVENT_CATALOG[envelope.type];
  await createInAppNotification({
    eventKey: notificationEventKey(envelope, envelope.recipient_subject),
    recipientUserSubjects: [envelope.recipient_subject],
    title: envelope.data.title,
    message: envelope.data.summary,
    href: envelope.data.href,
    severity: definition.severity,
    category: "general",
    sourceLabel: definition.category,
    correlationKey: envelope.correlation_id,
    eventType: envelope.type,
    retentionDays: notificationRetentionDays(),
  });
  return "delivered";
}

/**
 * Starts the durable JetStream consumer. Called once from instrumentation.
 * Every replica runs the same durable consumer, so NATS delivers each event
 * to one replica. Connection failures retry in the background and never block
 * server startup.
 */
export function startNotificationConsumer(): void {
  if (notificationTransportMode() !== "jetstream") return;
  void runConsumerWithRetry();
}

let consumerStopped = false;

/** Stops the consumer loop and closes its connection. Used on shutdown and in tests. */
export async function stopNotificationConsumer(): Promise<void> {
  consumerStopped = true;
  await closeNotificationConnection();
}

async function runConsumerWithRetry(): Promise<void> {
  while (!consumerStopped) {
    try {
      await runConsumer();
      console.warn("[notifications] consumer ended, restarting");
    } catch (error) {
      console.error("[notifications] consumer failed, retrying in 5s", error);
    }
    if (consumerStopped) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function runConsumer(): Promise<void> {
  const nc = await getNatsConnection();
  await ensureNotificationStream(nc);
  const consumer = await nc
    .jetstream()
    .consumers.get(NOTIFICATION_STREAM, NOTIFICATION_CONSUMER);
  const messages = await consumer.consume();

  for await (const message of messages) {
    await handleJetStreamMessage(message);
  }
}

async function handleJetStreamMessage(message: JsMsg): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(message.data));
  } catch {
    console.warn("[notifications] dropped unparseable message");
    message.term();
    return;
  }

  const parsed = parseNotificationEnvelope(input);
  if (parsed.ok === false) {
    console.warn("[notifications] dropped invalid message:", parsed.error);
    message.term();
    return;
  }

  try {
    await storeNotificationEnvelope(parsed.envelope);
    message.ack();
  } catch (error) {
    console.error("[notifications] storage failed, will redeliver", error);
    message.nak(5_000);
  }
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
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_RETENTION_DAYS) return DEFAULT_RETENTION_DAYS;
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
