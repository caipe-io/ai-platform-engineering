"""OpenFGA-backed Webex space agent routes with optional Mongo metadata."""

from __future__ import annotations

import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable, Literal, Optional

import requests
from pymongo import MongoClient
from pymongo.collection import Collection
from pymongo.errors import PyMongoError
from pydantic import ValidationError

from ai_platform_engineering.integrations.slack_bot.utils.config_models import (
    AgentBinding,
    BotsConfig,
    EscalationConfig,
    UsersConfig,
)
from ai_platform_engineering.integrations.webex_bot.utils.user_messages import (
    WEBEX_DIRECT_AGENT_REQUIRED_MESSAGE,
    WEBEX_SPACE_MENTION_REQUIRED_MESSAGE,
    WEBEX_SPACE_SETUP_REQUIRED_MESSAGE,
)
from ai_platform_engineering.integrations.webex_bot.utils.webex_bot_catalog import (
    configured_webex_bot,
)
logger = logging.getLogger("caipe.webex_bot.webex_agent_routes")
DEFAULT_OPENFGA_HTTP = "http://openfga:8080"

WebexAgentRouteMode = Literal["config", "db_prefer", "db_only"]
CollectionFactory = Callable[[], Optional[Collection[Any]]]
AuditEventWriter = Callable[[dict[str, Any]], None]
OpenFgaAgentIdsFactory = Callable[[str, str, str], list[str] | None]


def webex_agent_route_mode() -> WebexAgentRouteMode:
    """Return how Webex should source space agent routes.

    Modes:
    - ``config``: static/env config only (default).
    - ``db_prefer``: Mongo + OpenFGA when present, else static fallback.
    - ``db_only``: Mongo + OpenFGA only.

    ``WEBEX_AGENT_ROUTES_ENABLED=true`` is accepted as an alias for ``db_prefer``.
    """

    explicit = os.environ.get("WEBEX_AGENT_ROUTES_MODE", "").strip().lower()
    if explicit in {"config", "db_prefer", "db_only"}:
        return explicit  # type: ignore[return-value]
    if os.environ.get("WEBEX_AGENT_ROUTES_ENABLED", "false").lower() == "true":
        return "db_prefer"
    return "config"


def webex_workspace_ref(workspace_id: Optional[str] = None) -> str:
    """Canonical workspace namespace for Webex ReBAC and OpenFGA subjects.

    Priority: explicit workspace_id > WEBEX_WORKSPACE_ALIAS > WEBEX_WORKSPACE_ID > "unknown".
    Callers that pass workspace_id explicitly (e.g. the "unknown" legacy fallback in
    _load_routes) get their value back unchanged so the lookup uses the right prefix.
    """
    if workspace_id is not None and workspace_id.strip():
        return workspace_id.strip()
    alias = os.environ.get("WEBEX_WORKSPACE_ALIAS", "").strip()
    if alias:
        return alias
    fallback = os.environ.get("WEBEX_WORKSPACE_ID", "").strip()
    return fallback or "unknown"


def webex_space_openfga_subject(workspace_id: str, space_id: str) -> str:
    """OpenFGA user subject for a Webex space (``webex_space:<ref>--<space>``)."""

    workspace_ref = webex_workspace_ref(workspace_id)
    return f"webex_space:{workspace_ref}--{space_id}"


def webex_bot_installation_openfga_subject(
    bot_id: str, workspace_id: str, space_id: str
) -> str:
    """OpenFGA subject for one configured bot operating in one Webex space."""

    workspace_ref = webex_workspace_ref(workspace_id)
    return f"webex_bot_installation:{bot_id}--{workspace_ref}--{space_id}"


def infer_listen_mode(text: str) -> Literal["message", "mention"]:
    """Classify a Webex message as plain text or mention-triggered."""

    stripped = (text or "").strip()
    if not stripped:
        return "mention"
    if stripped.startswith("@"):
        return "mention"
    mention_pattern = os.environ.get("WEBEX_BOT_MENTION_PATTERN", "").strip()
    if mention_pattern:
        try:
            if re.search(mention_pattern, stripped, re.IGNORECASE):
                return "mention"
        except re.error:
            logger.warning("Invalid WEBEX_BOT_MENTION_PATTERN; ignoring")
    return "message"


class WebexAgentRouteResolver:
    """Load OpenFGA-backed Webex agent routes with optional Mongo metadata."""

    def __init__(
        self,
        *,
        ttl_seconds: Optional[int] = None,
        collection_factory: Optional[CollectionFactory] = None,
        audit_event_writer: Optional[AuditEventWriter] = None,
        openfga_agent_ids_factory: Optional[OpenFgaAgentIdsFactory] = None,
    ) -> None:
        self._ttl = ttl_seconds if ttl_seconds is not None else _ttl_from_env()
        self._collection_factory = collection_factory
        self._audit_event_writer = audit_event_writer
        self._openfga_agent_ids_factory = openfga_agent_ids_factory
        self._client: Optional[MongoClient] = None
        self._db_name = os.environ.get("MONGODB_DATABASE", "caipe")
        self._cache: dict[tuple[str, str, str], tuple[list[dict[str, Any]], float]] = {}
        self._last_errors: dict[tuple[str, str], str] = {}

    def _get_client(self) -> Optional[MongoClient]:
        uri = os.environ.get("MONGODB_URI", "").strip()
        if not uri:
            return None
        if self._client is None:
            try:
                self._client = MongoClient(
                    uri,
                    serverSelectionTimeoutMS=5000,
                    retryWrites=False,
                )
            except PyMongoError as exc:
                logger.warning("WebexAgentRouteResolver: MongoDB client init failed: %s", exc)
                return None
        return self._client

    def _get_collection(self) -> Optional[Collection[Any]]:
        if self._collection_factory is not None:
            return self._collection_factory()

        client = self._get_client()
        if client is None:
            return None
        return client[self._db_name]["webex_space_agent_routes"]

    def _write_audit_event(self, event: dict[str, Any]) -> None:
        if self._audit_event_writer is not None:
            self._audit_event_writer(event)
            return
        if os.environ.get("AUDIT_LOG_BACKEND", "service").strip().lower() != "service":
            return
        service_url = os.environ.get("AUDIT_SERVICE_URL", "").strip().rstrip("/")
        if not service_url:
            return
        try:
            requests.post(
                f"{service_url}/v1/audit/events",
                headers={"Content-Type": "application/json"},
                json={"events": [event]},
                timeout=1,
            ).raise_for_status()
        except requests.RequestException as exc:
            logger.warning("WebexAgentRouteResolver: failed to write runtime audit event: %s", exc)

    def _record_runtime_error(
        self,
        *,
        workspace_id: str,
        space_id: str,
        reason_code: str,
        action: str,
        message: str,
    ) -> None:
        self._write_audit_event(
            {
                "type": "webex_runtime",
                "component": "webex_bot",
                "source": "webex",
                "outcome": "error",
                "action": action,
                "reason_code": reason_code,
                "resource_ref": webex_space_openfga_subject(workspace_id, space_id),
                "message": message,
                "ts": datetime.now(timezone.utc).isoformat(),
            }
        )

    def _load_routes(
        self, bot_id: str, workspace_id: str, space_id: str
    ) -> list[dict[str, Any]]:
        agent_ids = self._load_openfga_agent_ids(bot_id, workspace_id, space_id)
        if agent_ids is None:
            return []
        if not agent_ids and workspace_id != "unknown":
            agent_ids = self._load_openfga_agent_ids(bot_id, "unknown", space_id)
            if agent_ids is None:
                return []
        if not agent_ids:
            return []

        collection = self._get_collection()
        if collection is None:
            return []

        try:
            routes = self._query_routes(collection, bot_id, workspace_id, space_id)
            if not routes and workspace_id != "unknown":
                routes = self._query_routes(collection, bot_id, "unknown", space_id)
            return _merge_openfga_agents_with_route_metadata(agent_ids, routes)
        except PyMongoError as exc:
            logger.warning("WebexAgentRouteResolver: route query failed: %s", exc)
            return []

    def _load_openfga_agent_ids(
        self, bot_id: str, workspace_id: str, space_id: str
    ) -> list[str] | None:
        if self._openfga_agent_ids_factory is not None:
            return self._openfga_agent_ids_factory(bot_id, workspace_id, space_id)

        base_url = (os.environ.get("OPENFGA_HTTP", "").strip() or DEFAULT_OPENFGA_HTTP).rstrip("/")
        space_subject = webex_bot_installation_openfga_subject(
            bot_id, workspace_id, space_id
        )

        try:
            store_id = _openfga_store_id(base_url)
            agent_ids: list[str] = []
            seen: set[str] = set()
            continuation_token: str | None = None
            while True:
                body: dict[str, Any] = {
                    "page_size": 100,
                    "tuple_key": {
                        "user": space_subject,
                        "relation": "user",
                        "object": "agent:",
                    },
                }
                if continuation_token:
                    body["continuation_token"] = continuation_token
                response = requests.post(
                    f"{base_url}/stores/{store_id}/read",
                    headers={"Content-Type": "application/json"},
                    json=body,
                    timeout=5,
                )
                response.raise_for_status()
                payload = response.json()
                for agent_id in _agent_ids_from_openfga_read(payload, space_subject):
                    if agent_id not in seen:
                        seen.add(agent_id)
                        agent_ids.append(agent_id)
                continuation_token = payload.get("continuation_token") or None
                if not continuation_token:
                    self._last_errors.pop((workspace_id, space_id), None)
                    return agent_ids
        except requests.RequestException as exc:
            logger.warning("WebexAgentRouteResolver: OpenFGA tuple read failed: %s", exc)
            self._last_errors[(workspace_id, space_id)] = str(exc)
            self._record_runtime_error(
                workspace_id=workspace_id,
                space_id=space_id,
                action="webex.route.openfga_read",
                reason_code="OPENFGA_READ_FAILED",
                message=str(exc),
            )
            return None

    def last_error(self, bot_id: str, workspace_id: str, space_id: str) -> str | None:
        """Return the latest route-loading error for a space, if any."""

        del bot_id
        return self._last_errors.get((workspace_id, space_id))

    def _query_routes(
        self,
        collection: Collection[Any],
        bot_id: str,
        workspace_id: str,
        space_id: str,
    ) -> list[dict[str, Any]]:
        base_query: dict[str, Any] = {
            "workspace_id": workspace_id,
            "space_id": space_id,
            "status": "active",
            "enabled": {"$ne": False},
        }
        cursor = collection.find({**base_query, "bot_id": bot_id}).sort(
            [
                ("updated_at", -1),
                ("created_at", -1),
                ("priority", 1),
                ("agent_id", 1),
            ]
        )
        if hasattr(cursor, "limit"):
            cursor = cursor.limit(1)
        if hasattr(cursor, "to_list"):
            routes = list(cursor.to_list())  # type: ignore[no-any-return, operator]
        else:
            routes = list(cursor)
        return routes

    def _cached_routes(
        self, bot_id: str, workspace_id: str, space_id: str
    ) -> list[dict[str, Any]]:
        now = time.monotonic()
        key = (bot_id, workspace_id, space_id)
        cached = self._cache.get(key)
        if cached and now - cached[1] < self._ttl:
            return cached[0]

        routes = self._load_routes(bot_id, workspace_id, space_id)
        self._cache[key] = (routes, now)
        return routes

    def match_routes(
        self,
        *,
        bot_id: str,
        workspace_id: str,
        space_id: str,
        is_bot: bool,
        bot_username: Optional[str] = None,
        user_id: Optional[str] = None,
        listen: Optional[str] = None,
    ) -> list[AgentBinding]:
        """Return active DB route matches as ``AgentBinding`` objects."""

        matches: list[AgentBinding] = []
        for route in self._cached_routes(bot_id, workspace_id, space_id):
            binding = _route_to_agent_binding(route)
            if binding is None:
                continue
            if is_bot:
                if _side_matches(binding.bots, listen, bot_username, "bot_list"):
                    matches.append(binding)
            elif _side_matches(binding.users, listen, user_id, "user_list"):
                matches.append(binding)
        return matches

    def explain_no_route_match(
        self,
        *,
        bot_id: str,
        workspace_id: str,
        space_id: str,
        is_bot: bool,
        bot_username: Optional[str] = None,
        user_id: Optional[str] = None,
        listen: Optional[str] = None,
        app_name: str = "CAIPE",
        route_required: bool = False,
        is_direct: bool = False,
    ) -> str | None:
        """Return a user-facing explanation when a routed Webex message has no match."""

        if self.last_error(bot_id, workspace_id, space_id):
            return (
                f"{app_name} could not read Webex routing relationships from OpenFGA, "
                "so I cannot safely dispatch this message. Please try again shortly "
                "or ask an admin to check Webex Runtime Diagnostics."
            )

        candidates = self.match_routes(
            bot_id=bot_id,
            workspace_id=workspace_id,
            space_id=space_id,
            is_bot=is_bot,
            bot_username=bot_username,
            user_id=user_id,
            listen=None,
        )
        if self.last_error(bot_id, workspace_id, space_id):
            return (
                f"{app_name} could not read Webex routing relationships from OpenFGA, "
                "so I cannot safely dispatch this message. Please try again shortly "
                "or ask an admin to check Webex Runtime Diagnostics."
            )
        if is_direct:
            return WEBEX_DIRECT_AGENT_REQUIRED_MESSAGE.format(app_name=app_name)
        if candidates and listen == "message":
            return WEBEX_SPACE_MENTION_REQUIRED_MESSAGE.format(app_name=app_name)
        if candidates and listen == "mention":
            return (
                f"I found Webex routes for this space, but none can respond to "
                f"{app_name} mentions yet. Ask an admin to check this space's "
                f"Webex setup in {app_name}."
            )
        if route_required:
            return WEBEX_SPACE_SETUP_REQUIRED_MESSAGE.format(app_name=app_name)
        return None

    def invalidate(self, bot_id: str, workspace_id: str, space_id: str) -> None:
        self._cache.pop((bot_id, workspace_id, space_id), None)

    def invalidate_all(self) -> None:
        self._cache.clear()

    def cache_status(self) -> dict[str, Any]:
        return {
            "ttl_seconds": self._ttl,
            "cache_size": len(self._cache),
            "cached_spaces": [
                f"{bot_id}/{workspace_id}/{space_id}"
                for bot_id, workspace_id, space_id in self._cache
            ],
            "last_errors": {
                f"{workspace_id}/{space_id}": error
                for (workspace_id, space_id), error in self._last_errors.items()
            },
        }


async def resolve_webex_agent_route(
    *,
    bot_id: str,
    workspace_id: str,
    space_id: str,
    person_id: str,
    text: str,
    is_direct: bool = False,
    was_bot_mentioned: bool = False,
    thread_parent_id: Optional[str] = None,
    resolver: WebexAgentRouteResolver | None = None,
) -> tuple[Optional[str], Optional[str]]:
    """Resolve the agent for a Webex message (agent_id, deny_message)."""

    mode = webex_agent_route_mode()
    # assisted-by Codex Codex-sonnet-4-6
    # 1:1 Webex rooms have no mention gesture, so direct messages should
    # use any active user route for that room instead of requiring message mode.
    listen = (
        None
        if is_direct
        else "mention"
        if was_bot_mentioned
        else infer_listen_mode(text)
    )
    active = resolver or get_webex_agent_route_resolver()
    bot = configured_webex_bot(bot_id)
    default_agent_id = (
        bot.spaces.default_agent_id
        if bot is not None and bot.spaces_access_mode == "all_spaces"
        else None
    )

    if mode == "config":
        if default_agent_id:
            return default_agent_id, None
        return None, "No agent route is configured for this Webex space."

    # Thread replies are excluded from passive message-mode routing, mirroring
    # Slack's handle_message_events which skips true thread replies before its
    # listen-mode filter runs. Webex's parentId (thread_parent_id here) is only
    # ever populated on true replies, never on the root message, so a plain
    # truthiness check is sufficient. @mentions still route from within a
    # thread since that only applies when the inferred mode is "message".
    if listen == "message" and thread_parent_id:
        return None, None

    matches = active.match_routes(
        bot_id=bot_id,
        workspace_id=workspace_id,
        space_id=space_id,
        is_bot=False,
        user_id=person_id,
        listen=listen,
    )
    if active.last_error(bot_id, workspace_id, space_id):
        return None, active.explain_no_route_match(
            bot_id=bot_id,
            workspace_id=workspace_id,
            space_id=space_id,
            is_bot=False,
            user_id=person_id,
            listen=listen,
            is_direct=is_direct,
            route_required=True,
        )
    if matches:
        return matches[0].agent_id, None
    if mode == "db_only":
        deny = active.explain_no_route_match(
            bot_id=bot_id,
            workspace_id=workspace_id,
            space_id=space_id,
            is_bot=False,
            user_id=person_id,
            listen=listen,
            is_direct=is_direct,
            route_required=True,
        )
        return None, deny or "No agent route is configured for this Webex space."

    if default_agent_id:
        return default_agent_id, None
    deny = active.explain_no_route_match(
        bot_id=bot_id,
        workspace_id=workspace_id,
        space_id=space_id,
        is_bot=False,
        user_id=person_id,
        listen=listen,
        is_direct=is_direct,
        route_required=not bool(default_agent_id),
    )
    return None, deny or "No agent route is configured for this Webex space."


def _ttl_from_env() -> int:
    try:
        return max(0, int(os.environ.get("WEBEX_AGENT_ROUTES_TTL_SECONDS", "60")))
    except ValueError:
        return 60


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


def _agent_ids_from_openfga_read(payload: dict[str, Any], space_subject: str) -> list[str]:
    agent_ids: list[str] = []
    seen: set[str] = set()
    for tuple_row in payload.get("tuples", []):
        key = tuple_row.get("key") if isinstance(tuple_row, dict) else None
        if not isinstance(key, dict):
            continue
        if key.get("user") != space_subject or key.get("relation") != "user":
            continue
        object_id = key.get("object") if isinstance(key, dict) else None
        if not isinstance(object_id, str) or not object_id.startswith("agent:"):
            continue
        agent_id = object_id.removeprefix("agent:").strip()
        if agent_id and agent_id not in seen:
            seen.add(agent_id)
            agent_ids.append(agent_id)
    return agent_ids


def _default_route(agent_id: str) -> dict[str, Any]:
    return {
        "agent_id": agent_id,
        "enabled": True,
        "priority": 100,
        "status": "active",
        "users": {"enabled": True, "listen": "mention"},
    }


def _merge_openfga_agents_with_route_metadata(
    agent_ids: list[str],
    routes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    metadata_by_agent_id = {
        route["agent_id"]: route
        for route in routes
        if isinstance(route.get("agent_id"), str) and route["agent_id"] in agent_ids
    }
    merged = list(metadata_by_agent_id.values())
    return sorted(merged, key=lambda route: (route.get("priority", 100), route.get("agent_id", "")))


def _side_matches(
    side: UsersConfig | BotsConfig | None,
    listen: Optional[str],
    actor_id: Optional[str],
    list_field: Literal["user_list", "bot_list"],
) -> bool:
    if side is None or not side.enabled:
        return False
    if listen and side.listen not in ("all", listen):
        return False
    allowed_ids = getattr(side, list_field, None)
    if allowed_ids is not None and actor_id not in allowed_ids:
        return False
    return True


def _route_to_agent_binding(route: dict[str, Any]) -> AgentBinding | None:
    agent_id = route.get("agent_id")
    if not isinstance(agent_id, str) or not agent_id.strip():
        return None

    try:
        return AgentBinding(
            agent_id=agent_id.strip(),
            users=UsersConfig(**route["users"]) if isinstance(route.get("users"), dict) else None,
            bots=BotsConfig(**route["bots"]) if isinstance(route.get("bots"), dict) else None,
            escalation=(
                EscalationConfig(**route["escalation"])
                if isinstance(route.get("escalation"), dict)
                else None
            ),
        )
    except ValidationError as exc:
        logger.warning("WebexAgentRouteResolver: invalid route for agent=%s: %s", agent_id, exc)
        return None


_default_resolver: Optional[WebexAgentRouteResolver] = None


def get_webex_agent_route_resolver() -> WebexAgentRouteResolver:
    global _default_resolver
    if _default_resolver is None:
        _default_resolver = WebexAgentRouteResolver()
    return _default_resolver
