import { ApiError } from "@/lib/api-error";

/** Notification APIs accept small metadata documents, never arbitrary attachments. */
export async function readNotificationJson(
  request: Request,
): Promise<Record<string, unknown>> {
  const limit = 32 * 1024;
  if (Number(request.headers.get("content-length")) > limit)
    throw new ApiError("Notification request is too large", 413);
  if (!request.body) throw new ApiError("Request body must be JSON", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError("Notification request is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Not an object");
    return input;
  } catch {
    throw new ApiError("Request body must be a JSON object", 400);
  }
}
