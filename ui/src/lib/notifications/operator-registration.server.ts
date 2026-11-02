import { ApiError } from "@/lib/api-error";
import { findNotificationProducer } from "@/lib/agentic-apps/notification-producer";
import { getConfiguredAgenticApp } from "@/lib/agentic-apps/config";
import { getCollection } from "@/lib/mongodb";
import { validateNotificationTypes, type SourceRegistration } from "./subscriptions.server";

/** Operator declarations survive a publisher replacing its own declaration list. */
export async function registerOperatorNotificationType(input: unknown): Promise<{ sourceId: string; eventType: string }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError("Registration object required", 400);
  const raw = input as { sourceId?: unknown; event?: unknown };
  if (typeof raw.sourceId !== "string" || !raw.sourceId.startsWith("app:")) throw new ApiError("Select an installed app", 400);
  const app = getConfiguredAgenticApp(raw.sourceId.slice(4));
  if (!app || !findNotificationProducer(app.installation.bindings?.serviceAccountClientId, [app])) throw new ApiError("App must have a bound notification publisher", 403);
  const [event] = validateNotificationTypes([raw.event]);
  const collection = await getCollection<SourceRegistration>("notification_sources");
  await collection.updateOne({ _id: raw.sourceId }, { $setOnInsert: { label: app.manifest.displayName, events: [], updatedAt: new Date() } }, { upsert: true });
  try {
    const result = await collection.updateOne({ _id: raw.sourceId, "events.id": { $ne: event.id }, "operatorEvents.id": { $ne: event.id }, $expr: { $lt: [{ $size: { $ifNull: ["$operatorEvents", []] } }, 30] } } as never,
      { $set: { updatedAt: new Date() }, $push: { operatorEvents: event } });
    if (!result.matchedCount) throw new ApiError("Event already registered or registration limit reached; reload", 409);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new ApiError("Event already registered or registration limit reached; reload", 409);
    throw error;
  }
  return { sourceId: raw.sourceId, eventType: event.id };
}
