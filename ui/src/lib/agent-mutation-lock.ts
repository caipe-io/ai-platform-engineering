import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";

export type MutationLockGuard = () => Promise<void>;
interface MutationLockDocument {
  _id: string;
  token: string;
  expires_at?: Date;
}

/** Serialize cross-service agent publication, including relationship changes. */
export async function withAgentMutationLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
  return withResourceMutationLock("agent_mutation_locks", agentId, "Another agent save is in progress", operation);
}

/** Unique keys exclude replicas; optional renewable leases recover abandoned locks. */
export async function withResourceMutationLock<T>(
  collection: string,
  resourceId: string,
  conflictMessage: string,
  operation: (assertOwned: MutationLockGuard) => Promise<T>,
  options: { leaseMs?: number } = {},
): Promise<T> {
  const locks = await getCollection<MutationLockDocument>(collection);
  const token = randomUUID();
  const leaseMs = options.leaseMs;
  const expiresAt = () => new Date(Date.now() + leaseMs!);
  try {
    await locks.insertOne({ _id: resourceId, token, ...(leaseMs ? { expires_at: expiresAt() } : {}) });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    if (!leaseMs) throw new ApiError(conflictMessage, 409);
    const previous = await locks.findOne({ _id: resourceId });
    if (!previous?.expires_at) throw new ApiError(conflictMessage, 409);
    // Both the old owner and expiry must still match. A renewal or a competing
    // reclaimer invalidates this conditional takeover without deleting its row.
    const claimed = await locks.updateOne(
      { _id: resourceId, token: previous.token, expires_at: { $lte: new Date() } },
      { $set: { token, expires_at: expiresAt() } },
    );
    if (claimed.matchedCount !== 1) throw new ApiError(conflictMessage, 409);
  }
  if (!leaseMs) {
    try { return await operation(async () => {}); }
    finally { await locks.deleteOne({ _id: resourceId, token }); }
  }

  let lost = false;
  const assertOwned: MutationLockGuard = async () => {
    if (lost) throw new ApiError(conflictMessage, 409);
    try {
      // Expired owners cannot revive their lease, even before another request
      // claims it. Callers check this guard between awaited mutation steps.
      const renewed = await locks.updateOne(
        { _id: resourceId, token, expires_at: { $gt: new Date() } },
        { $max: { expires_at: expiresAt() } },
      );
      if (renewed.matchedCount !== 1) throw new ApiError(conflictMessage, 409);
    } catch (error) {
      lost = true;
      throw error;
    }
  };
  let heartbeat: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (heartbeat || lost) return;
    heartbeat = assertOwned().catch((error: unknown) => {
      console.error('[mutation-lock] Lease renewal failed', { collection, resourceId, error });
    }).finally(() => { heartbeat = undefined; });
  }, Math.max(1, Math.floor(leaseMs / 3)));
  timer.unref?.();
  try {
    await assertOwned();
    const result = await operation(assertOwned);
    await assertOwned();
    return result;
  } finally {
    clearInterval(timer);
    await heartbeat;
    try { await locks.deleteOne({ _id: resourceId, token }); }
    catch (error) {
      // Keep the successful mutation result; a later request can reclaim the
      // row after expiry. Never remove a replacement owner's lock.
      console.error('[mutation-lock] Lease release failed; expiry permits retry', { collection, resourceId, error });
    }
  }
}
