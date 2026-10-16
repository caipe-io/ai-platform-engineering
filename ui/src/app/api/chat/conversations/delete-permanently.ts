import { getCollection } from '@/lib/mongodb';
import type { Conversation } from '@/types/mongodb';
import { resolveConversationRuntimeId } from '@/app/api/v1/chat/_conversation-authz';

/**
 * Hard-delete one or more conversations and all associated data
 * (messages + Dynamic Agent checkpoint records).
 */
export async function deleteConversationsPermanently(
  items: Array<Pick<Conversation, '_id' | 'participants'> & Partial<Pick<Conversation,
    'source' | 'execution_context_id' | 'task_id' | 'metadata'
  >>>
): Promise<void> {
  if (items.length === 0) return;

  const ids = items.map((c) => c._id);

  const runtimeIds = new Set(ids);
  for (const item of items) {
    // Resolve only the execution explicitly behind each authorized resource.
    // A task reference does not authorize purging every other task run.
    runtimeIds.add(await resolveConversationRuntimeId(item));
  }

  // A minimal deletion ledger closes the race with a request authorized
  // before this purge. Admission and replay reject these native session IDs.
  const deletedSessions = await getCollection<{ _id: string; deleted_at: Date }>('native_acp_deleted_sessions');
  const deletedAt = new Date();
  for (const sessionId of runtimeIds) {
    await deletedSessions.updateOne(
      { _id: sessionId },
      { $setOnInsert: { deleted_at: deletedAt } },
      { upsert: true },
    );
  }

  const conversations = await getCollection<Conversation>('conversations');
  await conversations.deleteMany({ _id: { $in: ids } });

  const messages = await getCollection('messages');
  await messages.deleteMany({ conversation_id: { $in: ids } });
  // Journal metadata disappears first: readers stop immediately, and workers
  // cannot append further output to a deleted execution. Erase its event log
  // afterwards so replay cannot retain a second copy of a removed transcript.
  const executionRuns = await getCollection<{ run_id: string }>('native_acp_execution_runs');
  const runScope = { session_id: { $in: [...runtimeIds] } };
  const runs = await executionRuns.find(runScope, { projection: { run_id: 1 } }).toArray();
  await executionRuns.deleteMany(runScope);
  const executionEvents = await getCollection('native_acp_execution_events');
  await executionEvents.deleteMany({
    $or: [
      { session_id: { $in: [...runtimeIds] } },
      // Older journals predate the internal session index on event records.
      ...(runs.length > 0 ? [{ run_id: { $in: runs.map((run) => run.run_id) } }] : []),
    ],
  });

  const agentIds = items
    .filter((c) => c.participants?.some((p: { type: string }) => p.type === 'agent'))
    .map((c) => c._id);

  if (agentIds.length > 0) {
    const checkpoints = await getCollection('checkpoints_conversation');
    const checkpointWrites = await getCollection('checkpoint_writes_conversation');
    await checkpoints.deleteMany({ thread_id: { $in: [...runtimeIds] } });
    await checkpointWrites.deleteMany({ thread_id: { $in: [...runtimeIds] } });
  }
}
