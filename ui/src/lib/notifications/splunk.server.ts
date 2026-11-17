import {
  collectorFailure,
  collectorJson,
  collectorUrl,
} from "./collector-http.server";
import {
  NotificationDeliveryError,
  type NotificationExportEvent,
} from "./delivery-types";

export async function sendSplunkNotificationEvent(
  event: NotificationExportEvent,
): Promise<void> {
  const token = process.env.NOTIFICATION_SPLUNK_HEC_TOKEN?.trim();
  if (!token)
    throw new NotificationDeliveryError(
      "Splunk HEC token is not configured",
      false,
    );
  const response = await fetch(
    collectorUrl(process.env.NOTIFICATION_SPLUNK_HEC_URL),
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Splunk ${token}`,
      },
      body: JSON.stringify({
        time: Date.parse(event.occurredAt) / 1000,
        source: "caipe.notifications",
        sourcetype:
          process.env.NOTIFICATION_SPLUNK_SOURCETYPE?.trim() || "_json",
        ...(process.env.NOTIFICATION_SPLUNK_INDEX?.trim()
          ? { index: process.env.NOTIFICATION_SPLUNK_INDEX.trim() }
          : {}),
        event,
      }),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw collectorFailure(
      response,
      response.status === 429 || response.status >= 500,
    );
  }
  const result = await collectorJson(response);
  if (result.code !== 0)
    throw new NotificationDeliveryError(
      "Splunk HEC rejected the event",
      result.code === 8 || result.code === 9,
    );
}
