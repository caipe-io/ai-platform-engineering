import { randomUUID } from 'node:crypto';
import { ApiError } from '@/lib/api-error';
import { purgeConversationRelationships } from '@/lib/authz';
import { getCollection } from '@/lib/mongodb';
import type { Conversation } from '@/types/mongodb';
import type { Document, ObjectId } from 'mongodb';

export const ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const MAX_BATCH = 100;
const FILE_BATCH = 1000;
const operation = { maxTimeMS: 10_000 };

type ClaimedConversation = Conversation & { purge: NonNullable<Conversation['purge']> };
type PurgeReason = 'manual' | 'retention';
type DeletionCounts = { deleted: number; pending: number; messagesDeleted: number; checkpointsDeleted: number;
  checkpointWritesDeleted: number; filesDeleted: number };
const emptyCounts = (): DeletionCounts => ({ deleted: 0, pending: 0, messagesDeleted: 0,
  checkpointsDeleted: 0, checkpointWritesDeleted: 0, filesDeleted: 0 });

export function conversationPurgingError(): ApiError {
  return new ApiError('This conversation is being permanently deleted and cannot be restored.',
    409, 'CONVERSATION_PURGING');
}

/** The same document CAS decides whether restore or permanent deletion wins. */
async function claimPurge(snapshot: Conversation, now: Date, reason: PurgeReason, cutoffTime: Date): Promise<ClaimedConversation | null> {
  const conversations = await getCollection<Conversation>('conversations');
  const token = randomUUID();
  if (snapshot.purge) {
    return conversations.findOneAndUpdate({ _id: snapshot._id,
      'purge.token': snapshot.purge.token, 'purge.lease_until': { $lte: now },
      ...(reason === 'retention' ? { 'purge.retry_after': { $lte: now } } : {}),
    }, { $set: { 'purge.token': token, 'purge.lease_until': new Date(now.getTime() + LEASE_MS),
      'purge.last_attempted_at': now } }, { ...operation, returnDocument: 'after' }) as Promise<ClaimedConversation | null>;
  }
  if (reason === 'retention' && (!snapshot.deleted_at ||
      snapshot.deleted_at.getTime() > cutoffTime.getTime() - ARCHIVE_RETENTION_MS)) return null;
  return conversations.findOneAndUpdate({ _id: snapshot._id, purge: { $exists: false },
    deleted_at: snapshot.deleted_at ?? null,
  }, { $set: { deleted_at: snapshot.deleted_at ?? now, is_archived: true,
    purge: { token, started_at: now, last_attempted_at: now,
      lease_until: new Date(now.getTime() + LEASE_MS), retry_after: now, reason },
  } }, { ...operation, returnDocument: 'after' }) as Promise<ClaimedConversation | null>;
}

async function releasePurge(claim: ClaimedConversation, now: Date, failed: boolean): Promise<void> {
  await (await getCollection<Conversation>('conversations')).updateOne({ _id: claim._id, 'purge.token': claim.purge.token }, {
    $set: { 'purge.lease_until': now, 'purge.retry_after': new Date(now.getTime() + (failed ? RETRY_MS : 0)) },
  }, operation);
}

/** Scoped, idempotent child cleanup; retain the parent as the retry tombstone. */
async function finishPurge(claim: ClaimedConversation): Promise<DeletionCounts> {
  const counts = emptyCounts();
  const conversations = await getCollection<Conversation>('conversations');
  if (!await conversations.findOne({ _id: claim._id, 'purge.token': claim.purge.token }, operation)) return counts;
  for (const collection of ['messages', 'turns', 'feedback', 'conversation_bookmarks', 'sharing_access', 'harness_gateway_bindings']) {
    const result = await (await getCollection(collection)).deleteMany({ conversation_id: claim._id }, operation);
    if (collection === 'messages') counts.messagesDeleted += result.deletedCount;
  }
  for (const collection of ['checkpoints_conversation', 'checkpoint_writes_conversation']) {
    const result = await (await getCollection(collection)).deleteMany({ thread_id: claim._id }, operation);
    if (collection === 'checkpoints_conversation') counts.checkpointsDeleted += result.deletedCount;
    else counts.checkpointWritesDeleted += result.deletedCount;
  }
  const files = await getCollection<Document & { _id: ObjectId }>('agent_files.files');
  // Exact conversation filesystem namespace, including old agent bindings.
  const namespace = { 'metadata.namespace.1': claim._id, 'metadata.namespace.2': 'filesystem',
    'metadata.namespace.3': { $exists: false } };
  const ids = (await files.find(namespace, { ...operation, projection: { _id: 1 } })
    .limit(FILE_BATCH).toArray()).map(file => file._id);
  if (ids.length) {
    await (await getCollection('agent_files.chunks')).deleteMany({ files_id: { $in: ids } }, operation);
    counts.filesDeleted += (await files.deleteMany({ _id: { $in: ids } }, operation)).deletedCount;
  }
  if (await files.findOne(namespace, { ...operation, projection: { _id: 1 } })) return counts;
  if (!await purgeConversationRelationships(claim._id)) return counts;
  // A stale worker can repeat child deletions, but cannot finish a newer claim.
  counts.deleted = (await conversations.deleteOne({ _id: claim._id, 'purge.token': claim.purge.token }, operation)).deletedCount;
  return counts;
}

function attemptClock(reference: Date): () => Date {
  const started = Date.now();
  return () => new Date(reference.getTime() + Date.now() - started);
}

async function deleteCandidate(snapshot: Conversation, cutoffTime: Date, reason: PurgeReason, clock: () => Date): Promise<DeletionCounts> {
  const claim = await claimPurge(snapshot, clock(), reason, cutoffTime);
  if (!claim) {
    if (reason === 'retention') return emptyCounts();
    const current = await (await getCollection<Conversation>('conversations')).findOne({ _id: snapshot._id }, operation);
    if (!current) return { ...emptyCounts(), deleted: 1 };
    if (current.purge) return { ...emptyCounts(), pending: 1 };
    throw new ApiError('The conversation changed. Reload and try again.', 409, 'CONVERSATION_CHANGED');
  }
  try {
    const result = await finishPurge(claim);
    if (!result.deleted) { result.pending = 1; await releasePurge(claim, clock(), false); }
    return result;
  } catch (error) {
    await releasePurge(claim, clock(), true);
    throw error;
  }
}

/** Explicit permanent deletion shares the worker's retryable lifecycle. */
export async function deleteConversationsPermanently(
  items: Pick<Conversation, '_id' | 'participants'>[],
  options: { now?: Date } = {},
): Promise<DeletionCounts> {
  const counts = emptyCounts();
  if (!items.length) return counts;
  const now = options.now ?? new Date();
  const clock = attemptClock(now);
  const conversations = await getCollection<Conversation>('conversations');
  for (const item of items) {
    const current = await conversations.findOne({ _id: item._id }, operation);
    if (!current) { counts.deleted++; continue; }
    const result = await deleteCandidate(current, now, 'manual', clock);
    for (const key of Object.keys(counts) as (keyof DeletionCounts)[]) counts[key] += result[key];
  }
  return counts;
}

/** Bounded all-owner sweep; failed rows back off so other owners progress. */
export async function purgeExpiredConversations(now = new Date(), batchSize = MAX_BATCH): Promise<{
  examined: number; deleted: number; failed: number;
}> {
  const limit = Math.max(1, Math.min(MAX_BATCH, Math.floor(batchSize) || MAX_BATCH));
  const conversations = await getCollection<Conversation>('conversations');
  const clock = attemptClock(now);
  // Continue admitted deletions before fresh work: a steady stream of newly
  // expired rows must not starve a previous file/tuple batch continuation.
  const ready = await conversations.find({ purge: { $exists: true }, 'purge.lease_until': { $lte: now },
    'purge.retry_after': { $lte: now } }, operation)
    .sort({ 'purge.retry_after': 1, _id: 1 }).limit(limit).toArray();
  const fresh = ready.length < limit ? await conversations.find({ purge: { $exists: false },
    deleted_at: { $type: 'date', $lte: new Date(now.getTime() - ARCHIVE_RETENTION_MS) },
  }, operation).sort({ deleted_at: 1, _id: 1 }).limit(limit - ready.length).toArray() : [];
  const items = [...ready, ...fresh];
  const result = { examined: items.length, deleted: 0, failed: 0 };
  for (const item of items) {
    try { result.deleted += (await deleteCandidate(item, now, 'retention', clock)).deleted; }
    catch (error) {
      result.failed++;
      console.error('[ConversationRetention] Purge remains retryable', error instanceof Error ? error.message : 'Unknown error');
    }
  }
  return result;
}
