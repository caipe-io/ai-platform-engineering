import { NextRequest,after } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { listInAppNotifications } from "@/lib/in-app-notifications.server";
import { platformHealthNotificationsEnabled } from "@/lib/notification-preferences.server";
import { runPlatformHealthNotificationAudit } from "@/lib/platform-health-notifications.server";

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { user, session } = await getAuthFromBearerOrSession(request);
  const subject = typeof session.sub === "string" ? session.sub.trim() : "";
  if (!subject) throw new ApiError("Your session has expired. Please sign in again.", 401);
  const params = request.nextUrl.searchParams;
  const includePlatformNotifications = await platformHealthNotificationsEnabled(user.email);
  const page = await listInAppNotifications(subject, {
    page: positiveInteger(params.get("page"), 1),
    pageSize: positiveInteger(params.get("page_size"), 10),
    includePlatformNotifications,
  });
  after(() => runPlatformHealthNotificationAudit(request.nextUrl.origin));
  return successResponse(page);
});
