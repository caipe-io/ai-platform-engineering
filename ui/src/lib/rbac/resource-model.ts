import type {
  UniversalRebacResourceAction,
  UniversalRebacResourceType,
  UniversalRebacResourceTypeDefinition,
} from "@/types/rbac-universal";

export const STANDARD_REBAC_ACTIONS = [
  "discover",
  "read",
  "use",
  "write",
  "create",
  "delete",
  "manage",
  "administer",
  "audit",
  "approve",
  "share",
] as const;

export const UNIVERSAL_REBAC_RESOURCE_TYPES: readonly UniversalRebacResourceTypeDefinition[] =
  [
    {
      type: "organization",
      actions: ["discover", "read", "manage", "audit", "automate"],
      description: "Platform-wide organization scope.",
    },
    {
      type: "user",
      actions: ["read", "manage", "audit"],
      description: "User profile and identity-link state.",
    },
    {
      type: "user_profile",
      actions: ["discover", "read", "create", "manage", "audit"],
      description:
        "OpenFGA self-read profile object keyed by Keycloak subject.",
    },
    {
      type: "external_group",
      actions: ["discover", "read", "map", "audit"],
      description:
        "Enterprise identity group imported from an upstream provider.",
    },
    {
      type: "team",
      actions: ["discover", "read", "write", "manage", "audit"],
      description: "CAIPE team membership and team-owned authorization scope.",
    },
    {
      type: "slack_workspace",
      actions: ["discover", "read", "manage", "audit"],
      description: "Slack workspace configuration and channel discovery scope.",
    },
    {
      type: "slack_channel",
      actions: ["discover", "read", "use", "write", "manage", "audit"],
      description:
        "Slack channel that can be granted access to multiple CAIPE resources.",
    },
    {
      type: "webex_workspace",
      actions: ["discover", "read", "manage", "audit"],
      description: "Webex workspace configuration and space discovery scope.",
    },
    {
      type: "webex_space",
      actions: ["discover", "read", "use", "write", "manage", "audit"],
      description:
        "Webex space that can be granted access to multiple CAIPE resources.",
    },
    {
      type: "agent",
      actions: [
        "discover",
        "read",
        "use",
        "write",
        "create",
        "manage",
        "audit",
      ],
      description: "Agent execution and configuration resource.",
    },
    {
      type: "llm_model",
      actions: [
        "discover",
        "read",
        "write",
        "create",
        "delete",
        "manage",
        "audit",
      ],
      description: "LLM model registration available to Dynamic Agents.",
    },
    {
      type: "mcp_gateway",
      actions: ["call"],
      description: "AgentGateway MCP gateway coarse call scope.",
    },
    {
      type: "mcp_server",
      actions: [
        "discover",
        "read",
        "use",
        "invoke",
        "create",
        "manage",
        "audit",
      ],
      description: "MCP server registration and invocation scope.",
    },
    {
      type: "tool",
      actions: ["discover", "read", "use", "call", "manage", "audit"],
      description: "Tool or tool-prefix authorization target.",
    },
    {
      type: "rag_collection",
      actions: ["discover", "read", "use", "write", "manage", "audit"],
      description:
        "First-class RAG collection grouping datasources for reusable agent and API access.",
    },
    {
      type: "knowledge_base",
      actions: [
        "discover",
        "read",
        "use",
        "write",
        "ingest",
        "administer",
        "audit",
      ],
      description:
        "Knowledge base Search and trusted connector-transport scope.",
    },
    {
      type: "data_source",
      actions: [
        "discover",
        "read",
        "use",
        "write",
        "ingest",
        "delete",
        "manage",
        "audit",
      ],
      description:
        "Data source within a knowledge base; inherits access from its parent_kb.",
    },
    {
      type: "mcp_tool",
      actions: ["discover", "read", "use", "call", "delete", "manage", "audit"],
      description:
        "RAG custom MCP search tool created via the knowledge-base MCP API.",
    },
    {
      type: "ingestion_source",
      actions: ["discover", "read", "manage", "delete", "audit"],
      description:
        "Self-service RAG ingestion source configuration (Slack, Confluence, Jira, web, Webex).",
    },
    {
      type: "document",
      actions: ["discover", "read", "write", "delete", "share", "audit"],
      description:
        "Document-level authorization target within a knowledge base.",
    },
    {
      type: "skill",
      actions: [
        "discover",
        "read",
        "use",
        "write",
        "create",
        "manage",
        "audit",
      ],
      description: "Skill catalog entry and execution permission.",
    },
    {
      type: "task",
      actions: [
        "discover",
        "read",
        "use",
        "write",
        "create",
        "manage",
        "audit",
      ],
      description: "Task template or execution target.",
    },
    {
      type: "conversation",
      actions: ["discover", "read", "write", "share", "delete", "audit"],
      description: "Conversation history and sharing scope.",
    },
    {
      type: "admin_surface",
      actions: ["discover", "read", "write", "manage", "audit"],
      description: "Admin UI page or operation group.",
    },
    {
      type: "policy",
      actions: ["discover", "read", "write", "approve", "manage", "audit"],
      description: "Policy rule or relationship change-set resource.",
    },
    {
      type: "audit_log",
      actions: ["discover", "read", "audit"],
      description: "Audit view scoped by team, resource, or platform area.",
    },
    {
      type: "secret_ref",
      actions: ["discover", "read-metadata", "use", "manage", "share", "audit"],
      description:
        "Secret reference metadata and usage authorization without secret disclosure.",
    },
    {
      type: "system_config",
      actions: ["discover", "read", "write", "manage", "audit"],
      description: "System configuration area.",
    },
  ] as const;

const RESOURCE_TYPES_BY_NAME = new Map(
  UNIVERSAL_REBAC_RESOURCE_TYPES.map((definition) => [
    definition.type,
    definition,
  ]),
);

export function listResourceTypeDefinitions(): readonly UniversalRebacResourceTypeDefinition[] {
  return UNIVERSAL_REBAC_RESOURCE_TYPES;
}
export function getResourceTypeDefinition(
  type: UniversalRebacResourceType,
): UniversalRebacResourceTypeDefinition | undefined {
  return RESOURCE_TYPES_BY_NAME.get(type);
}

export function isSupportedResourceAction(
  resourceType: UniversalRebacResourceType,
  action: UniversalRebacResourceAction,
): boolean {
  return Boolean(
    getResourceTypeDefinition(resourceType)?.actions.includes(action),
  );
}
