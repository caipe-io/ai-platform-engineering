/**
 * "Does this autonomous task belong to this custom agent?" predicate.
 *
 * The Custom Agent editor's Autonomous tab uses this to filter the
 * full ``GET /tasks`` list down to the rows it should display when
 * an operator opens an existing agent.
 *
 * Why both fields?
 *   - ``dynamic_agent_id`` is the current stamping written by
 *     ``syncAutonomousTasks`` -- this is the routing target the
 *     autonomous-agents service uses to dispatch the task through
 *     the dynamic-agents service.
 *   - ``agent`` covers any rows created before the rename. The plan
 *     explicitly avoids a Mongo backfill, so the editor must keep
 *     matching on the legacy field too (the editor will then
 *     re-stamp them to ``dynamic_agent_id`` on next save via
 *     ``syncAutonomousTasks``).
 */

import type { AutonomousTask } from "@/components/autonomous/types";

export function isTaskOwnedByAgent(
  task: Pick<AutonomousTask, "agent" | "dynamic_agent_id">,
  agentId: string,
): boolean {
  return (
    (task.dynamic_agent_id ?? null) === agentId || task.agent === agentId
  );
}
