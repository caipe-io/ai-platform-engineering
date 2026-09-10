"""Pydantic models for Dynamic Agents service."""

import logging
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger(__name__)


class TransportType(str, Enum):
    """MCP server transport types."""

    STDIO = "stdio"
    SSE = "sse"
    HTTP = "http"


class VisibilityType(str, Enum):
    """Agent visibility types."""

    PRIVATE = "private"
    TEAM = "team"
    GLOBAL = "global"


# =============================================================================
# User Context
# =============================================================================


class UserContext(BaseModel):
    """Authenticated user context.

    Only ``email`` is required.  Everything else is opaque — callers may
    pass arbitrary fields (``is_admin``, ``groups``, ``can_view_admin``,
    etc.) and they will be stored and accessible as attributes via
    Pydantic's ``extra="allow"``.

    The ``user_info`` tool dumps all fields so agents can see whatever
    the gateway or auth layer chose to include.
    """

    model_config = ConfigDict(extra="allow")

    email: str
    name: str | None = None
    # Keycloak subject (UUID). OpenFGA/CAS key subjects by ``sub``, so this is
    # what agent-use authorization evaluates against. For autonomous
    # (unattended) runs the scheduler puts the task owner's sub here so the
    # decision is made on the owner, not the service principal.
    sub: str | None = None
    groups: list[str] = []
    is_admin: bool = False
    raw_claims: dict[str, Any] = {}
    access_token: str | None = Field(default=None, repr=False)
    obo_jwt: str | None = Field(default=None, repr=False)


# =============================================================================
# MCP Server Config
# =============================================================================


class MCPServerConfigBase(BaseModel):
    """Base fields for MCP server configuration."""

    name: str = Field(..., description="Display name")
    description: str | None = Field(None, description="Optional description")
    transport: TransportType = Field(..., description="Transport type")
    endpoint: str | None = Field(None, description="Server URL for sse/http transports")
    command: str | None = Field(None, description="Command for stdio transport")
    args: list[str] | None = Field(None, description="Args for stdio transport")
    env: dict[str, str] | None = Field(None, description="Env vars for stdio transport")
    enabled: bool = Field(True, description="Whether the server is enabled")
    credential_sources: list["MCPCredentialSource"] | None = Field(
        None,
        description="Server-side credential refs to resolve for MCP connections.",
    )


class MCPCredentialSource(BaseModel):
    """Credential source metadata for MCP server connection setup."""

    kind: Literal["secret_ref", "provider_connection", "caller_token"] = Field(
        ..., description="Credential source type"
    )
    target: Literal["env", "header"] = Field(..., description="Where to inject the resolved credential")
    name: str = Field(..., description="Environment variable or header name")
    secret_ref: str | None = Field(None, description="Credential secret_ref id")
    provider_connection_id: str | None = Field(None, description="Provider connection id")
    provider: str | None = Field(None, description="Provider key for JWT subject-owned provider connection")
    connection_scope: Literal["caller", "pinned"] | None = Field(
        None,
        description=(
            "DEPRECATED/ignored: pinned scope removed for security; all provider_connection "
            "sources are caller-scoped. Field retained for backward-compatible parsing of "
            "existing MongoDB documents that may still contain connection_scope='pinned'."
        ),
    )
    fallback_env: str | None = Field(
        None,
        description=(
            "Optional env var read when no per-user credential resolves (e.g. the caller "
            "has not connected this provider). Enables a static service-account fallback "
            "so shared-token MCP servers (GitHub/GitLab) stay backward compatible."
        ),
    )
    fallback_client_credentials: bool = Field(
        False,
        description=(
            "When true and no per-request user JWT is available (e.g. background "
            "reconcile/probe with no caller context), mint a service-to-service "
            "OAuth2 client-credentials token from Keycloak. Used by backends that "
            "enforce their own OIDC auth (e.g. the RAG knowledge-base) so they accept "
            "the caller's user JWT for per-user RBAC and a service token otherwise."
        ),
    )


class MCPServerConfig(MCPServerConfigBase):
    """Full MCP server config as stored in MongoDB."""

    id: str = Field(..., alias="_id", description="Unique slug ID")
    config_driven: bool = Field(False, description="Whether this server was loaded from config.yaml")
    source: Literal["manual", "config", "agentgateway"] | None = Field(
        None,
        description="Where this MCP server record came from.",
    )
    agentgateway_discovered: bool = Field(
        False,
        description="Whether this MCP server was discovered from AgentGateway.",
    )
    agentgateway_target_endpoint: str | None = Field(
        None,
        description="Upstream MCP endpoint behind the AgentGateway route.",
    )
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    model_config = {"populate_by_name": True}


class MCPServerProbeResult(BaseModel):
    """Result from probing an MCP server for tools."""

    server_id: str
    success: bool
    tools: list[dict] | None = None  # List of tool metadata
    error: str | None = None


# =============================================================================
# Model Config
# =============================================================================


class ModelConfig(BaseModel):
    """LLM model configuration.

    Groups ``id`` and ``provider`` into a single nested object, mirroring
    the pattern used by Claude's agent API.

    A ``model_validator(mode="before")`` on the parent config transparently
    migrates legacy ``model_id`` / ``model_provider`` top-level fields into
    this nested shape so existing MongoDB documents keep working.
    """

    id: str = Field(..., description="LLM model identifier (e.g., 'claude-sonnet-4-20250514')")
    provider: str = Field(..., description="LLM provider (anthropic-claude, openai, azure-openai, aws-bedrock, etc.)")


# =============================================================================
# Agent Backend Configuration
# =============================================================================

# Backend type constants
BACKEND_STATE = "state"
BACKEND_STORE = "store"
BACKEND_SANDBOX = "sandbox"


class AgentBackendConfig(BaseModel):
    """Backend-specific configuration options."""

    fs_ttl_seconds: int | None = Field(
        None,
        ge=0,
        description="Filesystem TTL in seconds. 0 = infinite. None = use server default.",
    )
    fs_namespace: list[str] | None = Field(
        None,
        min_length=3,
        max_length=3,
        description=(
            "Override filesystem namespace as [scope, id, 'filesystem']. "
            "Defaults to [agent_id, session_id, 'filesystem']. "
            "Used by workflow service to scope files to a workflow run."
        ),
    )
    checkpoint_collection: str | None = Field(
        None,
        description=(
            "Override checkpoint collection name for MongoDBSaver. "
            "Use 'workflow_checkpoints' for workflow steps to isolate from regular chat history. "
            "None = use server default collection."
        ),
    )
    checkpoint_ttl: int | None = Field(
        None,
        ge=0,
        description=(
            "TTL in seconds for checkpoint documents (MongoDBSaver ttl param). "
            "Creates a MongoDB TTL index that auto-expires documents. "
            "Only effective with a custom checkpoint_collection to avoid expiring regular chats. "
            "None = no TTL (checkpoints persist indefinitely)."
        ),
    )


class AgentBackend(BaseModel):
    """Agent backend configuration — controls filesystem storage strategy."""

    type: Literal["state", "store", "sandbox"] | None = Field(
        None,
        description="Backend type. None = use server default_runtime_backend.",
    )
    config: AgentBackendConfig | None = Field(
        None,
        description="Backend-specific config (TTL, etc.)",
    )


# =============================================================================
# SubAgent Reference
# =============================================================================


class SubAgentRef(BaseModel):
    """Reference to another dynamic agent to use as a subagent.

    When a dynamic agent has subagents configured, the deepagents framework
    automatically creates a `task` tool that the parent agent can use to
    delegate work. The LLM decides when to delegate based on the description.
    """

    agent_id: str = Field(..., description="MongoDB ObjectId of the subagent")
    name: str = Field(..., description="Routing identifier (e.g., 'code-reviewer')")
    description: str = Field(
        ...,
        description="Description for LLM routing decisions (e.g., 'Reviews code for bugs and best practices')",
    )


# =============================================================================
# Built-in Tools Config
# =============================================================================


class BuiltinToolConfigField(BaseModel):
    """Definition of a configurable field for a built-in tool."""

    name: str = Field(..., description="Field name (e.g., 'allowed_domains')")
    type: Literal["string", "number", "boolean"] = Field(..., description="Field type")
    label: str = Field(..., description="Display label for UI")
    description: str = Field(..., description="Help text for users")
    default: str | int | float | bool | None = Field(None, description="Default value")
    required: bool = Field(False, description="Whether the field is required")


class BuiltinToolDefinition(BaseModel):
    """Definition of a built-in tool for API discovery."""

    id: str = Field(..., description="Unique tool identifier (e.g., 'fetch_url')")
    name: str = Field(..., description="Display name")
    description: str = Field(..., description="What the tool does")
    enabled_by_default: bool = Field(True, description="Whether enabled by default for new agents")
    config_fields: list[BuiltinToolConfigField] = Field(
        default_factory=list,
        description="Configurable fields for this tool",
    )


class FetchUrlToolConfig(BaseModel):
    """Configuration for the fetch_url built-in tool."""

    enabled: bool = Field(False, description="Whether the tool is enabled")
    allowed_domains: str = Field(
        default="*",
        description=(
            "Comma-separated domain patterns. "
            "Use * for all, *.domain.com for subdomains, or exact domain. "
            "Empty string blocks all domains."
        ),
    )


class CurlToolConfig(BaseModel):
    """Configuration for the curl built-in tool."""

    enabled: bool = Field(False, description="Whether the tool is enabled")
    allowed_domains: str = Field(
        default="*",
        description=(
            "Comma-separated domain patterns. "
            "Use * for all, *.domain.com for subdomains, or exact domain. "
            "Empty string blocks all domains."
        ),
    )
    https_only: bool = Field(
        default=True,
        description="If True (default), reject non-https:// URLs.",
    )
    allow_non_public_urls: bool = Field(
        default=False,
        description="If True, allow URLs that resolve to private/internal IP addresses. Off by default (SSRF protection).",
    )


class CurrentDatetimeToolConfig(BaseModel):
    """Configuration for the current_datetime built-in tool."""

    enabled: bool = Field(True, description="Whether the tool is enabled")


class UserInfoToolConfig(BaseModel):
    """Configuration for the user_info built-in tool."""

    enabled: bool = Field(True, description="Whether the tool is enabled")


class WaitToolConfig(BaseModel):
    """Configuration for the wait built-in tool."""

    enabled: bool = Field(True, description="Whether the tool is enabled")
    max_seconds: int = Field(
        300,
        description="Maximum wait duration in seconds",
        ge=1,
        le=3600,
    )


class RequestUserInputToolConfig(BaseModel):
    """Configuration for the request_user_input built-in tool."""

    enabled: bool = Field(True, description="Whether the tool is enabled")


class SelfIdentityToolConfig(BaseModel):
    """Configuration for the self_identity built-in tool."""

    enabled: bool = Field(True, description="Whether the tool is enabled")


class BuiltinToolsConfig(BaseModel):
    """Configuration for built-in tools available to dynamic agents."""

    model_config = ConfigDict(populate_by_name=True)

    fetch_url: FetchUrlToolConfig | None = Field(
        None,
        description="Configuration for the fetch_url tool (fetches content from URLs)",
    )
    curl: CurlToolConfig | None = Field(
        None,
        description="Configuration for the curl tool (HTTP requests including PUT/POST/PATCH/DELETE)",
    )
    current_datetime: CurrentDatetimeToolConfig | None = Field(
        None,
        description="Configuration for the current_datetime tool (returns current date/time)",
    )
    user_info: UserInfoToolConfig | None = Field(
        None,
        description="Configuration for the user_info tool (returns info about the current user)",
    )
    wait: WaitToolConfig | None = Field(
        None,
        description="Configuration for the wait tool (pauses execution)",
    )
    request_user_input: RequestUserInputToolConfig | None = Field(
        None,
        description="Configuration for the request_user_input tool (requests structured input from user)",
    )
    self_identity: SelfIdentityToolConfig | None = Field(
        None,
        alias="agent_info",
        description="Configuration for the self_identity tool (returns this agent's identity)",
    )
    workflows: list[str] | None = Field(
        None,
        description="List of workflow config IDs this agent can interact with. "
        "When set, adds list_workflow_runs, get_workflow_run_status, and start_workflow_run tools.",
    )

    @model_validator(mode="before")
    @classmethod
    def _migrate_sleep_to_wait(cls, data: Any) -> Any:
        """Backward-compat: migrate legacy ``sleep`` field to ``wait``.

        Existing MongoDB documents may still contain ``builtin_tools.sleep``
        from before the rename.  This validator transparently migrates them
        so the rest of the codebase only needs to know about ``wait``.
        """
        if isinstance(data, dict) and "sleep" in data:
            if "wait" not in data or data["wait"] is None:
                data["wait"] = data.pop("sleep")
                logger.warning("Migrated deprecated 'builtin_tools.sleep' → 'wait'")
            else:
                # Both present — drop the legacy field, keep explicit 'wait'
                data.pop("sleep")
                logger.warning("Dropped deprecated 'builtin_tools.sleep' (explicit 'wait' already set)")
        return data


# =============================================================================
# HITL Input Fields (for request_user_input tool)
# =============================================================================


class InputFieldType(str, Enum):
    """Field types for user input forms."""

    TEXT = "text"
    SELECT = "select"
    MULTISELECT = "multiselect"
    BOOLEAN = "boolean"
    NUMBER = "number"
    URL = "url"
    EMAIL = "email"


class InputField(BaseModel):
    """Definition of an input field for user forms.

    Used by the request_user_input tool to define form fields.
    Matches the InputField interface in the UI's MetadataInputForm component.
    """

    field_name: str = Field(..., description="Unique field identifier (snake_case)")
    field_label: str | None = Field(None, description="Display label (auto-generated from field_name if not provided)")
    field_description: str | None = Field(None, description="Help text shown below the field")
    field_type: InputFieldType = Field(InputFieldType.TEXT, description="Type of input control")
    field_values: list[str] | None = Field(None, description="Options for select/multiselect fields")
    required: bool = Field(False, description="Whether the field is required")
    default_value: str | None = Field(None, description="Pre-populated default value")
    placeholder: str | None = Field(None, description="Placeholder text for text inputs")
    value: str | None = Field(None, description="User-provided value (populated when form is submitted)")


# =============================================================================
# Agent UI Config
# =============================================================================


class AgentUIConfig(BaseModel):
    """UI configuration for dynamic agents."""

    gradient_theme: str | None = Field(
        None,
        description="Gradient theme ID for agent avatar (e.g., 'ocean', 'sunset'). None uses global theme.",
    )


# =============================================================================
# Features / Middleware Config
# =============================================================================


class MiddlewareEntry(BaseModel):
    """A single middleware in the agent's middleware stack.

    Entries are ordered — the list defines execution order.
    Some middleware types allow multiple instances (e.g. ``pii`` for
    different PII types, ``tool_call_limit`` for per-tool limits);
    others are singletons (e.g. ``model_retry``).
    """

    type: str = Field(..., description="Middleware type key (e.g. 'model_retry', 'pii')")
    enabled: bool = Field(True, description="Whether this middleware is active")
    params: dict[str, Any] = Field(
        default_factory=dict,
        description="Middleware-specific parameters (merged over defaults)",
    )


class FeaturesConfig(BaseModel):
    """Agent feature flags and middleware configuration.

    When absent from MongoDB (``features`` is None on the agent config),
    all default-enabled middleware are applied with their default params.
    No migration script needed.

    The middleware list is ordered and may contain multiple entries of the
    same type where the registry allows it.
    """

    middleware: list[MiddlewareEntry] = Field(
        default_factory=list,
        description="Ordered list of middleware entries",
    )


# =============================================================================
# Dynamic Agent Config
# =============================================================================


class InterruptConfig(BaseModel):
    """Per-tool interrupt configuration for HITL workflows.

    Controls what decisions a human reviewer can make when a tool call
    is intercepted.  See deepagents docs: human-in-the-loop.
    """

    allowed_decisions: list[str] = Field(
        default=["approve", "edit", "reject"],
        description="Decisions the reviewer is allowed to make",
    )


class DynamicAgentConfigBase(BaseModel):
    """Base fields for dynamic agent configuration."""

    name: str = Field(..., description="Display name")
    description: str | None = Field(None, description="Optional description")
    system_prompt: str = Field(..., description="Main system prompt / instructions")
    allowed_tools: dict[str, list[str] | bool] = Field(
        default_factory=dict,
        description=(
            "Map of server_id -> tool names or boolean. "
            "true = all tools from server, false = server disabled, "
            "list = specific tools only, [] = legacy (treated as true)"
        ),
    )
    model: ModelConfig = Field(..., description="LLM model configuration (id + provider)")
    visibility: VisibilityType = Field(VisibilityType.PRIVATE, description="Visibility scope")
    shared_with_teams: list[str] | None = Field(None, description="Team IDs when visibility=team")
    subagents: list[SubAgentRef] = Field(
        default_factory=list,
        description="Other dynamic agents that can be delegated to as subagents",
    )
    skills: list[str] = Field(
        default_factory=list,
        description="Skill document IDs from agent_skills collection",
    )
    datasource_ids: list[str] | None = Field(
        None,
        description=(
            "RAG datasource ids (== source_id == knowledge_base_id) this agent's "
            "search tool is pinned to. Narrows, never widens: the runtime "
            "intersects this list with the caller's RBAC-accessible datasources, "
            "so None preserves the legacy 'search everything the caller can see' "
            "behavior, while an explicit empty list keeps RAG tools available "
            "with no indexed content in scope."
        ),
    )
    rag_collection_ids: list[str] | None = Field(
        None,
        description=(
            "RAG collection ids expanded from MongoDB at tool-call time. "
            "The resulting datasource ids are unioned with datasource_ids; "
            "the RAG server still intersects them with caller authorization."
        ),
    )
    builtin_tools: BuiltinToolsConfig | None = Field(
        None,
        description="Configuration for built-in tools (fetch_url, etc.)",
    )
    ui: AgentUIConfig | None = Field(
        None,
        description="UI configuration (gradient theme, etc.)",
    )
    features: FeaturesConfig | None = Field(
        None,
        description="Feature flags and middleware configuration. None = apply defaults.",
    )
    enabled: bool = Field(True, description="Whether the agent is active")
    interrupt_on: dict[str, dict[str, bool | InterruptConfig]] = Field(
        default_factory=lambda: {"builtin": {"request_user_input": True}},
        description=(
            "Tools that require human approval before execution. "
            "Map of server_id -> {tool_name: config}. "
            "Use 'builtin' as server_id for built-in tools (no namespace prefix)."
        ),
    )
    backend: AgentBackend | None = Field(
        None,
        description="Backend configuration (storage type, TTL). None = use server defaults.",
    )

    @model_validator(mode="before")
    @classmethod
    def _migrate_model_fields(cls, data: Any) -> Any:
        """Backward-compat: migrate legacy ``model_id``/``model_provider`` to ``model``.

        Existing MongoDB documents store these as top-level fields.  This
        validator transparently nests them so the rest of the codebase only
        needs ``config.model.id`` / ``config.model.provider``.
        """
        if isinstance(data, dict) and "model_id" in data and "model" not in data:
            data["model"] = {
                "id": data.pop("model_id"),
                "provider": data.pop("model_provider", "unknown"),
            }
        return data


class DynamicAgentConfig(DynamicAgentConfigBase):
    """Full dynamic agent config as stored in MongoDB."""

    id: str = Field(..., alias="_id", description="Unique ID")
    owner_id: str = Field(..., description="Creator's email")
    is_system: bool = Field(False, description="System-provided agent (non-deletable)")
    config_driven: bool = Field(False, description="Whether this agent was loaded from config.yaml")
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    model_config = {"populate_by_name": True}


# =============================================================================
# Chat Request/Response
# =============================================================================


class ClientContext(BaseModel):
    """Opaque client context passed through to system prompt rendering.

    Only ``source`` is required. Clients send arbitrary extra fields
    (e.g. overthink, channel_type) which agent system prompts can
    reference via Jinja2 conditionals like ``{% if client_context.overthink %}``.
    """

    source: str = Field(..., description="Client identifier, e.g. 'slack', 'webui'")

    model_config = ConfigDict(extra="allow")


class InputFile(BaseModel):
    """A file attached to a chat message (e.g. an uploaded image or document).

    Carries either inline base64-encoded bytes (``data``) or a reference
    ``uri``. ``mime_type`` is required so the runtime can build the correct
    multimodal content block (image or document) for the LLM.
    """

    mime_type: str = Field(..., description="IANA media type, e.g. 'image/png' or 'application/pdf'")
    data: str | None = Field(None, description="Base64-encoded file bytes")
    uri: str | None = Field(None, description="URI reference to the file")
    name: str | None = Field(None, description="Original filename, if known")

    @model_validator(mode="after")
    def _require_data_or_uri(self) -> "InputFile":
        if not self.data and not self.uri:
            raise ValueError("InputFile requires either 'data' (base64) or 'uri'")
        return self


class ChatRequest(BaseModel):
    """Request to chat with a dynamic agent."""

    message: str = Field(..., description="User message")
    files: list[InputFile] | None = Field(
        None,
        description="Optional files attached to the message (uploaded images or documents) for multimodal input",
    )
    conversation_id: str = Field(..., description="Conversation/session ID")
    agent_id: str = Field(..., description="Dynamic agent config ID")
    protocol: str = Field("custom", pattern=r"^(custom|agui)$", description="Wire protocol: 'custom' or 'agui'")
    trace_id: str | None = Field(None, description="Optional trace ID for Langfuse tracing")
    autonomous: bool = Field(
        False,
        description=(
            "True when the scheduler/webhook runtime drives this call unattended. "
            "Requires autonomous team entitlement in addition to agent use access."
        ),
    )
    client_context: ClientContext | None = Field(None, description="Opaque client context for system prompt rendering")
    config_override: dict | None = Field(
        None,
        description=(
            "Override agent config fields for this request. "
            "Supported: system_prompt, allowed_tools, model, builtin_tools, "
            "interrupt_on, subagents, skills, features, backend. "
            "Ignored: ui, name, description, owner_id, visibility, enabled, is_system, config_driven."
        ),
    )
    workflow_config_id: str | None = Field(
        None,
        description=(
            "When set, agent use may be delegated from workflow execution: the caller "
            "must be allowed to run this workflow and the agent must appear in its steps."
        ),
    )


# =============================================================================
# Agent Context (passed to deepagents)
# =============================================================================


class AgentContext(BaseModel):
    """Context schema passed to deepagents via context_schema."""

    user_id: str
    user_name: str | None = None
    user_groups: list[str] = []
    agent_config_id: str
    session_id: str
    obo_jwt: str | None = None


# =============================================================================
# API Response Wrappers
# =============================================================================


class ApiResponse(BaseModel):
    """Standard API response wrapper."""

    success: bool = True
    data: dict | list | None = None
    error: str | None = None
