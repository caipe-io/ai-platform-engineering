import { enqueueNotificationExports } from "./exports.server";
import { resolveRecipients } from "./audience.server";
import { enqueueNotification } from "./delivery.server";
import type { InAppNotificationSeverity } from "@/types/in-app-notification";

/** Shared incidents keep their lifecycle inbox entry; personal channels fan out separately. */
export async function queuePlatformNotificationChannels(input: {
  id: string;
  eventType: "service.degraded" | "service.recovered";
  title: string;
  message: string;
  severity: InAppNotificationSeverity;
}): Promise<void> {
  if (process.env.NOTIFICATION_EVENTS_ENABLED === "false") return;
  try {
    await enqueueNotificationExports({
      key: [input.id],
      sourceId: "platform",
      eventType: input.eventType,
      occurredAt: new Date().toISOString(),
      severity: input.severity,
    });
    if (
      !(
        process.env.NOTIFICATION_WEB_PUSH_PUBLIC_KEY ||
        process.env.NOTIFICATION_SLACK_ENABLED === "true" ||
        process.env.NOTIFICATION_WEBEX_ENABLED === "true"
      )
    )
      return;
    const audience = await resolveRecipients([], { includeOrgAdmins: true });
    for (const recipient of audience.recipients)
      await enqueueNotification({
        ...input,
        sourceId: "platform",
        sourceLabel: "Platform",
        recipient,
        href: "/admin/operations/health",
        channels: ["web_push", "webex", "slack"],
      });
  } catch (error) {
    console.error(
      "[notifications] platform channel enqueue failed",
      error instanceof Error ? error.name : "unknown",
    );
  }
}
