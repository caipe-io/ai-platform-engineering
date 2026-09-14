# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Security hardening tests for the Webex runtime gate."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Optional

import pytest

from ai_platform_engineering.integrations.webex_bot.app import (
    REASON_IDENTITY_UNAVAILABLE,
    REASON_IGNORED_BOT,
    REASON_OBO_FAILED,
    REASON_WORKSPACE_UNCONFIGURED,
    parse_event_flag,
    parse_webex_event,
    handle_webex_message,
    configured_webex_workspace_ref,
)
from ai_platform_engineering.integrations.webex_bot.tests.test_runtime_gate import (
    FakeDispatcher,
    FakeOboExchanger,
    FakeRebacChecker,
    FakeRouteResolver,
    FakeTeamResolver,
    _event,
)
from ai_platform_engineering.integrations.webex_bot.utils.obo_exchange import OboToken

RAW_ROOM_ID = "6f91b070-531a-11f1-926d-6fd3c20dfdc4"
PUBLIC_ROOM_ID = "Y2lzY29zcGFyazovL3VzL1JPT00vNmY5MWIwNzAtNTMxYS0xMWYxLTkyNmQtNmZkM2MyMGRmZGM0"


def test_parse_event_flag_string_false_is_not_truthy() -> None:
    assert parse_event_flag("false") is False
    assert parse_event_flag("False", 0) is False
    assert parse_event_flag("true") is True
    assert parse_event_flag("1") is True


def test_parse_webex_event_ignores_event_workspace_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEBEX_WORKSPACE_ALIAS", "CAIPE-WEBEX")
    parsed = parse_webex_event(
        {
            "botId": "primary",
            "person_id": "person1234",
            "space_id": "space12345",
            "workspace_id": "EVENT-SHOULD-NOT-WIN",
        }
    )
    assert parsed is not None
    assert parsed.workspace_id == "CAIPE-WEBEX"


def test_parse_webex_event_canonicalizes_public_room_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEBEX_WORKSPACE_ALIAS", "CAIPE-WEBEX")

    parsed = parse_webex_event(
        {
            "data": {
                "botId": "primary",
                "id": "message-public-id",
                "roomId": PUBLIC_ROOM_ID,
                "personId": "person1234",
                "text": "neo-coder hello",
            }
        }
    )

    assert parsed is not None
    assert parsed.space_id == RAW_ROOM_ID
    assert parsed.webex_room_id == PUBLIC_ROOM_ID
    assert parsed.message_id == "message-public-id"


def test_configured_workspace_requires_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WEBEX_WORKSPACE_ALIAS", raising=False)
    monkeypatch.delenv("WEBEX_WORKSPACE_ID", raising=False)
    assert configured_webex_workspace_ref() is None


def test_workspace_unconfigured_denies(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WEBEX_WORKSPACE_ALIAS", raising=False)
    monkeypatch.delenv("WEBEX_WORKSPACE_ID", raising=False)
    dispatcher = FakeDispatcher()
    result = asyncio.run(
        handle_webex_message(
            _event(),
            dispatcher=dispatcher,
        )
    )
    assert result.reason_code == REASON_WORKSPACE_UNCONFIGURED
    assert dispatcher.calls == []


@dataclass
class FailingIdentityLinker:
    async def resolve(self, webex_user_id: str) -> Optional[str]:
        raise ConnectionError("keycloak unreachable")

    async def linking_url(self, webex_user_id: str) -> Optional[str]:
        return None


def test_identity_lookup_exception_fail_closed() -> None:
    dispatcher = FakeDispatcher()
    result = asyncio.run(
        handle_webex_message(
            _event(),
            identity_linker=FailingIdentityLinker(),
            team_resolver=FakeTeamResolver(),
            dispatcher=dispatcher,
        )
    )
    assert result.reason_code == REASON_IDENTITY_UNAVAILABLE
    assert dispatcher.calls == []
    # Passive channel message — must not be flagged explicit.
    assert result.explicit_invocation is False


def test_identity_lookup_exception_explicit_mention_marks_explicit_invocation() -> None:
    # An @mention must propagate explicit_invocation=True even when
    # linker.resolve() raises, so the responder tells the user identity
    # verification is unavailable instead of silently dropping the request.
    dispatcher = FakeDispatcher()
    result = asyncio.run(
        handle_webex_message(
            _event(text="@bot help", is_bot=False),
            identity_linker=FailingIdentityLinker(),
            team_resolver=FakeTeamResolver(),
            dispatcher=dispatcher,
        )
    )
    assert result.reason_code == REASON_IDENTITY_UNAVAILABLE
    assert result.explicit_invocation is True
    assert dispatcher.calls == []


@dataclass
class ValueErrorOboExchanger:
    async def impersonate(self, keycloak_user_id: str) -> OboToken:
        # Simulates a Keycloak-side failure (e.g. user disabled, KC
        # config drift) — kept as ValueError to preserve the fail-closed
        # path the gate already exercises.
        raise ValueError("OBO exchange failed")


@dataclass
class LinkedIdentityLinker:
    async def resolve(self, webex_user_id: str) -> Optional[str]:
        return "kc-user-1"

    async def linking_url(self, webex_user_id: str) -> Optional[str]:
        return None


def test_obo_value_error_fail_closed() -> None:
    dispatcher = FakeDispatcher()
    result = asyncio.run(
        handle_webex_message(
            _event(),
            identity_linker=LinkedIdentityLinker(),
            team_resolver=FakeTeamResolver(team_slug="platform-eng"),
            obo_exchanger=ValueErrorOboExchanger(),
            dispatcher=dispatcher,
        )
    )
    assert result.reason_code == REASON_OBO_FAILED
    assert dispatcher.calls == []
    # Passive channel message — must not be flagged explicit.
    assert result.explicit_invocation is False


def test_obo_value_error_explicit_mention_marks_explicit_invocation() -> None:
    # An @mention must propagate explicit_invocation=True even when
    # obo.impersonate() raises.
    dispatcher = FakeDispatcher()
    result = asyncio.run(
        handle_webex_message(
            _event(text="@bot help", is_bot=False),
            identity_linker=LinkedIdentityLinker(),
            team_resolver=FakeTeamResolver(team_slug="platform-eng"),
            obo_exchanger=ValueErrorOboExchanger(),
            dispatcher=dispatcher,
        )
    )
    assert result.reason_code == REASON_OBO_FAILED
    assert result.explicit_invocation is True
    assert dispatcher.calls == []


def test_string_false_is_bot_not_ignored() -> None:
    dispatcher = FakeDispatcher()
    result = asyncio.run(
        handle_webex_message(
            {**_event(), "is_bot": "false"},
            identity_linker=LinkedIdentityLinker(),
            team_resolver=FakeTeamResolver(),
            obo_exchanger=FakeOboExchanger(),
            rebac_checker=FakeRebacChecker(),
            route_resolver=FakeRouteResolver(),
            dispatcher=dispatcher,
        )
    )
    assert result.reason_code != REASON_IGNORED_BOT
    assert result.ignored is False


def test_invalid_person_id_is_malformed() -> None:
    assert parse_webex_event({"person_id": "bad/id", "space_id": "space12345"}) is None


def test_invalid_space_id_is_malformed() -> None:
    assert parse_webex_event({"person_id": "person1234", "space_id": "space/with/slash"}) is None
    assert parse_webex_event({"person_id": "person1234", "space_id": "short"}) is None
    assert parse_webex_event({"person_id": "person1234", "space_id": "x" * 200}) is None
    assert parse_webex_event({"person_id": "person1234", "space_id": "space\x00id"}) is None


@dataclass
class CapturingRebacChecker:
    workspace_ids: list[str] = field(default_factory=list)

    def check_space_grant(self, **kwargs: Any):
        self.workspace_ids.append(kwargs["workspace_id"])
        from ai_platform_engineering.integrations.webex_bot.utils.webex_rebac import (
            WebexSpaceRebacDecision,
        )

        return WebexSpaceRebacDecision(
            allowed=True,
            space_allowed=True,
            reason="allowed",
        )


def test_rebac_uses_configured_workspace_not_event_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEBEX_WORKSPACE_ALIAS", "CAIPE-WEBEX")
    rebac = CapturingRebacChecker()
    dispatcher = FakeDispatcher()
    asyncio.run(
        handle_webex_message(
            {
                **_event(),
                "workspace_id": "EVENT-OTHER",
            },
            identity_linker=LinkedIdentityLinker(),
            team_resolver=FakeTeamResolver(),
            obo_exchanger=FakeOboExchanger(),
            rebac_checker=rebac,
            route_resolver=FakeRouteResolver(),
            dispatcher=dispatcher,
        )
    )
    assert rebac.workspace_ids == ["CAIPE-WEBEX"]


def test_route_denied_before_dispatch() -> None:
    dispatcher = FakeDispatcher()
    result = asyncio.run(
        handle_webex_message(
            _event(),
            identity_linker=LinkedIdentityLinker(),
            team_resolver=FakeTeamResolver(),
            obo_exchanger=FakeOboExchanger(),
            route_resolver=FakeRouteResolver(agent_id=None),
            dispatcher=dispatcher,
        )
    )
    assert result.reason_code == "WEBEX_ROUTE_DENIED"
    assert dispatcher.calls == []
