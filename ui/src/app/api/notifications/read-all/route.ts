import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { markAllInAppNotificationsRead } from "@/lib/in-app-notifications.server";
import { inboxViewOptions } from "@/lib/notification-preferences.server";

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { user, session } = await getAuthFromBearerOrSession(request);
  const subject = typeof session.sub === "string" ? session.sub.trim() : "";
  if (!subject) throw new ApiError("Your session has expired. Please sign in again.", 401);
  const viewOptions = await inboxViewOptions(user.email);
  const updated = await markAllInAppNotificationsRead(subject, {
    ...viewOptions,
  });
  return successResponse({ updated });
});
