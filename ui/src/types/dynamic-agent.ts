/**
 * TypeScript types for Dynamic Agents feature.
 */

// =============================================================================
// Enums
// =============================================================================

export type TransportType = "stdio" | "sse" | "http";

/**
 * Visibility of a dynamic agent.
 *
 *   - `team`:   the owner team's members get `can_use`; the owner team's
 *               admins get `can_manage`. Additional teams in
 *               `shared_with_teams` get `can_use`.
 *   - `global`: everyone gets `can_use` (via `user:* user agent:<id>`).
 *               The owner team's admins still manage the agent.
 *
 * NOTE: `'private'` was retired on 2026-05-22. Every dynamic agent is now
 * team-owned. Users who want a truly personal agent should create a
 * single-member team and own the agent through that team. Legacy
 * `visibility: 'private'` documents are coerced to `'team'` at read time
 * and converted in place by the admin "Reconcile dynamic agent OpenFGA"
 * migration. See `docs/docs/changes/2026-05-22-remove-private-agents.md`.
 */
export type VisibilityType = "team" | "global";

/**
 * Wire-level type accepted on the way IN to the BFF. We still accept the
 * historical `'private'` string so old clients (and Mongo docs being
 * re-saved) don't fail outright — the BFF normalizes it to `'team'` and
 * surfaces a deprecation warning in the response.
 */
export type LegacyVisibilityType = VisibilityType | "private";

// =============================================================================
// MCP Server Types
// =============================================================================

export interface MCPServerConfig {
  _id: string;
  name: string;
  description?: string;
  transport: TransportType;
  endpoint?: string; // For sse/http transports
  command?: string; // For stdio transport
  args?: string[]; // For stdio transport
  env?: Record<string, string>; // For stdio transport
  credential_sources?: MCPCredentialSource[];
  enabled: boolean;
  config_driven?: boolean; // Whether loaded from config.yaml (not editable)
  source?: "manual" | "config" | "agentgateway";
  agentgateway_discovered?: boolean;
  agentgateway_endpoint?: string;
  agentgateway_target_endpoint?: string;
  owner_id?: string;
  owner_subject?: string;
  owner_team_slug?: string;
  created_at: string;
  updated_at: string;
}

/** Per-row OpenFGA decisions returned by GET /api/mcp-servers (batch-checked). */
export interface MCPServerRowPermissions {
  can_manage: boolean;
  can_invoke: boolean;
  can_discover: boolean;
}

/** List-level capabilities returned once per GET /api/mcp-servers response. */
export interface MCPServerListCapabilities {
  repair_agentgateway: boolean;
}

export interface MCPServerConfigWithPermissions extends MCPServerConfig {
  permissions: MCPServerRowPermissions;
}

export interface MCPCredentialSource {
  kind: "secret_ref" | "provider_connection" | "caller_token";
  target: "env" | "header";
  name: string;
  secret_ref?: string;
  provider_connection_id?: string;
  provider?: string;
  /**
   * Provider connections are always caller-scoped (each caller resolves their
   * OWN connection per JWT sub). The legacy `'pinned'` scope — one connection
   * reused for all callers — was removed for security; the value is still
   * accepted on the wire so old documents parse, but it is ignored.
   */
  connection_scope?: "caller" | "pinned";
  /** provider_connection: env var holding the shared fallback token (e.g. PAT). */
  fallback_env?: string;
  /** caller_token: mint a service client-credentials token when no user JWT. */
  fallback_client_credentials?: boolean;
}

export interface MCPServerConfigCreate {
  id: string; // User-provided slug ID
  name: string;
  description?: string;
  transport: TransportType;
  endpoint?: string;
  /** Upstream MCP URL when the form endpoint is an AgentGateway route from the picker. */
  agentgateway_target_endpoint?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  credential_sources?: MCPCredentialSource[];
  enabled?: boolean;
  owner_team_slug?: string;
}

export interface MCPServerConfigUpdate {
  name?: string;
  description?: string;
  transport?: TransportType;
  endpoint?: string;
  agentgateway_target_endpoint?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  credential_sources?: MCPCredentialSource[];
  enabled?: boolean;
}

export interface MCPToolInfo {
  name: string;
  namespaced_name: string;
  description: string;
  inputSchema?: unknown;
  input_schema?: unknown;
}

export interface MCPServerProbeResult {
  server_id: string;
  success: boolean;
  tools?: MCPToolInfo[];
  error?: string;
}

// =============================================================================
// Built-in Tools Types
// =============================================================================

/**
 * Definition of a configurable field for a built-in tool.
 * Returned by the /api/v1/builtin-tools endpoint.
 */
export interface BuiltinToolConfigField {
  name: string; // Field name (e.g., 'allowed_domains')
  type: "string" | "number" | "boolean";
  label: string; // Display label for UI
  description: string; // Help text for users
  default?: string | number | boolean; // Default value
  required?: boolean;
}

/**
 * Definition of a built-in tool returned by the API.
 */
export interface BuiltinToolDefinition {
  id: string; // Tool identifier (e.g., 'fetch_url')
  name: string; // Display name
  description: string; // What the tool does
  enabled_by_default: boolean;
  config_fields: BuiltinToolConfigField[];
}

/**
 * Configuration for the fetch_url built-in tool.
 */
export interface FetchUrlToolConfig {
  enabled: boolean;
  /**
   * Comma-separated domain patterns.
   * - "*" allows all domains
   * - "*.cisco.com" allows any subdomain of cisco.com
   * - "cisco.com" allows only the exact domain
   * - Empty string blocks all domains
   */
  allowed_domains: string;
}

/**
 * Configuration for the current_datetime built-in tool.
 */
export interface CurrentDatetimeToolConfig {
  enabled: boolean;
}

/**
 * Configuration for the user_info built-in tool.
 */
export interface UserInfoToolConfig {
  enabled: boolean;
}

/**
 * Configuration for the sleep built-in tool.
 */
export interface SleepToolConfig {
  enabled: boolean;
  max_seconds?: number; // Maximum sleep duration in seconds (default: 300)
}

/**
 * Configuration for all built-in tools available to dynamic agents.
 * Each tool config is optional - if not present, tool uses defaults.
 */
export interface BuiltinToolsConfig {
  fetch_url?: FetchUrlToolConfig;
  current_datetime?: CurrentDatetimeToolConfig;
  user_info?: UserInfoToolConfig;
  sleep?: SleepToolConfig;
  workflows?: string[] | null; // Workflow config IDs the agent can trigger/monitor
  // Allow dynamic tool configs for future extensibility
  // Using Record type to avoid index signature conflicts with specific tool types
}

/**
 * Generic tool config type for dynamic access patterns.
 * Use this when accessing tools by dynamic key.
 */
export type GenericToolConfig = { enabled: boolean; [field: string]: unknown };

/**
 * Helper type for accessing tool configs dynamically while preserving type safety.
 */
export type BuiltinToolsConfigWithIndex = BuiltinToolsConfig & {
  [key: string]: GenericToolConfig | undefined;
};

// =============================================================================
// Agent UI Config
// =============================================================================

/**
 * Custom theme configuration for agents.
 * Used when gradient_theme is "custom".
 */
export interface CustomThemeConfig {
  gradient_from: string; // CSS color for gradient start (hex, hsl, etc.)
  gradient_to: string; // CSS color for gradient end
  accent_color: string; // Tint color for the bot avatar SVG stroke
}

/**
 * UI configuration for dynamic agents.
 * Controls visual appearance like gradient themes.
 */
export interface AgentUIConfig {
  gradient_theme?: string; // Theme ID (e.g., 'ocean', 'sunset'), "custom", or empty for global default
  custom_theme_config?: CustomThemeConfig; // Only used when gradient_theme === "custom"
}

// =============================================================================
// Features / Middleware Config
// =============================================================================

/**
 * A single middleware entry in the agent's middleware stack.
 * Entries are ordered — the list defines execution order.
 */
export interface MiddlewareEntry {
  type: string; // Middleware type key (e.g. 'model_retry', 'pii')
  enabled: boolean;
  params: Record<string, unknown>;
}

/**
 * Agent feature flags and middleware configuration.
 * When absent (features is undefined), all default-enabled middleware
 * are applied with their default params on the server side.
 */
export interface FeaturesConfig {
  middleware: MiddlewareEntry[];
}

/**
 * Metadata for a middleware type in the registry.
 * Fetched from the backend GET /api/dynamic-agents/middleware endpoint.
 * Used by the UI to render toggles, param editors, and "Add" menu.
 */
export interface MiddlewareDefinition {
  key: string;
  label: string;
  description: string;
  enabled_by_default: boolean;
  allow_multiple: boolean;
  default_params: Record<string, unknown>;
  /** Whether this middleware needs model_id/model_provider params. */
  model_params?: boolean;
  /**
   * Type hints for params.
   * Values: "number", "boolean", "string", or "opt1|opt2|..." for selects.
   */
  param_schema?: Record<string, string>;
}

// =============================================================================
// Model Config
// =============================================================================

/**
 * LLM model configuration.
 * Groups model identifier and provider into a single nested object.
 */
export interface ModelConfig {
  id: string; // LLM model identifier (e.g., 'claude-sonnet-4-20250514')
  provider: string; // LLM provider (anthropic-claude, openai, azure-openai, aws-bedrock, etc.)
}

// =============================================================================
// Dynamic Agent Types
// =============================================================================

/**
 * Reference to another dynamic agent to use as a subagent.
 * When configured, the parent agent can delegate tasks to this subagent.
 */
export interface SubAgentRef {
  agent_id: string; // MongoDB ObjectId of the subagent
  name: string; // Routing identifier (e.g., 'code-reviewer')
  description: string; // Description for LLM routing decisions
}

/**
 * Per-tool interrupt configuration for HITL approval workflows.
 * Controls what decisions a reviewer can make when a tool call is intercepted.
 */
export type DecisionType = "approve" | "edit" | "reject";

export interface InterruptToolConfig {
  allowed_decisions: DecisionType[];
}

/**
 * Interrupt configuration: namespace -> { tool_name: true | InterruptToolConfig }
 * "builtin" is the reserved namespace for built-in tools (no server prefix).
 * Tool name "*" means all tools in that namespace.
 * `true` is shorthand for { allowed_decisions: ["approve", "edit", "reject"] }.
 */
export type InterruptOn = Record<
  string,
  Record<string, boolean | InterruptToolConfig>
>;

/**
 * SSE interrupt payload — discriminated union by `type`.
 */
export interface FormInputInterrupt {
  type: "form_input";
  interrupt_id: string;
  prompt: string;
  fields: Array<{
    field_name: string;
    field_type: string;
    description?: string;
    required?: boolean;
    options?: string[];
  }>;
  agent: string;
}

export interface ToolApprovalInterrupt {
  type: "tool_approval";
  interrupt_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  allowed_decisions: DecisionType[];
  agent: string;
  /** Multiple tool calls needing approval (when LLM batches gated tools) */
  tool_approvals?: Array<{
    tool_name: string;
    tool_args: Record<string, unknown>;
    tool_call_id: string;
    allowed_decisions: string[];
  }>;
}

export type InterruptPayload = FormInputInterrupt | ToolApprovalInterrupt;

/**
 * Resume data sent to POST /chat/stream/resume — discriminated union by `type`.
 */
export type ResumeData =
  | { type: "form_input"; values: Record<string, unknown> }
  | { type: "form_input"; dismissed: true }
  | { type: "tool_approval"; decision: "approve" }
  | { type: "tool_approval"; decision: "reject" }
  | {
      type: "tool_approval";
      decision: "edit";
      edited_args: Record<string, unknown>;
    }
  | {
      type: "tool_approval";
      decisions: Array<{
        decision: string;
        tool_name?: string;
        edited_args?: Record<string, unknown>;
      }>;
    };

export interface DynamicAgentConfig {
  _id: string;
  name: string;
  description?: string;
  system_prompt: string;
  allowed_tools: Record<string, string[] | boolean>; // server_id -> tool names, true=all, false=disabled
  builtin_tools?: BuiltinToolsConfig; // Built-in tools configuration
  model: ModelConfig; // Required: LLM model configuration
  visibility: VisibilityType;
  shared_with_teams?: string[];
  subagents: SubAgentRef[]; // Other dynamic agents that can be delegated to
  skills: string[]; // Skill document IDs from agent_skills collection
  /**
   * RAG datasource ids (== source_id == knowledge_base_id) this agent's
   * search tool is pinned to. Narrows, never widens: the runtime intersects
   * this list with the caller's RBAC-accessible datasources, so leaving it
   * unset preserves the legacy "search everything the caller can see"
   * behavior; an explicit empty list disables RAG tools. Populated from the
   * owning team's visible datasources.
   */
  datasource_ids?: string[];
  /**
   * RAG collection ids expanded to their current datasource membership at
   * tool-call time. This keeps delegated collections automatically updated
   * without rewriting every agent whenever a maintainer adds/removes a source.
   */
  rag_collection_ids?: string[];
  ui?: AgentUIConfig; // UI configuration (gradient theme, etc.)
  features?: FeaturesConfig; // Middleware and feature flags
  interrupt_on?: InterruptOn; // Tools requiring human approval before execution
  enabled: boolean;
  owner_id: string;
  owner_subject?: string;
  /**
   * Every dynamic agent is owned by a team (visibility was either `team`
   * or `global`). `owner_team_slug` is the source of truth; `owner_team_id`
   * is the matching Mongo ObjectId string for legacy lookups. Both are
   * effectively required from 2026-05-22 onward — the BFF rejects writes
   * that omit them. They remain optional on the type only so the legacy
   * coercion path (`normalizeLegacyVisibility`) can flag drift.
   */
  owner_team_slug?: string;
  owner_team_id?: string;
  is_system: boolean;
  config_driven?: boolean; // Whether loaded from config.yaml (not editable)
  /**
   * Set by the "Import from YAML" admin flow. Once true, seed-config.ts's
   * seedAgents()/cleanupStaleConfigDriven() skip this agent ID entirely —
   * the YAML seed file becomes a no-op for it, even if the entry is still
   * present there. Lets an imported agent's `config_driven` flag flip to
   * `false` (making it editable/deletable in the UI) without being wiped
   * or resurrected on the next server restart.
   */
  config_import_adopted?: boolean;
  /** Compact AI Review verdict from the last save. Drives the Grade column
   *  in the agent list. Optional — agents created before AI Review was wired
   *  up have this missing. */
  last_review?: import("./ai-review").LastReview;
  created_at: string;
  updated_at: string;
}

/** Per-row OpenFGA decisions returned by GET /api/dynamic-agents (batch-checked). */
export interface AgentRowPermissions {
  can_manage: boolean;
  can_write: boolean;
  can_discover: boolean;
}

export interface DynamicAgentConfigWithPermissions extends DynamicAgentConfig {
  permissions: AgentRowPermissions;
}

export interface DynamicAgentConfigCreate {
  id: string; // Required: User-friendly slug ID derived from name
  name: string;
  description?: string;
  system_prompt: string;
  allowed_tools?: Record<string, string[] | boolean>;
  builtin_tools?: BuiltinToolsConfig;
  model: ModelConfig; // Required: LLM model configuration
  /** Accepts legacy `'private'` for back-compat; the BFF coerces it to `'team'`. */
  visibility?: LegacyVisibilityType;
  shared_with_teams?: string[];
  /** Required for the new contract. */
  owner_team_slug?: string;
  owner_team_id?: string;
  subagents?: SubAgentRef[];
  skills?: string[];
  datasource_ids?: string[];
  rag_collection_ids?: string[];
  ui?: AgentUIConfig;
  features?: FeaturesConfig;
  interrupt_on?: InterruptOn;
  enabled?: boolean;
  last_review?: import("./ai-review").LastReview;
}

export interface DynamicAgentConfigUpdate {
  name?: string;
  description?: string;
  system_prompt?: string;
  allowed_tools?: Record<string, string[] | boolean>;
  builtin_tools?: BuiltinToolsConfig;
  model?: ModelConfig;
  /** Accepts legacy `'private'` for back-compat; the BFF coerces it to `'team'`. */
  visibility?: LegacyVisibilityType;
  /** Updates may move the agent to a different owner team. */
  owner_team_slug?: string;
  owner_team_id?: string;
  shared_with_teams?: string[];
  subagents?: SubAgentRef[];
  skills?: string[];
  datasource_ids?: string[];
  rag_collection_ids?: string[];
  ui?: AgentUIConfig;
  features?: FeaturesConfig;
  interrupt_on?: InterruptOn;
  enabled?: boolean;
  last_review?: import("./ai-review").LastReview;
}

/**
 * Available agent for subagent selection (returned by available-subagents endpoint)
 */
export interface AvailableSubagent {
  id: string;
  name: string;
  description?: string;
  visibility: VisibilityType;
  gradient_theme?: string;
  custom_theme_config?: CustomThemeConfig;
}

// =============================================================================
// LLM Model Types
// =============================================================================

export interface LLMModelConfig {
  _id: string; // model_id
  model_id: string;
  name: string;
  provider: string;
  description?: string;
  config_driven?: boolean; // Whether loaded from config.yaml (not editable)
  owner_subject?: string;
  owner_id?: string;
  updated_at: string;
}

export interface LLMModelCreate {
  model_id: string; // Unique model identifier (e.g., "gpt-4o")
  name: string;
  provider: string;
  description?: string;
}

export interface LLMModelUpdate {
  name?: string;
  provider?: string;
  description?: string;
}

// =============================================================================
// Chat Types
// =============================================================================

export interface ChatRequest {
  message: string;
  conversation_id: string;
  agent_id: string;
}

export interface ChatEvent {
  type: "content" | "tool_start" | "tool_end" | "error" | "done";
  data?: string | Record<string, unknown>;
}

// =============================================================================
// API Response Types
// =============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}
