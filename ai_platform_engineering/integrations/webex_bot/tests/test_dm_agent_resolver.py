# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Phase 2.3 — Webex DM (1:1) agent resolver.

Mirror of the Slack-bot ``test_dm_agent_resolver.py`` adapted for the
Webex override-key shape (person_id, room_id).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import pytest

from ai_platform_engineering.integrations.webex_bot.utils.dm_agent_resolver import (
    DmAgentResolution,
    resolve_dm_agent,
)
from ai_platform_engineering.integrations.webex_bot.utils.dm_authz_client import (
    DmAgentAccessDecision,
)
from ai_platform_engineering.integrations.webex_bot.utils.dm_thread_overrides import (
    OverrideKey,
    OverrideStore,
)
from ai_platform_engineering.integrations.webex_bot.utils.user_preferences_client import (
    UserPreferenceResult,
)


@dataclass
class FakeAuthzClient:
    allowed_agents: set[str]
    available: bool = True
    calls: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.calls = []

    def check_agent_access(
        self, *, agent_id: str, bearer_token: str  # noqa: ARG002
    ) -> DmAgentAccessDecision:
        self.calls.append(agent_id)
        if not self.available:
            return DmAgentAccessDecision(
                allowed=False,
                reason="PDP_UNAVAILABLE",
                path="unavailable",
                available=False,
            )
        ok = agent_id in self.allowed_agents
        return DmAgentAccessDecision(
            allowed=ok,
            reason="ALLOW_DIRECT" if ok else "DENY_NO_CAPABILITY",
            path="direct_user_grant" if ok else "denied",
            available=True,
        )


@dataclass
class FakePrefClient:
    result: UserPreferenceResult

    def get_dm_default_agent(self, *, bearer_token: str) -> UserPreferenceResult:  # noqa: ARG002
        return self.result


def _override_key() -> OverrideKey:
    return OverrideKey(person_id="p1", room_id="r1")


def _call(
    *,
    overrides: OverrideStore,
    authz: FakeAuthzClient,
    prefs: FakePrefClient,
    dm_agent_id: Optional[str] = "dm-fallback",
    default_agent_id: Optional[str] = "default-fallback",
) -> DmAgentResolution:
    return resolve_dm_agent(
        override_key=_override_key(),
        overrides=overrides,
        prefs_client=prefs,
        authz_client=authz,
        dm_agent_id=dm_agent_id,
        default_agent_id=default_agent_id,
        bearer_token="obo",
    )


def test_override_wins() -> None:
    overrides = OverrideStore()
    overrides.set(_override_key(), "agent-x")
    prefs = FakePrefClient(UserPreferenceResult(agent_id="agent-y", source="saved"))
    authz = FakeAuthzClient(allowed_agents={"agent-x", "agent-y"})

    r = _call(overrides=overrides, authz=authz, prefs=prefs)

    assert r.agent_id == "agent-x"
    assert r.source == "thread_override"


def test_saved_pref_when_no_override() -> None:
    overrides = OverrideStore()
    prefs = FakePrefClient(UserPreferenceResult(agent_id="agent-y", source="saved"))
    authz = FakeAuthzClient(allowed_agents={"agent-y"})

    r = _call(overrides=overrides, authz=authz, prefs=prefs)

    assert r.agent_id == "agent-y"
    assert r.source == "saved_preference"


def test_falls_back_to_dm_then_default() -> None:
    overrides = OverrideStore()
    prefs = FakePrefClient(UserPreferenceResult(agent_id=None, source="not_set"))
    authz = FakeAuthzClient(allowed_agents={"default-fallback"})

    r = _call(overrides=overrides, authz=authz, prefs=prefs, dm_agent_id=None)

    assert r.agent_id == "default-fallback"
    assert r.source == "default_agent_id"


def test_deny_when_nothing_authorized() -> None:
    overrides = OverrideStore()
    overrides.set(_override_key(), "agent-x")
    prefs = FakePrefClient(UserPreferenceResult(agent_id="agent-y", source="saved"))
    authz = FakeAuthzClient(allowed_agents=set())

    r = _call(overrides=overrides, authz=authz, prefs=prefs)

    assert r.agent_id is None
    assert r.source == "denied"


def test_unauthorized_override_auto_cleared() -> None:
    overrides = OverrideStore()
    overrides.set(_override_key(), "agent-x")
    prefs = FakePrefClient(UserPreferenceResult(agent_id=None, source="not_set"))
    authz = FakeAuthzClient(allowed_agents={"dm-fallback"})

    _call(overrides=overrides, authz=authz, prefs=prefs)

    assert overrides.get(_override_key()) is None


def test_pdp_unavailable_short_circuits() -> None:
    overrides = OverrideStore()
    overrides.set(_override_key(), "agent-x")
    prefs = FakePrefClient(UserPreferenceResult(agent_id="agent-y", source="saved"))
    authz = FakeAuthzClient(allowed_agents=set(), available=False)

    r = _call(overrides=overrides, authz=authz, prefs=prefs)

    assert r.agent_id is None
    assert r.source == "pdp_unavailable"
    assert len(authz.calls) == 1


def test_pref_unavailable_silently_falls_through() -> None:
    overrides = OverrideStore()
    prefs = FakePrefClient(UserPreferenceResult(agent_id=None, source="unavailable"))
    authz = FakeAuthzClient(allowed_agents={"dm-fallback"})

    r = _call(overrides=overrides, authz=authz, prefs=prefs)

    assert r.agent_id == "dm-fallback"
    assert r.source == "dm_agent_id"
    assert not any("preference" in n.lower() for n in r.notices)


@pytest.mark.parametrize("v", [None, "", "  "])
def test_blank_env_default_treated_as_unset(v: Optional[str]) -> None:
    overrides = OverrideStore()
    prefs = FakePrefClient(UserPreferenceResult(agent_id=None, source="not_set"))
    authz = FakeAuthzClient(allowed_agents={"default-fallback"})

    r = resolve_dm_agent(
        override_key=_override_key(),
        overrides=overrides,
        prefs_client=prefs,
        authz_client=authz,
        dm_agent_id=v,
        default_agent_id="default-fallback",
        bearer_token="obo",
    )
    assert r.agent_id == "default-fallback"
    assert r.source == "default_agent_id"
