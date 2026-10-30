import { NextRequest } from "next/server";
import { successResponse, withErrorHandler } from "@/lib/api-middleware";
import { notificationUser } from "@/lib/notifications/request-user.server";
import { notificationChannelAvailability } from "@/lib/notifications/adapters.server";
export const GET = withErrorHandler(async (request: NextRequest) => {
  const { subject } = await notificationUser(request);
  return successResponse(await notificationChannelAvailability(subject));
});
