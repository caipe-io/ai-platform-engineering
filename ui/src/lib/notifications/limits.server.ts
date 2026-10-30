import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import { notificationKey } from "./subscriptions.server";

/** Shared across replicas; only authenticated publishers can consume these buckets. */
export async function consumeNotificationQuota(
  scope: string,
  limit: number,
  units = 1,
): Promise<void> {
  const collection = await getCollection<{
    _id: string;
    count: number;
    expiresAt: Date;
  }>("notification_publish_limits");
  const row = await collection.findOneAndUpdate(
    { _id: notificationKey(scope, String(Math.floor(Date.now() / 60_000))) },
    {
      $inc: { count: units },
      $setOnInsert: { expiresAt: new Date(Date.now() + 120_000) },
    },
    { upsert: true, returnDocument: "after" },
  );
  if ((row?.count ?? 0) > limit)
    throw new ApiError(
      "Notification publishing limit reached. Try again in a minute.",
      429,
      "RATE_LIMITED",
    );
}
