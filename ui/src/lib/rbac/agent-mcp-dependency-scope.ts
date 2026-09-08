import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import {
  requireResourcePermission,
  type ResourceAuthzSession,
} from "@/lib/rbac/resource-authz";
import type { MCPServerConfig, VisibilityType } from "@/types/dynamic-agent";

type AllowedTools = Record<string, string[] | boolean>;

export interface AgentMcpScope {
  visibility: VisibilityType;
  ownerSubject: string;
  ownerTeamSlug?: string | null;
  sharedTeamSlugs?: readonly string[];
}

function selectedServerIds(allowedTools: AllowedTools): string[] {
  return Object.entries(allowedTools)
    .filter(([, tools]) => tools !== false && (!Array.isArray(tools) || tools.length > 0))
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
      .filter((slug): slug is string => typeof slug === "string" && slug.trim().length > 0)
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
      if (server.owner_subject !== input.agent.ownerSubject) {
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
  const servers = await getCollection<MCPServerConfig>("mcp_servers")
    .then((collection) => collection.find({ _id: { $in: ids } }).toArray());
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
