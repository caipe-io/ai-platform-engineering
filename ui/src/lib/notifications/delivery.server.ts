import { randomUUID } from "node:crypto";

import { createInAppNotification } from "@/lib/in-app-notifications.server";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { sendExternalNotification } from "./adapters.server";
import {
  notificationKey,
  deliveryAllowed,
  readSubscription,
} from "./subscriptions.server";
import { quietHoursEnd, type NotificationChannel } from "./channels";
import {
  NotificationDeliveryError,
  type NotificationDispatch,
  type NotificationDelivery,
} from "./delivery-types";
export type {
  NotificationDispatch,
  NotificationDelivery,
} from "./delivery-types";
interface BrowserPushDevice { _id: string; subject: string; expiresAt: Date; }
type QueuedDelivery = NotificationDelivery;

interface NotificationJob extends NotificationDispatch {
  _id: string;
  expanded: boolean;
  createdAt: Date;
  expiresAt: Date;
}
/** Persist acceptance before returning; expansion can resume after a process exits. */
export async function enqueueNotification(
  input: NotificationDispatch,
): Promise<void> {
  if (process.env.NOTIFICATION_EVENTS_ENABLED === "false")
    throw new Error("Notifications are disabled");
  await (
    await getCollection<NotificationJob>("notification_jobs")
  ).updateOne(
    { _id: notificationKey(input.sourceId, input.id, input.recipient.subject) },
    {
      $setOnInsert: {
        ...input,
        expanded: false,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 86400_000),
      },
    },
    { upsert: true },
  );
}

async function expandNotificationJobs(): Promise<void> {
  const jobs = await getCollection<NotificationJob>("notification_jobs");
  const deliveries = await getCollection<NotificationDelivery>(
    "notification_deliveries",
  );
  for (const job of await jobs
    .find({ expanded: false, expiresAt: { $gt: new Date() } })
    .limit(25)
    .toArray()) {
    const devices = await (
      await getCollection<BrowserPushDevice>("notification_push_devices")
    )
      .find({ subject: job.recipient.subject, expiresAt: { $gt: new Date() } })
      .limit(10)
      .toArray();
    const targets: Array<{ channel: NotificationChannel; targetId?: string }> =
      [
        { channel: "in_app" },
        { channel: "slack" },
        { channel: "webex" },
        ...devices.map((device) => ({
          channel: "web_push" as const,
          targetId: device._id,
        })),
      ];
    for (const target of targets) {
      if (job.channels && !job.channels.includes(target.channel)) continue;
      const { _id, ...input } = job;
      delete (input as Partial<NotificationJob>).expanded;
      const id = notificationKey(_id, target.channel, target.targetId ?? "");
      await deliveries.updateOne(
        { _id: id },
        {
          $setOnInsert: {
            ...input,
            notificationId: _id,
            ...target,
            status: "pending",
            attempts: 0,
            availableAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
    await jobs.updateOne({ _id: job._id }, { $set: { expanded: true } });
  }
}

export async function runNotificationDeliveriesOnce(): Promise<number> {
  await expandNotificationJobs();
  const deliveries = await getCollection<QueuedDelivery>(
    "notification_deliveries",
  );
  const now = new Date();
  const due = {
    expiresAt: { $gt: now },
    $or: [
      { status: "pending", availableAt: { $lte: now } },
      { status: "processing", leaseUntil: { $lte: now } },
    ],
  };
  const candidates = await deliveries
    .find(due as never)
    .sort({ availableAt: 1 })
    .limit(25)
    .toArray();
  for (const candidate of candidates) {
    const token = randomUUID();
    const delivery = await deliveries.findOneAndUpdate(
      { _id: candidate._id, ...due } as never,
      {
        $set: {
          status: "processing",
          leaseToken: token,
          leaseUntil: new Date(Date.now() + 60_000),
          updatedAt: new Date(),
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: "after" },
    );
    if (!delivery) continue;
    try {
      const allowed = await deliveryAllowed(
          delivery.recipient.subject,
          delivery.sourceId,
          delivery.eventType,
          delivery.channel,
        );
        if (allowed && delivery.channel !== "in_app") {
          const [global, source] = await Promise.all([
            readSubscription(delivery.recipient.subject),
            readSubscription(delivery.recipient.subject, delivery.sourceId),
          ]);
          const until = quietHoursEnd(source?.quietHours ? source : global);
          if (until) {
            await deliveries.updateOne(
              { _id: delivery._id, leaseToken: token },
              {
                $set: {
                  status: "pending",
                  availableAt: until,
                  updatedAt: new Date(),
                },
                $inc: { attempts: -1 },
                $unset: { leaseUntil: "", leaseToken: "" },
              },
            );
            continue;
          }
        }
        if (allowed) {
          if (delivery.channel === "in_app") {
            await createInAppNotification({
              eventKey: delivery.notificationId,
              recipientUserSubjects: [delivery.recipient.subject],
              title: delivery.title,
              message: delivery.message,
              href: delivery.href,
              severity: delivery.severity,
              sourceLabel: delivery.sourceLabel,
              sourceId: delivery.sourceId,
              correlationKey: delivery.correlationKey,
              eventType: delivery.eventType,
              retentionDays: delivery.retentionDays,
            });
          } else await sendExternalNotification(delivery);
        }
      await deliveries.updateOne(
        { _id: delivery._id, leaseToken: token },
        {
          $set: {
            status: allowed ? "delivered" : "skipped",
            updatedAt: new Date(),
          },
          $unset: { leaseUntil: "", leaseToken: "", lastError: "" },
        },
      );
    } catch (error) {
      console.error(
        "[notification-delivery] channel failed",
        delivery.channel,
        delivery._id,
        error instanceof Error ? error.name : "unknown",
      );
      await deliveries.updateOne(
        { _id: delivery._id, leaseToken: token },
        {
          $set: {
            status:
              delivery.attempts >= 5 ||
              (error instanceof NotificationDeliveryError && !error.retryable)
                ? "failed"
                : "pending",
            availableAt: new Date(
              Date.now() +
                Math.max(
                  Math.min(300_000, 5000 * 2 ** delivery.attempts) *
                    (0.8 + Math.random() * 0.4),
                  error instanceof NotificationDeliveryError
                    ? error.retryAfterMs
                    : 0,
                ),
            ),
            updatedAt: new Date(),
            lastError:
              "Delivery failed. Check the channel connection and try again.",
          },
          $unset: { leaseUntil: "", leaseToken: "" },
        },
      );
    }
  }
  return candidates.length;
}

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
export function kickNotificationDeliveries(): void {
  if (running || process.env.NOTIFICATION_EVENTS_ENABLED === "false") return;
  running = true;
  void runNotificationDeliveriesOnce()
    .catch((error) =>
      console.error("[notification-delivery] worker failed", error),
    )
    .finally(() => {
      running = false;
    });
}
export function startNotificationDeliveries(): void {
  if (
    timer ||
    !isMongoDBConfigured ||
    process.env.NOTIFICATION_EVENTS_ENABLED === "false"
  )
    return;
  kickNotificationDeliveries();
  timer = setInterval(kickNotificationDeliveries, 2000);
  timer.unref?.();
}
export function stopNotificationDeliveries(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
