import { getCollection } from '@/lib/mongodb';
import type { Conversation } from '@/types/mongodb';
import { resolveConversationRuntimeId } from '@/app/api/v1/chat/_conversation-authz';
import { ApiError } from '@/lib/api-error';
import { authenticateRequest, buildBackendHeaders, getDynamicAgentsConfig } from '@/lib/da-proxy';
import { readBoundedBody } from '@/lib/dynamic-agents/bounded-body';
import { NextRequest, NextResponse } from 'next/server';

interface SandboxSessionBinding {
  agent_id: string;
  session_id: string;
  runtime_kind: string;
  sandbox?: unknown;
}

interface PendingExecution {
  active?: boolean;
  status?: string;
  created_at?: Date | string;
  updated_at?: Date | string;
  finishing?: boolean;
}

function hasPendingAdmission(run: PendingExecution, now: number): boolean {
  if (run.active !== true) return false;
  // Running requests are owned by the lease checked separately. A stale active
  // flag after worker loss must not prevent explicit cleanup indefinitely.
  if (run.status === 'running' || run.status === 'awaiting_input') {
    return run.finishing === true && (!run.updated_at || new Date(run.updated_at).getTime() > now - 30_000);
  }
  if (run.status !== 'queued') return true;
  const created = run.created_at ? new Date(run.created_at).getTime() : NaN;
  return !Number.isFinite(created) || created > now - 30_000;
}

/**
 * Hard-delete one or more conversations and all associated data
 * (messages + Dynamic Agent checkpoint records).
 */
export async function deleteConversationsPermanently(
  items: Array<Pick<Conversation, '_id' | 'participants'> & Partial<Pick<Conversation,
    'source' | 'execution_context_id' | 'task_id' | 'metadata'
  >>>,
  request?: NextRequest,
): Promise<void> {
  if (items.length === 0) return;

  const ids = items.map((c) => c._id);

  const runtimeIds = new Set(ids);
  const itemRuntimeIds = new Map<string, string>();
  for (const item of items) {
    // Resolve only the execution explicitly behind each authorized resource.
    // A task reference does not authorize purging every other task run.
    const runtimeId = await resolveConversationRuntimeId(item);
    runtimeIds.add(runtimeId);
    itemRuntimeIds.set(item._id, runtimeId);
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


  // A producer already provisioning an environment must finish or stop before
  // cleanup. The deletion fence prevents a delayed producer starting afterwards.
  const leases = await getCollection<{ lease_id?: string }>('native_acp_runs');
  const activeLeases = await leases.find({
    session_id: { $in: [...runtimeIds] }, lease_id: { $exists: true }, lease_expires_at: { $gt: new Date() },
  }).toArray();
  const requests = await getCollection<PendingExecution>('native_acp_execution_runs');
  const activeRequests = await requests.find({ session_id: { $in: [...runtimeIds] }, active: true }).toArray();
  if (activeLeases.some((lease) => typeof lease.lease_id === 'string') || activeRequests.some((run) => hasPendingAdmission(run, Date.now()))) {
    throw new ApiError('Stop the active agent run before permanently deleting this conversation. History has been retained.', 409);
  }

  const bindings = await getCollection<SandboxSessionBinding>('native_acp_sessions');
  const saved = (await bindings.find({
    session_id: { $in: [...runtimeIds] }, runtime_kind: 'sandbox',
  }).toArray()).filter((binding) => binding.runtime_kind === 'sandbox');
  if (saved.length > 0) {
    if (!request) throw new ApiError('Authenticated sandbox cleanup is required before deleting this conversation', 409);
    const auth = await authenticateRequest(request);
    if (auth instanceof NextResponse) throw new ApiError('Sandbox cleanup requires authentication', auth.status);
    const config = getDynamicAgentsConfig();
    if (config instanceof NextResponse) throw new ApiError('Sandbox cleanup is unavailable', 503);
    for (const item of items) {
      const scope = new Set([item._id, itemRuntimeIds.get(item._id)]);
      const targets = saved.filter((binding) => scope.has(binding.session_id));
      if (targets.length === 0) continue;
      const agentId = item.participants?.find((participant) => participant.type === 'agent')?.id;
      if (!agentId || targets.some((binding) => binding.agent_id !== agentId)) {
        throw new ApiError('The sandbox does not match the conversation execution binding', 409);
      }
      try {
        const response = await fetch(new URL(`/api/v1/conversations/${encodeURIComponent(item._id)}/cleanup`, config.dynamicAgentsUrl), {
          method: 'POST', headers: buildBackendHeaders('application/json', auth),
          body: '{}', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
        });
        if (!response.ok) throw new ApiError(
          response.status === 409 ? 'The sandbox could not be cleaned up. Stop its active run and retry deletion.' : 'Sandbox cleanup failed; conversation history has been retained',
          [401, 403, 409].includes(response.status) ? response.status : 503,
        );
        const result = JSON.parse(await readBoundedBody(response.body, 256 * 1024));
        if (result?.success !== true || !Array.isArray(result.data?.session_ids) ||
            targets.some((target) => !result.data.session_ids.includes(target.session_id))) {
          throw new ApiError('Sandbox cleanup did not confirm the conversation execution binding', 503);
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        console.warn('[chat/delete] Sandbox cleanup unavailable', { errorType: error instanceof Error ? error.name : 'UnknownError' });
        throw new ApiError('Sandbox cleanup is unavailable; conversation history has been retained', 503);
      }
    }
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
  const toolRequests = await getCollection('native_acp_tool_requests');
  await toolRequests.deleteMany({ session_id: { $in: [...runtimeIds] } });
  await bindings.deleteMany({ session_id: { $in: [...runtimeIds] } });

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
