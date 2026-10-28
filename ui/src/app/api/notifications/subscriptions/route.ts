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
import { browserPushPublicKey } from "@/lib/notifications/web-push.server";
import { linkedNotificationAccounts } from "@/lib/notifications/adapters.server";
import { getCollection } from "@/lib/mongodb";
import type { BrowserPushDevice } from "@/lib/notifications/web-push.server";

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
    webPushPublicKey: browserPushPublicKey(),
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
    const choices = patch.channels as Record<string, unknown>;
    if (
      choices.web_push === true &&
      (!browserPushPublicKey() ||
        !(await (
          await getCollection<BrowserPushDevice>("notification_push_devices")
        ).findOne({ subject, expiresAt: { $gt: new Date() } })))
    )
      throw new ApiError(
        "Subscribe this browser before enabling web push",
        400,
      );
    if (choices.webex === true || choices.slack === true) {
      const accounts = await linkedNotificationAccounts(subject);
      if (
        (choices.webex === true &&
          (process.env.NOTIFICATION_WEBEX_ENABLED !== "true" ||
            !accounts.webex)) ||
        (choices.slack === true &&
          (process.env.NOTIFICATION_SLACK_ENABLED !== "true" ||
            !accounts.slack))
      )
        throw new ApiError(
          "Enable the bot and link your account before enabling this channel",
          400,
        );
    }
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
