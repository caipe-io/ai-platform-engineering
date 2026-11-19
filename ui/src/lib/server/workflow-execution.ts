import { randomUUID } from "node:crypto";

import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import type { WorkflowRunDocument } from "./workflow-engine";

const HEARTBEAT_MS = 15_000;
export const WORKFLOW_EXECUTION_LEASE_MS = 90_000;

export interface WorkflowExecution {
  id: string;
  signal: AbortSignal;
}

const controllers = new Map<string, AbortController>();

export function cancelLocalWorkflow(runId: string): void {
  controllers.get(runId)?.abort();
}

/** Claim once; heartbeats and fenced writes prevent another request taking ownership. */
export async function launchWorkflowExecution(
  runId: string,
  expectedStatus: "pending" | "waiting_for_input",
  work: (execution: WorkflowExecution) => Promise<void>,
): Promise<void> {
  const col = await getCollection<WorkflowRunDocument>("workflow_runs");
  const id = randomUUID();
  const now = new Date();
  const claimed = await col.updateOne({ _id: runId, status: expectedStatus }, {
    $set: { status: "running", execution_id: id, heartbeat_at: now, lease_expires_at: new Date(now.getTime() + WORKFLOW_EXECUTION_LEASE_MS) },
  });
  if (claimed.matchedCount !== 1) throw new ApiError("Workflow execution was already claimed or its status changed", 409, "WORKFLOW_EXECUTION_CONFLICT");

  const controller = new AbortController();
  controllers.set(runId, controller);
  const filter = { _id: runId, status: "running" as const, execution_id: id };
  let renewing = false;
  const heartbeat = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const time = new Date();
      const result = await col.updateOne({ ...filter, lease_expires_at: { $gt: time } }, {
        $set: { heartbeat_at: time, lease_expires_at: new Date(time.getTime() + WORKFLOW_EXECUTION_LEASE_MS) },
      });
      if (result.matchedCount !== 1) controller.abort();
    } catch (error) {
      console.error(`[WorkflowEngine] Heartbeat failed for ${runId}:`, error);
      controller.abort();
    } finally {
      renewing = false;
    }
  }, HEARTBEAT_MS);

  void Promise.resolve().then(() => work({ id, signal: controller.signal })).catch(async (error: unknown) => {
    console.error(`[WorkflowEngine] Execution failed for ${runId}:`, error);
    const run = await col.findOne(filter);
    if (!run) return;
    const message = `Workflow worker stopped: ${error instanceof Error ? error.message : "Unexpected execution failure"}. Inspect saved progress and external state before recovery.`;
    await col.updateOne(filter, { $set: {
      status: "failed", completed_at: new Date(),
      [`steps.${run.current_step_index}.status`]: "failed",
      [`steps.${run.current_step_index}.error`]: message,
      [`steps.${run.current_step_index}.completed_at`]: new Date(),
    } });
  }).catch((error: unknown) => {
    // If MongoDB is unavailable, expiry still lets a later poll diagnose the lost worker.
    console.error(`[WorkflowEngine] Could not persist execution failure for ${runId}:`, error);
  }).finally(async () => {
    clearInterval(heartbeat);
    if (controllers.get(runId) === controller) controllers.delete(runId);
    try {
      await col.updateOne({ _id: runId, execution_id: id, status: { $ne: "running" } }, { $unset: { execution_id: "", lease_expires_at: "" } });
    } catch (error) {
      console.error(`[WorkflowEngine] Could not release execution lease for ${runId}:`, error);
    }
  });
}
