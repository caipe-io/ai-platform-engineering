import { withConversationSharingLock, type ConversationSharingMutation } from '@/lib/rbac/conversation-sharing-mutation';
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

  // Share changes cannot recreate grants while permanent cleanup is running.
  for (const item of items) {
    await withConversationSharingLock(item._id, async (assertOwned) => {
      const ids = [item._id];
      // Keep the owning record available if grant or child-data cleanup fails.
      await assertOwned.runExclusive(() => deleteAllConversationRelationshipTuples(item._id));

      const sharingAccess = await getCollection('sharing_access');
      await assertOwned.runExclusive(() => sharingAccess.deleteMany({ conversation_id: { $in: ids } }));

      const messages = await getCollection('messages');
      await assertOwned.runExclusive(() => messages.deleteMany({ conversation_id: { $in: ids } }));

      const agentIds = [item]
        .filter((c) => c.participants?.some((p: { type: string }) => p.type === 'agent'))
        .map((c) => c._id);

      if (agentIds.length > 0) {
        const checkpoints = await getCollection('checkpoints_conversation');
        const checkpointWrites = await getCollection('checkpoint_writes_conversation');
        await assertOwned.runExclusive(() => checkpoints.deleteMany({ thread_id: { $in: agentIds } }));
        await assertOwned.runExclusive(() => checkpointWrites.deleteMany({ thread_id: { $in: agentIds } }));
      }
      const journal = await getCollection<ConversationSharingMutation>('conversation_share_mutations');
      await assertOwned.runExclusive(() => journal.deleteMany({ _id: { $in: ids } }));
      const conversations = await getCollection<Conversation>('conversations');
      await assertOwned.runExclusive(() => conversations.deleteMany({ _id: { $in: ids } }));
    });
  }
}
