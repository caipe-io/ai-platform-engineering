// POST /api/settings/notification-preferences/test
//
// Sends the signed-in user one sample notification for a catalog event type.
// It goes through the same publish path as real events, so it honors the
// user's own preferences and shows what they would actually receive. It only
// ever notifies the caller: there is no recipient field.

import { randomUUID } from "node:crypto";

import { ApiError, getAuthFromBearerOrSession, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { publishNotificationEvent } from "@/lib/notifications/consumer.server";
import { isNotificationEventType, NOTIFICATION_EVENT_CATALOG } from "@/lib/notifications/taxonomy";
import { NextRequest } from "next/server";

const MAX_TESTS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;
const recentTests = new Map<string, number[]>();

// Per-process limit. It stops a stuck button or script from filling the inbox.
// Each replica counts separately, which is fine for a convenience action.
function withinRateLimit(subject: string, now: number): boolean {
  const recent = (recentTests.get(subject) ?? []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_TESTS_PER_MINUTE) {
    recentTests.set(subject, recent);
    return false;
  }
  recent.push(now);
  recentTests.set(subject, recent);
  return true;
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { user, session } = await getAuthFromBearerOrSession(request);
  const subject = typeof session.sub === "string" ? session.sub.trim() : "";
  if (!subject || !user.email) {
    throw new ApiError("Your session has expired. Please sign in again.", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError("Request body must be JSON", 400, "INVALID_JSON");
  }
  const type = (body as { type?: unknown } | null)?.type;
  if (!isNotificationEventType(type)) {
    throw new ApiError("type must be a known notification event type", 400, "INVALID_EVENT_TYPE");
  }

  if (!withinRateLimit(subject, Date.now())) {
    throw new ApiError("Too many test notifications. Try again in a minute.", 429, "RATE_LIMITED");
  }

  const definition = NOTIFICATION_EVENT_CATALOG[type];
  const outcome = await publishNotificationEvent({
    id: `test:${type}:${randomUUID()}`,
    type,
    version: 1,
    occurred_at: new Date().toISOString(),
    resource: { type: "test", id: "notification-test" },
    attempt_id: randomUUID(),
    recipient_subject: subject,
    recipient_email: user.email,
    data: {
      status: "test",
      title: `Test: ${type}`,
      summary: `This is a ${definition.category} test notification. No real event happened.`,
      href: "/settings/notifications",
    },
  });

  if (outcome === "failed") {
    throw new ApiError("The test notification could not be delivered.", 503, "DELIVERY_FAILED");
  }
  return successResponse({ outcome });
});
