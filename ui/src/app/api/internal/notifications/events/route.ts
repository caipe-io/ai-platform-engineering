// POST /api/internal/notifications/events
//
// Service-to-service entry point for producers that run outside the UI server,
// such as the Python ingestion and autonomous-agent services. Callers present
// NOTIFICATIONS_INTERNAL_TOKEN as a bearer token. The request carries one event
// plus its audience: explicit recipients, org admins, or both. The server
// resolves each person's identifiers from its own user records and publishes one
// event per recipient through the same path that in-process producers use.
//
// Trust model: the token authenticates the calling service. Each recipient's
// preferences are still applied before anything is written.

import { timingSafeEqual } from "crypto";

import { publishNotificationRequest } from "@/lib/notifications/fanout.server";
import { parseNotificationEventRequest } from "@/lib/notifications/request";
import { NextRequest } from "next/server";

function tokenMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function authorize(request: NextRequest): Response | null {
  const expected = process.env.NOTIFICATIONS_INTERNAL_TOKEN?.trim();
  if (!expected) {
    return Response.json({ error: "Notification internal token is not configured" }, { status: 503 });
  }

  const authorization = request.headers.get("authorization") ?? "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!actual || !tokenMatches(actual, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const denied = authorize(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const parsed = parseNotificationEventRequest(body);
  if (parsed.ok === false) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const outcome = await publishNotificationRequest(parsed.request);

  // 202 means the event was accepted. 503 tells the caller that at least one
  // delivery failed and it may retry; recipients already delivered are
  // deduplicated by event key.
  const status = outcome.results.failed > 0 ? 503 : 202;
  return Response.json(outcome, { status });
}
