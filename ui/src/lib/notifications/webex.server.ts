import { callWebexBotAdmin } from "@/lib/webex-bot-admin";
import { linkedNotificationAccounts } from "./destinations.server";
import type { NotificationDelivery } from "./delivery.server";

export async function sendWebexNotification(
  delivery: NotificationDelivery,
): Promise<void> {
  if (process.env.NOTIFICATION_WEBEX_ENABLED !== "true")
    throw new Error("Webex notification delivery is not configured");
  const linked = await linkedNotificationAccounts(delivery.recipient.subject);
  if (!linked.webex)
    throw new Error("Link your Webex account before enabling delivery");
  await callWebexBotAdmin("/admin/webex/notifications", {
    method: "POST",
    body: {
      person_id: linked.webex,
      markdown: `${delivery.title}\n${delivery.message}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
}
