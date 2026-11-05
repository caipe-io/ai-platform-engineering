import { readNotificationJson } from "@/lib/notifications/http.server";
import { NextRequest } from "next/server";

import {
  ApiError,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { notificationUser } from "@/lib/notifications/request-user.server";
import {
  saveBrowserPushDevice,
  validatePushEndpoint,
  type BrowserPushDevice,
} from "@/lib/notifications/web-push.server";
import { notificationKey } from "@/lib/notifications/subscriptions.server";

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { subject } = await notificationUser(request);
  const id = await saveBrowserPushDevice(
    subject,
    await readNotificationJson(request),
  );
  return successResponse({ id }, 201);
});
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const { subject } = await notificationUser(request);
  const body = await readNotificationJson(request);
  if (typeof body?.endpoint !== "string")
    throw new ApiError("endpoint is required", 400);
  await (
    await getCollection<BrowserPushDevice>("notification_push_devices")
  ).deleteOne({
    _id: notificationKey(validatePushEndpoint(body.endpoint).href),
    subject,
  });
  return successResponse({ removed: true });
});
