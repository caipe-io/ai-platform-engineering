import { getCollection } from '@/lib/mongodb';
import type { Conversation } from '@/types/mongodb';

/**
 * Hard-delete one or more conversations and all associated data
 * (messages + Dynamic Agent checkpoint records).
 */
export async function deleteConversationsPermanently(
  items: (Pick<Conversation, '_id' | 'participants'> & Partial<Pick<Conversation, 'execution_context_id'>>)[]
): Promise<void> {
  if (items.length === 0) return;

  const ids = items.map((c) => c._id);

  // Fence admitted producers before removing their visible history. Engine
  // lease renewal, admission and projection all consult this durable tombstone.
  const contexts = [...new Set(items.flatMap(c => [c._id, ...(c.execution_context_id ? [c.execution_context_id] : [])]))];
  const deletedContexts = await getCollection<{ _id: string; deleted_at: Date }>('harness_deleted_contexts');
  await deletedContexts.bulkWrite(contexts.map(id => ({ updateOne: {
    filter: { _id: id }, update: { $setOnInsert: { deleted_at: new Date() } }, upsert: true,
  } })));

  const conversations = await getCollection<Conversation>('conversations');
  await conversations.deleteMany({ _id: { $in: ids } });

  const messages = await getCollection('messages');
  await messages.deleteMany({ conversation_id: { $in: ids } });

  const agentIds = items
    .filter((c) => c.participants?.some((p: { type: string }) => p.type === 'agent'))
    .map((c) => c._id);

  if (agentIds.length > 0) {
    const checkpoints = await getCollection('checkpoints_conversation');
    const checkpointWrites = await getCollection('checkpoint_writes_conversation');
    await checkpoints.deleteMany({ thread_id: { $in: agentIds } });
    await checkpointWrites.deleteMany({ thread_id: { $in: agentIds } });
  }
}
