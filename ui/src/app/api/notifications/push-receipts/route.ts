import { NextRequest } from "next/server";

import {
  ApiError,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { readNotificationJson } from "@/lib/notifications/http.server";
import { notificationUser } from "@/lib/notifications/request-user.server";
import type { NotificationDelivery } from "@/lib/notifications/delivery.server";

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { subject } = await notificationUser(request);
  const { deliveryId } = await readNotificationJson(request);
  if (typeof deliveryId !== "string" || !/^[a-f0-9]{64}$/.test(deliveryId))
    throw new ApiError("Invalid delivery receipt", 400);
  const result = await (
    await getCollection<NotificationDelivery>("notification_deliveries")
  ).updateOne(
    {
      _id: deliveryId,
      channel: "web_push",
      "recipient.subject": subject,
      expiresAt: { $gt: new Date() },
      browserDisplayedAt: { $exists: false },
    },
    { $set: { browserDisplayedAt: new Date() } },
  );
  return successResponse({ recorded: result.modifiedCount > 0 });
});
