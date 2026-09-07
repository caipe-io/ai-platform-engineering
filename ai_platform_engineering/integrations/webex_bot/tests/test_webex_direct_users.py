"""Direct-user resolver modes and route matching."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from ai_platform_engineering.integrations.webex_bot.utils.webex_direct_users import (
    WebexDirectUserResolver,
)


class _Collection:
    def __init__(self, documents: list[dict[str, Any]]) -> None:
        self.documents = documents

    def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        return next(
            (doc for doc in self.documents if all(doc.get(key) == value for key, value in query.items())),
            None,
        )


def _set_bot_policy(
    monkeypatch,
    *,
    mode: str,
    bot_id: str = "primary",
) -> None:
    candidate: dict[str, object] = {
        "id": bot_id,
        "name": bot_id.title(),
        "tokenEnv": f"{bot_id.upper()}_TOKEN",
        "spaces": {"accessMode": "allowlist"},
        "directMessages": {"accessMode": mode},
    }
    if mode == "all_users":
        candidate["directMessages"] = {
            "accessMode": "all_users",
            "defaultAgentId": "agent-default",
        }
    monkeypatch.setenv("WEBEX_INTEGRATION_BOTS_JSON", json.dumps([candidate]))


def test_disabled_mode_never_reads_storage(monkeypatch) -> None:
    _set_bot_policy(monkeypatch, mode="disabled")
    resolver = WebexDirectUserResolver(
        collection_factory=lambda: (_ for _ in ()).throw(AssertionError("storage read")),
    )
    result = asyncio.run(
        resolver.resolve(bot_id="primary", webex_user_id="person1234", keycloak_user_id="kc-user-1")
    )
    assert result.allowed is False
    assert result.reason == "disabled"


def test_allowlist_matches_bot_and_webex_user_id(monkeypatch) -> None:
    _set_bot_policy(monkeypatch, mode="allowlist", bot_id="secondary")
    collection = _Collection([
        {
            "bot_id": "secondary",
            "status": "active",
            "webex_user_id": "person1234",
            "expected_webex_email": "user@example.com",
            "keycloak_user_id": "kc-user-1",
            "agent_id": "agent-1",
        }
    ])
    resolver = WebexDirectUserResolver(collection_factory=lambda: collection)  # type: ignore[arg-type]
    result = asyncio.run(
        resolver.resolve(bot_id="secondary", webex_user_id="person1234", keycloak_user_id="kc-user-1")
    )
    assert result.allowed is True
    assert result.keycloak_user_id == "kc-user-1"
    assert result.agent_id == "agent-1"


def test_allowlist_requires_a_verified_webex_user_id_match(monkeypatch) -> None:
    """A route is keyed on the immutable, OAuth-verified webex_user_id only —
    an attacker linked to the victim's Keycloak user cannot ride in on
    someone else's pre-provisioned route just by sharing a keycloak_user_id."""
    _set_bot_policy(monkeypatch, mode="allowlist", bot_id="secondary")
    collection = _Collection([
        {
            "bot_id": "secondary",
            "status": "active",
            "webex_user_id": "victim-person-id",
            "expected_webex_email": "victim@example.com",
            "keycloak_user_id": "kc-victim",
            "agent_id": "agent-1",
        }
    ])
    resolver = WebexDirectUserResolver(collection_factory=lambda: collection)  # type: ignore[arg-type]
    result = asyncio.run(
        resolver.resolve(
            bot_id="secondary",
            webex_user_id="attacker-person-id",
            keycloak_user_id="kc-victim",
        )
    )
    assert result.allowed is False
    assert result.reason == "not_onboarded"


def test_all_users_admits_enabled_deployment_user_with_bot_defaults(monkeypatch) -> None:
    _set_bot_policy(monkeypatch, mode="all_users")

    async def user_by_id(user_id: str) -> dict[str, Any] | None:
        return {"id": user_id, "enabled": True}

    resolver = WebexDirectUserResolver(
        collection_factory=lambda: _Collection([]),  # type: ignore[arg-type]
        user_by_id=user_by_id,
    )
    result = asyncio.run(
        resolver.resolve(bot_id="primary", webex_user_id="person1234", keycloak_user_id="kc-user-1")
    )
    assert result.allowed is True
    assert result.keycloak_user_id == "kc-user-1"
    assert result.agent_id == "agent-default"
    assert result.reason == "all_users"


def test_all_users_denies_unlinked_sender(monkeypatch) -> None:
    _set_bot_policy(monkeypatch, mode="all_users")
    resolver = WebexDirectUserResolver(
        collection_factory=lambda: _Collection([]),  # type: ignore[arg-type]
        user_by_id=lambda user_id: (_ for _ in ()).throw(AssertionError("directory lookup")),
    )
    result = asyncio.run(
        resolver.resolve(bot_id="primary", webex_user_id="person1234", keycloak_user_id=None)
    )
    assert result.allowed is False
    assert result.reason == "not_linked"


def test_same_user_can_have_independent_routes_for_multiple_bots(monkeypatch) -> None:
    monkeypatch.setenv(
        "WEBEX_INTEGRATION_BOTS_JSON",
        json.dumps(
            [
                {
                    "id": bot_id,
                    "name": bot_id.title(),
                    "tokenEnv": f"{bot_id.upper()}_TOKEN",
                    "spaces": {"accessMode": "allowlist"},
                    "directMessages": {"accessMode": "allowlist"},
                }
                for bot_id in ("primary", "secondary")
            ]
        ),
    )
    collection = _Collection([
        {
            "bot_id": "primary",
            "status": "active",
            "webex_user_id": "person1234",
            "expected_webex_email": "user@example.com",
            "keycloak_user_id": "kc-user-1",
            "agent_id": "agent-1",
        },
        {
            "bot_id": "secondary",
            "status": "active",
            "webex_user_id": "person1234",
            "expected_webex_email": "user@example.com",
            "keycloak_user_id": "kc-user-1",
            "agent_id": "agent-2",
        },
    ])
    resolver = WebexDirectUserResolver(collection_factory=lambda: collection)  # type: ignore[arg-type]

    result = asyncio.run(
        resolver.resolve(
            bot_id="secondary",
            webex_user_id="person1234",
            keycloak_user_id="kc-user-1",
        )
    )

    assert result.allowed is True
    assert result.agent_id == "agent-2"


def test_all_users_explicit_deny_overrides_inherited_access(monkeypatch) -> None:
    _set_bot_policy(monkeypatch, mode="all_users")
    collection = _Collection(
        [
            {
                "bot_id": "primary",
                "status": "disabled",
                "webex_user_id": "person1234",
                "expected_webex_email": "user@example.com",
                "keycloak_user_id": "kc-user-1",
            }
        ]
    )
    resolver = WebexDirectUserResolver(
        collection_factory=lambda: collection,  # type: ignore[arg-type]
    )

    result = asyncio.run(
        resolver.resolve(
            bot_id="primary",
            webex_user_id="person1234",
            keycloak_user_id="kc-user-1",
        )
    )

    assert result.allowed is False
    assert result.reason == "explicit_deny"


def test_all_users_directory_lookup_failure_denies(monkeypatch) -> None:
    _set_bot_policy(monkeypatch, mode="all_users")

    async def user_by_id(user_id: str) -> dict[str, Any] | None:
        raise RuntimeError("keycloak outage")

    resolver = WebexDirectUserResolver(
        collection_factory=lambda: _Collection([]),  # type: ignore[arg-type]
        user_by_id=user_by_id,
    )
    result = asyncio.run(
        resolver.resolve(bot_id="primary", webex_user_id="person1234", keycloak_user_id="kc-user-1")
    )
    assert result.allowed is False
    assert result.reason == "directory_unavailable"


def test_all_users_disabled_or_missing_user_denies(monkeypatch) -> None:
    _set_bot_policy(monkeypatch, mode="all_users")

    async def missing_user(user_id: str) -> dict[str, Any] | None:
        return None

    resolver = WebexDirectUserResolver(
        collection_factory=lambda: _Collection([]),  # type: ignore[arg-type]
        user_by_id=missing_user,
    )
    result = asyncio.run(
        resolver.resolve(bot_id="primary", webex_user_id="person1234", keycloak_user_id="kc-user-1")
    )
    assert result.allowed is False
    assert result.reason == "not_deployment_user"

    async def disabled_user(user_id: str) -> dict[str, Any] | None:
        return {"id": user_id, "enabled": False}

    resolver = WebexDirectUserResolver(
        collection_factory=lambda: _Collection([]),  # type: ignore[arg-type]
        user_by_id=disabled_user,
    )
    result = asyncio.run(
        resolver.resolve(bot_id="primary", webex_user_id="person1234", keycloak_user_id="kc-user-1")
    )
    assert result.allowed is False
    assert result.reason == "not_deployment_user"


def test_allowlist_route_missing_keycloak_or_agent_id_is_invalid(monkeypatch) -> None:
    _set_bot_policy(monkeypatch, mode="allowlist", bot_id="secondary")
    collection = _Collection([
        {
            "bot_id": "secondary",
            "status": "active",
            "webex_user_id": "person1234",
            "keycloak_user_id": "",
            "agent_id": "agent-1",
        }
    ])
    resolver = WebexDirectUserResolver(collection_factory=lambda: collection)  # type: ignore[arg-type]
    result = asyncio.run(
        resolver.resolve(bot_id="secondary", webex_user_id="person1234", keycloak_user_id="kc-user-1")
    )
    assert result.allowed is False
    assert result.reason == "invalid_route"

    collection_missing_agent = _Collection([
        {
            "bot_id": "secondary",
            "status": "active",
            "webex_user_id": "person1234",
            "keycloak_user_id": "kc-user-1",
        }
    ])
    resolver = WebexDirectUserResolver(collection_factory=lambda: collection_missing_agent)  # type: ignore[arg-type]
    result = asyncio.run(
        resolver.resolve(bot_id="secondary", webex_user_id="person1234", keycloak_user_id="kc-user-1")
    )
    assert result.allowed is False
    assert result.reason == "invalid_route"
