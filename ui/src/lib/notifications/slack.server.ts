import { callSlackBotAdmin } from "@/lib/slack-bot-admin";
import { linkedNotificationAccounts } from "./destinations.server";
import type { NotificationDelivery } from "./delivery.server";

export async function sendSlackNotification(
  delivery: NotificationDelivery,
): Promise<void> {
  if (process.env.NOTIFICATION_SLACK_ENABLED !== "true")
    throw new Error("Slack notification delivery is not configured");
  const linked = await linkedNotificationAccounts(delivery.recipient.subject);
  if (!linked.slack)
    throw new Error("Link your Slack account before enabling delivery");
  await callSlackBotAdmin("/admin/slack/user-notifications", {
    method: "POST",
    body: {
      user_id: linked.slack,
      text: `${delivery.title}\n${delivery.message}`,
      notification_id: delivery._id,
    },
    signal: AbortSignal.timeout(15_000),
  });
}
