import { getCollection } from "@/lib/mongodb";
import { sendBrowserPush, type BrowserPushDevice } from "./web-push.server";
import { sendSlackNotification } from "./slack.server";
import { sendWebexNotification } from "./webex.server";
import type { NotificationDelivery } from "./delivery.server";

export { linkedNotificationAccounts } from "./destinations.server";

export async function sendExternalNotification(
  delivery: NotificationDelivery,
): Promise<void> {
  if (delivery.channel === "web_push") {
    const device = await (
      await getCollection<BrowserPushDevice>("notification_push_devices")
    ).findOne({
      _id: delivery.targetId,
      subject: delivery.recipient.subject,
      expiresAt: { $gt: new Date() },
    });
    if (!device)
      throw new Error("Browser subscription has expired or was removed");
    await sendBrowserPush(device, delivery._id);
  } else if (delivery.channel === "slack")
    await sendSlackNotification(delivery);
  else if (delivery.channel === "webex") await sendWebexNotification(delivery);
  else throw new Error("Unsupported external notification channel");
}
