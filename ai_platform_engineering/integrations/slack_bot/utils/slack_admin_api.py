"""Internal Slack bot admin API for route cache reload and config migration."""

from __future__ import annotations

import hmac
import json
import logging
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional
from urllib.parse import urlparse

import jwt
import requests
from jwt import PyJWKClient
from pymongo import MongoClient
from pymongo.collection import Collection

from .config_models import AgentBinding, Config
from .slack_agent_routes import (
    DEFAULT_OPENFGA_HTTP,
    SlackAgentRouteResolver,
    get_slack_agent_route_resolver,
    slack_agent_route_mode,
    slack_workspace_ref,
)

logger = logging.getLogger("caipe.slack_bot.slack_admin_api")

CollectionFactory = Callable[[str], Optional[Collection[Any]]]
OpenFgaWriter = Callable[[dict[str, str]], None]
RequestGet = Callable[..., requests.Response]


@dataclass(frozen=True)
class SlackAdminAuthResult:
    """Verified Slack admin API caller identity."""

    client_id: str
    subject: str | None
    scopes: list[str]
    claims: dict[str, Any]


class SlackAdminAuthError(PermissionError):
    """Raised when a Slack admin API request is not authorized."""


class SlackAdminTokenValidator:
    """Validate Slack admin API service tokens with Keycloak JWKS."""

    def __init__(
        self,
        *,
        issuer: str | None = None,
        audience: str | None = None,
        jwks_url: str | None = None,
        allowed_client_ids: list[str] | None = None,
    ) -> None:
        self.issuer = issuer or os.environ.get("SLACK_ADMIN_JWT_ISSUER") or os.environ.get("OIDC_ISSUER")
        self.audience = audience or os.environ.get("SLACK_ADMIN_JWT_AUDIENCE", "caipe-slack-bot-admin")
        self.jwks_url = jwks_url or os.environ.get("SLACK_ADMIN_JWKS_URL") or self._discover_jwks_url()
        raw_clients = os.environ.get("SLACK_ADMIN_ALLOWED_CLIENT_IDS", "caipe-ui")
        self.allowed_client_ids = allowed_client_ids or [
            value.strip() for value in raw_clients.split(",") if value.strip()
        ]
        self._jwks_client = PyJWKClient(self.jwks_url) if self.jwks_url else None

    def _validate_dev_token(self, token: str, *, required_scope: str | None = None) -> SlackAdminAuthResult | None:
        """Accept an explicit local-dev token when Keycloak is intentionally disabled."""

        if os.environ.get("SLACK_ADMIN_DEV_AUTH_ENABLED", "false").lower() != "true":
            return None
        expected = os.environ.get("SLACK_ADMIN_DEV_TOKEN", "").strip()
        if not expected:
            raise SlackAdminAuthError("Slack admin dev auth is enabled but SLACK_ADMIN_DEV_TOKEN is not set")
        if not hmac.compare_digest(token, expected):
            return None
        scopes = [required_scope] if required_scope else []
        return SlackAdminAuthResult(
            client_id="local-dev",
            subject="anonymous-local-dev",
            scopes=scopes,
            claims={"dev_auth": True},
        )

    def _discover_jwks_url(self) -> str | None:
        issuer = self.issuer
        if not issuer:
            return None
        discovery_base = os.environ.get("OIDC_DISCOVERY_URL") or issuer
        discovery_url = discovery_base.rstrip("/")
        if not discovery_url.endswith("/.well-known/openid-configuration"):
            discovery_url = f"{discovery_url}/.well-known/openid-configuration"
        response = requests.get(discovery_url, timeout=5)
        response.raise_for_status()
        jwks_url = response.json().get("jwks_uri")
        return str(jwks_url) if jwks_url else None

    def validate(self, token: str, *, required_scope: str | None = None) -> SlackAdminAuthResult:
        dev_result = self._validate_dev_token(token, required_scope=required_scope)
        if dev_result is not None:
            return dev_result

        if not self.issuer or not self.audience or not self._jwks_client:
            raise SlackAdminAuthError("Slack admin JWT validation is not configured")
        try:
            signing_key = self._jwks_client.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256", "RS384", "RS512", "ES256"],
                audience=self.audience,
                issuer=self.issuer,
            )
        except Exception as exc:  # noqa: BLE001 - auth library exposes several exception types
            raise SlackAdminAuthError("Invalid Slack admin bearer token") from exc

        client_id = str(claims.get("azp") or claims.get("client_id") or "").strip()
        if self.allowed_client_ids and client_id not in self.allowed_client_ids:
            raise SlackAdminAuthError("Slack admin bearer token client is not allowed")

        scopes = str(claims.get("scope") or "").split()
        if required_scope and required_scope not in scopes:
            raise SlackAdminAuthError(f"Slack admin bearer token is missing scope {required_scope}")

        return SlackAdminAuthResult(
            client_id=client_id,
            subject=str(claims.get("sub")) if claims.get("sub") else None,
            scopes=scopes,
            claims=claims,
        )


class SlackBotAdminService:
    """Operations exposed through the internal Slack bot admin API."""

    def __init__(
        self,
        *,
        config: Config,
        resolver: SlackAgentRouteResolver,
        collection_factory: CollectionFactory | None = None,
        openfga_writer: OpenFgaWriter | None = None,
        request_get: RequestGet = requests.get,
    ) -> None:
        self._config = config
        self._resolver = resolver
        self._collection_factory = collection_factory
        self._openfga_writer = openfga_writer
        self._request_get = request_get
        self._client: Optional[MongoClient] = None
        self._db_name = os.environ.get("MONGODB_DATABASE", "caipe")
        self._last_sync: dict[str, Any] | None = None

    def _get_client(self) -> Optional[MongoClient]:
        uri = os.environ.get("MONGODB_URI", "").strip()
        if not uri:
            return None
        if self._client is None:
            self._client = MongoClient(uri, serverSelectionTimeoutMS=5000, retryWrites=False)
        return self._client

    def _collection(self, name: str) -> Optional[Collection[Any]]:
        if self._collection_factory is not None:
            return self._collection_factory(name)
        client = self._get_client()
        if client is None:
            return None
        return client[self._db_name][name]

    def status(self) -> dict[str, Any]:
        route_count = sum(len(channel.agents) for channel in self._config.channels.values())
        return {
            "route_mode": slack_agent_route_mode(),
            "static_config": {
                "channels": len(self._config.channels),
                "routes": route_count,
            },
            "route_cache": self._resolver.cache_status(),
            "last_sync": self._last_sync,
        }

    def send_notification(self, *, channel_id: str, text: str) -> dict[str, str]:
        """Send an operator-configured publication approval notification."""

        normalized_channel_id = channel_id.strip()
        normalized_text = text.strip()
        if not normalized_channel_id:
            raise ValueError("channel_id is required")
        if not normalized_text:
            raise ValueError("text is required")
        if len(normalized_text) > 4000:
            raise ValueError("text must not exceed 4000 characters")

        token = os.environ.get(
            "SLACK_INTEGRATION_BOT_TOKEN",
            os.environ.get("SLACK_BOT_TOKEN", ""),
        ).strip()
        if not token:
            raise RuntimeError("No Slack bot token is configured for notifications")
        response = requests.post(
            "https://slack.com/api/chat.postMessage",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            json={
                "channel": normalized_channel_id,
                "text": normalized_text,
                "unfurl_links": False,
            },
            timeout=10,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("ok") is not True:
            raise RuntimeError(str(payload.get("error") or "Slack rejected the notification"))
        return {
            "channel_id": normalized_channel_id,
            "message_ts": str(payload.get("ts") or ""),
        }

    def inspect_channel(self, *, channel_id: str) -> dict[str, Any]:
        """Return provider-owned metadata used by publication risk policy.

        The browser-supplied name, membership count, and workspace identifier
        are deliberately ignored by the onboarding API. This lookup also proves
        that the configured bot is currently a member of the channel.
        """

        normalized_channel_id = channel_id.strip()
        if not normalized_channel_id:
            raise ValueError("channel_id is required")
        token = os.environ.get(
            "SLACK_INTEGRATION_BOT_TOKEN",
            os.environ.get("SLACK_BOT_TOKEN", ""),
        ).strip()
        if not token:
            raise RuntimeError("No Slack bot token is configured for channel inspection")
        headers = {"Authorization": f"Bearer {token}"}
        channel_response = self._request_get(
            "https://slack.com/api/conversations.info",
            headers=headers,
            params={"channel": normalized_channel_id, "include_num_members": "true"},
            timeout=10,
        )
        channel_response.raise_for_status()
        channel_payload = channel_response.json()
        if not isinstance(channel_payload, dict) or channel_payload.get("ok") is not True:
            error = (
                channel_payload.get("error")
                if isinstance(channel_payload, dict)
                else None
            )
            raise ValueError(str(error or "Slack rejected the channel lookup"))
        channel = channel_payload.get("channel")
        if not isinstance(channel, dict):
            raise RuntimeError("Slack returned an invalid channel response")
        if channel.get("is_member") is not True:
            raise ValueError("The configured Slack bot is not a member of this channel")

        auth_response = self._request_get(
            "https://slack.com/api/auth.test",
            headers=headers,
            timeout=10,
        )
        auth_response.raise_for_status()
        auth_payload = auth_response.json()
        if not isinstance(auth_payload, dict) or auth_payload.get("ok") is not True:
            error = auth_payload.get("error") if isinstance(auth_payload, dict) else None
            raise RuntimeError(str(error or "Slack rejected the workspace lookup"))
        workspace_id = str(auth_payload.get("team_id") or "").strip()
        if not workspace_id:
            raise RuntimeError("Slack did not return a workspace identifier")

        member_count = channel.get("num_members")
        return {
            "workspace_id": workspace_id,
            "channel_id": str(channel.get("id") or normalized_channel_id),
            "channel_name": str(channel.get("name") or normalized_channel_id),
            **(
                {"member_count": member_count}
                if isinstance(member_count, int)
                and not isinstance(member_count, bool)
                and member_count >= 0
                else {}
            ),
        }

    def config_defaults(self, *, workspace_id: str | None = None) -> dict[str, Any]:
        """Return structured legacy channel-agent defaults from loaded config."""
        workspace_ref = slack_workspace_ref(workspace_id)
        channels: dict[str, dict[str, Any]] = {}
        routes_seen = 0
        for channel_id, channel in self._config.channels.items():
            agents: list[dict[str, Any]] = []
            for index, agent in enumerate(channel.agents):
                agents.append(_agent_config_default(agent, index))
                routes_seen += 1

            channels[channel_id] = {
                "workspace_id": workspace_ref,
                "channel_id": channel_id,
                "channel_name": channel.name,
                "agents": agents,
                "suggested_agent_id": _suggested_agent_id(agents),
            }

        return {
            "workspace_id": workspace_ref,
            "channels_seen": len(channels),
            "routes_seen": routes_seen,
            "channels": channels,
        }

    def reload_routes(
        self,
        *,
        workspace_id: str | None = None,
        channel_id: str | None = None,
    ) -> dict[str, str]:
        if workspace_id and channel_id:
            self._resolver.invalidate(workspace_id, channel_id)
            return {"reloaded": "channel", "workspace_id": workspace_id, "channel_id": channel_id}
        self._resolver.invalidate_all()
        return {"reloaded": "all"}

    def sync_from_config(
        self,
        *,
        workspace_id: str | None = None,
        dry_run: bool = True,
        actor: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        workspace_ref = slack_workspace_ref(workspace_id)
        routes = self._collection("slack_channel_agent_routes")
        if routes is None and not dry_run:
            raise RuntimeError("MongoDB is not configured for Slack route sync")

        now = datetime.now(timezone.utc).isoformat()
        planned = self._planned_routes(workspace_ref)
        summary: dict[str, Any] = {
            "dry_run": dry_run,
            "workspace_id": workspace_ref,
            "channels_seen": len(self._config.channels),
            "routes_planned": len(planned),
            "routes_upserted": 0,
            "openfga_tuples_written": 0,
            # Full per-channel/agent breakdown so the admin UI preview can show
            # exactly what an import will write (listen modes, allow lists,
            # overthink, escalation) instead of bare counts. The TS layer
            # enriches each channel with its current team mapping before render.
            "channels": self._planned_channels(workspace_ref),
            "updated_at": now,
            "actor": actor or {},
        }

        if dry_run:
            self._last_sync = summary
            return summary

        assert routes is not None
        for route in planned:
            routes.update_one(
                {
                    "workspace_id": route["workspace_id"],
                    "channel_id": route["channel_id"],
                    "agent_id": route["agent_id"],
                },
                {
                    "$set": {
                        **route,
                        "source_type": "config_sync",
                        "status": "active",
                        "updated_by": "slack_admin_sync",
                        "updated_at": now,
                    },
                    "$setOnInsert": {
                        "created_by": "slack_admin_sync",
                        "created_at": now,
                    },
                },
                upsert=True,
            )
            summary["routes_upserted"] += 1
            self._write_openfga_tuple(
                {
                    "user": f"slack_channel:{route['workspace_id']}--{route['channel_id']}",
                    "relation": "user",
                    "object": f"agent:{route['agent_id']}",
                }
            )
            summary["openfga_tuples_written"] += 1
            self._resolver.invalidate(str(route["workspace_id"]), str(route["channel_id"]))

        self._last_sync = summary
        return summary

    def _planned_routes(self, workspace_ref: str) -> list[dict[str, Any]]:
        planned: list[dict[str, Any]] = []
        for channel_id, channel in self._config.channels.items():
            for index, agent in enumerate(channel.agents):
                planned.append(_route_from_agent_binding(workspace_ref, channel_id, agent, index))
        return planned

    def _planned_channels(self, workspace_ref: str) -> list[dict[str, Any]]:
        """Return a human-reviewable breakdown of what an import will write.

        One entry per channel, each with the full per-agent config (listen
        modes, allow lists, overthink, escalation). Drives the admin UI
        "Slack Bot Config Sync Preview" so admins can see every option being
        imported, not just route counts.
        """
        channels: list[dict[str, Any]] = []
        for channel_id, channel in self._config.channels.items():
            channels.append(
                {
                    "workspace_id": workspace_ref,
                    "channel_id": channel_id,
                    "channel_name": channel.name,
                    # Optional owning team from the YAML config; lets the import
                    # assign the channel to a team instead of leaving it team-less.
                    "team": channel.team,
                    "agents": [
                        _planned_agent_detail(agent, index)
                        for index, agent in enumerate(channel.agents)
                    ],
                }
            )
        return channels

    def _write_openfga_tuple(self, tuple_key: dict[str, str]) -> None:
        if self._openfga_writer is not None:
            self._openfga_writer(tuple_key)
            return

        base_url = (os.environ.get("OPENFGA_HTTP", "").strip() or DEFAULT_OPENFGA_HTTP).rstrip("/")
        store_id = _openfga_store_id(base_url)
        response = requests.post(
            f"{base_url}/stores/{store_id}/write",
            headers={"Content-Type": "application/json"},
            json={"writes": {"tuple_keys": [tuple_key]}},
            timeout=5,
        )
        if response.status_code >= 400 and "already" not in response.text.lower():
            response.raise_for_status()


def _planned_agent_detail(agent: AgentBinding, index: int) -> dict[str, Any]:
    """Serialize a single AgentBinding for the import preview.

    Unlike ``_route_from_agent_binding`` (which builds the persisted route
    doc), this keeps the full ``overthink`` block and always includes the
    ``users``/``bots``/``escalation`` keys when present so the UI can render
    a complete picture of what gets imported.
    """
    detail: dict[str, Any] = {
        "agent_id": agent.agent_id,
        "priority": (index + 1) * 100,
        # Mirror what the import will persist so the preview shows the right
        # "Run as" value (defaults to User for legacy configs).
        "execution_identity": _import_execution_identity(agent),
    }
    if agent.users is not None:
        detail["users"] = agent.users.model_dump(exclude_none=True)
    if agent.bots is not None:
        detail["bots"] = agent.bots.model_dump(exclude_none=True)
    if agent.escalation is not None:
        detail["escalation"] = agent.escalation.model_dump(exclude_none=True)
    return detail


def _route_from_agent_binding(
    workspace_ref: str,
    channel_id: str,
    agent: AgentBinding,
    index: int,
) -> dict[str, Any]:
    route: dict[str, Any] = {
        "workspace_id": workspace_ref,
        "channel_id": channel_id,
        "agent_id": agent.agent_id,
        "enabled": True,
        "priority": (index + 1) * 100,
        # Always persist execution_identity explicitly so imported routes are
        # never ambiguous. The static slack-bot YAML config predates this field,
        # so legacy imports must default to "User" (obo_user) — only carry a
        # service_account when the config explicitly named one with a valid sub.
        "execution_identity": _import_execution_identity(agent),
    }
    if agent.users is not None:
        route["users"] = agent.users.model_dump(exclude_none=True)
    if agent.bots is not None:
        route["bots"] = agent.bots.model_dump(exclude_none=True)
    if agent.escalation is not None:
        route["escalation"] = agent.escalation.model_dump(exclude_none=True)
    return route


def _import_execution_identity(agent: AgentBinding) -> dict[str, Any]:
    """Execution identity to persist for an imported route.

    Defaults to ``obo_user`` (the static YAML config never had this field, so a
    plain import must not produce service-account routes). Only emits a
    ``service_account`` identity when the config explicitly set that mode AND a
    non-empty ``service_account_sub`` — otherwise falls back to ``obo_user`` to
    avoid corrupted entries on import.
    """
    exec_id = agent.execution_identity
    if exec_id.mode == "service_account" and (exec_id.service_account_sub or "").strip():
        identity: dict[str, Any] = {
            "mode": "service_account",
            "service_account_sub": exec_id.service_account_sub,
        }
        if exec_id.service_account_name:
            identity["service_account_name"] = exec_id.service_account_name
        return identity
    return {"mode": "obo_user"}


def _openfga_store_id(base_url: str) -> str:
    explicit = os.environ.get("OPENFGA_STORE_ID", "").strip()
    if explicit:
        return explicit

    store_name = os.environ.get("OPENFGA_STORE_NAME", "caipe-openfga").strip()
    response = requests.get(f"{base_url}/stores", headers={"Content-Type": "application/json"}, timeout=5)
    response.raise_for_status()
    for store in response.json().get("stores", []):
        if store.get("name") == store_name and store.get("id"):
            return str(store["id"])
    raise requests.RequestException(f"OpenFGA store {store_name!r} was not found")


class _SlackAdminRequestHandler(BaseHTTPRequestHandler):
    service: SlackBotAdminService
    validator: SlackAdminTokenValidator

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        path = urlparse(self.path).path
        if path not in {"/admin/slack/routes/status", "/admin/slack/routes/config-defaults"}:
            self._write_json({"error": "not_found"}, status=404)
            return
        if not self._authorize(scope_env="SLACK_ADMIN_STATUS_SCOPE"):
            return
        if path == "/admin/slack/routes/config-defaults":
            self._write_json(self.service.config_defaults())
            return
        self._write_json(self.service.status())

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        path = urlparse(self.path).path
        body = self._read_json()
        if path == "/admin/slack/routes/reload":
            if not self._authorize(scope_env="SLACK_ADMIN_RELOAD_SCOPE"):
                return
            self._write_json(
                self.service.reload_routes(
                    workspace_id=_optional_string(body.get("workspace_id")),
                    channel_id=_optional_string(body.get("channel_id")),
                )
            )
            return
        if path == "/admin/slack/routes/sync-from-config":
            if not self._authorize(scope_env="SLACK_ADMIN_SYNC_SCOPE"):
                return
            try:
                self._write_json(
                    self.service.sync_from_config(
                        workspace_id=_optional_string(body.get("workspace_id")),
                        dry_run=body.get("dry_run") is not False,
                        actor=body.get("actor") if isinstance(body.get("actor"), dict) else {},
                    )
                )
            except Exception as exc:  # noqa: BLE001 - returned as JSON to admin client
                logger.warning("Slack admin config sync failed: %s", exc)
                self._write_json({"error": str(exc)}, status=500)
            return
        if path == "/admin/slack/notifications":
            if not self._authorize(scope_env="SLACK_ADMIN_NOTIFICATION_SCOPE"):
                return
            try:
                self._write_json(
                    self.service.send_notification(
                        channel_id=_required_string(body.get("channel_id"), "channel_id"),
                        text=_required_string(body.get("text"), "text"),
                    )
                )
            except ValueError as exc:
                self._write_json({"error": str(exc)}, status=400)
            except RuntimeError as exc:
                self._write_json({"error": str(exc)}, status=503)
            except requests.RequestException as exc:
                logger.warning("Slack approval notification failed: %s", exc)
                self._write_json({"error": "slack_api_unavailable"}, status=502)
            return
        if path == "/admin/slack/channels/inspect":
            if not self._authorize(scope_env="SLACK_ADMIN_STATUS_SCOPE"):
                return
            try:
                self._write_json(
                    self.service.inspect_channel(
                        channel_id=_required_string(body.get("channel_id"), "channel_id"),
                    )
                )
            except ValueError as exc:
                self._write_json({"error": str(exc)}, status=400)
            except RuntimeError as exc:
                self._write_json({"error": str(exc)}, status=503)
            except requests.RequestException as exc:
                logger.warning("Slack channel inspection failed: %s", exc)
                self._write_json({"error": "slack_api_unavailable"}, status=502)
            return
        self._write_json({"error": "not_found"}, status=404)

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _authorize(self, *, scope_env: str) -> bool:
        header = self.headers.get("Authorization", "")
        token = header.removeprefix("Bearer ").strip()
        if not token:
            self._write_json({"error": "missing_bearer"}, status=401)
            return False
        try:
            required_scope = os.environ.get(scope_env, "").strip() or None
            self.validator.validate(token, required_scope=required_scope)
            return True
        except SlackAdminAuthError as exc:
            self._write_json({"error": str(exc)}, status=403)
            return False

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}

    def _write_json(self, payload: dict[str, Any], *, status: int = 200) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def _optional_string(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _required_string(value: object, field: str) -> str:
    normalized = _optional_string(value)
    if normalized is None:
        raise ValueError(f"{field} is required")
    return normalized


def _suggested_agent_id(agents: list[dict[str, Any]]) -> str | None:
    for agent in agents:
        users = agent.get("users")
        if isinstance(users, dict) and users.get("enabled") is not False:
            agent_id = agent.get("agent_id")
            return str(agent_id) if agent_id else None
    for agent in agents:
        agent_id = agent.get("agent_id")
        if agent_id:
            return str(agent_id)
    return None


def _agent_config_default(agent: AgentBinding, index: int) -> dict[str, Any]:
    default: dict[str, Any] = {
        "agent_id": agent.agent_id,
        "priority": (index + 1) * 100,
    }
    if agent.users is not None:
        default["users"] = {
            "enabled": agent.users.enabled,
            **({"listen": agent.users.listen} if agent.users.listen else {}),
        }
    if agent.bots is not None:
        default["bots"] = {
            "enabled": agent.bots.enabled,
            **({"listen": agent.bots.listen} if agent.bots.listen else {}),
        }
    if agent.escalation is not None:
        default["escalation"] = agent.escalation.model_dump(exclude_none=True)
    return default


def start_slack_admin_api_server(config: Config) -> ThreadingHTTPServer | None:
    """Start the internal admin API in a background thread when enabled."""

    if os.environ.get("SLACK_ADMIN_API_ENABLED", "false").lower() != "true":
        return None
    host = os.environ.get("SLACK_ADMIN_API_HOST", "0.0.0.0")
    port = int(os.environ.get("SLACK_ADMIN_API_PORT", "3001"))
    service = SlackBotAdminService(config=config, resolver=get_slack_agent_route_resolver())
    validator = SlackAdminTokenValidator()

    class Handler(_SlackAdminRequestHandler):
        pass

    Handler.service = service
    Handler.validator = validator
    server = ThreadingHTTPServer((host, port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True, name="slack-admin-api")
    thread.start()
    logger.info("Started Slack bot admin API on %s:%s", host, port)
    return server
