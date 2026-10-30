import { getCollection } from "@/lib/mongodb";
import { notificationKey } from "./subscriptions.server";
import {
  parseNotificationEnvelope,
  type NotificationEnvelope,
} from "./envelope";
import { NOTIFICATION_EVENT_CATALOG } from "./taxonomy";
import { sendSplunkNotificationEvent } from "./splunk.server";
import { sendOtelNotificationEvent } from "./otel.server";
import type {
  NotificationExportDelivery,
  NotificationExportEvent,
  NotificationExportSink,
} from "./delivery-types";

function enabled(sink: NotificationExportSink): boolean {
  return (
    process.env.NOTIFICATION_EVENTS_ENABLED !== "false" &&
    process.env[`NOTIFICATION_${sink.toUpperCase()}_ENABLED`] === "true"
  );
}

function eventAllowed(eventType: string): boolean {
  const types = process.env.NOTIFICATION_EXPORT_EVENT_TYPES?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return !types?.length || types.includes(eventType);
}

export async function enqueueNotificationExports(
  input: Omit<NotificationExportEvent, "id"> & { key: string[] },
): Promise<void> {
  const sinks = (["splunk", "otel"] as const).filter(enabled);
  if (!sinks.length || !eventAllowed(input.eventType)) return;
  const event: NotificationExportEvent = {
    id: notificationKey(input.sourceId, input.eventType, ...input.key),
    sourceId: input.sourceId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    severity: input.severity,
    ...(input.resourceType ? { resourceType: input.resourceType } : {}),
    ...(input.resourceIdHash ? { resourceIdHash: input.resourceIdHash } : {}),
  };
  const deliveries = await getCollection<NotificationExportDelivery>(
    "notification_deliveries",
  );
  for (const channel of sinks)
    await deliveries.updateOne(
      { _id: notificationKey("export", channel, event.id) },
      {
        $setOnInsert: {
          kind: "export",
          channel,
          event,
          status: "pending",
          attempts: 0,
          availableAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + 90 * 86400_000),
        },
      },
      { upsert: true },
    );
}

export async function enqueuePlatformNotificationExports(
  input: unknown,
): Promise<void> {
  if (!enabled("splunk") && !enabled("otel")) return;
  const parsed = parseNotificationEnvelope({
    ...(input as NotificationEnvelope),
    recipient_subject: "export-validation",
    recipient_email: "validation@example.test",
  });
  if (!parsed.ok)
    throw new Error("Cannot export an invalid notification event");
  const event = parsed.envelope;
  await enqueueNotificationExports({
    key: [event.resource.type, event.resource.id, event.attempt_id],
    sourceId: "platform",
    eventType: event.type,
    occurredAt: event.occurred_at,
    severity: NOTIFICATION_EVENT_CATALOG[event.type].severity,
    resourceType: event.resource.type,
    resourceIdHash: notificationKey(event.resource.type, event.resource.id),
  });
}

export async function sendNotificationExport(
  delivery: NotificationExportDelivery,
): Promise<boolean> {
  if (!enabled(delivery.channel) || !eventAllowed(delivery.event.eventType))
    return false;
  if (delivery.channel === "splunk")
    await sendSplunkNotificationEvent(delivery.event);
  else await sendOtelNotificationEvent(delivery.event);
  return true;
}
