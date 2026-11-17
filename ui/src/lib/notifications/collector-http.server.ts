import { NotificationDeliveryError } from "./delivery-types";

/** Endpoints and headers come exclusively from operator-owned configuration. */
export function collectorUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value?.trim() ?? "");
  } catch {
    throw new NotificationDeliveryError(
      "Collector endpoint is missing or invalid",
      false,
    );
  }
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        process.env.NOTIFICATION_COLLECTOR_ALLOW_HTTP === "true"
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new NotificationDeliveryError(
      "Collector requires a permitted HTTP(S) URL without embedded credentials",
      false,
    );
  return url.href;
}

export async function collectorJson(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.body)
    throw new NotificationDeliveryError(
      "Collector returned no response body",
      false,
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        throw new NotificationDeliveryError(
          "Collector response exceeds the size limit",
          false,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid object");
    return value;
  } catch {
    throw new NotificationDeliveryError(
      "Collector response is not a JSON object",
      false,
    );
  }
}

export function collectorFailure(
  response: Response,
  retryable: boolean,
): NotificationDeliveryError {
  const header = response.headers.get("retry-after");
  const delay = header
    ? /^\d+$/.test(header)
      ? Number(header) * 1000
      : Date.parse(header) - Date.now()
    : 0;
  return new NotificationDeliveryError(
    "Collector did not accept the event",
    retryable,
    Number.isFinite(delay) ? Math.max(0, Math.min(delay, 86400_000)) : 0,
  );
}
