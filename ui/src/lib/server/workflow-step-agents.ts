import { ApiError } from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import {
  flattenStepEntries,
  type WorkflowConfig,
  type WorkflowStep,
} from "@/types/workflow-config";

type AgentToolConfig = {
  _id: string;
  allowed_tools?: Record<string, string[] | boolean>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedToolsValue(value: unknown): value is string[] | boolean {
  return value === true || value === false ||
    (Array.isArray(value) && value.every((tool) => typeof tool === "string"));
}

async function loadWorkflowAgents(agentIds: string[]): Promise<AgentToolConfig[]> {
  const agentCol = await getCollection<AgentToolConfig>("dynamic_agents");
  return (await agentCol
    .find({ _id: { $in: agentIds } })
    .project({ _id: 1, allowed_tools: 1 })
    .toArray()) as AgentToolConfig[];
}

/**
 * Fail fast when a workflow references dynamic agent IDs that are not in MongoDB.
 */
export async function assertWorkflowStepAgentsExist(config: WorkflowConfig): Promise<void> {
  const agentIds = [
    ...new Set(
      (config.steps ?? [])
        .filter((entry): entry is WorkflowStep => entry.type === "step")
        .map((step) => step.agent_id)
        .filter((id): id is string => Boolean(id?.trim())),
    ),
  ];

  if (agentIds.length === 0) {
    return;
  }

  const agentCol = await getCollection<{ _id: string }>("dynamic_agents");
  const found = await agentCol
    .find({ _id: { $in: agentIds } })
    .project({ _id: 1 })
    .toArray();
  const foundIds = new Set(found.map((doc) => String(doc._id)));
  const missing = agentIds.filter((id) => !foundIds.has(id));

  if (missing.length > 0) {
    throw new ApiError(
      `This workflow references agent(s) that do not exist: ${missing.join(", ")}. ` +
        "Open the workflow in the editor, select each step, and choose an agent from the catalog " +
        "(or update config/app-config.yaml for config-driven workflows and restart the UI).",
      400,
    );
  }
}

/**
 * Validate workflow agent references and per-step allowed_tools overrides
 * before a workflow is persisted or started.
 *
 * Dynamic Agents deliberately reject overrides that add a server or tool to
 * the base agent. Checking the same contract at the UI boundary turns an
 * asynchronous step failure into an actionable save/run error and catches
 * stale server IDs after an MCP server rename.
 */
export async function assertWorkflowConfigRunnable(config: WorkflowConfig): Promise<void> {
  const flatSteps = flattenStepEntries(config.steps ?? []);
  const agentIds = [
    ...new Set(
      flatSteps
        .map(({ step }) => step.agent_id)
        .filter((id): id is string => Boolean(id?.trim())),
    ),
  ];

  if (agentIds.length === 0) {
    return;
  }

  const agents = await loadWorkflowAgents(agentIds);
  const agentsById = new Map(agents.map((agent) => [String(agent._id), agent]));
  const missing = agentIds.filter((id) => !agentsById.has(id));

  if (missing.length > 0) {
    throw new ApiError(
      `This workflow references agent(s) that do not exist: ${missing.join(", ")}. ` +
        "Open the workflow in the editor, select each step, and choose an agent from the catalog " +
        "(or update config/app-config.yaml for config-driven workflows and restart the UI).",
      400,
      "WORKFLOW_AGENT_NOT_FOUND",
    );
  }

  const violations: string[] = [];
  for (const { index, step } of flatSteps) {
    const rawOverride = step.config_override?.allowed_tools;
    if (rawOverride === undefined || rawOverride === null) {
      continue;
    }

    const agent = agentsById.get(step.agent_id);
    if (!agent) continue;

    if (!isRecord(rawOverride)) {
      violations.push(
        `step ${index} ("${step.display_text}") has an allowed_tools override that must be an object`,
      );
      continue;
    }

    const baseAllowedTools = isRecord(agent.allowed_tools) ? agent.allowed_tools : {};
    const unknownServers: string[] = [];
    const invalidTools: string[] = [];

    for (const [serverId, overrideValue] of Object.entries(rawOverride)) {
      if (!Object.prototype.hasOwnProperty.call(baseAllowedTools, serverId)) {
        unknownServers.push(serverId);
        continue;
      }

      if (!isAllowedToolsValue(overrideValue)) {
        invalidTools.push(`${serverId} (value must be true, false, or a string array)`);
        continue;
      }

      const baseValue = baseAllowedTools[serverId];
      if (baseValue === false && overrideValue !== false) {
        invalidTools.push(`${serverId} (server is disabled on the base agent)`);
        continue;
      }

      if (Array.isArray(baseValue) && Array.isArray(overrideValue)) {
        const extraTools = overrideValue.filter((tool) => !baseValue.includes(tool));
        if (extraTools.length > 0) {
          invalidTools.push(`${serverId} (unknown tools: ${extraTools.join(", ")})`);
        }
      }
    }

    if (unknownServers.length > 0 || invalidTools.length > 0) {
      const availableServers = Object.keys(baseAllowedTools).sort();
      const details = [
        unknownServers.length > 0 ? `unknown server(s): ${unknownServers.sort().join(", ")}` : null,
        invalidTools.length > 0 ? `invalid server/tool selection(s): ${invalidTools.join("; ")}` : null,
      ].filter((detail): detail is string => detail !== null);
      violations.push(
        `step ${index} ("${step.display_text}", agent "${step.agent_id}"): ${details.join("; ")}. ` +
          `Available base servers: ${availableServers.length > 0 ? availableServers.join(", ") : "none"}`,
      );
    }
  }

  if (violations.length > 0) {
    throw new ApiError(
      "Workflow tool access validation failed. Refresh the agent configuration and recreate the " +
        `step override(s): ${violations.join(" | ")}`,
      400,
      "WORKFLOW_TOOL_OVERRIDE_INVALID",
    );
  }
}
