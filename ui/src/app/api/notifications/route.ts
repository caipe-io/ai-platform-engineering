import { notificationCallbackUri } from "@/lib/notifications/callback";
import { enqueueNotificationExports } from "@/lib/notifications/exports.server";
import { consumeNotificationQuota } from "@/lib/notifications/limits.server";
import { canLaunchAgenticApp, agenticAppUserContextFromSession } from "@/lib/agentic-apps/access";
import { loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import { readNotificationJson } from "@/lib/notifications/http.server";
import { NextRequest, after } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getRequestOrigin } from "@/app/api/skills/_lib/request-origin";
import { enqueueNotification } from "@/lib/notifications/delivery.server";
import { getNotificationSource } from "@/lib/notifications/subscriptions.server";
import { resolveRecipients } from "@/lib/notifications/audience.server";
import { findNotificationProducer } from "@/lib/agentic-apps/notification-producer";
import { createInAppNotification, listInAppNotifications } from "@/lib/in-app-notifications.server";
import { inboxViewOptions } from "@/lib/notification-preferences.server";
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
  const viewOptions = await inboxViewOptions(user.email, subject);
  const page = await listInAppNotifications(subject, {
    page: positiveInteger(params.get("page"), 1),
    pageSize: positiveInteger(params.get("page_size"), 10),
    ...viewOptions,
    allowedAppSourceIds: loadConfiguredAgenticApps().filter((app) => canLaunchAgenticApp(app, agenticAppUserContextFromSession(session, user.role))).map((app) => `app:${app.manifest.id}`),
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

  const body = await readNotificationJson(request);
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
  let href: string | undefined;
  try { href = notificationCallbackUri(body.callbackUri, body.href); }
  catch { throw new ApiError("callbackUri/href must be matching relative application paths", 400, "BAD_REQUEST"); }
  const severity = body.severity ?? "info";
  if (!SEVERITIES.includes(severity as Severity)) {
    throw new ApiError("severity is not recognised", 400, "BAD_REQUEST");
  }

  const eventKey = text(body.eventKey, "eventKey");
  const title = text(body.title, "title"), message = text(body.message, "message");
  const sourceId = `app:${app.manifest.id}`;
  const source = await getNotificationSource(`app:${app.manifest.id}`);
  if (source) {
    if (typeof body.eventType !== "string" || !source.events.some((event) => event.id === body.eventType)) throw new ApiError("Select a registered notification eventType", 400);
    const audience = await resolveRecipients((recipients as string[]).map((subject) => ({ subject })), { includeOrgAdmins: false });
    await consumeNotificationQuota(sourceId, 200, Math.max(1, audience.recipients.length));
    for (const recipient of audience.recipients) await consumeNotificationQuota(`recipient:${recipient.subject}`, 20);
    await enqueueNotificationExports({ key: [eventKey], sourceId, eventType: body.eventType, occurredAt: new Date().toISOString(), severity: severity as Severity });
    for (const recipient of audience.recipients) await enqueueNotification({
      id: eventKey, sourceId: `app:${app.manifest.id}`, sourceLabel: app.manifest.displayName,
      eventType: body.eventType, recipient, title, message, href, severity: severity as Severity, retentionDays: 90,
    });
    return successResponse({ queued: audience.recipients.length, skipped: audience.skipped + audience.rejected }, 202);
  }
  await consumeNotificationQuota(sourceId, 200, recipients.length);
  await enqueueNotificationExports({ key: [eventKey], sourceId, eventType: "app.notification", occurredAt: new Date().toISOString(), severity: severity as Severity });
  const created = await createInAppNotification({
    eventKey: `app:${app.installation.appId}:${eventKey}`,
    recipientUserSubjects: recipients as string[],
    title,
    message,
    href,
    severity: severity as Severity,
    sourceLabel: app.manifest.displayName,
  });
  return successResponse({ created }, created ? 201 : 200);
});
