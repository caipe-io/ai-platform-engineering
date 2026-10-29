import { randomUUID } from "crypto";
import { MongoServerError } from "mongodb";
import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";

/** Shared with the bot. A paused writer must not outlive a lock lease. */
export async function withWebexIdentityWriteLock<T>(write: () => Promise<T>): Promise<T> {
  const collection = await getCollection<{ _id: string; nonce: string; created_at: Date }>("webex_identity_write_locks");
  const nonce = randomUUID();
  try { await collection.insertOne({ _id: "identity-write", nonce, created_at: new Date() }); }
  catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) throw new ApiError("Another identity link is being saved. Please retry.", 409, "WEBEX_LINK_BUSY");
    throw error;
  }
  try { return await write(); }
  finally { await collection.deleteOne({ _id: "identity-write", nonce }); }
}
