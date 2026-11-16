# assisted-by Codex Codex-sonnet-4-6

"""Reconcile BFF-published MCP server targets into standalone AgentGateway config.

AgentGateway's Kubernetes mode should use native Gateway API resources
(`HTTPRoute` + `AgentgatewayBackend`). Local Docker Compose runs standalone
AgentGateway from a config file, and AgentGateway hot-reloads route/backend
changes written to that file. This bridge keeps those local routes in sync
with the BFF's internal MCP target API so runtime-added MCP servers get a
matching `/mcp/<server_id>` route without exposing the persistence backend to
the sidecar.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import re
import stat
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import yaml


LOGGER = logging.getLogger("agentgateway-config-bridge")
RECONCILE_OK_MARKER = ".reconcile_ok"
SAFE_TARGET_ID = re.compile(r"^[A-Za-z0-9._-]+$")
PUBLISHED_CONFIG_MODE = 0o644
_VALID_AGENTGATEWAY_LOG_LEVELS = frozenset({"trace", "debug", "info", "warn", "error"})
DEFAULT_AGENTGATEWAY_LOG_LEVEL = "info"

# Host:port of the OpenFGA ext_authz bridge the gateway calls for every MCP
# route. The default matches the Docker Compose service name. In Helm the
# service is release-name-prefixed (e.g. `<release>-openfga-authz-bridge`), so
# the chart sets AGENTGATEWAY_AUTHZ_HOST to the prefixed name. Without this the
# gateway resolves a non-existent host, ext_authz fails, and the fail-closed
# `denyWithStatus: 403` below rejects every discovered-server MCP call.
DEFAULT_AUTHZ_HOST = os.getenv("AGENTGATEWAY_AUTHZ_HOST", "openfga-authz-bridge:9100").strip()

DEFAULT_MCP_ROUTE_POLICIES: dict[str, Any] = {
    "extAuthz": {
        "host": DEFAULT_AUTHZ_HOST,
        "failureMode": {"denyWithStatus": 403},
        # Forward the HTTP request body to the bridge so it can parse the
        # JSON-RPC `tools/call` method+name and run the caller-keyed per-tool
        # check (FR-012/SC-010). Without this only gRPC metadata reaches the
        # bridge, `tool_call` is always None, and the caller-keyed block is
        # skipped — every MCP call would pass on the coarse `mcp_gateway:list`
        # check alone. Headers (x-caipe-agent-context*) are already delivered by
        # the gRPC protocol when includeRequestHeaders is empty; only the body
        # needs requesting. packAsBytes -> CheckRequest.http.raw_body, which the
        # bridge's _request_body_text() reads first. See issue #36. The per-route
        # overrides below only add `transformations` (shallow-merged), so they
        # inherit this extAuthz block unchanged.
        # Keep this in sync with deploy/agentgateway/config.yaml (bootstrap seed).
        "includeRequestBody": {
            "maxRequestBytes": 65536,
            "allowPartialMessage": False,
            "packAsBytes": True,
        },
        "protocol": {
            "grpc": {
                "metadata": {
                    # Carry preferred_username alongside sub so the bridge can
                    # detect service accounts (T002 rule) — the gateway's jwtAuth
                    # consumes the Authorization bearer and does NOT forward it in
                    # the ext_authz CheckRequest, so metadata is the only channel
                    # for the SA signal (#46/#49). Keep in sync with config.yaml.
                    "caipe.auth": '{"sub": jwt.sub, "preferred_username": jwt.preferred_username}',
                },
            },
        },
    },
    "authorization": {
        "rules": [
            {"allow": "true"},
        ],
    },
}

# Target-level (per-backend) policies. GitHub/GitLab no longer use a static
# `backendAuth` PAT here; they authenticate per-request through the route-level
# transformation below (see DEFAULT_MCP_ROUTE_POLICY_OVERRIDES).
DEFAULT_MCP_TARGET_POLICIES: dict[str, dict[str, Any]] = {}

# Route-level policy overrides shallow-merged onto DEFAULT_MCP_ROUTE_POLICIES for
# specific servers. GitHub/GitLab upstreams expect `Authorization: Bearer <token>`.
# Dynamic Agents resolves the caller's own OAuth token (or, when the caller has
# not connected, the static org PAT via MCPCredentialSource.fallback_env) and
# forwards it on `X-CAIPE-Provider-Token`. This transformation rewrites that
# header into the upstream Authorization header, so connected users act as
# themselves while unconnected callers transparently fall back to the org token.
# Standalone config uses the `transformations` (plural) policy key with the
# `set` map form; CEL `default(...)` keeps the expression total when the header
# is absent. Keep in sync with deploy/agentgateway/config.yaml (bootstrap seed).
PROVIDER_TOKEN_BEARER_TRANSFORM: dict[str, Any] = {
    "transformations": {
        "request": {
            "set": {
                "authorization": (
                    '"Bearer " + default(request.headers["x-caipe-provider-token"], "")'
                ),
                # Jira MCP reads Atlassian OAuth from this header directly; GitHub/GitLab
                # and sooperset/mcp-atlassian (Confluence) consume Authorization. Forward
                # the provider token for both patterns.
                "x-caipe-provider-token": (
                    'default(request.headers["x-caipe-provider-token"], "")'
                ),
            },
        },
    },
}

# knowledge-base (RAG) reuses the same transform: the RAG server enforces its own
# Keycloak/OIDC auth on /mcp, so Dynamic Agents forwards the caller's user JWT (for
# per-user RAG group RBAC) or a caipe-platform service token (non-user contexts) on
# X-CAIPE-Provider-Token, which this rewrites into the upstream Authorization header.
DEFAULT_MCP_ROUTE_POLICY_OVERRIDES: dict[str, dict[str, Any]] = {
    "confluence": PROVIDER_TOKEN_BEARER_TRANSFORM,
    "github": PROVIDER_TOKEN_BEARER_TRANSFORM,
    "gitlab": PROVIDER_TOKEN_BEARER_TRANSFORM,
    "jira": PROVIDER_TOKEN_BEARER_TRANSFORM,
    "pagerduty": PROVIDER_TOKEN_BEARER_TRANSFORM,
    "knowledge-base": PROVIDER_TOKEN_BEARER_TRANSFORM,
}


@dataclass(frozen=True)
class McpGatewayTarget:
    """AgentGateway MCP target rendered from the BFF target API."""

    id: str
    upstream_url: str
    credential_sources: tuple[dict[str, Any], ...] = ()


def _reconcile_ok_path(config_path: Path) -> Path:
    """Path to the health marker written after a successful reconcile or seed."""

    return config_path.parent / RECONCILE_OK_MARKER


def _mark_reconcile_ok(config_path: Path) -> None:
    """Record that the published config is safe for AgentGateway to consume."""

    marker = _reconcile_ok_path(config_path)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch()


def _as_bool(value: Any, *, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off"}
    return bool(value)


def _server_id(document: dict[str, Any]) -> str | None:
    raw_id = document.get("_id") or document.get("id")
    if not isinstance(raw_id, str):
        return None
    target_id = raw_id.strip()
    return target_id if SAFE_TARGET_ID.fullmatch(target_id) else None


def _upstream_url(document: dict[str, Any]) -> str | None:
    raw_url = document.get("agentgateway_target_endpoint") or document.get(
        "agentgateway_upstream_url"
    )
    if raw_url is None and document.get("transport") in {"http", "sse"}:
        raw_url = document.get("endpoint")
    if not isinstance(raw_url, str):
        return None
    upstream_url = raw_url.strip()
    if not upstream_url.startswith(("http://", "https://")):
        return None
    if _is_agentgateway_route(upstream_url):
        return None
    return upstream_url


def _is_agentgateway_route(url: str) -> bool:
    configured = os.environ.get("AGENT_GATEWAY_URL") or os.environ.get(
        "AGENTGATEWAY_URL", "http://agentgateway:4000"
    )
    base = configured.rstrip("/")
    if not base.endswith("/mcp"):
        base = f"{base}/mcp"
    return url.rstrip("/").startswith(base)


def _credential_sources(document: dict[str, Any]) -> tuple[dict[str, Any], ...]:
    raw_sources = document.get("credential_sources")
    if not isinstance(raw_sources, list):
        return ()
    return tuple(source for source in raw_sources if isinstance(source, dict))


def select_gateway_targets(documents: Iterable[dict[str, Any]]) -> list[McpGatewayTarget]:
    """Select enabled network MCP targets that AgentGateway should front."""

    targets: list[McpGatewayTarget] = []
    seen: set[str] = set()
    for document in documents:
        if not _as_bool(document.get("enabled"), default=True):
            continue
        if document.get("transport") not in {"http", "sse"}:
            continue
        target_id = _server_id(document)
        upstream_url = _upstream_url(document)
        if target_id is None or upstream_url is None:
            continue
        if target_id in seen:
            continue
        targets.append(
            McpGatewayTarget(
                id=target_id,
                upstream_url=upstream_url,
                credential_sources=_credential_sources(document),
            )
        )
        seen.add(target_id)
    return targets


def select_gateway_targets_from_bff_payload(payload: dict[str, Any]) -> list[McpGatewayTarget]:
    """Select bridge targets from the BFF's internal target API response."""

    documents: list[dict[str, Any]] = []
    for item in payload.get("targets", []):
        if not isinstance(item, dict):
            continue
        document = {
            "_id": item.get("id"),
            "enabled": True,
            "transport": "http",
            "source": "agentgateway",
            "agentgateway_target_endpoint": item.get("target_endpoint"),
            "credential_sources": item.get("credential_sources")
            if isinstance(item.get("credential_sources"), list)
            else [],
        }
        documents.append(document)
    return select_gateway_targets(documents)


def _first_http_listener(config: dict[str, Any]) -> dict[str, Any]:
    binds = config.setdefault("binds", [{"port": 4000, "listeners": [{}]}])
    if not isinstance(binds, list) or not binds:
        config["binds"] = [{"port": 4000, "listeners": [{}]}]
        binds = config["binds"]
    bind = binds[0]
    if not isinstance(bind, dict):
        bind = {"port": 4000, "listeners": [{}]}
        binds[0] = bind
    listeners = bind.setdefault("listeners", [{}])
    if not isinstance(listeners, list) or not listeners:
        bind["listeners"] = [{}]
        listeners = bind["listeners"]
    listener = listeners[0]
    if not isinstance(listener, dict):
        listener = {}
        listeners[0] = listener
    listener.setdefault("protocol", "HTTP")
    listener.setdefault("routes", [])
    return listener


def _is_managed_mcp_route_path(path: str | None) -> bool:
    """True for per-target ``/mcp/<id>`` routes this reconciler owns.

    Such routes are derived 1:1 from ``mcp_servers`` documents, so the reconciler
    is their single source of truth and may add *or* remove them. Non-MCP routes
    (anything not under ``/mcp/``) are never pruned.
    """
    return isinstance(path, str) and path.startswith("/mcp/")


def _route_path(route: dict[str, Any]) -> str | None:
    matches = route.get("matches")
    if not isinstance(matches, list):
        return None
    for match in matches:
        if not isinstance(match, dict):
            continue
        path = match.get("path")
        if not isinstance(path, dict):
            continue
        value = path.get("pathPrefix") or path.get("value")
        if isinstance(value, str):
            return value
    return None


def _target_policies(route: dict[str, Any]) -> dict[str, Any] | None:
    backends = route.get("backends")
    if not isinstance(backends, list) or not backends:
        return None
    backend = backends[0]
    if not isinstance(backend, dict):
        return None
    mcp_backend = backend.get("mcp")
    if not isinstance(mcp_backend, dict):
        return None
    targets = mcp_backend.get("targets")
    if not isinstance(targets, list) or not targets:
        return None
    target = targets[0]
    if not isinstance(target, dict):
        return None
    policies = target.get("policies")
    return copy.deepcopy(policies) if isinstance(policies, dict) else None


def _mcp_route(
    target: McpGatewayTarget,
    policies: dict[str, Any],
    *,
    target_policies: dict[str, Any] | None = None,
) -> dict[str, Any]:
    mcp_target = {
        "name": target.id,
        "mcp": {"host": target.upstream_url},
    }
    if target_policies:
        mcp_target["policies"] = copy.deepcopy(target_policies)
    return {
        "matches": [{"path": {"pathPrefix": f"/mcp/{target.id}"}}],
        "policies": copy.deepcopy(policies),
        "backends": [
            {
                "mcp": {
                    "targets": [mcp_target],
                },
            },
        ],
    }


def _forward_credentials_through_gateway(target: McpGatewayTarget | None) -> bool:
    """Return true when AgentGateway should wire resolved credential headers upstream.

  When ``credential_sources`` is empty the MCP server uses its own configured
  credentials; the gateway must not rewrite ``Authorization`` or provider-token
  headers (extAuthz/FGA still applies).
    """

    if target is None:
        # No BFF target row for this id — preserve bootstrap defaults.
        return True
    return len(target.credential_sources) > 0


def _strip_credential_forwarding_transforms(policies: dict[str, Any]) -> dict[str, Any]:
    """Remove provider-token header rewrites from a route policy object."""

    merged = copy.deepcopy(policies)
    transformations = merged.get("transformations")
    if not isinstance(transformations, dict):
        return merged
    request = transformations.get("request")
    if not isinstance(request, dict):
        return merged
    request_set = request.get("set")
    if not isinstance(request_set, dict):
        return merged
    for key in ("authorization", "x-caipe-provider-token"):
        request_set.pop(key, None)
    if not request_set:
        transformations.pop("request", None)
    if not transformations:
        merged.pop("transformations", None)
    return merged


def _strip_route_credential_forwarding(route: dict[str, Any]) -> dict[str, Any]:
    """Drop credential header transforms from a rendered MCP route."""

    stripped = copy.deepcopy(route)
    policies = stripped.get("policies")
    if isinstance(policies, dict):
        stripped["policies"] = _strip_credential_forwarding_transforms(policies)
    return stripped


def _route_policies_for(
    target_id: str,
    base: dict[str, Any],
    *,
    forward_credentials: bool,
) -> dict[str, Any]:
    """Merge any per-server route-policy override onto the base MCP route policy."""

    merged = copy.deepcopy(base)
    if forward_credentials:
        override = DEFAULT_MCP_ROUTE_POLICY_OVERRIDES.get(target_id)
        if override:
            merged.update(copy.deepcopy(override))
    return merged


def _is_safe_header_name(value: str) -> bool:
    """Return true when ``value`` is a conservative HTTP header token."""

    return bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,127}", value))


def _credential_source_transformations(
    credential_sources: Iterable[dict[str, Any]],
) -> dict[str, str]:
    """Build AgentGateway header transforms from MCP ``credential_sources``.

    Dynamic Agents resolves secret/provider/caller credentials before the request
    reaches AgentGateway and forwards them as headers. The bridge only wires those
    already-resolved request headers to the upstream target; it never resolves,
    logs, or stores credential values.
    """

    transformations: dict[str, str] = {}
    for source in credential_sources:
        if source.get("target") != "header":
            continue
        header_name = source.get("name")
        if not isinstance(header_name, str):
            continue
        header_name = header_name.strip()
        if not _is_safe_header_name(header_name):
            continue

        incoming_header = header_name.lower()
        outgoing_header = incoming_header
        expression = f'default(request.headers["{incoming_header}"], "")'
        if incoming_header == "x-caipe-provider-token":
            transformations["authorization"] = (
                '"Bearer " + default(request.headers["x-caipe-provider-token"], "")'
            )
            transformations["x-caipe-provider-token"] = (
                'default(request.headers["x-caipe-provider-token"], "")'
            )
            continue
        transformations[outgoing_header] = expression
    return transformations


def _merge_request_transformations(
    policies: dict[str, Any],
    transformations: dict[str, str],
) -> dict[str, Any]:
    if not transformations:
        return policies
    merged = copy.deepcopy(policies)
    request = merged.setdefault("transformations", {}).setdefault("request", {})
    request_set = request.setdefault("set", {})
    if isinstance(request_set, dict):
        request_set.update(transformations)
    return merged


def load_builtin_mcp_routes(bootstrap_path: Path | None) -> dict[str, dict[str, Any]]:
    """Return ``{target_id: route}`` for every ``/mcp/<id>`` route shipped in the
    static bootstrap config (``deploy/agentgateway/config.yaml``).

    These are the platform's *built-in* MCP servers. Unlike runtime-added servers,
    they are not part of the dynamic BFF target payload, so the
    reconciler must treat them as a **protected baseline**: always rendered (from
    their authoritative bootstrap definition, including any per-route
    transformations) and never pruned just because they are absent from the API.

    Without this, an empty (or freshly reset) dynamic target set makes the
    reconciler classify all built-in ``/mcp/<id>`` routes as "stale managed
    routes" and wipe them — leaving AgentGateway with zero MCP routes.
    """

    if bootstrap_path is None or not bootstrap_path.exists():
        return {}
    try:
        config = yaml.safe_load(bootstrap_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        LOGGER.warning("Could not parse bootstrap config %s: %s", bootstrap_path, exc)
        return {}
    if not isinstance(config, dict):
        return {}

    builtins: dict[str, dict[str, Any]] = {}
    for bind in asarray_dicts(config.get("binds")):
        for listener in asarray_dicts(bind.get("listeners")):
            for route in asarray_dicts(listener.get("routes")):
                path = _route_path(route)
                if not _is_managed_mcp_route_path(path):
                    continue
                target_id = path[len("/mcp/") :]  # type: ignore[index]
                if SAFE_TARGET_ID.fullmatch(target_id):
                    builtins[target_id] = copy.deepcopy(route)
    return builtins


def asarray_dicts(value: Any) -> list[dict[str, Any]]:
    """Return ``value`` as a list of dicts (empty when not a list of dicts)."""

    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def merge_agentgateway_mcp_routes(
    baseline_config: dict[str, Any],
    targets: Iterable[McpGatewayTarget],
    *,
    route_policies: dict[str, Any] | None = None,
    builtin_routes: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return AgentGateway config with one route per desired MCP target.

    ``builtin_routes`` (id -> route) are statically shipped MCP servers that the
    reconciler protects: they are always re-rendered from their bootstrap
    definition and never pruned. BFF-backed ``targets`` are layered on top as
    *dynamic* routes that may be added or pruned; a dynamic target sharing an id
    with a built-in defers to the built-in definition.
    """

    rendered = copy.deepcopy(baseline_config)
    listener = _first_http_listener(rendered)
    routes = listener.setdefault("routes", [])
    if not isinstance(routes, list):
        routes = []
        listener["routes"] = routes

    policies = route_policies or DEFAULT_MCP_ROUTE_POLICIES
    builtin_routes = builtin_routes or {}
    builtin_ids = set(builtin_routes)
    builtin_paths = {f"/mcp/{target_id}" for target_id in builtin_ids}
    targets_by_id = {target.id: target for target in targets}
    # Dynamic (BFF-managed) targets are everything not shipped as a built-in.
    dynamic_targets = [target for target in targets if target.id not in builtin_ids]
    desired_by_path = {f"/mcp/{target.id}": target for target in dynamic_targets}
    target_policies_by_path = {
        path: target_policies
        for route in routes
        if isinstance(route, dict)
        for path in [_route_path(route)]
        for target_policies in [_target_policies(route)]
        if path in desired_by_path and target_policies
    }
    # The reconciler owns every dynamic ``/mcp/<id>`` route, so drop *all* managed
    # MCP routes from the baseline and re-render the protected built-ins plus the
    # desired dynamic set below. This makes deletion automatic: when an
    # target is removed, its route is no longer in ``desired_by_path``
    # and simply isn't re-added. Built-in routes are exempt — they are restored
    # from ``builtin_routes`` regardless of dynamic target state. Non-MCP routes (and any
    # malformed entries) are always retained.
    stale_paths = sorted(
        path
        for route in routes
        if isinstance(route, dict)
        for path in [_route_path(route)]
        if _is_managed_mcp_route_path(path)
        and path not in desired_by_path
        and path not in builtin_paths
    )
    if stale_paths:
        LOGGER.info("Pruning stale AgentGateway MCP routes: %s", stale_paths)
    retained_routes = [
        route
        for route in routes
        if not (isinstance(route, dict) and _is_managed_mcp_route_path(_route_path(route)))
    ]
    # Protected built-in routes: always present, rendered from their authoritative
    # bootstrap definition unless the BFF reports empty credential_sources — then
    # strip credential header transforms so the upstream MCP uses its own config.
    for target_id in sorted(builtin_ids):
        route = copy.deepcopy(builtin_routes[target_id])
        if not _forward_credentials_through_gateway(targets_by_id.get(target_id)):
            route = _strip_route_credential_forwarding(route)
        retained_routes.append(route)
    retained_routes.extend(
        _mcp_route(
            target,
            _merge_request_transformations(
                _route_policies_for(
                    target.id,
                    policies,
                    forward_credentials=_forward_credentials_through_gateway(target),
                ),
                _credential_source_transformations(target.credential_sources)
                if _forward_credentials_through_gateway(target)
                else {},
            ),
            # Servers handled by a route-level transformation must NOT carry a
            # target-level backendAuth (drop any stale PAT preserved from the
            # live config); their auth comes from the X-CAIPE-Provider-Token
            # transformation merged in by _route_policies_for above.
            target_policies=(
                None
                if _forward_credentials_through_gateway(target)
                and target.id in DEFAULT_MCP_ROUTE_POLICY_OVERRIDES
                else (
                    target_policies_by_path.get(f"/mcp/{target.id}")
                    or DEFAULT_MCP_TARGET_POLICIES.get(target.id)
                )
            ),
        )
        for target in sorted(desired_by_path.values(), key=lambda t: t.id)
    )
    listener["routes"] = retained_routes
    return rendered


def fetch_agentgateway_config(admin_config_url: str) -> dict[str, Any]:
    """Fetch the current live AgentGateway config from the admin endpoint."""

    with urllib.request.urlopen(admin_config_url, timeout=5) as response:
        payload = response.read().decode("utf-8")
    config = json.loads(payload)
    if not isinstance(config, dict):
        raise ValueError("AgentGateway admin config response was not an object")
    return config


def _ensure_published_config_mode(path: Path) -> bool:
    """Ensure AgentGateway's non-root UID can read the generated config."""

    current_mode = stat.S_IMODE(path.stat().st_mode)
    if current_mode == PUBLISHED_CONFIG_MODE:
        return False
    path.chmod(PUBLISHED_CONFIG_MODE)
    return True


def resolve_agentgateway_log_level() -> str:
    """Return the AgentGateway proxy log level from ``AGENTGATEWAY_LOG_LEVEL``."""

    level = os.getenv("AGENTGATEWAY_LOG_LEVEL", DEFAULT_AGENTGATEWAY_LOG_LEVEL).strip().lower()
    if level not in _VALID_AGENTGATEWAY_LOG_LEVELS:
        LOGGER.warning(
            "Invalid AGENTGATEWAY_LOG_LEVEL %r; using %s",
            level,
            DEFAULT_AGENTGATEWAY_LOG_LEVEL,
        )
        return DEFAULT_AGENTGATEWAY_LOG_LEVEL
    return level


def apply_agentgateway_logging(config: dict[str, Any]) -> None:
    """Pin proxy logging on every published config so live admin state cannot revert it."""

    logging_config = config.setdefault("config", {}).setdefault("logging", {})
    logging_config["level"] = resolve_agentgateway_log_level()
    logging_config.setdefault("format", "json")


def apply_agentgateway_jwt_auth(config: dict[str, Any]) -> None:
    """Apply deployment JWT overrides to every listener that enables JWT auth.

    The generated config is normally based on AgentGateway's live admin state.
    Without reapplying these values, a persisted bootstrap issuer can survive a
    deployment hostname change even when the config bridge has the correct
    environment. JWKS remains independently configurable so it can use Docker
    DNS while the issuer matches the browser-facing URL embedded in tokens.
    """

    issuer = os.getenv("AGENTGATEWAY_JWT_ISSUER", "").strip()
    jwks_url = os.getenv("AGENTGATEWAY_JWKS_URL", "").strip()
    audiences_value = os.getenv("AGENTGATEWAY_JWT_AUDIENCES")
    audiences = (
        [value.strip() for value in audiences_value.split(",") if value.strip()]
        if audiences_value is not None
        else None
    )
    if not issuer and not jwks_url and audiences is None:
        return

    for bind in config.get("binds", []):
        if not isinstance(bind, dict):
            continue
        for listener in bind.get("listeners", []):
            if not isinstance(listener, dict):
                continue
            policies = listener.get("policies")
            if not isinstance(policies, dict):
                continue
            jwt_auth = policies.get("jwtAuth")
            if not isinstance(jwt_auth, dict):
                continue
            if issuer:
                jwt_auth["issuer"] = issuer
            if jwks_url:
                jwks = jwt_auth.setdefault("jwks", {})
                if isinstance(jwks, dict):
                    jwks["url"] = jwks_url
            if audiences is not None:
                jwt_auth["audiences"] = audiences


def write_config_atomically(path: Path, config: dict[str, Any]) -> bool:
    """Write config as JSON/YAML-compatible content; return true when changed."""

    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(config, indent=2, sort_keys=False) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == rendered:
        _ensure_published_config_mode(path)
        return False

    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        delete=False,
    ) as handle:
        handle.write(rendered)
        tmp_path = Path(handle.name)
    tmp_path.chmod(PUBLISHED_CONFIG_MODE)
    tmp_path.replace(path)
    return True


def seed_config_from_bootstrap(config_path: Path, bootstrap_path: Path | None) -> bool:
    """Copy the static bootstrap config before AgentGateway is available."""

    if config_path.exists() or bootstrap_path is None or not bootstrap_path.exists():
        return False
    config_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=config_path.parent,
        delete=False,
    ) as handle:
        handle.write(bootstrap_path.read_text(encoding="utf-8"))
        tmp_path = Path(handle.name)
    tmp_path.chmod(PUBLISHED_CONFIG_MODE)
    tmp_path.replace(config_path)
    LOGGER.info("Seeded AgentGateway config from %s", bootstrap_path)
    _mark_reconcile_ok(config_path)
    return True


def _minimal_config() -> dict[str, Any]:
    issuer = os.getenv("AGENTGATEWAY_JWT_ISSUER", "http://localhost:7080/realms/caipe")
    jwks_url = os.getenv(
        "AGENTGATEWAY_JWKS_URL",
        "http://keycloak:7080/realms/caipe/protocol/openid-connect/certs",
    )
    audiences = [
        audience.strip()
        for audience in os.getenv(
            "AGENTGATEWAY_JWT_AUDIENCES",
            "caipe-platform,agentgateway",
        ).split(",")
        if audience.strip()
    ]
    return {
        "binds": [
            {
                "port": int(os.getenv("AGENTGATEWAY_PORT", "4000")),
                "listeners": [
                    {
                        "protocol": "HTTP",
                        "policies": {
                            "jwtAuth": {
                                "mode": "strict",
                                "issuer": issuer,
                                "audiences": audiences,
                                "jwks": {"url": jwks_url},
                            },
                        },
                        "routes": [],
                    },
                ],
            },
        ],
        "config": {
            "adminAddr": os.getenv("AGENTGATEWAY_ADMIN_ADDR", "0.0.0.0:15000"),
            "logging": {
                "level": resolve_agentgateway_log_level(),
                "format": "json",
            },
        },
    }


def load_baseline_config(
    admin_config_url: str,
    *,
    allow_minimal_fallback: bool = True,
) -> dict[str, Any]:
    """Load live config, falling back to a minimal bootstrap config."""

    try:
        return fetch_agentgateway_config(admin_config_url)
    except (OSError, urllib.error.URLError, json.JSONDecodeError, ValueError) as exc:
        if not allow_minimal_fallback:
            raise
        LOGGER.warning("Falling back to minimal AgentGateway config: %s", exc)
        return _minimal_config()


def _load_targets_from_bff() -> list[McpGatewayTarget]:
    targets_url = os.environ["AGENTGATEWAY_TARGETS_URL"]
    token = os.environ["AGENTGATEWAY_TARGETS_TOKEN"]
    timeout = float(os.getenv("AGENTGATEWAY_TARGETS_TIMEOUT_SECONDS", "5"))
    request = urllib.request.Request(
        targets_url,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("AgentGateway targets API returned a non-object payload")
    return select_gateway_targets_from_bff_payload(payload)


def _load_targets() -> list[McpGatewayTarget]:
    return _load_targets_from_bff()


def reconcile_once(
    *,
    config_path: Path,
    admin_config_url: str,
    bootstrap_path: Path | None = None,
) -> dict[str, Any]:
    """Render and write one AgentGateway config generation."""

    try:
        targets = _load_targets()
    except (OSError, urllib.error.URLError, json.JSONDecodeError, ValueError) as exc:
        if config_path.exists():
            LOGGER.warning(
                "UI Backend unavailable; keeping existing config at %s (%s)",
                config_path,
                exc,
            )
            _mark_reconcile_ok(config_path)
            return {
                "changed": False,
                "skipped": True,
                "reason": "bff_unavailable",
                "config_path": str(config_path),
            }
        raise

    try:
        baseline = load_baseline_config(
            admin_config_url,
            allow_minimal_fallback=not config_path.exists(),
        )
    except (OSError, urllib.error.URLError, json.JSONDecodeError, ValueError) as exc:
        if config_path.exists():
            LOGGER.warning(
                "AgentGateway admin unavailable; keeping existing config at %s (%s)",
                config_path,
                exc,
            )
            _mark_reconcile_ok(config_path)
            return {
                "targets": [target.id for target in targets],
                "target_count": len(targets),
                "changed": False,
                "skipped": True,
                "reason": "admin_unavailable",
                "config_path": str(config_path),
            }
        raise
    builtin_routes = load_builtin_mcp_routes(bootstrap_path)
    rendered = merge_agentgateway_mcp_routes(baseline, targets, builtin_routes=builtin_routes)
    apply_agentgateway_jwt_auth(rendered)
    apply_agentgateway_logging(rendered)
    changed = write_config_atomically(config_path, rendered)
    result = {
        "targets": [target.id for target in targets],
        "target_count": len(targets),
        "builtin_count": len(builtin_routes),
        "changed": changed,
        "config_path": str(config_path),
    }
    if changed:
        LOGGER.info("AgentGateway MCP config reconciled: %s", result)
    else:
        LOGGER.debug("AgentGateway MCP config unchanged: %s", result)
    _mark_reconcile_ok(config_path)
    return result


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if not os.getenv("AGENTGATEWAY_TARGETS_URL"):
        raise RuntimeError("AGENTGATEWAY_TARGETS_URL is required")
    if not os.getenv("AGENTGATEWAY_TARGETS_TOKEN"):
        raise RuntimeError("AGENTGATEWAY_TARGETS_TOKEN is required")

    config_path = Path(os.getenv("AGENTGATEWAY_CONFIG_PATH", "/generated/config.yaml"))
    bootstrap_config_path = os.getenv("AGENTGATEWAY_BOOTSTRAP_CONFIG_PATH")
    bootstrap_path = Path(bootstrap_config_path) if bootstrap_config_path else None
    admin_config_url = os.getenv(
        "AGENTGATEWAY_ADMIN_CONFIG_URL",
        "http://agentgateway:15000/config",
    )
    poll_seconds = float(os.getenv("AGENTGATEWAY_CONFIG_BRIDGE_POLL_SECONDS", "5"))
    seed_config_from_bootstrap(config_path, bootstrap_path)

    while True:
        try:
            reconcile_once(
                config_path=config_path,
                admin_config_url=admin_config_url,
                bootstrap_path=bootstrap_path,
            )
        except Exception:
            LOGGER.exception("AgentGateway MCP config reconciliation failed")
        time.sleep(poll_seconds)


if __name__ == "__main__":
    main()
