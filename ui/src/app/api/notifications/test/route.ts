import { readNotificationJson } from "@/lib/notifications/http.server";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import {
  ApiError,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { notificationUser } from "@/lib/notifications/request-user.server";
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from "@/lib/notifications/channels";
import { enqueueNotification } from "@/lib/notifications/delivery.server";
import { notificationKey } from "@/lib/notifications/subscriptions.server";

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { subject, user } = await notificationUser(request);
  const body = await readNotificationJson(request);
  const channel = body?.channel as NotificationChannel;
  if (!NOTIFICATION_CHANNELS.includes(channel))
    throw new ApiError("Select a delivery channel", 400);
  const limits = await getCollection<{
    _id: string;
    count: number;
    expiresAt: Date;
  }>("notification_test_limits");
  const limit = await limits.findOneAndUpdate(
    { _id: notificationKey(subject, String(Math.floor(Date.now() / 60_000))) },
    {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: new Date(Date.now() + 120_000) },
    },
    { upsert: true, returnDocument: "after" },
  );
  if ((limit?.count ?? 0) > 3) throw new ApiError("Try again in a minute", 429);
  await enqueueNotification({
    id: randomUUID(),
    sourceId: "platform",
    sourceLabel: "CAIPE",
    eventType: "notification.test",
    recipient: { subject, email: user.email },
    title: "Test notification",
    message: "Your notification delivery channel is working.",
    href: "/settings/notifications",
    severity: "info",
    channels: [channel],
    retentionDays: 1,
  });
  return successResponse({ queued: true }, 202);
});
