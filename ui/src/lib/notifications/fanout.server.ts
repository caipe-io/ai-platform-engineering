import { resolveRecipients } from "@/lib/notifications/audience.server";
import {
  publishNotificationEvent,
  type NotificationPublishOutcome,
} from "@/lib/notifications/consumer.server";
import type { NotificationEventRequest } from "@/lib/notifications/request";

export interface FanOutResult {
  /** Resolved recipients the event was offered to. */
  recipients: number;
  /** Recipients dropped because no subject and email could be resolved. */
  skipped: number;
  results: Record<NotificationPublishOutcome, number>;
}

/**
 * Expands one request into one event per recipient and publishes each through
 * the normal path, so every recipient's own preferences apply. Never throws.
 * Per-recipient event keys differ, so redelivering the whole request cannot
 * create duplicates.
 */
export async function publishNotificationRequest(
  request: NotificationEventRequest,
): Promise<FanOutResult> {
  const results: Record<NotificationPublishOutcome, number> = {
    delivered: 0,
    queued: 0,
    disabled: 0,
    invalid: 0,
    failed: 0,
  };

  let audience;
  try {
    audience = await resolveRecipients(request.recipients, {
      includeOrgAdmins: request.includeOrgAdmins,
    });
  } catch (error) {
    console.error("[notifications] could not resolve recipients", error);
    results.failed += 1;
    return { recipients: 0, skipped: 0, results };
  }

  const outcomes = await Promise.all(
    audience.recipients.map((recipient) =>
      publishNotificationEvent({
        ...request.base,
        recipient_subject: recipient.subject,
        recipient_email: recipient.email,
      }),
    ),
  );
  for (const outcome of outcomes) results[outcome] += 1;

  return { recipients: audience.recipients.length, skipped: audience.skipped, results };
}
