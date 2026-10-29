import { NextRequest, NextResponse } from "next/server";

import { ApiError } from "@/lib/api-error";
import { agenticAppUserContextFromSession } from "@/lib/agentic-apps/access";
import { resolveNotificationCallback } from "@/lib/notifications/callback.server";
import { notificationCallbackPath } from "@/lib/notifications/callback";
import { notificationUser } from "@/lib/notifications/request-user.server";
import { originFromNextAuthUrl } from "@/lib/request-origin";

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
function unavailable(status: number): NextResponse {
  return privateResponse(
    new NextResponse(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notification unavailable</title></head><body><main><h1>Notification unavailable</h1><p>This notification has expired, is temporarily unavailable, or you no longer have access.</p><a href="/settings/notifications">Notification settings</a></main></body></html>',
      { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
    ),
  );
}

/** Resolve at the host before loading the destination app, including after SSO. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) return unavailable(404);
  const origin = originFromNextAuthUrl() ?? request.nextUrl.origin;
  try {
    const { subject, user, session } = await notificationUser(request);
    const destination = await resolveNotificationCallback(
      id,
      subject,
      agenticAppUserContextFromSession(session, user.role),
    );
    return privateResponse(
      NextResponse.redirect(new URL(destination, origin), 303),
    );
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      const login = new URL("/login", origin);
      // Only the opaque marker travels through OIDC, so fragments cannot be lost.
      login.searchParams.set("callbackUrl", notificationCallbackPath(id));
      return privateResponse(NextResponse.redirect(login, 303));
    }
    if (error instanceof ApiError && [403, 404].includes(error.statusCode))
      return unavailable(error.statusCode);
    console.error(
      "[notifications] callback resolution failed",
      error instanceof Error ? error.name : "unknown",
    );
    return unavailable(503);
  }
}
