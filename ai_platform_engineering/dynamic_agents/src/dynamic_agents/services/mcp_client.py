"""MCP Client wrapper for Dynamic Agents."""

import asyncio
import base64
import copy
import hashlib
import hmac
import json
import logging
import os
import random
import re
import ssl
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx
from langchain_core.tools import BaseTool, StructuredTool
from langchain_mcp_adapters.client import MultiServerMCPClient

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.config import get_settings
from dynamic_agents.models import MCPServerConfig, TransportType
from dynamic_agents.services.credential_exchange import CredentialExchangeClient
from dynamic_agents.services.mcp_endpoint_normalizer import (
    normalize_mcp_endpoint_for_server,
)

logger = logging.getLogger(__name__)


CALLER_PROVIDER_NOT_CONNECTED = "caller_provider_not_connected"
TOP_LEVEL_UNION_SCHEMA_KEYS = ("oneOf", "anyOf", "allOf")

_PROVIDER_DISPLAY_NAMES: dict[str, str] = {
    "atlassian": "Atlassian",
    "github": "GitHub",
    "gitlab": "GitLab",
    "pagerduty": "PagerDuty",
    "webex": "Webex",
}


class McpCredentialUnavailableError(RuntimeError):
    """MCP credential could not be resolved for this server/caller."""

    def __init__(
        self,
        message: str,
        *,
        reason: str = "mcp_credential_unavailable",
        provider: str | None = None,
        server_id: str | None = None,
        server_name: str | None = None,
    ) -> None:
        super().__init__(message)
        self.reason = reason
        self.provider = provider
        self.server_id = server_id
        self.server_name = server_name


def mcp_credential_connect_warning(error: McpCredentialUnavailableError) -> str:
    """Build a user-facing warning when a caller-scoped provider is not connected."""
    server_label = error.server_name or error.server_id or "MCP server"
    provider = error.provider or "provider"
    provider_label = _PROVIDER_DISPLAY_NAMES.get(provider, provider.replace("_", " ").title())
    if error.reason == CALLER_PROVIDER_NOT_CONNECTED:
        return (
            f"{server_label} needs your {provider_label} account connected. "
            f"[Connect {provider_label}](/credentials?tab=connections) — then start a new chat."
        )
    return str(error)


@dataclass
class McpCredentialResolutionResult:
    """Credential resolution output: connectable servers and structured failures."""

    connections: dict[str, dict[str, Any]]
    failures: dict[str, McpCredentialUnavailableError] = field(default_factory=dict)


def _agent_gateway_base_url() -> str | None:
    """Resolve the AgentGateway base URL from env.

    Returns the origin (e.g. ``http://agentgateway:4000``) without a
    ``/mcp`` suffix. ``None`` when no override is set — in that case the
    normaliser has no anchor and self-heal is a no-op.
    """
    raw = (os.getenv("AGENT_GATEWAY_URL") or os.getenv("AGENTGATEWAY_URL") or "").strip()
    if not raw:
        return None
    # Tolerate operators who set the URL with or without `/mcp`. The
    # normaliser only matches on origin, but having a clean base keeps
    # log lines readable.
    return raw[: -len("/mcp")] if raw.rstrip("/").endswith("/mcp") else raw.rstrip("/")


def _is_agentgateway_endpoint(endpoint: str | None, base_url: str | None) -> bool:
    if not endpoint or not base_url:
        return False
    endpoint = endpoint.rstrip("/")
    base = base_url.rstrip("/")
    if base.endswith("/mcp"):
        base = base[: -len("/mcp")]
    return endpoint == base or endpoint.startswith(f"{base}/mcp")


def _is_gateway_managed_server(server: MCPServerConfig, base_url: str | None) -> bool:
    """Return true when an MCP row has a corresponding AgentGateway route."""

    return (
        server.source == "agentgateway"
        or server.agentgateway_discovered
        or _is_agentgateway_endpoint(server.endpoint, base_url)
    )


def _heal_endpoint(server: MCPServerConfig) -> str | None:
    """Self-heal stale AgentGateway endpoints at read time.

    Background: ``POST/PUT /api/mcp-servers`` (BFF) now normalises
    endpoints on save, but Mongo can still hold legacy rows where an
    admin saved ``http://agentgateway:4000/mcp`` (the bare base) instead
    of ``http://agentgateway:4000/mcp/<id>``. Those rows produce
    ``HTTP 404 Not Found from http://agentgateway:4000/mcp`` on every
    probe and tool call because AgentGateway routes by path prefix.

    Self-healing here means probe/runtime works even before the legacy
    row is repaired in Mongo (via the repair script or by re-saving).
    """
    base = _agent_gateway_base_url()
    if not base:
        return server.endpoint
    return normalize_mcp_endpoint_for_server(server.endpoint, server.id, base)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def build_agent_context_headers(agent_id: str, *, now: int | None = None) -> dict[str, str]:
    """Build signed AgentGateway context headers for per-agent tool policy.

    The bridge only trusts this context when both Dynamic Agents and the bridge
    share ``CAIPE_AGENT_CONTEXT_HMAC_SECRET``. Without that secret we omit the
    headers and the gateway falls back to coarse user-level authorization.
    """
    secret = os.getenv("CAIPE_AGENT_CONTEXT_HMAC_SECRET", "").strip()
    if not secret:
        return {}
    issued_at = int(now if now is not None else time.time())
    payload = {
        "agent_id": agent_id,
        "iat": issued_at,
        "exp": issued_at + 300,
    }
    encoded = _b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    signature = hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).hexdigest()
    return {
        "X-CAIPE-Agent-Context": encoded,
        "X-CAIPE-Agent-Context-Signature": signature,
    }


def warn_if_agent_gateway_missing_hmac() -> None:
    """Log when AgentGateway routing is enabled without the shared HMAC secret."""
    gateway_url = _agent_gateway_base_url()
    if not gateway_url:
        return
    if os.getenv("CAIPE_AGENT_CONTEXT_HMAC_SECRET", "").strip():
        return
    logger.warning(
        "AGENT_GATEWAY_URL is set (%s) but CAIPE_AGENT_CONTEXT_HMAC_SECRET is unset; "
        "AgentGateway will enforce only coarse mcp_gateway:list checks and per-agent "
        "tool calls may 403. Set the same shared secret on dynamic-agents and "
        "openfga-authz-bridge.",
        gateway_url,
    )


def build_httpx_client_factory(agent_id: str | None = None) -> Callable[..., httpx.AsyncClient]:
    """Build an httpx.AsyncClient factory that injects per-request CAIPE auth.

    Spec 102 Phase 8 / T106. Each MCP HTTP connection opened by
    ``langchain-mcp-adapters`` calls this factory, which reads
    ``current_user_token`` (set by ``JwtAuthMiddleware``) and forwards
    it as ``Authorization: Bearer <token>``. This is the fix for the
    live HTTP 401 from agentgateway because the runtime no longer relies
    on the (token-less) X-User-Context header for outbound auth. The signed
    agent context is also generated here, not in the long-lived connection
    config, so resumed conversations do not reuse an expired context header.

    Honors ``CUSTOM_CA_BUNDLE`` / ``REQUESTS_CA_BUNDLE`` /
    ``SSL_CERT_FILE`` and ``SSL_VERIFY=false``.
    """
    ca_bundle = (
        os.getenv("CUSTOM_CA_BUNDLE")
        or os.getenv("REQUESTS_CA_BUNDLE")
        or os.getenv("SSL_CERT_FILE")
    )
    ssl_verify = os.getenv("SSL_VERIFY", "true").lower()
    if ca_bundle and os.path.exists(ca_bundle):
        verify: Any = ssl.create_default_context(cafile=ca_bundle)
    elif ssl_verify == "false":
        logger.warning(
            "SSL_VERIFY=false: disabling TLS verification for MCP HTTP transport. "
            "Insecure; dev only."
        )
        verify = False
    else:
        verify = True

    def _factory(
        headers: dict[str, str] | None = None,
        timeout: httpx.Timeout | None = None,
        auth: httpx.Auth | None = None,
    ) -> httpx.AsyncClient:
        merged = dict(headers or {})
        token = current_user_token.get()
        has_authorization = any(key.lower() == "authorization" for key in merged)
        if token and not has_authorization:
            merged["Authorization"] = f"Bearer {token}"
        if agent_id:
            for key in list(merged):
                if key.lower() in (
                    "x-caipe-agent-context",
                    "x-caipe-agent-context-signature",
                ):
                    del merged[key]
            merged.update(build_agent_context_headers(agent_id))
        return httpx.AsyncClient(
            headers=merged,
            timeout=timeout or httpx.Timeout(30.0),
            auth=auth,
            verify=verify,
        )

    return _factory


def build_mcp_connection_config(
    server: MCPServerConfig,
    *,
    agent_gateway_url: str | None = None,
    auth_bearer: str | None = None,
    agent_id: str | None = None,
) -> dict[str, Any]:
    """Build connection config dict for MultiServerMCPClient.

    Args:
        server: MCP server configuration
        agent_gateway_url: When set, HTTP/SSE targets use ``{base}/mcp/{server.id}`` instead of direct endpoints.
        auth_bearer: Optional Bearer token for AG or upstream MCP.

    Returns:
        Connection config dict compatible with langchain_mcp_adapters
    """
    headers: dict[str, str] = {}
    if auth_bearer:
        headers["Authorization"] = f"Bearer {auth_bearer}"

    # Spec 102 Phase 8 / T106: also attach the httpx_client_factory so the
    # per-request user JWT and signed agent context are injected on every
    # outbound connection, even after this config is built.
    factory = build_httpx_client_factory(agent_id=agent_id)
    token = current_user_token.get()
    if token and "Authorization" not in headers:
        headers["Authorization"] = f"Bearer {token}"

    def attach_headers(cfg: dict[str, Any]) -> dict[str, Any]:
        cfg = {**cfg, "httpx_client_factory": factory}
        if not headers:
            return cfg
        return {**cfg, "headers": {**cfg.get("headers", {}), **headers}}

    # Self-heal stale AgentGateway endpoints (e.g. bare
    # ``http://agentgateway:4000/mcp`` written by an older save path)
    # before we hand the URL to the transport. See ``_heal_endpoint``.
    healed_endpoint = _heal_endpoint(server)
    if server.transport == TransportType.SSE:
        url = (
            f"{agent_gateway_url.rstrip('/')}/mcp/{server.id}"
            if agent_gateway_url and healed_endpoint
            else healed_endpoint
        )
        return attach_headers(
            {
                "url": url,
                "transport": "sse",
            }
        )
    if server.transport == TransportType.HTTP:
        url = (
            f"{agent_gateway_url.rstrip('/')}/mcp/{server.id}"
            if agent_gateway_url and healed_endpoint
            else healed_endpoint
        )
        return attach_headers(
            {
                "url": url,
                "transport": "streamable_http",
            }
        )
    config: dict[str, Any] = {
        "command": server.command,
        "transport": "stdio",
    }
    if server.args:
        config["args"] = server.args
    if server.env:
        config["env"] = server.env
    return config


def build_mcp_connections(
    servers: list[MCPServerConfig],
    server_ids: list[str],
    *,
    agent_gateway_url: str | None = None,
    auth_bearer: str | None = None,
    agent_id: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Build MCP connections dict for MultiServerMCPClient.

    Args:
        servers: List of all available MCP server configs
        server_ids: List of server IDs to include
        agent_gateway_url: Optional Agent Gateway base URL for HTTP/SSE MCP routing.
        auth_bearer: Optional OBO/user JWT for Authorization header on MCP requests.

    Returns:
        Dict mapping server_id to connection config
    """
    connections: dict[str, dict[str, Any]] = {}

    server_map = {s.id: s for s in servers}
    for server_id in server_ids:
        server = server_map.get(server_id)
        if not server:
            logger.warning(f"MCP server '{server_id}' not found in registry")
            continue
        if not server.enabled:
            logger.warning(f"MCP server '{server_id}' is disabled, skipping")
            continue

        # assisted-by Codex Codex-sonnet-4-6
        # In normal product mode AgentGateway is the MCP policy enforcement
        # point, so every network MCP server routes through it when configured.
        use_gateway = bool(
            agent_gateway_url
            and server.transport in (TransportType.HTTP, TransportType.SSE)
        )
        connections[server_id] = build_mcp_connection_config(
            server,
            agent_gateway_url=agent_gateway_url if use_gateway else None,
            auth_bearer=auth_bearer,
            agent_id=agent_id,
        )

    return connections


def _use_impersonation_tokens() -> bool:
    return os.getenv("USE_IMPERSONATION_TOKENS", "false").strip().lower() == "true"


# In-process cache for the service-to-service client-credentials token, keyed by
# "<token_url>|<client_id>". Value is (access_token, expiry_monotonic_seconds).
_service_token_cache: dict[str, tuple[str, float]] = {}
_service_token_lock = asyncio.Lock()


def _service_oidc_config() -> tuple[str | None, str | None, str | None]:
    """Resolve ``(token_url, client_id, client_secret)`` for service-to-service OIDC.

    Reuses the platform Keycloak client (``INGESTOR_OIDC_CLIENT_*`` /
    ``KEYCLOAK_URL``) when dedicated ``MCP_SERVICE_OIDC_*`` overrides are absent so
    a standard deployment needs no extra configuration.
    """
    client_id = (
        os.getenv("MCP_SERVICE_OIDC_CLIENT_ID")
        or os.getenv("INGESTOR_OIDC_CLIENT_ID")
        or "caipe-platform"
    )
    client_secret = os.getenv("MCP_SERVICE_OIDC_CLIENT_SECRET") or os.getenv(
        "INGESTOR_OIDC_CLIENT_SECRET"
    )
    token_url = os.getenv("MCP_SERVICE_OIDC_TOKEN_URL")
    if not token_url:
        base = (os.getenv("KEYCLOAK_URL") or "").rstrip("/")
        realm = os.getenv("KEYCLOAK_REALM") or "caipe"
        if base:
            token_url = f"{base}/realms/{realm}/protocol/openid-connect/token"
    return token_url, client_id, client_secret


async def mint_service_client_credentials_token() -> str | None:
    """Mint (and cache) a service-to-service OAuth2 client-credentials token.

    Returns ``None`` when the OIDC service config is incomplete. The token is cached
    in process until ~30s before expiry to avoid minting on every tool load. Used as
    the no-caller fallback for backends that enforce their own OIDC auth (e.g. the
    RAG knowledge-base) when there is no per-request user JWT (background reconcile).
    """
    token_url, client_id, client_secret = _service_oidc_config()
    if not token_url or not client_id or not client_secret:
        return None

    cache_key = f"{token_url}|{client_id}"
    now = time.monotonic()
    cached = _service_token_cache.get(cache_key)
    if cached and cached[1] - 30 > now:
        return cached[0]

    async with _service_token_lock:
        cached = _service_token_cache.get(cache_key)
        if cached and cached[1] - 30 > now:
            return cached[0]
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
                resp = await client.post(
                    token_url,
                    data={
                        "grant_type": "client_credentials",
                        "client_id": client_id,
                        "client_secret": client_secret,
                    },
                )
            if resp.status_code != 200:
                logger.warning(
                    "service client-credentials mint failed: status=%s", resp.status_code
                )
                return None
            payload = resp.json()
            token = payload.get("access_token")
            expires_in = float(payload.get("expires_in", 300) or 300)
            if not isinstance(token, str) or not token:
                return None
            _service_token_cache[cache_key] = (token, now + expires_in)
            return token
        except Exception as exc:  # noqa: BLE001 - mint failure must not crash tool load
            logger.warning(
                "service client-credentials mint error: %s", type(exc).__name__
            )
            return None


async def resolve_mcp_credential_refs(
    server: MCPServerConfig,
    config: dict[str, Any],
    *,
    credential_client: CredentialExchangeClient | Any,
    caller_token: str | None = None,
) -> dict[str, Any]:
    """Resolve MCP credential sources into env vars or headers.

    Resolution is disabled unless ``USE_IMPERSONATION_TOKENS=true`` so existing
    MCP deployments keep their current credential behavior.

    ``caller_token`` is the validated caller JWT captured by the AgentRuntime at
    request entry (``self._auth_bearer``). The ``caller_token`` credential source
    prefers it over the ``current_user_token`` ContextVar, because the ContextVar
    is not reliably propagated into the (ephemeral) runtime-build async context
    where credential resolution runs — leaving it empty there and falling back to
    a service-account mint, which forwards the WRONG identity (service, not the
    caller/SA) to the MCP. Passing the runtime's already-captured token fixes the
    per-caller identity end-to-end (#64).
    """

    if not _use_impersonation_tokens() or not server.credential_sources:
        return config

    resolved = dict(config)
    for source in server.credential_sources:
        credential: str | None = None
        # ``origin`` records which path produced the credential so operators can
        # verify per-user OAuth vs the static service-account fallback without
        # ever logging the secret itself.
        origin: str = "none"
        # Per-user resolution may fail (e.g. the caller has not connected this
        # provider -> the credential service answers 404). Treat that as "no
        # per-user credential" and fall through to the static fallback rather
        # than failing the whole tool load for an optional MCP server.
        try:
            if source.kind == "secret_ref" and source.secret_ref:
                credential = await credential_client.retrieve_secret(
                    source.secret_ref, intended_use="mcp_server"
                )
                if credential:
                    origin = "secret_ref"
            elif source.kind == "provider_connection":
                exchanged: dict[str, Any] = {}
                try:
                    if source.provider:
                        exchanged = await credential_client.exchange_provider_connection_by_provider(
                            source.provider,
                            intended_use="mcp_server",
                            mcp_server_id=server.id,
                        )
                    elif source.provider_connection_id:
                        # Legacy doc: had connection_scope="pinned" + a specific
                        # provider_connection_id. The BFF /api/credentials/exchange
                        # endpoint now resolves the *caller's own* connection for
                        # that id's provider, so this is safe — no shared token.
                        exchanged = await credential_client.exchange_provider_connection(
                            source.provider_connection_id,
                            intended_use="mcp_server",
                            mcp_server_id=server.id,
                        )
                except Exception as exc:
                    logger.debug(
                        "credential exchange for server=%s source=%s failed (%s); "
                        "falling back to static credential if configured",
                        server.id,
                        source.name,
                        type(exc).__name__,
                    )
                    exchanged = {}
                access_token = exchanged.get("access_token")
                if isinstance(access_token, str) and access_token:
                    credential = access_token
                    origin = "per_user_oauth"
            elif source.kind == "caller_token":
                # Forward the caller's own Keycloak JWT so the backend can enforce
                # per-user RBAC (e.g. RAG group-based access). Prefer the explicitly
                # threaded caller_token (the runtime's request-entry self._auth_bearer)
                # over the ContextVar, which is empty when credential resolution runs
                # outside the request task (#64). Absent in non-user contexts
                # (background reconcile) -> client-credentials fallback below.
                user_jwt = caller_token or current_user_token.get()
                if isinstance(user_jwt, str) and user_jwt:
                    credential = user_jwt
                    origin = "user_jwt"
        except McpCredentialUnavailableError:
            raise
        except Exception as exc:  # noqa: BLE001 - fall back to static credential below
            logger.debug(
                "credential exchange for server=%s source=%s failed (%s); "
                "falling back to static credential if configured",
                server.id,
                source.name,
                type(exc).__name__,
            )

        # Static service-account fallback: keeps shared-token MCP servers
        # (e.g. GitHub/GitLab) working for callers without a personal connection.
        if not credential and source.fallback_env:
            env_value = os.getenv(source.fallback_env, "").strip()
            if env_value:
                credential = env_value
                origin = f"static_fallback_env:{source.fallback_env}"

        # Service-to-service fallback: no per-request user JWT (e.g. background
        # reconcile/probe). Mint a client-credentials token so backends that
        # enforce their own OIDC auth (RAG knowledge-base) remain reachable.
        if not credential and source.fallback_client_credentials:
            minted = await mint_service_client_credentials_token()
            if minted:
                credential = minted
                origin = "client_credentials"

        if not credential:
            if source.kind == "provider_connection":
                if source.provider and not source.fallback_env:
                    raise McpCredentialUnavailableError(
                        f"Caller has no connected provider for server={server.id} "
                        f"provider={source.provider}",
                        reason=CALLER_PROVIDER_NOT_CONNECTED,
                        provider=source.provider,
                        server_id=server.id,
                        server_name=server.name,
                    )
            logger.info(
                "MCP credential resolve: server=%s source=%s -> no credential "
                "(per-user not connected and no fallback)",
                server.id,
                source.name,
            )
            continue

        # Non-reversible fingerprint lets you confirm WHICH token flowed
        # (per-user OAuth vs static PAT) without leaking the secret: the two
        # tokens hash to different fingerprints.
        fingerprint = hashlib.sha256(credential.encode()).hexdigest()[:8]
        logger.info(
            "MCP credential resolve: server=%s source=%s target=%s origin=%s fp=%s",
            server.id,
            source.name,
            source.target,
            origin,
            fingerprint,
        )

        if source.target == "env":
            resolved["env"] = {**resolved.get("env", {}), source.name: credential}
        elif source.target == "header":
            header_value = credential
            if source.name.lower() == "authorization" and not credential.lower().startswith("bearer "):
                header_value = f"Bearer {credential}"
            resolved["headers"] = {**resolved.get("headers", {}), source.name: header_value}
            if source.kind == "caller_token" and "Authorization" not in resolved["headers"]:
                resolved["headers"]["Authorization"] = (
                    credential if credential.lower().startswith("bearer ") else f"Bearer {credential}"
                )

    return resolved


async def resolve_mcp_connections_credential_refs(
    servers: list[MCPServerConfig],
    connections: dict[str, dict[str, Any]],
    *,
    credential_client: CredentialExchangeClient | Any | None,
    caller_token: str | None = None,
) -> McpCredentialResolutionResult:
    """Resolve credential refs across a connection map.

    ``caller_token`` (the runtime's request-entry ``self._auth_bearer``) is
    forwarded to each server's resolution so the ``caller_token`` credential
    source uses the real caller JWT even when the ``current_user_token``
    ContextVar is empty at this call site (#64).

    Servers that fail caller-scoped credential resolution are omitted
    from ``connections`` and recorded in ``failures`` with structured reasons.
    """

    if not _use_impersonation_tokens():
        return McpCredentialResolutionResult(connections=dict(connections))

    server_map = {server.id: server for server in servers}
    resolved: dict[str, dict[str, Any]] = {}
    failures: dict[str, McpCredentialUnavailableError] = {}
    for server_id, config in connections.items():
        server = server_map.get(server_id)
        if server is None:
            resolved[server_id] = config
            continue
        if credential_client is None and not any(
            source.kind == "caller_token" and source.fallback_client_credentials
            for source in server.credential_sources
        ):
            resolved[server_id] = config
            continue
        try:
            resolved[server_id] = await resolve_mcp_credential_refs(
                server,
                config,
                credential_client=credential_client,
                caller_token=caller_token,
            )
        except McpCredentialUnavailableError as exc:
            if exc.server_id is None:
                exc.server_id = server_id
            if exc.server_name is None:
                exc.server_name = server.name
            failures[server_id] = exc
    return McpCredentialResolutionResult(connections=resolved, failures=failures)


def filter_tools_by_allowed(
    all_tools: list,
    allowed_tools: dict[str, list[str] | bool],
) -> tuple[list, list[str]]:
    """Filter tools based on allowed_tools config.

    Args:
        all_tools: List of all tools from MCP client (with namespaced names)
        allowed_tools: Config mapping server_id -> tool_names | bool.
            true = all tools from server, false = server disabled,
            list = specific tools only, [] = legacy (treated as true, logs warning)

    Returns:
        Tuple of (filtered_tools, missing_tool_names)
    """
    logger = logging.getLogger(__name__)

    # Build set of allowed namespaced tool names
    allowed_names: set[str] = set()

    for server_id, value in allowed_tools.items():
        if value is False:
            # Explicitly disabled — skip entirely
            continue
        elif value is True:
            # All tools from this server
            for tool in all_tools:
                if tool.name.startswith(f"{server_id}_"):
                    allowed_names.add(tool.name)
        elif isinstance(value, list):
            if not value:
                # Empty list = legacy for "all tools", log deprecation warning
                logger.warning(
                    "allowed_tools[%s] uses empty list [] which is deprecated. "
                    "Use `true` instead to indicate all tools are allowed.",
                    server_id,
                )
                for tool in all_tools:
                    if tool.name.startswith(f"{server_id}_"):
                        allowed_names.add(tool.name)
            else:
                # Specific tools only
                for tool_name in value:
                    namespaced = f"{server_id}_{tool_name}"
                    allowed_names.add(namespaced)

    # Filter and validate tools
    filtered_tools = []
    missing_tools: list[str] = []
    available_names = {t.name for t in all_tools}

    for tool_name in allowed_names:
        if tool_name in available_names:
            tool = next(t for t in all_tools if t.name == tool_name)
            filtered_tools.append(tool)
        else:
            missing_tools.append(tool_name)

    return filtered_tools, missing_tools


def _extract_error_message(exc: BaseException) -> str:
    """Extract a user-friendly error message from an exception.

    Handles ExceptionGroup by extracting the most relevant nested error.
    """
    # Handle ExceptionGroup (Python 3.11+)
    if isinstance(exc, BaseExceptionGroup):
        # Get the first nested exception
        if exc.exceptions:
            return _extract_error_message(exc.exceptions[0])
        return str(exc)

    # Handle httpx.HTTPStatusError specifically
    if hasattr(exc, "response") and hasattr(exc.response, "status_code"):
        status = exc.response.status_code
        url = getattr(exc.response, "url", "unknown")
        return f"HTTP {status} error connecting to {url}"

    return str(exc)


# Messages that the langchain-mcp-adapters / streamable-http transport emits
# without an attached HTTP response. They tell the UI "something went wrong on
# the wire", but not whether the wire died on a 401 from AgentGateway, a
# connection refused, or a clean disconnect. Treat them as opaque and re-probe
# the endpoint over plain HTTP so we can surface a concrete cause.
_OPAQUE_MCP_TRANSPORT_MESSAGES = (
    "session terminated",
    "session closed",
    "stream ended",
)


def _is_opaque_transport_message(message: str) -> bool:
    """True if the inner exception message carries no actionable detail."""
    lowered = (message or "").strip().lower()
    return any(token in lowered for token in _OPAQUE_MCP_TRANSPORT_MESSAGES)


# Classification of a single MCP server tool-load attempt.
#   - "transient": worth retrying (cold-start timeout, mid-stream disconnect, 5xx).
#   - "permanent": fail fast, needs operator attention (DNS, refused, 404, bad config).
#   - "denied":    a genuine authorization decision; never retried, never relabeled.
MCPLoadStatus = str  # one of: "transient" | "permanent" | "denied"

# Substrings (lowercased) that mark a failure as worth retrying.
_TRANSIENT_TIMEOUT_TOKENS = (
    "timeout",
    "timed out",
    "upstream call timeout",
)
# Mid-stream disconnects / opaque wire errors: usually a flaky leg, not a verdict.
_TRANSIENT_DISCONNECT_TOKENS = _OPAQUE_MCP_TRANSPORT_MESSAGES + (
    "connection reset",
    "connection aborted",
    "server disconnected",
    "remotedisconnected",
    "incomplete read",
    "peer closed connection",
)
# Substrings (lowercased) that mark a failure as permanent (no point retrying).
_PERMANENT_TOKENS = (
    "name or service not known",
    "nodename nor servname",
    "getaddrinfo",
    "no address associated",
    "failed to resolve",
    "name resolution",
    "connection refused",
    "connect call failed",
    "all connection attempts failed",
    "no route to host",
    "certificate",
    "ssl",
    "not configured",
    "malformed",
    "unsupported",
)


def _parse_http_status(error_msg: str) -> int | None:
    """Best-effort extraction of an HTTP status code from an error string.

    Matches the shapes produced by ``_extract_error_message`` /
    ``_diagnose_endpoint_failure`` (e.g. ``"HTTP 403 Forbidden from ..."``).
    Returns ``None`` when no ``HTTP <code>`` token is present.
    """
    match = re.search(r"\bhttp\s+(\d{3})\b", error_msg, flags=re.IGNORECASE)
    return int(match.group(1)) if match else None


def classify_load_error(error_msg: str, status_code: int | None = None) -> MCPLoadStatus:
    """Classify a failed MCP tool-load as transient, permanent, or denied.

    The classification drives both the bounded retry policy (only ``transient``
    is retried) and the user-facing messaging (``transient`` reads as "still
    starting up", ``permanent`` as "needs attention").

    Security note (FR-009): a genuine authorization decision (a clean ``401``/
    ``403`` with no timeout signal) is classified ``denied`` and is **never**
    retried nor relabeled as transient. When a ``403`` cannot be tied to a
    timeout/connection signal we err toward ``denied`` rather than retrying it.

    Args:
        error_msg: Extracted, user-safe error message (see ``_extract_error_message``).
        status_code: Optional HTTP status if known; otherwise parsed from ``error_msg``.

    Returns:
        ``"transient"``, ``"permanent"``, or ``"denied"``.
    """
    lowered = (error_msg or "").strip().lower()
    code = status_code if status_code is not None else _parse_http_status(lowered)

    # 1. An ext_authz / upstream timeout is the cold-start race we self-heal,
    #    even when it surfaces as a fail-closed 403. Check timeouts first so a
    #    "HTTP 403 ... upstream call timeout" is treated as transient, not denied.
    if any(token in lowered for token in _TRANSIENT_TIMEOUT_TOKENS):
        return "transient"

    # 2. HTTP status verdicts.
    if code is not None:
        if code in (408, 429) or 500 <= code <= 599:
            return "transient"
        if code == 404:
            return "permanent"
        if code in (401, 403):
            # Clean policy decision with no timeout signal (handled above).
            return "denied"

    # 3. Mid-stream disconnects / opaque transport errors → retry.
    if any(token in lowered for token in _TRANSIENT_DISCONNECT_TOKENS):
        return "transient"

    # 4. DNS / refused / TLS / config problems → permanent.
    if any(token in lowered for token in _PERMANENT_TOKENS):
        return "permanent"

    # 5. Unknown: prefer "needs attention" over an endless "starting up".
    return "permanent"


async def _diagnose_endpoint_failure(endpoint: str) -> str:
    """Issue a direct HTTP probe to ``endpoint`` and translate the result into
    a one-line diagnostic message.

    Returns one of:
      - ``"HTTP <status> <reason> from <endpoint>"`` when the server replies
      - ``"Cannot connect to <endpoint>: <details>"`` when no response arrives

    Never raises — the caller already has an exception to attach this to.
    """
    if not endpoint:
        return "MCP endpoint URL is not configured"

    # Honor the same TLS / CA bundle posture as the MCP HTTP factory so this
    # diagnostic doesn't lie about cert problems.
    ca_bundle = (
        os.getenv("CUSTOM_CA_BUNDLE")
        or os.getenv("REQUESTS_CA_BUNDLE")
        or os.getenv("SSL_CERT_FILE")
    )
    ssl_verify = os.getenv("SSL_VERIFY", "true").lower()
    if ca_bundle and os.path.exists(ca_bundle):
        verify: Any = ssl.create_default_context(cafile=ca_bundle)
    elif ssl_verify == "false":
        verify = False
    else:
        verify = True

    headers: dict[str, str] = {}
    token = current_user_token.get()
    if token:
        # Match what the MCP HTTP client would have sent so the upstream
        # auth decision matches the one that failed.
        headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(verify=verify, timeout=httpx.Timeout(5.0)) as client:
            response = await client.get(endpoint, headers=headers)
    except (httpx.ConnectError, httpx.TransportError, httpx.TimeoutException) as exc:
        # Avoid leaking deep tracebacks; one short line is what the UI wants.
        return f"Cannot connect to {endpoint}: {type(exc).__name__}: {exc}"
    except Exception as exc:  # pragma: no cover - defensive
        return f"Cannot reach {endpoint}: {exc}"

    reason = (
        response.reason_phrase
        or response.extensions.get("reason_phrase", b"").decode("ascii", "replace")
        if hasattr(response, "extensions")
        else response.reason_phrase
    )
    if not reason:
        # Map a few common ones if the server omitted the reason phrase.
        reason = {401: "Unauthorized", 403: "Forbidden", 404: "Not Found"}.get(
            response.status_code, ""
        )
    if reason:
        return f"HTTP {response.status_code} {reason} from {endpoint}"
    return f"HTTP {response.status_code} from {endpoint}"


# Bounded retry policy for transient MCP tool-load failures (cold-start
# ext_authz timeouts, mid-stream disconnects). Kept small so a healthy
# enumeration is not slowed (success path does zero retries) and a permanent
# failure / denial is not retried needlessly.
_DEFAULT_LOAD_MAX_ATTEMPTS = 3
_DEFAULT_LOAD_BASE_BACKOFF_S = 0.25


async def get_tools_with_resilience(
    connections: dict[str, dict[str, Any]],
    *,
    max_attempts: int = _DEFAULT_LOAD_MAX_ATTEMPTS,
    base_backoff_s: float = _DEFAULT_LOAD_BASE_BACKOFF_S,
) -> tuple[list, list[str], dict[str, str], dict[str, str]]:
    """Get tools from MCP servers with per-server error handling and retry.

    Unlike MultiServerMCPClient.get_tools(), this connects to each server
    independently so that one failing server doesn't prevent others from
    connecting. Connections are made concurrently for performance.

    Each server's load is retried with jittered exponential backoff, but only
    for failures classified as ``transient`` (see ``classify_load_error``):
    cold-start ext_authz timeouts and mid-stream disconnects self-heal, while
    ``permanent`` failures and ``denied`` authorization decisions fail fast
    (no wasted retry budget, and a denial is never retried into success).

    Args:
        connections: Dict mapping server_id to connection config.
        max_attempts: Max connect attempts per server (>=1). Default 3.
        base_backoff_s: Base backoff for exponential+jitter delay. Default 0.25s.

    Returns:
        Tuple of:
        - all_tools: List of tools from successfully connected servers
        - failed_servers: List of server IDs that failed to connect
        - failed_errors: Dict mapping server_id to error message
        - failed_status: Dict mapping server_id to classification
          (``"transient"`` | ``"permanent"`` | ``"denied"``)
    """

    async def connect_single_server(
        server_id: str, connection_config: dict[str, Any]
    ) -> tuple[str, list | Exception, int]:
        """Connect to one server, retrying only transient failures.

        Returns (server_id, tools-or-exception, attempts_made).
        """
        last_exc: Exception | None = None
        for attempt in range(1, max(1, max_attempts) + 1):
            try:
                single_client = MultiServerMCPClient(
                    {server_id: connection_config},
                    tool_name_prefix=True,
                )
                server_tools = await single_client.get_tools()
                return server_id, server_tools, attempt
            except Exception as e:  # noqa: BLE001 - re-raised/returned below
                last_exc = e
                error_msg = _extract_error_message(e)
                status = classify_load_error(error_msg)
                # Only transient errors are worth retrying; permanent/denied
                # fail fast so we neither waste the budget nor retry a denial.
                if status != "transient" or attempt >= max(1, max_attempts):
                    return server_id, e, attempt
                backoff = base_backoff_s * (2 ** (attempt - 1)) + random.uniform(0, base_backoff_s)
                logger.info(
                    f"MCP server '{server_id}' transient load failure "
                    f"(attempt {attempt}/{max_attempts}): {error_msg}; retrying in {backoff:.2f}s"
                )
                await asyncio.sleep(backoff)
        # Defensive: loop always returns above, but satisfy the type checker.
        return server_id, (last_exc or RuntimeError("unknown MCP load failure")), max(1, max_attempts)

    # Connect to all servers concurrently
    tasks = [connect_single_server(server_id, config) for server_id, config in connections.items()]
    results = await asyncio.gather(*tasks)

    # Process results
    all_tools: list = []
    failed_servers: list[str] = []
    failed_errors: dict[str, str] = {}
    failed_status: dict[str, str] = {}

    for server_id, result, attempts in results:
        if isinstance(result, Exception):
            error_msg = _extract_error_message(result)
            status = classify_load_error(error_msg)
            failed_servers.append(server_id)
            failed_errors[server_id] = error_msg
            failed_status[server_id] = status
            logger.warning(
                f"Failed to connect to MCP server '{server_id}' after {attempts} attempt(s) "
                f"[{status}]: {error_msg}"
            )
        else:
            all_tools.extend(result)
            logger.info(
                f"Connected to MCP server '{server_id}': {len(result)} tools (attempt {attempts})"
            )

    return all_tools, failed_servers, failed_errors, failed_status


async def _resolve_probe_credentials(
    server: MCPServerConfig, connection: dict[str, Any]
) -> dict[str, Any]:
    """Apply MCP ``credential_sources`` resolution for a probe connection.

    Mirrors the runtime tool-load path (``agent_runtime`` →
    ``resolve_mcp_connections_credential_refs``) so the probe forwards the same
    headers the live agent would. A credential-exchange client is built from the
    caller's JWT when available (needed for ``secret_ref`` / ``provider_connection``
    kinds); the ``caller_token`` kind reads ``current_user_token`` directly and the
    client-credentials fallback mints its own token, so a missing client is safe.
    """
    if not _use_impersonation_tokens() or not server.credential_sources:
        return connection

    credential_client: CredentialExchangeClient | None = None
    try:
        settings = get_settings()
        user_jwt = current_user_token.get()
        if settings.credential_api_url and user_jwt:
            credential_client = CredentialExchangeClient(
                base_url=settings.credential_api_url,
                audience=settings.credential_service_audience,
                token_provider=lambda token=user_jwt: token or "",
            )
    except Exception as exc:  # noqa: BLE001 - credential client is best-effort
        logger.debug("probe credential client unavailable: %s", type(exc).__name__)

    return await resolve_mcp_credential_refs(
        server, connection, credential_client=credential_client
    )


async def probe_server_tools(server: MCPServerConfig) -> list[dict[str, Any]]:
    """Probe an MCP server for its available tools.

    Args:
        server: MCP server configuration

    Returns:
        List of tool metadata dicts

    Raises:
        Exception with user-friendly message if probing fails
    """
    connection = build_mcp_connection_config(server)
    # Resolve credential_sources so the probe behaves like the runtime tool-load
    # path. Without this, servers whose gateway route rewrites X-CAIPE-Provider-Token
    # into Authorization (e.g. knowledge-base/RAG) would receive an empty Bearer
    # (the CEL `default(..., "")`), stripping the caller's JWT and 401-ing the probe.
    connection = await _resolve_probe_credentials(server, connection)
    connections = {server.id: connection}

    # As of langchain-mcp-adapters 0.1.0, MultiServerMCPClient cannot be used
    # as a context manager. Use get_tools() directly instead.
    client = MultiServerMCPClient(connections, tool_name_prefix=True)

    # Resolve the URL the transport actually used so any diagnostic
    # re-probe targets the same address (otherwise admins would see a
    # 404 against the un-healed legacy endpoint, which is confusing).
    healed_probe_endpoint = _heal_endpoint(server) or server.endpoint
    try:
        tools = await client.get_tools()
    except BaseExceptionGroup as e:
        error_msg = _extract_error_message(e)
        # The streamable-http MCP transport raises generic "Session
        # terminated" / "Session closed" exceptions when the upstream
        # closes the SSE leg early — including on a clean 401/403 from
        # AgentGateway. Re-probe the endpoint directly so the UI sees a
        # concrete HTTP status / connectivity reason instead of an opaque
        # transport message.
        if _is_opaque_transport_message(error_msg) and healed_probe_endpoint:
            diagnostic = await _diagnose_endpoint_failure(healed_probe_endpoint)
            raise RuntimeError(
                f"Failed to connect to MCP server: {diagnostic}"
            ) from e
        raise RuntimeError(f"Failed to connect to MCP server: {error_msg}") from e
    except Exception as e:
        error_msg = _extract_error_message(e)
        if _is_opaque_transport_message(error_msg) and healed_probe_endpoint:
            diagnostic = await _diagnose_endpoint_failure(healed_probe_endpoint)
            raise RuntimeError(
                f"Failed to probe MCP server: {diagnostic}"
            ) from e
        raise RuntimeError(f"Failed to probe MCP server: {error_msg}") from e

    # Convert tools to serializable dicts
    # Use removeprefix to only strip the server prefix, not all occurrences
    # (e.g., "argocd_search_argocd_resources" -> "search_argocd_resources", not "search_resources")
    prefix = f"{server.id}_"
    return [
        {
            "name": tool.name.removeprefix(prefix),
            "namespaced_name": tool.name,
            "description": getattr(tool, "description", ""),
        }
        for tool in tools
    ]


def _format_tool_error(tool_name: str, exc: Exception) -> str:
    """Build a descriptive error message for the LLM.

    Includes the tool name, exception type, and message so the LLM can
    decide whether to retry with different arguments or try another approach.
    Uses _extract_error_message to unwrap ExceptionGroup/TaskGroup wrappers
    and surface the actual root cause.
    """
    error_text = _extract_error_message(exc) or type(exc).__name__
    return (
        f"ERROR: Tool '{tool_name}' failed: {error_text}\n"
        f"You can retry with different arguments or try a different approach."
    )


def _json_schema_dict(schema: Any) -> dict[str, Any] | None:
    """Return a JSON-schema dict for Pydantic model classes or schema dicts."""
    if isinstance(schema, dict):
        return copy.deepcopy(schema)

    if isinstance(schema, type):
        model_json_schema = getattr(schema, "model_json_schema", None)
        if callable(model_json_schema):
            return copy.deepcopy(model_json_schema())
        schema_method = getattr(schema, "schema", None)
        if callable(schema_method):
            return copy.deepcopy(schema_method())

    return None


def _resolve_local_schema_ref(ref: str, root: dict[str, Any]) -> dict[str, Any] | None:
    """Resolve local JSON-schema refs like ``#/$defs/Foo``."""
    if not ref.startswith("#/"):
        return None

    node: Any = root
    for raw_part in ref[2:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]

    return copy.deepcopy(node) if isinstance(node, dict) else None


def _dereference_schema(schema: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    ref = schema.get("$ref")
    if isinstance(ref, str):
        resolved = _resolve_local_schema_ref(ref, root)
        if resolved is not None:
            return resolved
    return schema


def _object_shape_from_schema(schema: dict[str, Any], root: dict[str, Any]) -> tuple[dict[str, Any], set[str]]:
    """Extract object properties and required fields from a schema branch."""
    schema = _dereference_schema(schema, root)
    properties: dict[str, Any] = {}
    required: set[str] = set()

    for key in TOP_LEVEL_UNION_SCHEMA_KEYS:
        branches = schema.get(key)
        if not isinstance(branches, list):
            continue

        branch_required_sets: list[set[str]] = []
        for branch in branches:
            if not isinstance(branch, dict):
                continue
            branch_properties, branch_required = _object_shape_from_schema(branch, root)
            properties.update(branch_properties)
            branch_required_sets.append(branch_required)

        if key == "allOf":
            for branch_required in branch_required_sets:
                required.update(branch_required)
        elif branch_required_sets:
            required.update(set.intersection(*branch_required_sets))

    branch_properties = schema.get("properties")
    if isinstance(branch_properties, dict):
        properties.update(copy.deepcopy(branch_properties))

    branch_required = schema.get("required")
    if isinstance(branch_required, list):
        required.update(item for item in branch_required if isinstance(item, str))

    return properties, required


def _collapse_top_level_union_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Collapse a top-level union/intersection schema into a provider-safe object."""
    properties, required = _object_shape_from_schema(schema, schema)
    collapsed: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": True,
    }

    for metadata_key in ("title", "description"):
        value = schema.get(metadata_key)
        if isinstance(value, str) and value:
            collapsed[metadata_key] = value

    if required:
        collapsed["required"] = sorted(required)

    return collapsed


def _model_safe_args_schema(tool: BaseTool, agent_name: str) -> Any:
    """Return an args schema that model providers can accept for tool binding."""
    try:
        schema = _json_schema_dict(getattr(tool, "tool_call_schema", None))
    except Exception as exc:  # noqa: BLE001 - schema inspection should not drop a tool
        logger.debug("[%s] Could not inspect tool schema for '%s': %s", agent_name, tool.name, exc)
        return tool.args_schema

    if not schema:
        return tool.args_schema

    top_level_keys = [key for key in TOP_LEVEL_UNION_SCHEMA_KEYS if key in schema]
    if not top_level_keys:
        return tool.args_schema

    # assisted-by Codex Codex-sonnet-4-6
    # Bedrock Converse rejects top-level oneOf/anyOf/allOf in tool input
    # schemas. Collapse just the root into an object while preserving known
    # properties so one bad MCP schema cannot prevent quick chat from starting.
    logger.warning(
        "[%s] Sanitizing Bedrock-incompatible top-level schema for tool '%s' (keys=%s)",
        agent_name,
        tool.name,
        ",".join(top_level_keys),
    )
    return _collapse_top_level_union_schema(schema)


def wrap_tools_with_error_handling(
    tools: list[BaseTool],
    agent_name: str = "agent",
) -> list[BaseTool]:
    """Wrap tools so that exceptions become LLM-visible error messages.

    Without this, MCP tool failures raise ToolException which propagates
    through LangGraph's ToolNode (default handler only catches
    ToolInvocationError) and terminates the entire agent loop.

    This follows the same pattern as built-in tools (fetch_url, sleep, etc.)
    which catch exceptions internally and return "ERROR: ..." strings.

    Args:
        tools: LangChain tools to wrap (MCP and/or built-in).
        agent_name: Label for log messages.

    Returns:
        New list of tools with error-handling wrappers.
    """
    wrapped: list[BaseTool] = []

    for tool in tools:
        tool_name = tool.name
        resp_fmt = getattr(tool, "response_format", "content")
        original_coro = getattr(tool, "coroutine", None)

        if original_coro is None:
            # Tool has no async coroutine (unusual) — keep as-is
            wrapped.append(tool)
            continue

        async def _safe_coro(
            *args: Any,
            _orig: Any = original_coro,
            _name: str = tool_name,
            _resp_fmt: str = resp_fmt,
            **kwargs: Any,
        ) -> Any:
            try:
                return await _orig(*args, **kwargs)
            except Exception as exc:
                msg = _format_tool_error(_name, exc)
                logger.error(f"[{agent_name}] Tool '{_name}' failed", exc_info=exc)
                # Return error in the format the tool's response_format expects.
                # MCP tools use content_and_artifact which requires a (content, artifact) tuple.
                if _resp_fmt == "content_and_artifact":
                    return (msg, [])
                return msg

        new_tool = StructuredTool(
            name=tool.name,
            description=tool.description or "",
            args_schema=_model_safe_args_schema(tool, agent_name),
            coroutine=_safe_coro,
            response_format=resp_fmt,
            metadata=tool.metadata,
        )
        wrapped.append(new_tool)

    logger.info(f"[{agent_name}] Wrapped {len(wrapped)} tools with error handling")
    return wrapped


def pin_datasource_filters(
    tools: list[BaseTool],
    datasource_ids: list[str] | None,
    agent_name: str = "agent",
    rag_server_ids: set[str] | None = None,
    datasource_ids_provider: Callable[[], list[str]] | None = None,
) -> list[BaseTool]:
    """Pin RAG search-style tools to a configured set of datasource ids.

    Only tools belonging to a configured RAG MCP server are affected. RAG
    tools whose schema accepts a ``filters`` argument are wrapped; RAG tools
    without that argument are removed because they cannot enforce the agent's
    source selection. Tools from every other MCP server remain untouched,
    including tools that coincidentally expose a field named ``filters``.

    This is the client-side half
    of the agent<->datasource binding: the server independently intersects
    with the caller's RBAC-accessible datasources (``server/tools.py``), so
    the effective scope is always (this pin) ∩ (caller's RBAC access) —
    narrows, never widens.

    Narrows, never widens at this layer too: if the model supplies its own
    ``filters["datasource_id"]``, it is intersected with ``datasource_ids``
    rather than overridden, so the model cannot escape the pin by asking for
    a different id.
    """
    # ``None`` is the backward-compatible legacy state: no agent-level pin.
    # An explicit empty list keeps filter-capable RAG tools available while
    # pinning them to an empty scope, so calls return no indexed content.
    if datasource_ids is None and datasource_ids_provider is None:
        return tools

    if rag_server_ids is None:
        configured = os.getenv("RAG_MCP_SERVER_IDS", "knowledge-base")
        rag_server_ids = {value.strip() for value in configured.split(",") if value.strip()}

    pinned: list[BaseTool] = []
    for tool in tools:
        is_rag_tool = any(tool.name.startswith(f"{server_id}_") for server_id in rag_server_ids)
        if not is_rag_tool:
            pinned.append(tool)
            continue

        schema = _json_schema_dict(getattr(tool, "tool_call_schema", None))
        properties = schema.get("properties") if isinstance(schema, dict) else None
        original_coro = getattr(tool, "coroutine", None)
        if not isinstance(properties, dict) or "filters" not in properties or original_coro is None:
            logger.warning(
                "[%s] Removed RAG tool '%s': it cannot enforce configured datasource_ids",
                agent_name,
                tool.name,
            )
            continue

        async def _pinned_coro(
            *args: Any,
            _orig: Any = original_coro,
            _ids: list[str] = datasource_ids or [],
            _ids_provider: Callable[[], list[str]] | None = datasource_ids_provider,
            **kwargs: Any,
        ) -> Any:
            effective_ids = (
                await asyncio.to_thread(_ids_provider)
                if _ids_provider is not None
                else _ids
            )
            requested = kwargs.get("filters")
            existing = requested.get("datasource_id") if isinstance(requested, dict) else None
            if existing is None:
                scoped: list[str] = list(effective_ids)
            elif isinstance(existing, str):
                scoped = [existing] if existing in effective_ids else []
            elif isinstance(existing, (list, tuple, set)):
                scoped = [x for x in existing if x in effective_ids]
            else:
                scoped = []
            merged = dict(requested) if isinstance(requested, dict) else {}
            merged["datasource_id"] = scoped
            kwargs["filters"] = merged
            return await _orig(*args, **kwargs)

        # Preserve the adapter-provided tool's tags, response behavior, error
        # handlers, and any future BaseTool fields. Reconstructing a bare
        # StructuredTool here silently discarded those attributes.
        if hasattr(tool, "model_copy"):
            pinned_tool = tool.model_copy(update={"coroutine": _pinned_coro})
        else:  # pragma: no cover - compatibility with pre-Pydantic-v2 tools
            pinned_tool = copy.copy(tool)
            pinned_tool.coroutine = _pinned_coro
        pinned.append(pinned_tool)
        logger.info(
            "[%s] Pinned tool '%s' to datasource_ids=%s%s",
            agent_name,
            tool.name,
            datasource_ids,
            " plus dynamic collections" if datasource_ids_provider else "",
        )

    return pinned
