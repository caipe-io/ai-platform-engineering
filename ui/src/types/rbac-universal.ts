/**
 * Shared types for the universal ReBAC model introduced by the
 * identity-group ReBAC specification.
 */

export type UniversalRebacStandardAction =
  | "discover"
  | "read"
  | "use"
  | "write"
  | "create"
  | "delete"
  | "manage"
  | "administer"
  | "audit"
  | "approve"
  | "share";

export type UniversalRebacResourceAction =
  | UniversalRebacStandardAction
  | "call"
  | "invoke"
  | "map"
  | "ingest"
  | "read-metadata"
  | "automate";

/**
 * Canonical, runtime-enumerable list of universal ReBAC resource (object) types.
 *
 * This `const` array is the single source the `UniversalRebacResourceType` union is
 * derived from, so coverage guards (see `fga-type-coverage.test.ts`) can compare it
 * against the authored OpenFGA model, the deployed chart model, and the runtime
 * resource registry WITHOUT a type-level enumeration.
 *
 * Subject-only model types (`service_account`, `anonymous`) are intentionally NOT in
 * this list — they are authorization subjects, not actionable resources. The parity
 * guard tracks them via an explicit allowlist.
 *
 * assisted-by Cursor claude-opus-4.8
 */
export const UNIVERSAL_REBAC_RESOURCE_TYPE_NAMES = [
  "organization",
  "user",
  "user_profile",
  "external_group",
  "team",
  "slack_workspace",
  "slack_channel",
  "webex_workspace",
  "webex_space",
  "agent",
  "llm_model",
  "mcp_gateway",
  "mcp_server",
  "tool",
  "rag_collection",
  "knowledge_base",
  "data_source",
  "mcp_tool",
  "ingestion_source",
  "document",
  "skill",
  "task",
  "conversation",
  "admin_surface",
  "policy",
  "audit_log",
  "secret_ref",
  "system_config",
] as const;

export type UniversalRebacResourceType =
  (typeof UNIVERSAL_REBAC_RESOURCE_TYPE_NAMES)[number];

export type UniversalRebacSubjectType =
  | "user"
  | "team"
  | "slack_channel"
  | "webex_space"
  | "webex_bot_installation"
  | "external_group"
  | "service_account";

export interface UniversalRebacSubjectRef {
  type: UniversalRebacSubjectType;
  id: string;
  relation?: "member" | "admin" | "owner";
}

export interface UniversalRebacResourceRef {
  type: UniversalRebacResourceType;
  id: string;
}

export interface UniversalRebacRelationship {
  subject: UniversalRebacSubjectRef;
  action: UniversalRebacResourceAction;
  resource: UniversalRebacResourceRef;
}

export interface UniversalRebacResourceTypeDefinition {
  type: UniversalRebacResourceType;
  actions: readonly UniversalRebacResourceAction[];
  description: string;
}
