import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { normalizeAgentExecution } from "./execution-config";

/** Portable operator configuration, excluding database bookkeeping. */
export function exportAgentConfiguration(agent: DynamicAgentConfig): Record<string, unknown> {
  const agentRecord = agent as unknown as Record<string, unknown>;
  return {
    id: agent._id,
    name: agent.name,
    description: agent.description || undefined,
    system_prompt: agent.system_prompt,
    execution: normalizeAgentExecution(agent.execution),
    model: agent.model,
    visibility: agent.visibility,
    shared_with_teams: agent.shared_with_teams?.length ? agent.shared_with_teams : undefined,
    allowed_tools: Object.keys(agent.allowed_tools || {}).length ? agent.allowed_tools : undefined,
    builtin_tools: agent.builtin_tools,
    subagents: agent.subagents?.length ? agent.subagents : undefined,
    skills: agent.skills?.length ? agent.skills : undefined,
    features: agent.features,
    interrupt_on: agentRecord.interrupt_on || undefined,
    ui: agent.ui?.gradient_theme ? agent.ui : undefined,
    enabled: agent.enabled,
  };
}
