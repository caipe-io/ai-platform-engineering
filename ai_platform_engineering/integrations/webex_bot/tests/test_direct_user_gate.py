"""Deployment-user access controls for Webex 1:1 messages."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Optional

import pytest

from ai_platform_engineering.integrations.webex_bot import app as app_module
from ai_platform_engineering.integrations.webex_bot.utils.dm_authz_client import (
    DmAgentAccessDecision,
)
from ai_platform_engineering.integrations.webex_bot.utils.dm_thread_overrides import (
    OverrideKey,
    OverrideStore,
)
from ai_platform_engineering.integrations.webex_bot.utils.obo_exchange import OboToken
from ai_platform_engineering.integrations.webex_bot.utils.webex_direct_users import (
    WebexDirectUserAccess,
)


def _event() -> dict[str, Any]:
    return {
        "personId": "person1234",
        "personEmail": "user@example.com",
        "roomId": "space12345",
        "roomType": "direct",
        "botId": "secondary",
        "text": "hello",
    }


@dataclass
class _DirectUsers:
    access: WebexDirectUserAccess
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def resolve(self, **kwargs: Any) -> WebexDirectUserAccess:
        self.calls.append(kwargs)
        return self.access


@dataclass
class _Identity:
    user_id: Optional[str] = "kc-user-1"
    resolve_calls: int = 0
    link_calls: int = 0

    async def resolve(self, webex_user_id: str) -> Optional[str]:
        self.resolve_calls += 1
        return self.user_id

    async def linking_url(self, webex_user_id: str) -> Optional[str]:
        self.link_calls += 1
        return "https://ui.example/link"


class _Obo:
    async def impersonate(self, keycloak_user_id: str) -> OboToken:
        return OboToken(access_token="obo-token", token_type="Bearer", expires_in=300)


@dataclass
class _DmAuthz:
    allowed: bool = True
    allowed_agents: set[str] | None = None
    available: bool = True
    calls: list[dict[str, str]] = field(default_factory=list)

    def check_agent_access(self, **kwargs: str) -> DmAgentAccessDecision:
        self.calls.append(kwargs)
        allowed = (
            kwargs["agent_id"] in self.allowed_agents
            if self.allowed_agents is not None
            else self.allowed
        )
        return DmAgentAccessDecision(
            allowed=allowed,
            reason="ALLOW" if allowed else "DENY_AGENT",
            path="user",
            available=self.available,
        )


class _NeverTeam:
    async def resolve(self, bot_id: str, space_id: str):
        del bot_id, space_id
        raise AssertionError("DMs must not use group-space team routing")


class _NeverRoutes:
    async def resolve_route(self, **kwargs: Any):
        raise AssertionError("DMs must use the onboarded direct-user agent")


class _NeverSpaceGrant:
    def check_space_grant(self, **kwargs: Any):
        raise AssertionError("DMs must not use a group-space grant")


async def _dispatch(calls: list[dict[str, Any]], payload: dict[str, Any]) -> None:
    calls.append(payload)


def _run(
    direct_users: _DirectUsers,
    identity: _Identity,
    *,
    dm_authz: _DmAuthz | None = None,
    dispatch_calls: list[dict[str, Any]] | None = None,
) -> app_module.WebexMessageResult:
    calls = dispatch_calls if dispatch_calls is not None else []
    return asyncio.run(
        app_module.handle_webex_message(
            _event(),
            direct_user_resolver=direct_users,
            identity_linker=identity,
            team_resolver=_NeverTeam(),
            obo_exchanger=_Obo(),
            route_resolver=_NeverRoutes(),
            rebac_checker=_NeverSpaceGrant(),
            dm_authz_checker=dm_authz or _DmAuthz(),
            dispatcher=lambda payload: _dispatch(calls, payload),
        )
    )


def test_unlinked_direct_user_is_prompted_to_link_before_dm_access_is_checked() -> None:
    identity = _Identity(user_id=None)
    direct_users = _DirectUsers(WebexDirectUserAccess(False, None, None, "not_onboarded"))
    result = _run(direct_users, identity)

    assert result.ignored is False
    assert result.reason_code == app_module.REASON_USER_NOT_LINKED
    assert result.linking_url == "https://ui.example/link"
    assert identity.resolve_calls == 1
    assert identity.link_calls == 1
    assert direct_users.calls == []


def test_unlinked_direct_user_is_ignored_silently_when_dm_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "WEBEX_INTEGRATION_BOTS_JSON",
        json.dumps(
            [
                {
                    "id": "secondary",
                    "name": "Secondary",
                    "tokenEnv": "SECONDARY_TOKEN",
                    "spaces": {"accessMode": "allowlist"},
                    "directMessages": {"accessMode": "disabled"},
                },
            ]
        ),
    )
    identity = _Identity(user_id=None)
    direct_users = _DirectUsers(WebexDirectUserAccess(False, None, None, "not_onboarded"))
    result = _run(direct_users, identity)

    assert result.ignored is True
    assert result.reason_code == app_module.REASON_DM_DISABLED
    assert result.linking_url is None
    assert identity.resolve_calls == 1
    assert identity.link_calls == 0
    assert direct_users.calls == []


def test_linked_but_not_onboarded_direct_user_gets_an_explicit_deny() -> None:
    result = _run(
        _DirectUsers(WebexDirectUserAccess(False, None, None, "not_onboarded")),
        _Identity(),
    )

    assert result.ignored is False
    assert result.allowed is False
    assert result.reason_code == app_module.REASON_DM_NOT_ONBOARDED
    assert result.deny_message is not None
    assert result.explicit_invocation is True


def test_linked_direct_user_is_ignored_silently_when_dm_is_disabled() -> None:
    """A linked deployment user must be ignored the same way as an unlinked
    sender when this bot's DM channel is disabled deployment-wide — not told
    to ask an admin to enable something a per-user allowlist change can never
    fix."""
    identity = _Identity()
    direct_users = _DirectUsers(WebexDirectUserAccess(False, None, None, "disabled"))
    calls: list[dict[str, Any]] = []
    result = _run(direct_users, identity, dispatch_calls=calls)

    assert result.ignored is True
    assert result.allowed is False
    assert result.reason_code == app_module.REASON_DM_DISABLED
    assert result.deny_message is None
    assert calls == []


def test_onboarded_direct_user_resolver_receives_the_linked_identity() -> None:
    identity = _Identity()
    direct_users = _DirectUsers(
        WebexDirectUserAccess(True, "kc-user-1", "agent-1", "allowlist_route")
    )
    result = _run(direct_users, identity)

    assert result.reason_code == app_module.REASON_DISPATCH_ALLOWED
    assert direct_users.calls == [{
        "bot_id": "secondary",
        "webex_user_id": "person1234",
        "keycloak_user_id": "kc-user-1",
    }]


def test_onboarded_direct_user_dispatches_selected_agent_with_user_obo() -> None:
    calls: list[dict[str, Any]] = []
    authz = _DmAuthz()
    direct_users = _DirectUsers(
        WebexDirectUserAccess(True, "kc-user-1", "agent-1", "allowlist_route")
    )
    result = _run(direct_users, _Identity(), dm_authz=authz, dispatch_calls=calls)

    assert result.reason_code == app_module.REASON_DISPATCH_ALLOWED
    assert result.dispatched is True
    assert direct_users.calls == [{
        "bot_id": "secondary",
        "webex_user_id": "person1234",
        "keycloak_user_id": "kc-user-1",
    }]
    assert authz.calls == [{"agent_id": "agent-1", "bearer_token": "obo-token"}]
    # DM dispatch payloads must carry is_direct=True so downstream Webex
    # conversation/message metadata can be excluded from space-scoped Insights
    # breakdowns (Top Spaces / Configured Spaces) while still counting the
    # activity in aggregate totals.
    assert calls[0]["is_direct"] is True
    assert calls[0]["agent_id"] == "agent-1"
    assert calls[0]["bot_id"] == "secondary"
    assert calls[0]["keycloak_user_id"] == "kc-user-1"
    assert calls[0]["team_slug"] is None


def test_linked_identity_must_match_onboarded_deployment_user() -> None:
    result = _run(
        _DirectUsers(WebexDirectUserAccess(True, "kc-user-2", "agent-1", "allowlist_route")),
        _Identity(user_id="kc-user-1"),
    )

    assert result.ignored is True
    assert result.reason_code == app_module.REASON_DM_NOT_ONBOARDED


def test_direct_agent_still_requires_user_openfga_access() -> None:
    result = _run(
        _DirectUsers(WebexDirectUserAccess(True, "kc-user-1", "agent-1", "allowlist_route")),
        _Identity(),
        dm_authz=_DmAuthz(allowed=False),
    )

    assert result.allowed is False
    assert result.reason_code == "DENY_AGENT"


def test_all_users_uses_live_bot_default(monkeypatch) -> None:
    async def _to_thread_inline(function, /, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(app_module, "get_default_override_store", OverrideStore)
    monkeypatch.setattr(app_module.asyncio, "to_thread", _to_thread_inline)
    authz = _DmAuthz()
    calls: list[dict[str, Any]] = []

    result = _run(
        _DirectUsers(
            WebexDirectUserAccess(
                True,
                "kc-user-1",
                "agent-bot-default",
                "all_users",
            )
        ),
        _Identity(),
        dm_authz=authz,
        dispatch_calls=calls,
    )

    assert result.reason_code == app_module.REASON_DISPATCH_ALLOWED
    assert calls[0]["agent_id"] == "agent-bot-default"
    assert authz.calls == [
        {"agent_id": "agent-bot-default", "bearer_token": "obo-token"}
    ]


def test_all_users_uses_temporary_override_before_bot_default(monkeypatch) -> None:
    async def _to_thread_inline(function, /, *args, **kwargs):
        return function(*args, **kwargs)

    overrides = OverrideStore()
    overrides.set(OverrideKey("person1234", "space12345"), "agent-temporary")
    monkeypatch.setattr(app_module, "get_default_override_store", lambda: overrides)
    monkeypatch.setattr(app_module.asyncio, "to_thread", _to_thread_inline)
    calls: list[dict[str, Any]] = []

    result = _run(
        _DirectUsers(
            WebexDirectUserAccess(
                True,
                "kc-user-1",
                "agent-bot-default",
                "all_users",
            )
        ),
        _Identity(),
        dispatch_calls=calls,
    )

    assert result.reason_code == app_module.REASON_DISPATCH_ALLOWED
    assert calls[0]["agent_id"] == "agent-temporary"


def test_all_users_clears_denied_temporary_override_and_uses_bot_default(
    monkeypatch,
) -> None:
    async def _to_thread_inline(function, /, *args, **kwargs):
        return function(*args, **kwargs)

    overrides = OverrideStore()
    overrides.set(OverrideKey("person1234", "space12345"), "agent-denied")
    monkeypatch.setattr(app_module, "get_default_override_store", lambda: overrides)
    monkeypatch.setattr(app_module.asyncio, "to_thread", _to_thread_inline)
    authz = _DmAuthz(allowed_agents={"agent-bot-default"})
    calls: list[dict[str, Any]] = []

    result = _run(
        _DirectUsers(
            WebexDirectUserAccess(
                True,
                "kc-user-1",
                "agent-bot-default",
                "all_users",
            )
        ),
        _Identity(),
        dm_authz=authz,
        dispatch_calls=calls,
    )

    assert result.reason_code == app_module.REASON_DISPATCH_ALLOWED
    assert calls[0]["agent_id"] == "agent-bot-default"
    assert overrides.get(OverrideKey("person1234", "space12345")) is None


def test_parser_carries_direct_identity_and_bot() -> None:
    parsed = app_module.parse_webex_event(_event())
    assert parsed is not None
    assert parsed.is_direct is True
    assert parsed.person_email == "user@example.com"
    assert parsed.bot_id == "secondary"
