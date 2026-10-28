import { NextRequest } from "next/server";

import { successResponse, withErrorHandler } from "@/lib/api-middleware";
import { notificationUser } from "@/lib/notifications/request-user.server";
import { linkedNotificationAccounts } from "@/lib/notifications/adapters.server";
import { browserPushPublicKey } from "@/lib/notifications/web-push.server";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { subject } = await notificationUser(request);
  let accounts = { slack: false, webex: false };
  try {
    const linked = await linkedNotificationAccounts(subject);
    accounts = { slack: Boolean(linked.slack), webex: Boolean(linked.webex) };
  } catch (error) {
    console.error(
      "[notifications] account link lookup failed",
      error instanceof Error ? error.name : "unknown",
    );
  }
  return successResponse({
    in_app: true,
    web_push: Boolean(browserPushPublicKey()),
    slack: process.env.NOTIFICATION_SLACK_ENABLED === "true" && accounts.slack,
    webex: process.env.NOTIFICATION_WEBEX_ENABLED === "true" && accounts.webex,
  });
});
