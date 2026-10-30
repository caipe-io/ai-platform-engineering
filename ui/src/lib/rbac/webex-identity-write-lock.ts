import { randomUUID } from "crypto";
import { MongoServerError } from "mongodb";
import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";

/** Shared with the bot. A paused writer must not outlive a lock lease. */
export async function withWebexIdentityWriteLock<T>(write: () => Promise<T>): Promise<T> {
  const collection = await getCollection<{ _id: string; nonce: string; created_at: Date }>("webex_identity_write_locks");
  const nonce = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      await collection.insertOne({ _id: "identity-write", nonce, created_at: new Date() });
      break;
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      if (attempt === 20) throw new ApiError("Another identity link is being saved. Please retry.", 409, "WEBEX_LINK_BUSY");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  let release = false;
  try {
    const result = await write();
    release = true;
    return result;
  } catch (error) {
    // Validation fails before writes; uncertain remote writes require reconciliation.
    release = error instanceof ApiError && ["WEBEX_ID_ALREADY_LINKED", "WEBEX_LINK_LOOKUP_UNAVAILABLE"].includes(error.code || "");
    throw error;
  } finally {
    if (release) await collection.deleteOne({ _id: "identity-write", nonce });
  }
}
