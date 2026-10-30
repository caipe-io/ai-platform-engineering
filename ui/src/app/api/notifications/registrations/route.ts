import { consumeNotificationQuota } from "@/lib/notifications/limits.server";
import { readNotificationJson } from "@/lib/notifications/http.server";
import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { findNotificationProducer } from "@/lib/agentic-apps/notification-producer";
import { registerAppNotificationTypes } from "@/lib/notifications/subscriptions.server";

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const caller = session as {
    isServiceAccount?: boolean;
    serviceAccountClientId?: string;
  };
  const app = caller.isServiceAccount
    ? findNotificationProducer(caller.serviceAccountClientId)
    : null;
  if (!app)
    throw new ApiError(
      "An installed notification producer service account is required",
      403,
    );
  const body = await readNotificationJson(request);
  await consumeNotificationQuota(`registration:${app.manifest.id}`, 10);
  await registerAppNotificationTypes(
    app.manifest.id,
    app.manifest.displayName,
    body?.events,
  );
  return successResponse({
    sourceId: `app:${app.manifest.id}`,
    registered: true,
  });
});
