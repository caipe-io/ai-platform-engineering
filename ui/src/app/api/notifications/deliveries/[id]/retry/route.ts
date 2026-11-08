import { NextRequest } from "next/server";

import {
  ApiError,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { notificationUser } from "@/lib/notifications/request-user.server";
import {
  kickNotificationDeliveries,
  type NotificationDelivery,
} from "@/lib/notifications/delivery.server";

export const POST = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const { subject } = await notificationUser(request);
    const { id } = await context.params;
    const result = await (
      await getCollection<NotificationDelivery>("notification_deliveries")
    ).updateOne(
      {
        _id: id,
        "recipient.subject": subject,
        status: "failed",
        expiresAt: { $gt: new Date() },
      },
      {
        $set: {
          status: "pending",
          attempts: 0,
          availableAt: new Date(),
          updatedAt: new Date(),
        },
        $unset: { lastError: "" },
      },
    );
    if (!result.modifiedCount)
      throw new ApiError("Failed delivery not found", 404);
    kickNotificationDeliveries();
    return successResponse({ queued: true });
  },
);
