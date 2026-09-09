import { ApiError } from "@/lib/api-error";
import {
  authzSyncPreCheck,
  type AuthzSyncDocument,
} from "@/lib/authz/resource-sync";
import { getCollection } from "@/lib/mongodb";
import {
  requireResourcePermission,
  type ResourceAuthzSession,
} from "@/lib/rbac/resource-authz";
import type { MCPServerConfig, VisibilityType } from "@/types/dynamic-agent";
import type { AgentSkill, SkillVisibility } from "@/types/agent-skill";
import type {
  WorkflowConfig,
  WorkflowConfigVisibility,
} from "@/types/workflow-config";

type AllowedTools = Record<string, string[] | boolean>;

export interface AgentMcpScope {
  visibility: VisibilityType;
  ownerSubject: string;
  ownerEmail?: string;
  ownerTeamSlug?: string | null;
  sharedTeamSlugs?: readonly string[];
}

function selectedServerIds(allowedTools: AllowedTools): string[] {
  return Object.entries(allowedTools)
    .filter(
      ([, tools]) =>
        tools !== false && (!Array.isArray(tools) || tools.length > 0),
    )
    .map(([serverId]) => serverId);
}

function mcpVisibility(server: MCPServerConfig): "private" | "team" | "global" {
  return server.visibility === "private" || server.visibility === "team"
    ? server.visibility
    : "global";
}

function effectiveTeams(input: {
  ownerTeamSlug?: string | null;
  sharedTeamSlugs?: readonly string[];
}): Set<string> {
  return new Set(
    [input.ownerTeamSlug, ...(input.sharedTeamSlugs ?? [])]
      .filter(
        (slug): slug is string =>
          typeof slug === "string" && slug.trim().length > 0,
      )
      .map((slug) => slug.trim()),
  );
}

function dependencyError(serverId: string): ApiError {
  return new ApiError(
    `MCP server "${serverId}" is not compatible with this agent's visibility or owner.`,
    400,
    "PRIVATE_RESOURCE_DEPENDENCY_DENIED",
  );
}

type AgentResourceDependency = AuthzSyncDocument & {
  id: string;
  kind: "skill" | "workflow";
  visibility: SkillVisibility | WorkflowConfigVisibility;
  ownerSubject?: string;
  ownerEmail?: string;
  sharedTeamSlugs: readonly string[];
};

function resourceDependencyError(
  dependency: AgentResourceDependency,
): ApiError {
  return new ApiError(
    `${dependency.kind === "skill" ? "Skill" : "Workflow"} "${dependency.id}" is not compatible with this agent's visibility or owner.`,
    400,
    "PRIVATE_RESOURCE_DEPENDENCY_DENIED",
  );
}

async function validateAgentResourceDependencyScopes(input: {
  agent: AgentMcpScope;
  dependencies: readonly AgentResourceDependency[];
  canUse: (dependency: AgentResourceDependency) => Promise<boolean>;
}): Promise<void> {
  const parentTeams = effectiveTeams({
    ownerTeamSlug: input.agent.ownerTeamSlug,
    sharedTeamSlugs: input.agent.sharedTeamSlugs,
  });
  for (const dependency of input.dependencies) {
    if (authzSyncPreCheck(dependency))
      throw resourceDependencyError(dependency);
    if (input.agent.visibility === "global") {
      if (dependency.visibility !== "global")
        throw resourceDependencyError(dependency);
      continue;
    }
    if (input.agent.visibility === "team") {
      if (dependency.visibility === "private")
        throw resourceDependencyError(dependency);
      if (dependency.visibility === "team") {
        const childTeams = new Set(
          dependency.sharedTeamSlugs.map((slug) => slug.trim()),
        );
        if ([...parentTeams].some((team) => !childTeams.has(team))) {
          throw resourceDependencyError(dependency);
        }
      }
      continue;
    }
    if (dependency.visibility === "private") {
      const sameOwner = dependency.ownerSubject
        ? dependency.ownerSubject === input.agent.ownerSubject
        : Boolean(
            dependency.ownerEmail &&
              input.agent.ownerEmail &&
              dependency.ownerEmail.toLowerCase() ===
                input.agent.ownerEmail.toLowerCase(),
          );
      if (!sameOwner) {
        throw resourceDependencyError(dependency);
      }
      continue;
    }
    if (!(await input.canUse(dependency)))
      throw resourceDependencyError(dependency);
  }
}

/** Enforce the private < team < global audience ordering for selected MCP servers. */
export async function validateAgentMcpDependencyScopes(input: {
  agent: AgentMcpScope;
  allowedTools: AllowedTools;
  servers: readonly MCPServerConfig[];
  canInvokeServer?: (serverId: string) => Promise<boolean>;
}): Promise<void> {
  const selected = new Set(selectedServerIds(input.allowedTools));
  if (selected.size === 0) return;

  const parentTeams = effectiveTeams({
    ownerTeamSlug: input.agent.ownerTeamSlug,
    sharedTeamSlugs: input.agent.sharedTeamSlugs,
  });
  for (const server of input.servers) {
    if (!selected.has(server._id)) continue;
    const visibility = mcpVisibility(server);

    if (input.agent.visibility === "global") {
      if (visibility !== "global") throw dependencyError(server._id);
      continue;
    }

    if (input.agent.visibility === "team") {
      if (visibility === "private") throw dependencyError(server._id);
      if (visibility === "team") {
        const childTeams = effectiveTeams({
          ownerTeamSlug: server.owner_team_slug,
          sharedTeamSlugs: server.shared_with_teams,
        });
        if ([...parentTeams].some((team) => !childTeams.has(team))) {
          throw dependencyError(server._id);
        }
      }
      continue;
    }

    if (visibility === "private") {
      const sameOwner = server.owner_subject
        ? server.owner_subject === input.agent.ownerSubject
        : Boolean(
            server.owner_id &&
              input.agent.ownerEmail &&
              server.owner_id.toLowerCase() ===
                input.agent.ownerEmail.toLowerCase(),
          );
      if (!sameOwner) {
        throw dependencyError(server._id);
      }
      continue;
    }
    if (visibility === "team") {
      const allowed = await input.canInvokeServer?.(server._id);
      if (!allowed) throw dependencyError(server._id);
    }
  }
}

export function selectedMcpServerIds(allowedTools: AllowedTools): string[] {
  return selectedServerIds(allowedTools);
}

export async function validatePersistedAgentMcpDependencies(input: {
  session: ResourceAuthzSession;
  agent: AgentMcpScope;
  allowedTools: AllowedTools;
}): Promise<void> {
  const ids = selectedMcpServerIds(input.allowedTools);
  if (ids.length === 0) return;
  const servers = await getCollection<MCPServerConfig>("mcp_servers").then(
    (collection) => collection.find({ _id: { $in: ids } }).toArray(),
  );
  await validateAgentMcpDependencyScopes({
    agent: input.agent,
    allowedTools: input.allowedTools,
    servers,
    canInvokeServer: async (serverId) => {
      try {
        await requireResourcePermission(input.session, {
          type: "mcp_server",
          id: serverId,
          action: "invoke",
        });
        return true;
      } catch {
        return false;
      }
    },
  });
}

/** Validate skills and workflow tools that the runtime loads directly from MongoDB. */
export async function validatePersistedAgentResourceDependencies(input: {
  session: ResourceAuthzSession;
  agent: AgentMcpScope;
  skillIds?: readonly string[];
  workflowIds?: readonly string[] | null;
}): Promise<void> {
  const skillIds = [...new Set(input.skillIds ?? [])];
  const persistedSkillIds = skillIds.filter((id) => {
    if (!id.startsWith("hub-")) return true;
    const rest = id.slice("hub-".length);
    return rest.indexOf("-", 1) < 0;
  });
  const hubSkillIds = skillIds.filter((id) => !persistedSkillIds.includes(id));
  const workflowIds = [...new Set(input.workflowIds ?? [])];
  const [skills, workflows] = await Promise.all([
    persistedSkillIds.length === 0
      ? Promise.resolve([] as AgentSkill[])
      : getCollection<AgentSkill>("agent_skills").then((collection) =>
          collection.find({ id: { $in: persistedSkillIds } }).toArray(),
        ),
    workflowIds.length === 0
      ? Promise.resolve([] as WorkflowConfig[])
      : getCollection<WorkflowConfig>("workflow_configs").then((collection) =>
          collection.find({ _id: { $in: workflowIds } }).toArray(),
        ),
  ]);
  if (
    skills.length !== persistedSkillIds.length ||
    workflows.length !== workflowIds.length
  ) {
    throw new ApiError(
      "One or more selected skills or workflows no longer exist.",
      400,
      "RESOURCE_DEPENDENCY_NOT_FOUND",
    );
  }
  const dependencies: AgentResourceDependency[] = [
    ...hubSkillIds.map((id) => ({
      id,
      kind: "skill" as const,
      visibility: "global" as const,
      sharedTeamSlugs: [],
    })),
    ...skills.map((skill) => ({
      id: skill.id,
      kind: "skill" as const,
      visibility: skill.visibility ?? ("private" as const),
      ownerSubject: skill.owner_subject,
      ownerEmail: skill.owner_id,
      sharedTeamSlugs: skill.shared_with_teams ?? [],
      authz_revision: skill.authz_revision,
      authz_sync_state: skill.authz_sync_state,
      authz_last_synced_revision: skill.authz_last_synced_revision,
    })),
    ...workflows.map((workflow) => ({
      id: workflow._id,
      kind: "workflow" as const,
      visibility: workflow.visibility ?? ("private" as const),
      ownerSubject: workflow.owner_subject,
      ownerEmail: workflow.owner_id,
      sharedTeamSlugs: workflow.shared_with_teams ?? [],
      authz_revision: workflow.authz_revision,
      authz_sync_state: workflow.authz_sync_state,
      authz_last_synced_revision: workflow.authz_last_synced_revision,
    })),
  ];
  await validateAgentResourceDependencyScopes({
    agent: input.agent,
    dependencies,
    canUse: async (dependency) => {
      try {
        await requireResourcePermission(input.session, {
          type: dependency.kind === "skill" ? "skill" : "task",
          id: dependency.id,
          action: dependency.kind === "skill" ? "invoke" : "use",
        });
        return true;
      } catch {
        return false;
      }
    },
  });
}
