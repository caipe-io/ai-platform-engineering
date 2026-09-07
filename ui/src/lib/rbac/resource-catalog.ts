import { getCollection } from "@/lib/mongodb";
import { listResourceTypeDefinitions } from "@/lib/rbac/resource-model";
import { slackWorkspaceRef } from "@/lib/rbac/slack-channel-grant-store";
import { webexWorkspaceRef } from "@/lib/rbac/webex-space-grant-store";
import type {
UniversalRebacResourceType,
UniversalRebacResourceTypeDefinition,
} from "@/types/rbac-universal";

export type RebacResourceStatus = "active" | "disabled" | "archived" | "deleted" | "unknown";
export type RebacEnforcementStatus =
  | "not_gated"
  | "role_gated"
  | "rebac_shadowed"
  | "rebac_enforced"
  | "deprecated";

export interface RebacCatalogResource {
  type: UniversalRebacResourceType;
  id: string;
  display_name: string;
  status: RebacResourceStatus;
  enforcement_status: RebacEnforcementStatus;
  metadata?: Record<string, unknown>;
}

export interface ListRebacCatalogInput {
  type?: string | null;
  status?: string | null;
  search?: string | null;
}

export interface RebacCatalog {
  resource_types: readonly UniversalRebacResourceTypeDefinition[];
  actions: Record<string, readonly string[]>;
  resources: RebacCatalogResource[];
}

const DEFAULT_RESOURCES: readonly RebacCatalogResource[] = [
  resource("organization", "caipe", "CAIPE", "rebac_shadowed"),
  resource("external_group", "example-enterprise-group", "Example Enterprise Group", "rebac_shadowed"),
  resource("team", "platform", "Platform", "rebac_shadowed"),
  resource("slack_workspace", "workspace-default", "Default Slack Workspace", "role_gated"),
  resource("slack_channel", "workspace-default--platform", "#platform", "role_gated"),
  resource("webex_workspace", "workspace-default", "Default Webex Workspace", "role_gated"),
  resource("webex_space", "workspace-default--platform", "Platform Space", "role_gated"),
  resource("agent", "platform-engineer", "Platform Engineer", "rebac_shadowed"),
  resource("llm_model", "default", "Default LLM Model", "rebac_enforced"),
  resource("mcp_gateway", "list", "AgentGateway MCP list", "rebac_shadowed"),
  resource("mcp_server", "argocd", "Argo CD MCP Server", "role_gated"),
  resource("tool", "argocd_*", "Argo CD Tools", "rebac_shadowed"),
  resource("knowledge_base", "platform-runbooks", "Platform Runbooks", "rebac_shadowed"),
  resource("rag_collection", "platform-rag", "Platform RAG", "rebac_enforced"),
  resource("data_source", "platform-runbooks", "Platform Runbooks Source", "rebac_enforced"),
  resource("ingestion_source", "slack-channel-platform", "Platform Slack Channel Source", "rebac_enforced"),
  resource("mcp_tool", "caipe_kb", "CAIPE KB Search Tool", "rebac_enforced"),
  resource("document", "platform-runbook", "Platform Runbook", "role_gated"),
  resource("skill", "incident-triage", "Incident Triage", "role_gated"),
  resource("task", "task-template", "Task Template", "role_gated"),
  resource("conversation", "*", "All conversations", "role_gated"),
  resource("admin_surface", "admin", "Admin Console", "role_gated"),
  resource("policy", "rebac-policies", "ReBAC Policies", "rebac_shadowed"),
  resource("audit_log", "rbac-audit", "RBAC Audit Log", "role_gated"),
  resource("secret_ref", "identity-provider-credentials", "Identity Provider Credentials", "not_gated"),
  resource("system_config", "rbac", "RBAC System Configuration", "role_gated"),
];

function resource(
  type: UniversalRebacResourceType,
  id: string,
  displayName: string,
  enforcementStatus: RebacEnforcementStatus,
  metadata?: Record<string, unknown>
): RebacCatalogResource {
  return {
    type,
    id,
    display_name: displayName,
    status: "active",
    enforcement_status: enforcementStatus,
    metadata,
  };
}

async function readCollection<T>(name: string, query: Record<string, unknown> = {}): Promise<T[]> {
  try {
    const collection = await getCollection<T>(name);
    const rows = await collection.find(query as never).sort({ name: 1 }).limit(200).toArray();
    return rows as T[];
  } catch {
    return [];
  }
}

function dedupeResources(resources: RebacCatalogResource[]): RebacCatalogResource[] {
  const seen = new Set<string>();
  const out: RebacCatalogResource[] = [];
  for (const item of resources) {
    const key = `${item.type}\n${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function matchesFilter(resourceItem: RebacCatalogResource, input: ListRebacCatalogInput): boolean {
  if (input.type && resourceItem.type !== input.type) return false;
  if (input.status && resourceItem.status !== input.status) return false;
  if (input.search) {
    const query = input.search.toLowerCase();
    return (
      resourceItem.id.toLowerCase().includes(query) ||
      resourceItem.display_name.toLowerCase().includes(query)
    );
  }
  return true;
}

export async function listRebacCatalog(input: ListRebacCatalogInput = {}): Promise<RebacCatalog> {
  const definitions = listResourceTypeDefinitions();
  const actions = Object.fromEntries(
    definitions.map((definition) => [definition.type, definition.actions])
  );

  const [teams, users, agents, llmModels, mcpServers, ragCollections, slackMappings, webexMappings] =
    await Promise.all([
      readCollection<{ _id: unknown; slug?: string; name?: string; status?: string }>("teams"),
      readCollection<{ _id?: unknown; email?: string; name?: string; role?: string; keycloak_sub?: string; metadata?: { keycloak_sub?: string } }>("users"),
      readCollection<{ _id: unknown; name?: string; description?: string }>("dynamic_agents", {
        enabled: { $ne: false },
      }),
      readCollection<{ _id: unknown; name?: string; model_id?: string }>("llm_models"),
      readCollection<{ _id: unknown; name?: string; description?: string }>("mcp_servers", {
        enabled: { $ne: false },
      }),
      readCollection<{ _id: unknown; name?: string; description?: string }>("rag_collections"),
      readCollection<{
        slack_workspace_id?: string;
        slack_channel_id?: string;
        channel_name?: string;
      }>("channel_team_mappings"),
      readCollection<{
        workspace_id?: string;
        webex_workspace_id?: string;
        space_id?: string;
        webex_space_id?: string;
        webex_room_id?: string;
        space_name?: string;
        space_title?: string;
      }>("webex_space_team_mappings"),
    ]);

  const discovered: RebacCatalogResource[] = [
    ...teams.map((team) =>
      resource("team", team.slug || String(team._id), team.name || String(team._id), "rebac_shadowed")
    ),
    ...users.map((user) =>
      resource("user", user.email || String(user._id), user.name || user.email || String(user._id), "role_gated")
    ),
    ...users.map((user) => {
      const subject = user.keycloak_sub || user.metadata?.keycloak_sub || String(user._id);
      return resource(
        "user_profile",
        subject,
        `${user.name || user.email || subject} profile`,
        "rebac_enforced"
      );
    }),
    ...agents.map((agent) =>
      resource("agent", String(agent._id), agent.name || String(agent._id), "rebac_shadowed")
    ),
    ...llmModels.map((model) =>
      resource("llm_model", String(model._id), model.name || model.model_id || String(model._id), "rebac_enforced")
    ),
    ...mcpServers.flatMap((server) => [
      resource("mcp_server", String(server._id), server.name || String(server._id), "role_gated"),
      resource("tool", `${String(server._id)}_*`, `${String(server._id)} tools`, "rebac_shadowed"),
    ]),
    ...ragCollections.map((collection) =>
      resource(
        "rag_collection",
        String(collection._id),
        collection.name || String(collection._id),
        "rebac_enforced",
      )
    ),
    ...slackMappings.flatMap((mapping) => {
      const workspaceId = slackWorkspaceRef(mapping.slack_workspace_id);
      const channelId = mapping.slack_channel_id || mapping.channel_name || "unknown";
      return [
        resource("slack_workspace", workspaceId, workspaceId, "role_gated"),
        resource(
          "slack_channel",
          `${workspaceId}--${channelId}`,
          mapping.channel_name || channelId,
          "role_gated"
        ),
      ];
    }),
    ...webexMappings.flatMap((mapping) => {
      const workspaceId = webexWorkspaceRef(mapping.webex_workspace_id || mapping.workspace_id);
      const spaceId = mapping.webex_space_id || mapping.space_id || mapping.webex_room_id;
      if (!spaceId) {
        return [resource("webex_workspace", workspaceId, workspaceId, "role_gated")];
      }
      return [
        resource("webex_workspace", workspaceId, workspaceId, "role_gated"),
        resource(
          "webex_space",
          `${workspaceId}--${spaceId}`,
          mapping.space_name || mapping.space_title || spaceId,
          "role_gated"
        ),
      ];
    }),
  ];

  return {
    resource_types: definitions,
    actions,
    resources: dedupeResources([...discovered, ...DEFAULT_RESOURCES])
      .filter((item) => matchesFilter(item, input))
      .sort((a, b) => `${a.type}:${a.display_name}`.localeCompare(`${b.type}:${b.display_name}`)),
  };
}
