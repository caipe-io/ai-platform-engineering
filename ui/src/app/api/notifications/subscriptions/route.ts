import { readNotificationJson } from "@/lib/notifications/http.server";
import { NextRequest } from "next/server";

import {
  ApiError,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { notificationUser } from "@/lib/notifications/request-user.server";
import {
  listNotificationSources,
  readSubscription,
  writeSubscription,
} from "@/lib/notifications/subscriptions.server";
import { updateNotificationPreferences } from "@/lib/notifications/preferences.server";
import { isNotificationEventType } from "@/lib/notifications/taxonomy";
import { DEFAULT_NOTIFICATION_CHANNELS } from "@/lib/notifications/channels";
import { validateNotificationChannelChoices, notificationWebPushPublicKey } from "@/lib/notifications/adapters.server";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { subject, session, user } = await notificationUser(request);
  const [global, sources] = await Promise.all([
    readSubscription(subject),
    listNotificationSources(subject, session, user.role, user.email),
  ]);
  return successResponse({
    global: {
      ...global,
      channels: { ...DEFAULT_NOTIFICATION_CHANNELS, ...global?.channels },
    },
    sources,
    webPushPublicKey: notificationWebPushPublicKey(),
  });
});

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  const { subject, session, user } = await notificationUser(request);
  const body = await readNotificationJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError("Request body must be an object", 400);
  const { sourceId = "*", eventType = "*", ...patch } = body;
  if (typeof sourceId !== "string" || typeof eventType !== "string")
    throw new ApiError("Invalid notification source", 400);
  if (sourceId !== "*") {
    const source = (
      await listNotificationSources(subject, session, user.role, user.email)
    ).find((entry) => entry.id === sourceId);
    if (
      !source ||
      (eventType !== "*" &&
        !source.events.some((entry) => entry.id === eventType))
    )
      throw new ApiError("Notification source not found", 404);
  } else if (eventType !== "*")
    throw new ApiError("Select a source before an event", 400);
  if (
    sourceId === "*" &&
    patch.channels &&
    typeof patch.channels === "object"
  ) {
    await validateNotificationChannelChoices(subject, patch.channels as Record<string, unknown>);
  }

  if (
    sourceId === "platform" &&
    isNotificationEventType(eventType) &&
    typeof patch.enabled === "boolean"
  ) {
    await updateNotificationPreferences(user.email, {
      events: { [eventType]: patch.enabled },
    });
    delete patch.enabled;
  }
  await writeSubscription(subject, sourceId, eventType, patch);
  return successResponse({ saved: true });
});
