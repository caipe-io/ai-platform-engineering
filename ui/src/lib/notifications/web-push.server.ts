import webPush from "web-push";

import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import { notificationKey } from "./subscriptions.server";

export interface BrowserPushDevice {
  _id: string;
  subject: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: Date;
  expiresAt: Date;
}

export function browserPushPublicKey(): string | null {
  return process.env.NOTIFICATION_WEB_PUSH_PUBLIC_KEY?.trim() &&
    process.env.NOTIFICATION_WEB_PUSH_PRIVATE_KEY?.trim() &&
    process.env.NOTIFICATION_WEB_PUSH_SUBJECT?.trim()
    ? process.env.NOTIFICATION_WEB_PUSH_PUBLIC_KEY.trim()
    : null;
}

/** Restrict server-side requests to explicitly trusted push services. */
export function validatePushEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ApiError("Invalid push service URL", 400);
  }
  const hosts = (
    process.env.NOTIFICATION_WEB_PUSH_ALLOWED_HOSTS ??
    "fcm.googleapis.com,updates.push.services.mozilla.com,web.push.apple.com"
  )
    .split(",")
    .map((host) => host.trim());
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !hosts.includes(url.hostname)
  )
    throw new ApiError("Push service is not allowed", 400);
  return url;
}

export async function saveBrowserPushDevice(
  subject: string,
  input: unknown,
): Promise<string> {
  if (!browserPushPublicKey())
    throw new ApiError("Browser web push is not configured", 503);
  const raw = input as Partial<BrowserPushDevice> | null;
  if (
    !raw ||
    typeof raw.endpoint !== "string" ||
    raw.endpoint.length > 2048 ||
    !raw.keys ||
    typeof raw.keys.p256dh !== "string" ||
    typeof raw.keys.auth !== "string" ||
    !/^[A-Za-z0-9_-]{87}=?$/.test(raw.keys.p256dh) ||
    !/^[A-Za-z0-9_-]{22}={0,2}$/.test(raw.keys.auth)
  )
    throw new ApiError("Invalid browser push subscription", 400);
  const publicKey = Buffer.from(raw.keys.p256dh, "base64url");
  if (
    publicKey.length !== 65 ||
    publicKey[0] !== 4 ||
    Buffer.from(raw.keys.auth, "base64url").length !== 16
  )
    throw new ApiError("Invalid browser push keys", 400);
  const endpoint = validatePushEndpoint(raw.endpoint).href;
  const devices = await getCollection<BrowserPushDevice>(
    "notification_push_devices",
  );
  const id = notificationKey(endpoint);
  const existing = await devices.findOne({ _id: id });
  if (existing && existing.subject !== subject)
    throw new ApiError(
      "This browser subscription belongs to another account. Disable browser push there first.",
      409,
    );
  if (!existing && (await devices.countDocuments({ subject })) >= 10)
    throw new ApiError(
      "Remove an existing browser subscription before adding another device",
      409,
    );
  try {
    await devices.updateOne(
      { _id: id, subject },
      {
        $set: {
          endpoint,
          keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth },
          expiresAt: new Date(Date.now() + 30 * 86400_000),
        },
        $setOnInsert: { subject, createdAt: new Date() },
      },
      { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      throw new ApiError("Browser subscription is already assigned", 409);
    throw error;
  }
  return id;
}

export async function sendBrowserPush(
  device: BrowserPushDevice,
  notificationId: string,
  href?: string,
): Promise<void> {
  validatePushEndpoint(device.endpoint);
  if (!browserPushPublicKey())
    throw new Error("Browser web push is not configured");
  try {
    await webPush.sendNotification(
      { endpoint: device.endpoint, keys: device.keys },
      JSON.stringify({
        title: "New CAIPE notification",
        body: "Open your inbox to view this update.",
        tag: notificationId,
        data: {
          href: href ?? "/settings/notifications",
          deliveryId: notificationId,
        },
      }),
      {
        TTL: 3600,
        timeout: 10_000,
        vapidDetails: {
          subject: process.env.NOTIFICATION_WEB_PUSH_SUBJECT!.trim(),
          publicKey: process.env.NOTIFICATION_WEB_PUSH_PUBLIC_KEY!.trim(),
          privateKey: process.env.NOTIFICATION_WEB_PUSH_PRIVATE_KEY!.trim(),
        },
      },
    );
  } catch (error) {
    if (
      [404, 410].includes((error as { statusCode?: number }).statusCode ?? 0)
    ) {
      await (
        await getCollection<BrowserPushDevice>("notification_push_devices")
      ).deleteOne({ _id: device._id, subject: device.subject });
    }
    throw error;
  }
}
