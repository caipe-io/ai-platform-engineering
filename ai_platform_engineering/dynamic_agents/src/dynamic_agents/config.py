"""Configuration settings for Dynamic Agents service."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables.

    Tracing (Langfuse) Configuration:
        The following environment variables are read by cnoe-agent-utils.TracingManager
        to enable Langfuse tracing for LLM calls and agent execution:

        - ENABLE_TRACING: Set to "true" to enable tracing (default: disabled)
        - LANGFUSE_PUBLIC_KEY: Langfuse project public key (e.g., "pk-lf-xxx")
        - LANGFUSE_SECRET_KEY: Langfuse project secret key (e.g., "sk-lf-xxx")
        - LANGFUSE_HOST: Langfuse server URL (e.g., "http://langfuse-web:3000")

        When enabled, traces are grouped by session_id (conversation) and include:
        - LLM inputs/outputs with token counts
        - Tool calls as nested spans
        - Agent metadata (name, config_id, user_id)
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Server
    host: str = "0.0.0.0"
    port: int = 8001
    debug: bool = False

    # Metrics
    # Port for the /metrics endpoint. When 0 (default) or equal to `port`,
    # metrics are served on the main API port (current behavior, unchanged).
    # Set to a different port to serve metrics on a dedicated port — e.g. to
    # keep the main API port on strict mTLS while leaving the metrics port in
    # mTLS-permissive mode for scrapers that don't support mTLS client certs.
    metrics_port: int = 0

    # MongoDB
    # Full URI takes precedence; if not set, built from components
    mongodb_uri: str = "mongodb://localhost:27017"
    mongodb_database: str = "caipe"

    # Collections
    dynamic_agents_collection: str = "dynamic_agents"
    mcp_servers_collection: str = "mcp_servers"
    # CORS
    cors_origins: list[str] = ["*"]

    # Checkpointer collections
    checkpoint_collection: str = "checkpoints_conversation"
    checkpoint_writes_collection: str = "checkpoint_writes_conversation"

    # GridFS store (for agent file storage outside checkpoints)
    gridfs_bucket_name: str = "agent_files"
    # User memory is isolated in a dedicated, non-expiring bucket.
    memory_gridfs_bucket_name: str = "agent_memory"
    memory_max_file_chars: int = 8000
    # Deployment default for the platform-wide Projects capability. An admin
    # override in platform_config.projects.enabled takes precedence.
    projects_enabled: bool = False

    # Runtime backend: "store" = GridFS-backed filesystem, "state" = in-checkpoint
    default_runtime_backend: str = "store"
    # Default TTL for filesystem documents (0 = infinite, never expires)
    default_fs_ttl_seconds: int = 21600  # 6 hours
    # Maximum allowed TTL (0 = no cap, infinite allowed)
    max_fs_ttl_seconds: int = 0

    # /invoke endpoint persistence
    # When False (default), each /invoke call uses an ephemeral in-memory runtime that is
    # discarded after the request — no MongoDB writes, no conversation history across calls.
    # Set to True to use the shared MongoDB-backed runtime cache, enabling multi-turn
    # conversation history via /invoke at the cost of additional MongoDB load.
    invoke_persist_history: bool = False

    # Runtime
    agent_runtime_ttl_seconds: int = 300  # 5m inactivity TTL for agent runtimes
    # Max concurrent cached runtimes. Each costs ~15-20MB (with shared clients).
    # Recommendation: (pod_memory_mb - 150) / 20, e.g. 512MB pod → 18 runtimes.
    agent_runtime_max_cache_size: int = 20

    # Seed configuration path (for MCP servers and agents loaded at startup)
    seed_config_path: str | None = None

    # When set, MCP HTTP/SSE clients use this base URL (e.g. http://agentgateway:4000/mcp/{server_id})
    agent_gateway_url: str | None = None

    # CAIPE credential service API used when USE_IMPERSONATION_TOKENS=true.
    credential_api_url: str | None = None
    credential_service_audience: str = "caipe-credential-service"

    # CAIPE UI server base URL used by workflow tools to call back into the
    # CAIPE API (e.g. trigger a workflow run, fetch run status).
    # Example: "http://caipe-ui:3000" (in-cluster) or "https://caipe.example.com".
    # Required when any agent has builtin_tools.workflows configured.
    caipe_api_url: str = ""

    # OAuth2 Client Credentials flow — used by workflow tools to obtain a
    # short-lived service token before calling caipe_api_url.
    # oauth2_token_url:     OIDC token endpoint (e.g. /realms/{realm}/protocol/openid-connect/token)
    # oauth2_client_id:     service-account client ID
    # oauth2_client_secret: service-account client secret (injected via ExternalSecret)
    # oauth2_scope:         requested scopes (space-separated; leave empty to use defaults)
    # oauth2_audience:      token audience claim (leave empty to use defaults)
    oauth2_token_url: str = ""
    oauth2_client_id: str = ""
    oauth2_client_secret: str = ""
    oauth2_scope: str = ""
    oauth2_audience: str = ""

    # Per-model input-capability overrides (env: MODEL_CAPABILITIES_JSON). JSON object
    # mapping model id (or family prefix) to accepted modalities, e.g.
    # '{"some-text-only-model": {"accepts_images": false}}'. Merged over the
    # seed defaults in services/model_capabilities.py; malformed JSON is ignored.
    # This is the values-driven seam for declaring per-model file acceptance
    # from Helm values without a code change.
    model_capabilities_json: str = ""

    # Input-attachment guardrails (env: MAX_INPUT_FILES / MAX_INPUT_FILE_BYTES /
    # MAX_INPUT_TURN_BYTES). Attached files ride inline as base64 in the user
    # turn, which is checkpointed to MongoDB — an unbounded set of large files
    # inflates the checkpoint and can breach Mongo's 16MB per-document cap. These
    # caps drop the overflow gracefully (the drop is surfaced to the user and to
    # the model) rather than failing the write. A value of 0 disables that guard
    # (unlimited), so ops can tune per-env from Helm without a code change.
    max_input_files: int = 10
    max_input_file_bytes: int = 5 * 1024 * 1024  # 5 MiB per file
    max_input_turn_bytes: int = 20 * 1024 * 1024  # 20 MiB total per turn

    # Attachment blob store (env: ATTACHMENT_BACKEND / ATTACHMENT_LOCAL_PATH /
    # ATTACHMENT_S3_BUCKET / ATTACHMENT_S3_PREFIX / ATTACHMENT_S3_REGION /
    # ATTACHMENT_S3_ENDPOINT_URL). Attachment bytes are stored once, content-
    # addressed, in this backend; only a reference is persisted in the MongoDB
    # checkpoint, and the rehydration middleware fetches the bytes back into the
    # model request at inference time. "local" (default) writes to disk — works
    # out of the box for docker-compose dev; "s3" uses the shared bucket via
    # ambient (IRSA) credentials. Mirrors the audit-service storage config shape.
    attachment_backend: str = "local"
    attachment_local_path: str = "/var/lib/caipe-attachments"
    attachment_s3_bucket: str = ""
    attachment_s3_prefix: str = "attachments"
    attachment_s3_region: str = "us-west-2"
    attachment_s3_endpoint_url: str | None = None


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
