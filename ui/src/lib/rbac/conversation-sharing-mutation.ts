import { ApiError } from '@/lib/api-middleware';
import { withResourceMutationLock, type MutationLockGuard } from '@/lib/agent-mutation-lock';
import { reconcileTupleDiff } from '@/lib/authz';
import { getCollection } from '@/lib/mongodb';
import type { TeamResourceTupleDiff } from '@/lib/rbac/openfga';
import type { Conversation, SharingAccess } from '@/types/mongodb';
import type { Document, Filter, UpdateFilter } from 'mongodb';

interface AccessUpdate {
  filter: Filter<SharingAccess>;
  update: UpdateFilter<SharingAccess>;
}

export interface ConversationSharingMutation extends Document {
  _id: string;
  grants: TeamResourceTupleDiff;
  accessInserts?: SharingAccess[];
  accessUpdates?: AccessUpdate[];
  conversationUpdate: UpdateFilter<Conversation>;
}

/** Sharing and permanent deletion must hold the same cross-replica lock. */
export function withConversationSharingLock<T>(id: string, operation: (assertOwned: MutationLockGuard) => Promise<T>): Promise<T> {
  return withResourceMutationLock(
    'conversation_mutation_locks', id, 'Another conversation access change is in progress. Please retry.', operation, { leaseMs: 60_000 },
  );
}

/**
 * Replay an accepted intent before accepting another sharing change. Each step
 * is idempotent; only this intent's exact tuple diff and access rows are applied.
 * Forward recovery never guesses an inverse that could remove pre-existing grants.
 * The caller holds the conversation lock and has checked sharing authorization.
 */
export async function resumeConversationSharingMutation(id: string, assertOwned: MutationLockGuard): Promise<boolean> {
  const journal = await getCollection<ConversationSharingMutation>('conversation_share_mutations');
  await assertOwned();
  const mutation = await journal.findOne({ _id: id });
  if (!mutation) return false;
  await applyMutation(mutation, assertOwned);
  return true;
}

async function applyMutation(mutation: ConversationSharingMutation, assertOwned: MutationLockGuard): Promise<void> {
  if (mutation.grants.writes.length || mutation.grants.deletes.length) {
    await assertOwned.runExclusive(() => reconcileTupleDiff(mutation.grants, { source: 'conversation_sharing' }));
  }
  const access = await getCollection<SharingAccess>('sharing_access');
  for (const record of mutation.accessInserts ?? []) {
    // Assigned before journaling, so a partial insert or retry cannot duplicate it.
    await assertOwned.runExclusive(() => access.updateOne({ _id: record._id }, { $setOnInsert: record }, { upsert: true }));
  }
  for (const change of mutation.accessUpdates ?? []) {
    await assertOwned.runExclusive(() => access.updateMany(change.filter, change.update));
  }
  const conversations = await getCollection<Conversation>('conversations');
  const result = await assertOwned.runExclusive(() => conversations.updateOne({ _id: mutation._id }, mutation.conversationUpdate));
  if (result.matchedCount === 0) throw new ApiError('Conversation not found', 404);
  const journal = await getCollection<ConversationSharingMutation>('conversation_share_mutations');
  await assertOwned.runExclusive(() => journal.deleteOne({ _id: mutation._id }));
}

/** Persist recovery work before any graph or sharing-state side effect. */
export async function commitConversationSharingMutation(mutation: ConversationSharingMutation, assertOwned: MutationLockGuard): Promise<void> {
  const journal = await getCollection<ConversationSharingMutation>('conversation_share_mutations');
  await assertOwned.runExclusive(() => journal.insertOne(mutation));
  await applyMutation(mutation, assertOwned);
}
