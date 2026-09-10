"""Tests for OpenFGA-backed Webex space agent routes."""

from __future__ import annotations

import asyncio
import json

import pytest
import requests

from ai_platform_engineering.integrations.webex_bot.app import handle_webex_message
from ai_platform_engineering.integrations.webex_bot.tests.test_runtime_gate import (
    FakeDispatcher,
    FakeIdentityLinker,
    FakeOboExchanger,
    FakeRebacChecker,
    FakeTeamResolver,
    _event,
)
from ai_platform_engineering.integrations.webex_bot.utils.webex_agent_routes import (
    WebexAgentRouteResolver,
    resolve_webex_agent_route,
    webex_agent_route_mode,
    webex_bot_installation_openfga_subject,
    webex_space_openfga_subject,
    webex_workspace_ref,
)


class _Cursor:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows

    def sort(self, fields: list[tuple[str, int]]) -> "_Cursor":
        for field, direction in reversed(fields):
            self._rows.sort(
                key=lambda row: row.get(field) if row.get(field) is not None else "",
                reverse=direction < 0,
            )
        return self

    def limit(self, count: int) -> "_Cursor":
        self._rows = self._rows[:count]
        return self

    def to_list(self) -> list[dict[str, object]]:
        return self._rows


class _Collection:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = [{**row, "bot_id": row.get("bot_id", "primary")} for row in rows]
        self.filters: list[dict[str, object]] = []

    def find(self, filter_query: dict[str, object]) -> _Cursor:
        self.filters.append(filter_query)
        requested_bot = filter_query.get("bot_id")
        rows = [
            row
            for row in self.rows
            if (
                row.get("bot_id") == requested_bot
                if "bot_id" in filter_query
                else row.get("bot_id") in {None, ""}
            )
            and row.get("workspace_id") == filter_query["workspace_id"]
            and row.get("space_id") == filter_query["space_id"]
            and row.get("status") == filter_query["status"]
            and row.get("enabled") is not False
        ]
        return _Cursor(rows)


class _Response:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, object]:
        return self._payload


def test_webex_agent_route_mode_defaults_to_static_config(monkeypatch) -> None:
    monkeypatch.delenv("WEBEX_AGENT_ROUTES_MODE", raising=False)
    monkeypatch.delenv("WEBEX_AGENT_ROUTES_ENABLED", raising=False)

    assert webex_agent_route_mode() == "config"


def test_webex_agent_route_mode_supports_legacy_enabled_flag(monkeypatch) -> None:
    monkeypatch.delenv("WEBEX_AGENT_ROUTES_MODE", raising=False)
    monkeypatch.setenv("WEBEX_AGENT_ROUTES_ENABLED", "true")

    assert webex_agent_route_mode() == "db_prefer"


def test_webex_space_openfga_subject_respects_explicit_workspace_id(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_WORKSPACE_ALIAS", "CAIPE-WEBEX")

    # Explicit workspace_id is used as-is so _load_routes' "unknown" fallback works.
    assert webex_space_openfga_subject("CAIPE-WEBEX", "space-abc") == "webex_space:CAIPE-WEBEX--space-abc"
    assert webex_space_openfga_subject("unknown", "space-abc") == "webex_space:unknown--space-abc"
    assert webex_bot_installation_openfga_subject(
        "primary", "CAIPE-WEBEX", "space-abc"
    ) == "webex_bot_installation:primary--CAIPE-WEBEX--space-abc"


def test_resolver_uses_newest_route_when_legacy_duplicates_exist() -> None:
    collection = _Collection(
        [
            {
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "space12345",
                "agent_id": "low-priority-agent",
                "enabled": True,
                "priority": 50,
                "status": "active",
                "users": {"enabled": True, "listen": "mention"},
                "updated_at": "2026-01-01T00:00:00Z",
            },
            {
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "space12345",
                "agent_id": "high-priority-agent",
                "enabled": True,
                "priority": 10,
                "status": "active",
                "users": {"enabled": True, "listen": "all"},
                "updated_at": "2026-02-01T00:00:00Z",
            },
        ]
    )
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: collection,
        openfga_agent_ids_factory=lambda _bot_id, _workspace_id, _space_id: [
            "low-priority-agent",
            "high-priority-agent",
        ],
    )

    matches = resolver.match_routes(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="space12345",
        is_bot=False,
        user_id="person1234",
        listen="mention",
    )

    assert [match.agent_id for match in matches] == ["high-priority-agent"]


def test_resolve_direct_webex_message_uses_existing_mention_route(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_AGENT_ROUTES_MODE", "db_only")
    collection = _Collection(
        [
            {
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "direct-space12345",
                "agent_id": "personal-agent",
                "enabled": True,
                "priority": 10,
                "status": "active",
                "users": {"enabled": True, "listen": "mention"},
            },
        ]
    )
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: collection,
        openfga_agent_ids_factory=lambda _bot_id, _workspace_id, _space_id: ["personal-agent"],
    )

    async def _run() -> tuple[str | None, str | None]:
        return await resolve_webex_agent_route(
            bot_id="primary",
            workspace_id="CAIPE-WEBEX",
            space_id="direct-space12345",
            person_id="person1234",
            text="howdy",
            is_direct=True,
            resolver=resolver,
        )

    agent_id, deny = asyncio.run(_run())

    assert agent_id == "personal-agent"
    assert deny is None


def test_wdm_bot_mention_uses_mention_route_without_at_prefix(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_AGENT_ROUTES_MODE", "db_only")
    collection = _Collection(
        [
            {
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "space12345",
                "agent_id": "mention-agent",
                "enabled": True,
                "priority": 10,
                "status": "active",
                "users": {"enabled": True, "listen": "mention"},
            },
        ]
    )
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: collection,
        openfga_agent_ids_factory=lambda _bot_id, _workspace_id, _space_id: [
            "mention-agent"
        ],
    )

    async def _run() -> tuple[str | None, str | None]:
        return await resolve_webex_agent_route(
            bot_id="primary",
            workspace_id="CAIPE-WEBEX",
            space_id="space12345",
            person_id="person1234",
            text="Primary please help",
            was_bot_mentioned=True,
            resolver=resolver,
        )

    agent_id, deny = asyncio.run(_run())

    assert agent_id == "mention-agent"
    assert deny is None


def test_thread_reply_plain_message_excluded_from_message_mode_route(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_AGENT_ROUTES_MODE", "db_only")
    collection = _Collection(
        [
            {
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "space12345",
                "agent_id": "message-mode-agent",
                "enabled": True,
                "priority": 10,
                "status": "active",
                "users": {"enabled": True, "listen": "message"},
            },
        ]
    )
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: collection,
        openfga_agent_ids_factory=lambda _bot_id, _workspace_id, _space_id: ["message-mode-agent"],
    )

    async def _run() -> tuple[str | None, str | None]:
        return await resolve_webex_agent_route(
            bot_id="primary",
            workspace_id="CAIPE-WEBEX",
            space_id="space12345",
            person_id="person1234",
            text="just chatting, no mention here",
            thread_parent_id="parent-message-id",
            resolver=resolver,
        )

    agent_id, deny = asyncio.run(_run())

    assert agent_id is None
    assert deny is None


def test_thread_reply_mention_still_matches_route(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_AGENT_ROUTES_MODE", "db_only")
    collection = _Collection(
        [
            {
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "space12345",
                "agent_id": "mention-agent",
                "enabled": True,
                "priority": 10,
                "status": "active",
                "users": {"enabled": True, "listen": "mention"},
            },
        ]
    )
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: collection,
        openfga_agent_ids_factory=lambda _bot_id, _workspace_id, _space_id: ["mention-agent"],
    )

    async def _run() -> tuple[str | None, str | None]:
        return await resolve_webex_agent_route(
            bot_id="primary",
            workspace_id="CAIPE-WEBEX",
            space_id="space12345",
            person_id="person1234",
            text="Primary please help",
            was_bot_mentioned=True,
            thread_parent_id="parent-message-id",
            resolver=resolver,
        )

    agent_id, deny = asyncio.run(_run())

    assert agent_id == "mention-agent"
    assert deny is None


def test_mention_only_thread_reply_matches_route_same_as_worded_mention(monkeypatch) -> None:
    """A bare "@bot" reply to an earlier non-mention message in the same
    thread must route identically to a worded mention: was_bot_mentioned is a
    structural flag from Mercury, not a function of message text, so an
    empty/mention-only body must not fall into the thread_parent_id message-mode
    short-circuit that only applies when listen resolves to "message"."""
    monkeypatch.setenv("WEBEX_AGENT_ROUTES_MODE", "db_only")
    collection = _Collection(
        [
            {
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "space12345",
                "agent_id": "mention-agent",
                "enabled": True,
                "priority": 10,
                "status": "active",
                "users": {"enabled": True, "listen": "mention"},
            },
        ]
    )
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: collection,
        openfga_agent_ids_factory=lambda _bot_id, _workspace_id, _space_id: ["mention-agent"],
    )

    async def _run(text: str) -> tuple[str | None, str | None]:
        return await resolve_webex_agent_route(
            bot_id="primary",
            workspace_id="CAIPE-WEBEX",
            space_id="space12345",
            person_id="person1234",
            text=text,
            was_bot_mentioned=True,
            thread_parent_id="parent-message-id",
            resolver=resolver,
        )

    for text in ("", "@bot"):
        agent_id, deny = asyncio.run(_run(text))
        assert agent_id == "mention-agent"
        assert deny is None


def test_top_level_plain_message_still_matches_message_mode_route(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_AGENT_ROUTES_MODE", "db_only")
    collection = _Collection(
        [
            {
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "space12345",
                "agent_id": "message-mode-agent",
                "enabled": True,
                "priority": 10,
                "status": "active",
                "users": {"enabled": True, "listen": "message"},
            },
        ]
    )
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: collection,
        openfga_agent_ids_factory=lambda _bot_id, _workspace_id, _space_id: ["message-mode-agent"],
    )

    async def _run() -> tuple[str | None, str | None]:
        return await resolve_webex_agent_route(
            bot_id="primary",
            workspace_id="CAIPE-WEBEX",
            space_id="space12345",
            person_id="person1234",
            text="just chatting, no mention here",
            resolver=resolver,
        )

    agent_id, deny = asyncio.run(_run())

    assert agent_id == "message-mode-agent"
    assert deny is None


def test_plain_group_message_route_mismatch_uses_plain_language() -> None:
    collection = _Collection(
        [
            {
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "space12345",
                "agent_id": "mention-only-agent",
                "enabled": True,
                "priority": 10,
                "status": "active",
                "users": {"enabled": True, "listen": "mention"},
            },
        ]
    )
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: collection,
        openfga_agent_ids_factory=lambda _bot_id, _workspace_id, _space_id: ["mention-only-agent"],
    )

    explanation = resolver.explain_no_route_match(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="space12345",
        is_bot=False,
        user_id="person1234",
        listen="message",
        route_required=True,
    )

    assert explanation == (
        "I can help in this Webex space when you mention CAIPE. Try mentioning "
        "CAIPE with your question, or ask an admin to enable always-on replies "
        "for this space."
    )
    for internal_term in ("OpenFGA", "Listen mode", "plain space messages", "Admin >"):
        assert internal_term not in explanation


def test_resolver_fails_closed_when_newest_route_lacks_openfga_tuple() -> None:
    collection = _Collection(
        [
            {
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "space12345",
                "agent_id": "tuple-backed-agent",
                "enabled": True,
                "priority": 100,
                "status": "active",
                "users": {"enabled": True, "listen": "mention"},
                "updated_at": "2026-01-01T00:00:00Z",
            },
            {
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "space12345",
                "agent_id": "stale-mongo-agent",
                "enabled": True,
                "priority": 1,
                "status": "active",
                "users": {"enabled": True, "listen": "mention"},
                "updated_at": "2026-02-01T00:00:00Z",
            },
        ]
    )
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: collection,
        openfga_agent_ids_factory=lambda _bot_id, _workspace_id, _space_id: ["tuple-backed-agent"],
    )

    matches = resolver.match_routes(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="space12345",
        is_bot=False,
        user_id="person1234",
        listen="mention",
    )

    assert matches == []


def test_same_space_routes_are_isolated_by_bot() -> None:
    collection = _Collection(
        [
            {
                "bot_id": "primary",
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "shared-space",
                "agent_id": "primary-agent",
                "enabled": True,
                "priority": 10,
                "status": "active",
                "users": {"enabled": True, "listen": "all"},
            },
            {
                "bot_id": "secondary",
                "workspace_id": "CAIPE-WEBEX",
                "space_id": "shared-space",
                "agent_id": "secondary-agent",
                "enabled": True,
                "priority": 10,
                "status": "active",
                "users": {"enabled": True, "listen": "all"},
            },
        ]
    )
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: collection,
        openfga_agent_ids_factory=lambda bot_id, _workspace_id, _space_id: [
            f"{bot_id}-agent",
        ],
    )

    primary = resolver.match_routes(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="shared-space",
        is_bot=False,
        user_id="user-1",
        listen="mention",
    )
    secondary = resolver.match_routes(
        bot_id="secondary",
        workspace_id="CAIPE-WEBEX",
        space_id="shared-space",
        is_bot=False,
        user_id="user-1",
        listen="mention",
    )

    assert [match.agent_id for match in primary] == ["primary-agent"]
    assert [match.agent_id for match in secondary] == ["secondary-agent"]


def test_botless_legacy_route_is_not_used_before_explicit_migration() -> None:
    collection = _Collection([
        {
            "bot_id": None,
            "workspace_id": "CAIPE-WEBEX",
            "space_id": "legacy-space",
            "agent_id": "legacy-agent",
            "enabled": True,
            "priority": 10,
            "status": "active",
            "users": {"enabled": True, "listen": "all"},
        },
    ])
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: collection,
        openfga_agent_ids_factory=lambda _bot_id, _workspace_id, _space_id: ["legacy-agent"],
    )

    matches = resolver.match_routes(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="legacy-space",
        is_bot=False,
        user_id="user-1",
        listen="mention",
    )
    secondary_matches = resolver.match_routes(
        bot_id="secondary",
        workspace_id="CAIPE-WEBEX",
        space_id="legacy-space",
        is_bot=False,
        user_id="user-1",
        listen="mention",
    )

    assert matches == []
    assert secondary_matches == []
    assert all("$or" not in query for query in collection.filters)


def test_openfga_read_includes_tuple_key_filter_and_pagination(monkeypatch) -> None:
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-1")
    post_calls: list[dict[str, object]] = []
    call_count = {"n": 0}

    def fake_post(_url: str, **_kwargs: object) -> _Response:
        body = _kwargs.get("json")
        assert isinstance(body, dict)
        post_calls.append(body)
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _Response(
                {
                    "tuples": [
                        {
                            "key": {
                                "user": "webex_bot_installation:primary--CAIPE-WEBEX--space12345",
                                "relation": "user",
                                "object": "agent:page-one",
                            }
                        }
                    ],
                    "continuation_token": "page-2",
                }
            )
        return _Response(
            {
                "tuples": [
                    {
                        "key": {
                            "user": "webex_bot_installation:primary--CAIPE-WEBEX--space12345",
                            "relation": "user",
                            "object": "agent:page-two",
                        }
                    }
                ],
                "continuation_token": "",
            }
        )

    monkeypatch.setattr(
        "ai_platform_engineering.integrations.webex_bot.utils.webex_agent_routes.requests.post",
        fake_post,
    )
    resolver = WebexAgentRouteResolver(collection_factory=lambda: _Collection([]))
    matches = resolver.match_routes(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="space12345",
        is_bot=False,
        user_id="person1234",
        listen="mention",
    )

    assert matches == []
    assert len(post_calls) == 2
    assert post_calls[0]["tuple_key"] == {
        "user": "webex_bot_installation:primary--CAIPE-WEBEX--space12345",
        "relation": "user",
        "object": "agent:",
    }
    assert post_calls[1]["continuation_token"] == "page-2"
    assert post_calls[1]["tuple_key"] == post_calls[0]["tuple_key"]


def test_resolver_records_openfga_read_failures_to_audit_service(monkeypatch) -> None:
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-1")
    audit_records: list[dict[str, object]] = []

    def fake_post(_url: str, **_kwargs: object) -> _Response:
        raise requests.RequestException("400 Bad Request")

    monkeypatch.setattr(
        "ai_platform_engineering.integrations.webex_bot.utils.webex_agent_routes.requests.post",
        fake_post,
    )
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: _Collection([]),
        audit_event_writer=audit_records.append,
    )

    matches = resolver.match_routes(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="space12345",
        is_bot=False,
        user_id="person1234",
        listen="mention",
    )

    assert matches == []
    assert len(audit_records) == 1
    assert audit_records[0] | {"ts": "ignored"} == {
        "type": "webex_runtime",
        "component": "webex_bot",
        "source": "webex",
        "outcome": "error",
        "action": "webex.route.openfga_read",
        "reason_code": "OPENFGA_READ_FAILED",
        "resource_ref": "webex_space:CAIPE-WEBEX--space12345",
        "message": "400 Bad Request",
        "ts": "ignored",
    }


def test_webex_workspace_ref_explicit_id_wins_over_alias(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_WORKSPACE_ALIAS", "CAIPE-WEBEX")
    monkeypatch.setenv("WEBEX_WORKSPACE_ID", "WFALLBACK")

    # Explicit workspace_id takes precedence so _load_routes' "unknown" fallback works.
    assert webex_workspace_ref("org-123") == "org-123"
    assert webex_workspace_ref("unknown") == "unknown"


def test_webex_workspace_ref_alias_used_when_no_id(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_WORKSPACE_ALIAS", "CAIPE-WEBEX")
    monkeypatch.setenv("WEBEX_WORKSPACE_ID", "WFALLBACK")

    # No argument → alias is the canonical namespace.
    assert webex_workspace_ref() == "CAIPE-WEBEX"


def test_resolver_explains_openfga_route_read_failure(monkeypatch) -> None:
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-1")

    def fake_post(_url: str, **_kwargs: object) -> _Response:
        raise requests.RequestException("503 unavailable")

    monkeypatch.setattr(
        "ai_platform_engineering.integrations.webex_bot.utils.webex_agent_routes.requests.post",
        fake_post,
    )
    resolver = WebexAgentRouteResolver(collection_factory=lambda: _Collection([]))

    explanation = resolver.explain_no_route_match(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="space12345",
        is_bot=False,
        user_id="person1234",
        listen="mention",
        route_required=True,
    )

    assert explanation is not None
    assert "OpenFGA" in explanation
    assert resolver.last_error("primary", "CAIPE-WEBEX", "space12345") is not None


def _resolve_denies_when_last_error(mode: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEBEX_AGENT_ROUTES_MODE", mode)

    class _FailingResolver(WebexAgentRouteResolver):
        def _load_openfga_agent_ids(
            self, bot_id: str, workspace_id: str, space_id: str
        ) -> list[str] | None:
            del bot_id
            self._last_errors[(workspace_id, space_id)] = "openfga down"
            return None

    resolver = _FailingResolver(collection_factory=lambda: _Collection([]))

    async def _run() -> tuple[str | None, str | None]:
        return await resolve_webex_agent_route(
            bot_id="primary",
            workspace_id="CAIPE-WEBEX",
            space_id="space12345",
            person_id="person1234",
            text="hello",
            resolver=resolver,
        )

    agent_id, deny = asyncio.run(_run())

    assert agent_id is None
    assert deny is not None
    assert "OpenFGA" in deny


def test_resolve_webex_agent_route_denies_on_openfga_outage_db_prefer(monkeypatch) -> None:
    _resolve_denies_when_last_error("db_prefer", monkeypatch)


def test_resolve_webex_agent_route_denies_on_openfga_outage_db_only(monkeypatch) -> None:
    _resolve_denies_when_last_error("db_only", monkeypatch)


def test_route_required_without_space_agent_association_uses_setup_message() -> None:
    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: _Collection([]),
        openfga_agent_ids_factory=lambda _bot_id, _workspace_id, _space_id: [],
    )

    explanation = resolver.explain_no_route_match(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="space12345",
        is_bot=False,
        user_id="person1234",
        listen="message",
        route_required=True,
    )

    assert explanation == (
        "This Webex space is not set up for CAIPE yet. Ask an admin to set up "
        "the Webex integration for this space in CAIPE."
    )


def test_resolve_webex_agent_route_db_prefer_uses_all_spaces_bot_default(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_AGENT_ROUTES_MODE", "db_prefer")
    monkeypatch.setenv(
        "WEBEX_INTEGRATION_BOTS_JSON",
        json.dumps(
            [
                {
                    "id": "primary",
                    "name": "Primary",
                    "tokenEnv": "PRIMARY_TOKEN",
                    "spaces": {
                        "accessMode": "all_spaces",
                        "defaultTeamSlug": "platform",
                        "defaultAgentId": "bot-default-agent",
                    },
                    "directMessages": {"accessMode": "disabled"},
                }
            ]
        ),
    )

    resolver = WebexAgentRouteResolver(
        collection_factory=lambda: _Collection([]),
        openfga_agent_ids_factory=lambda _bot_id, _workspace_id, _space_id: [],
    )

    async def _run() -> tuple[str | None, str | None]:
        return await resolve_webex_agent_route(
            bot_id="primary",
            workspace_id="CAIPE-WEBEX",
            space_id="space12345",
            person_id="person1234",
            text="hello",
            resolver=resolver,
        )

    agent_id, deny = asyncio.run(_run())

    assert agent_id == "bot-default-agent"
    assert deny is None


def test_gate_route_denied_when_default_resolver_openfga_fails(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_AGENT_ROUTES_MODE", "db_only")
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-1")

    def fake_post(_url: str, **_kwargs: object) -> _Response:
        raise requests.RequestException("openfga read failed")

    monkeypatch.setattr(
        "ai_platform_engineering.integrations.webex_bot.utils.webex_agent_routes.requests.post",
        fake_post,
    )
    import ai_platform_engineering.integrations.webex_bot.utils.webex_agent_routes as routes_mod

    routes_mod._default_resolver = None

    dispatcher = FakeDispatcher()
    result = asyncio.run(
        handle_webex_message(
            _event(),
            identity_linker=FakeIdentityLinker(),
            team_resolver=FakeTeamResolver(),
            obo_exchanger=FakeOboExchanger(),
            rebac_checker=FakeRebacChecker(),
            dispatcher=dispatcher,
        )
    )

    assert result.reason_code == "WEBEX_ROUTE_DENIED"
    assert dispatcher.calls == []
