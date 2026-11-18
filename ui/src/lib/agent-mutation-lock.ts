import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";

export type MutationLockGuard = (() => Promise<void>) & {
  runExclusive: <T>(effect: () => Promise<T>) => Promise<T>;
};
interface MutationLockDocument {
  _id: string;
  token: string;
  expires_at?: Date;
  effect_token?: string;
  effect_started_at?: Date;
  recovery_required?: boolean;
}

/** Serialize cross-service agent publication, including relationship changes. */
export async function withAgentMutationLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
  return withResourceMutationLock("agent_mutation_locks", agentId, "Another agent save is in progress", operation);
}

/** Leases reclaim idle owners; durable effect pins exclude outstanding writes. */
export async function withResourceMutationLock<T>(
  collection: string,
  resourceId: string,
  conflictMessage: string,
  operation: (guard: MutationLockGuard) => Promise<T>,
  options: { leaseMs?: number } = {},
): Promise<T> {
  const locks = await getCollection<MutationLockDocument>(collection);
  const token = randomUUID();
  const leaseMs = options.leaseMs;
  const expiresAt = () => new Date(Date.now() + leaseMs!);
  const conflict = () => new ApiError(conflictMessage, 409);
  const needsRecovery = () => new ApiError(
    'The access change could not be confirmed. An administrator must recover it before another change.',
    503, 'MUTATION_RECOVERY_REQUIRED',
  );
  try {
    await locks.insertOne({ _id: resourceId, token, ...(leaseMs ? { expires_at: expiresAt() } : {}) });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    if (!leaseMs) throw conflict();
    const previous = await locks.findOne({ _id: resourceId });
    if (previous?.recovery_required) throw needsRecovery();
    if (!previous?.expires_at || previous.effect_token) throw conflict();
    const claimed = await locks.updateOne(
      { _id: resourceId, token: previous.token, expires_at: { $lte: new Date() }, effect_token: { $exists: false } },
      { $set: { token, expires_at: expiresAt() } },
    );
    if (claimed.matchedCount !== 1) throw conflict();
  }
  if (!leaseMs) {
    const guard = Object.assign(async () => {}, { runExclusive: <R,>(effect: () => Promise<R>) => effect() });
    try { return await operation(guard); }
    finally { await locks.deleteOne({ _id: resourceId, token }); }
  }

  let lost = false;
  let closed = false;
  let recoveryRequired = false;
  let effectRunning = false;
  const effects = new Set<Promise<unknown>>();
  const renew = async () => {
    if (lost || closed) throw conflict();
    try {
      // A pinned writer remains exclusive even when paused past lease expiry.
      // Only idle expired owners can be replaced by another request.
      const renewed = await locks.updateOne(
        { _id: resourceId, token, $or: [
          { expires_at: { $gt: new Date() } }, { effect_token: { $exists: true } },
        ] },
        { $max: { expires_at: expiresAt() } },
      );
      if (renewed.matchedCount !== 1) throw conflict();
    } catch (error) {
      lost = true;
      throw error;
    }
  };
  async function runPinned<R>(effect: () => Promise<R>): Promise<R> {
    if (lost || closed || effectRunning) throw conflict();
    effectRunning = true;
    const effectToken = randomUUID();
    try {
      // Pin and owner/expiry validation are one Mongo operation. A paused caller
      // cannot start a write after an idle lease has already been reclaimed.
      const pinned = await locks.updateOne(
        { _id: resourceId, token, expires_at: { $gt: new Date() }, effect_token: { $exists: false } },
        { $set: { effect_token: effectToken, effect_started_at: new Date() }, $max: { expires_at: expiresAt() } },
      );
      if (pinned.matchedCount !== 1) { lost = true; throw conflict(); }
      let result: R;
      try {
        result = await effect();
      } catch (error) {
        // A transport error does not prove a remote write stopped. Preserve the
        // pin and journal; neither expiry nor finally may admit another writer.
        recoveryRequired = true;
        lost = true;
        try {
          await locks.updateOne(
            { _id: resourceId, token, effect_token: effectToken },
            { $set: { recovery_required: true } },
          );
        } catch (markError) {
          console.error('[mutation-lock] Could not mark uncertain write; effect pin retained', { collection, resourceId, markError });
        }
        console.error('[mutation-lock] Write outcome uncertain; verified recovery required', { collection, resourceId, error });
        throw needsRecovery();
      }
      const unpinned = await locks.updateOne(
        { _id: resourceId, token, effect_token: effectToken },
        { $unset: { effect_token: '', effect_started_at: '' }, $max: { expires_at: expiresAt() } },
      );
      if (unpinned.matchedCount !== 1) { lost = true; throw conflict(); }
      return result;
    } finally { effectRunning = false; }
  }
  const guard: MutationLockGuard = Object.assign(renew, {
    runExclusive: <R,>(effect: () => Promise<R>): Promise<R> => {
      const pending = runPinned(effect);
      effects.add(pending);
      void pending.then(() => effects.delete(pending), () => effects.delete(pending));
      return pending;
    },
  });
  let heartbeat: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (heartbeat || lost) return;
    heartbeat = renew().catch((error: unknown) => {
      console.error('[mutation-lock] Lease renewal failed', { collection, resourceId, error });
    }).finally(() => { heartbeat = undefined; });
  }, Math.max(1, Math.floor(leaseMs / 3)));
  timer.unref?.();
  try {
    await renew();
    const result = await operation(guard);
    await Promise.all(effects);
    if (recoveryRequired) throw needsRecovery();
    await renew();
    return result;
  } finally {
    closed = true;
    clearInterval(timer);
    await Promise.allSettled(effects);
    await heartbeat;
    if (!recoveryRequired) {
      // All writes have acknowledged completion. Token matching protects a new
      // idle owner; uncertain/in-flight writes must never release their pin.
      try { await locks.deleteOne({ _id: resourceId, token }); }
      catch (error) {
        console.error('[mutation-lock] Lease release failed; idle expiry permits retry', { collection, resourceId, error });
      }
    }
  }
}
