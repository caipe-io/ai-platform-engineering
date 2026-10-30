import { NextRequest } from "next/server";

import { successResponse, withErrorHandler } from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { notificationUser } from "@/lib/notifications/request-user.server";
import type { NotificationDelivery } from "@/lib/notifications/delivery.server";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { subject } = await notificationUser(request);
  const rows = await (
    await getCollection<NotificationDelivery>("notification_deliveries")
  )
    .find({ "recipient.subject": subject })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  return successResponse({
    deliveries: rows.map(
      ({
        _id,
        sourceLabel,
        eventType,
        channel,
        status,
        attempts,
        lastError,
        updatedAt,
        browserDisplayedAt,
      }) => ({
        id: _id,
        sourceLabel,
        eventType,
        channel,
        status,
        attempts,
        lastError,
        updatedAt,
        browserDisplayedAt,
      }),
    ),
  });
});
