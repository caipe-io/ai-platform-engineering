import { deleteAllConversationRelationshipTuples } from '@/lib/rbac/openfga-owned-resources-reconcile';
import { getCollection } from '@/lib/mongodb';
import type { Conversation } from '@/types/mongodb';

/**
 * Hard-delete one or more conversations and all associated data
 * (authorization grants, sharing records, messages, and agent checkpoints).
 */
export async function deleteConversationsPermanently(
  items: Pick<Conversation, '_id' | 'participants'>[]
): Promise<void> {
  if (items.length === 0) return;

  const ids = items.map((c) => c._id);

  // Keep the owning records available for retry if grant or child-data cleanup fails.
  for (const id of ids) {
    await deleteAllConversationRelationshipTuples(id);
  }

  const sharingAccess = await getCollection('sharing_access');
  await sharingAccess.deleteMany({ conversation_id: { $in: ids } });

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
  const conversations = await getCollection<Conversation>('conversations');
  await conversations.deleteMany({ _id: { $in: ids } });
}
