# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for the Webex personal-DM command dispatcher (spec 2026-05-24 T153)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import List, Optional

from ai_platform_engineering.integrations.webex_bot.utils.accessible_agents_client import (
    AccessibleAgent,
    AccessibleAgentsResult,
)
from ai_platform_engineering.integrations.webex_bot.utils.dm_authz_client import (
    DmAgentAccessDecision,
)
from ai_platform_engineering.integrations.webex_bot.utils.dm_thread_overrides import (
    OverrideStore,
)
from ai_platform_engineering.integrations.webex_bot.utils.webex_command_dispatcher import (
    WebexCommandDispatcher,
)


@dataclass
class _Parsed:
    """Minimal stand-in for :class:`ParsedWebexEvent`."""

    person_id: str = "personABC"
    space_id: str = "roomXYZ"
    workspace_id: str = "ws-1"
    text: str = ""
    is_direct: bool = True
    message_id: Optional[str] = "msg-1"
    thread_parent_id: Optional[str] = None


@dataclass
class _FakeWebexApi:
    sent: List[dict] = field(default_factory=list)

    def create_message(
        self,
        *,
        markdown: str,
        room_id: str | None = None,
        parent_id: str | None = None,
        person_id: str | None = None,
    ) -> str:
        self.sent.append(
            {
                "markdown": markdown,
                "room_id": room_id,
                "parent_id": parent_id,
                "person_id": person_id,
            }
        )
        return "msg-id-1"


@dataclass
class _FakeAccessibleAgents:
    agents: List[AccessibleAgent] = field(default_factory=list)
    available: bool = True

    def list_agents(
        self, *, bearer_token: str, page_size: int = 25
    ) -> AccessibleAgentsResult:
        return AccessibleAgentsResult(agents=self.agents, available=self.available)


@dataclass
class _FakeDmAuthz:
    allowed: bool = True
    available: bool = True

    def check_agent_access(
        self, *, agent_id: str, bearer_token: str
    ) -> DmAgentAccessDecision:
        return DmAgentAccessDecision(
            allowed=self.allowed,
            reason="ALLOW" if self.allowed else "DENY",
            path="direct" if self.allowed else "team",
            available=self.available,
        )


def _build(
    *,
    webex_api: Optional[_FakeWebexApi] = None,
    accessible: Optional[_FakeAccessibleAgents] = None,
    authz: Optional[_FakeDmAuthz] = None,
    overrides: Optional[OverrideStore] = None,
) -> WebexCommandDispatcher:
    return WebexCommandDispatcher(
        webex_api=webex_api or _FakeWebexApi(),
        accessible_agents_client=accessible or _FakeAccessibleAgents(),
        dm_authz_client=authz or _FakeDmAuthz(),
        override_store=overrides or OverrideStore(),
    )


def test_returns_none_for_non_command_text() -> None:
    dispatcher = _build()
    parsed = _Parsed(text="hi please book me a flight")
    result = asyncio.run(
        dispatcher.maybe_handle(
            parsed=parsed,
            keycloak_user_id="kc-1",
            bearer_token="bearer-1",
        )
    )
    assert result is None


def test_help_command_replies_inline_in_direct_room() -> None:
    api = _FakeWebexApi()
    dispatcher = _build(webex_api=api)
    parsed = _Parsed(text="help", is_direct=True)
    result = asyncio.run(
        dispatcher.maybe_handle(
            parsed=parsed,
            keycloak_user_id="kc-1",
            bearer_token="bearer-1",
        )
    )
    assert result is not None
    assert result.code == "help"
    assert len(api.sent) == 1
    assert api.sent[0]["room_id"] == "roomXYZ"
    assert api.sent[0]["person_id"] is None
    assert "CAIPE bot commands" in api.sent[0]["markdown"]


def test_help_command_replies_via_dm_in_group_space() -> None:
    api = _FakeWebexApi()
    dispatcher = _build(webex_api=api)
    parsed = _Parsed(text="help", is_direct=False)
    result = asyncio.run(
        dispatcher.maybe_handle(
            parsed=parsed,
            keycloak_user_id="kc-1",
            bearer_token="bearer-1",
        )
    )
    assert result is not None
    assert len(api.sent) == 1
    # In a group space the reply goes to the person, not the room,
    # so we never leak per-user state into the channel.
    assert api.sent[0]["room_id"] is None
    assert api.sent[0]["person_id"] == "personABC"


def test_list_command_lists_accessible_agents() -> None:
    api = _FakeWebexApi()
    dispatcher = _build(
        webex_api=api,
        accessible=_FakeAccessibleAgents(
            agents=[
                AccessibleAgent(id="github", name="GitHub", description="git stuff"),
                AccessibleAgent(id="jira", name="Jira", description=""),
            ]
        ),
    )
    parsed = _Parsed(text="list", is_direct=True)
    result = asyncio.run(
        dispatcher.maybe_handle(
            parsed=parsed,
            keycloak_user_id="kc-1",
            bearer_token="bearer-1",
        )
    )
    assert result is not None
    assert result.code == "list_ok"
    assert len(api.sent) == 1
    body = api.sent[0]["markdown"]
    assert "github" in body
    assert "jira" in body


def test_use_agent_sets_override_in_direct_room() -> None:
    api = _FakeWebexApi()
    overrides = OverrideStore()
    dispatcher = _build(webex_api=api, overrides=overrides)
    parsed = _Parsed(text="use github", is_direct=True)
    result = asyncio.run(
        dispatcher.maybe_handle(
            parsed=parsed,
            keycloak_user_id="kc-1",
            bearer_token="bearer-1",
        )
    )
    assert result is not None
    assert result.code == "use_ok"
    snapshot = overrides._snapshot_for_test()
    assert len(snapshot) == 1
    assert snapshot[0]["agent_id"] == "github"
    assert snapshot[0]["person_id"] == "personABC"
    assert snapshot[0]["room_id"] == "roomXYZ"


def test_use_in_group_space_is_rejected_with_dm_only_message() -> None:
    api = _FakeWebexApi()
    overrides = OverrideStore()
    dispatcher = _build(webex_api=api, overrides=overrides)
    parsed = _Parsed(text="use github", is_direct=False)
    result = asyncio.run(
        dispatcher.maybe_handle(
            parsed=parsed,
            keycloak_user_id="kc-1",
            bearer_token="bearer-1",
        )
    )
    assert result is not None
    assert result.code == "use_dm_only"
    assert overrides._snapshot_for_test() == []


def test_use_default_clears_override() -> None:
    api = _FakeWebexApi()
    overrides = OverrideStore()
    dispatcher = _build(webex_api=api, overrides=overrides)
    # Pre-populate an override so we can assert it's cleared.
    from ai_platform_engineering.integrations.webex_bot.utils.dm_thread_overrides import (
        OverrideKey,
    )

    overrides.set(OverrideKey(person_id="personABC", room_id="roomXYZ"), "agent-x")

    parsed = _Parsed(text="use default", is_direct=True)
    result = asyncio.run(
        dispatcher.maybe_handle(
            parsed=parsed,
            keycloak_user_id="kc-1",
            bearer_token="bearer-1",
        )
    )
    assert result is not None
    assert result.code == "use_default_ok"
    assert overrides._snapshot_for_test() == []


def test_post_reply_failure_does_not_raise() -> None:
    class _BrokenApi:
        def create_message(self, **_: object) -> str:
            raise RuntimeError("webex down")

    dispatcher = WebexCommandDispatcher(webex_api=_BrokenApi())
    parsed = _Parsed(text="help", is_direct=True)
    # Should NOT raise even though the API throws — the command was
    # still "handled" so the runtime gate short-circuits dispatch.
    result = asyncio.run(
        dispatcher.maybe_handle(
            parsed=parsed,
            keycloak_user_id="kc-1",
            bearer_token="bearer-1",
        )
    )
    assert result is not None
    assert result.code == "help"
