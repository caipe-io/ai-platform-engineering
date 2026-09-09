import { ApiError } from "@/lib/api-error";
import { authzSyncPreCheck } from "@/lib/authz/resource-sync";
import { getCollection } from "@/lib/mongodb";
import type { ResourceAuthzSession } from "@/lib/rbac/resource-authz";
import { requireAgentPermission } from "@/lib/rbac/resource-authz";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import type {
  StepEntry,
  WorkflowConfigVisibility,
} from "@/types/workflow-config";

function dependencyError(agentId: string): ApiError {
  return new ApiError(
    `Agent "${agentId}" is not compatible with this workflow's visibility or owner.`,
    400,
    "PRIVATE_RESOURCE_DEPENDENCY_DENIED",
  );
}

function agentIdsFromSteps(steps: StepEntry[]): string[] {
  const ids = new Set<string>();
  for (const entry of steps) {
    if (entry.type === "step") ids.add(entry.agent_id.trim());
  }
  return [...ids].filter(Boolean);
}

/** Prevent a shared workflow from becoming an execution tunnel to a private agent. */
export async function validateWorkflowAgentDependencies(input: {
  session: ResourceAuthzSession;
  workflow: {
    visibility: WorkflowConfigVisibility;
    ownerSubject: string;
    ownerEmail: string;
  };
  steps: StepEntry[];
}): Promise<void> {
  const ids = agentIdsFromSteps(input.steps);
  if (ids.length === 0) return;
  const agents = await getCollection<DynamicAgentConfig>("dynamic_agents").then(
    (collection) => collection.find({ _id: { $in: ids } }).toArray(),
  );
  if (agents.length !== ids.length) {
    throw new ApiError(
      "One or more selected workflow agents no longer exist.",
      400,
      "RESOURCE_DEPENDENCY_NOT_FOUND",
    );
  }

  for (const agent of agents) {
    if (authzSyncPreCheck(agent)) throw dependencyError(agent._id);
    if (agent.visibility === "private") {
      if (input.workflow.visibility !== "private")
        throw dependencyError(agent._id);
      const sameOwner = agent.owner_subject
        ? agent.owner_subject === input.workflow.ownerSubject
        : agent.owner_id.trim().toLowerCase() ===
          input.workflow.ownerEmail.trim().toLowerCase();
      if (!sameOwner) throw dependencyError(agent._id);
      continue;
    }
    try {
      await requireAgentPermission(input.session, agent._id, "use");
    } catch {
      throw dependencyError(agent._id);
    }
  }
}
