import { NextRequest, after } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getRequestOrigin } from "@/app/api/skills/_lib/request-origin";
import { findNotificationProducer } from "@/lib/agentic-apps/notification-producer";
import { createInAppNotification, listInAppNotifications } from "@/lib/in-app-notifications.server";
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
  after(() => runPlatformHealthNotificationAudit(getRequestOrigin(request)));
  return successResponse(page);
});

const MAX_RECIPIENTS = 50;
const LIMITS = { eventKey: 200, title: 200, message: 1000, href: 500 } as const;
const SEVERITIES = ["info", "success", "warning", "error"] as const;
type Severity = (typeof SEVERITIES)[number];

function text(value: unknown, field: keyof typeof LIMITS): string {
  if (typeof value !== "string" || !value.trim() || value.length > LIMITS[field]) {
    throw new ApiError(`${field} is required and at most ${LIMITS[field]} characters`, 400, "BAD_REQUEST");
  }
  return value.trim();
}

/**
 * An installed app creates a notification for named users about its own work.
 * Only the service account an installed app is bound to may call it, and only
 * for users, never a team, the organization's admins or every user. The event
 * key and source label come from the app's identity, so one app cannot
 * overwrite or pose as another.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const caller = session as { isServiceAccount?: boolean; serviceAccountClientId?: string };
  const app = caller.isServiceAccount === true ? findNotificationProducer(caller.serviceAccountClientId) : null;
  if (!app) throw new ApiError("This credential may not create notifications", 403, "FORBIDDEN");

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") throw new ApiError("Request body must be JSON", 400, "BAD_REQUEST");

  const recipients = body.recipientUserSubjects;
  if (
    !Array.isArray(recipients) ||
    recipients.length === 0 ||
    recipients.length > MAX_RECIPIENTS ||
    !recipients.every((sub) => typeof sub === "string" && sub.trim())
  ) {
    throw new ApiError(`recipientUserSubjects needs 1 to ${MAX_RECIPIENTS} subjects`, 400, "BAD_REQUEST");
  }
  const href = body.href === undefined ? undefined : text(body.href, "href");
  if (href !== undefined) {
    const origin = "https://example.invalid";
    if (
      !href.startsWith("/") ||
      href.startsWith("//") ||
      /[\\\u0000-\u001f\u007f]/.test(href) ||
      new URL(href, origin).origin !== origin
    ) {
      throw new ApiError("href must be a relative path", 400, "BAD_REQUEST");
    }
  }
  const severity = body.severity ?? "info";
  if (!SEVERITIES.includes(severity as Severity)) {
    throw new ApiError("severity is not recognised", 400, "BAD_REQUEST");
  }

  const created = await createInAppNotification({
    eventKey: `app:${app.installation.appId}:${text(body.eventKey, "eventKey")}`,
    recipientUserSubjects: recipients as string[],
    title: text(body.title, "title"),
    message: text(body.message, "message"),
    href,
    severity: severity as Severity,
    sourceLabel: app.manifest.displayName,
  });
  return successResponse({ created }, created ? 201 : 200);
});
