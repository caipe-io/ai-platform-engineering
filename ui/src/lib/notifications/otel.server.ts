import {
  collectorFailure,
  collectorJson,
  collectorUrl,
} from "./collector-http.server";
import {
  NotificationDeliveryError,
  type NotificationExportEvent,
} from "./delivery-types";

function endpoint(): string {
  if (process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim())
    return collectorUrl(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT);
  const base = collectorUrl(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  return base.replace(/\/+$/, "") + "/v1/logs";
}
function headers(): Record<string, string> {
  const value =
    process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS ??
    process.env.OTEL_EXPORTER_OTLP_HEADERS ??
    "";
  if (value.length > 8192)
    throw new NotificationDeliveryError(
      "Collector headers exceed the size limit",
      false,
    );
  const result: Record<string, string> = { "Content-Type": "application/json" };
  for (const item of value.split(",").filter(Boolean)) {
    const split = item.indexOf("=");
    if (split < 1)
      throw new NotificationDeliveryError(
        "Invalid collector header configuration",
        false,
      );
    let name: string, content: string;
    try {
      name = decodeURIComponent(item.slice(0, split).trim()).toLowerCase();
      content = decodeURIComponent(item.slice(split + 1).trim());
    } catch {
      throw new NotificationDeliveryError(
        "Invalid collector header encoding",
        false,
      );
    }
    if (
      !/^[a-z0-9-]+$/.test(name) ||
      [
        "content-type",
        "content-length",
        "host",
        "connection",
        "transfer-encoding",
        "cookie",
      ].includes(name) ||
      /[\r\n]/.test(content)
    )
      throw new NotificationDeliveryError(
        "Invalid collector header configuration",
        false,
      );
    result[name] = content;
  }
  return result;
}

export async function sendOtelNotificationEvent(
  event: NotificationExportEvent,
): Promise<void> {
  const level =
    event.severity === "error"
      ? [17, "ERROR"]
      : event.severity === "warning"
        ? [13, "WARN"]
        : [9, "INFO"];
  const attributes = Object.entries(event).map(([key, value]) => ({
    key: `notification.${key}`,
    value: { stringValue: String(value) },
  }));
  const response = await fetch(endpoint(), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: headers(),
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: {
                  stringValue: process.env.OTEL_SERVICE_NAME || "caipe-ui",
                },
              },
            ],
          },
          scopeLogs: [
            {
              scope: { name: "caipe.notifications", version: "1" },
              logRecords: [
                {
                  timeUnixNano: (
                    BigInt(Date.parse(event.occurredAt)) * BigInt(1000000)
                  ).toString(),
                  severityNumber: level[0],
                  severityText: level[1],
                  eventName: event.eventType,
                  body: { stringValue: event.eventType },
                  attributes,
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw collectorFailure(
      response,
      [429, 502, 503, 504].includes(response.status),
    );
  }
  const result = await collectorJson(response);
  const partial = result.partialSuccess;
  if (partial != null) {
    if (
      typeof partial !== "object" ||
      Array.isArray(partial) ||
      String((partial as Record<string, unknown>).rejectedLogRecords ?? "0") !==
        "0"
    )
      throw new NotificationDeliveryError(
        "OTLP collector rejected the log record",
        false,
      );
  }
}
