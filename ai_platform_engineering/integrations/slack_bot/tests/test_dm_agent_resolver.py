# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Phase 2.3 — Slack DM agent resolver (spec 2026-05-24 FR-023).

Priority chain:

  1. thread override (from ``OverrideStore``) — if PDP allows, use.
  2. saved per-user preference (``user_preferences`` BFF) — if PDP allows.
  3. deployment ``dm_agent_id`` env var — if PDP allows.
  4. deployment ``default_agent_id`` env var — if PDP allows.
  5. None → deny with help text.

For every candidate the resolver re-checks `can_use` via the BFF PDP
(`DmAuthzClient`). If a candidate is no longer authorized:

* For override: the resolver emits an ephemeral "your override is no
  longer authorized" notice (returned in the result) and falls through.
* For saved preference: the resolver emits an ephemeral notice and
  falls through.
* For dm_agent_id / default_agent_id: silent fall-through.

If the PDP is unavailable, the resolver returns a temporary-unavailable
status — callers MUST translate to "service temporarily unavailable".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.dm_agent_resolver import (
    DmAgentResolution,
    resolve_dm_agent,
)
from ai_platform_engineering.integrations.slack_bot.utils.dm_authz_client import (
    DmAgentAccessDecision,
)
from ai_platform_engineering.integrations.slack_bot.utils.dm_thread_overrides import (
    OverrideKey,
    OverrideStore,
)
from ai_platform_engineering.integrations.slack_bot.utils.user_preferences_client import (
    UserPreferenceResult,
)


@dataclass
class FakeAuthzClient:
    """Returns the same decision for any agent_id, plus tracks calls."""

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
                matched_team_slug=None,
            )
        ok = agent_id in self.allowed_agents
        return DmAgentAccessDecision(
            allowed=ok,
            reason="ALLOW_DIRECT" if ok else "DENY_NO_CAPABILITY",
            path="direct_user_grant" if ok else "denied",
            available=True,
            matched_team_slug=None,
        )


@dataclass
class FakePrefClient:
    result: UserPreferenceResult

    def get_dm_default_agent(self, *, bearer_token: str) -> UserPreferenceResult:  # noqa: ARG002
        return self.result


def _override_key() -> OverrideKey:
    return OverrideKey(
        workspace_id="W1", channel_id="C1", user_id="u1", thread_ts="t1"
    )


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
        bearer_token="obo-token",
    )


class TestResolverHappyPath:
    def test_override_present_and_authorized_returns_override(self) -> None:
        overrides = OverrideStore()
        overrides.set(_override_key(), "agent-x")
        prefs = FakePrefClient(UserPreferenceResult(agent_id="agent-y", source="saved"))
        authz = FakeAuthzClient(allowed_agents={"agent-x", "agent-y"})

        result = _call(overrides=overrides, authz=authz, prefs=prefs)

        assert result.agent_id == "agent-x"
        assert result.source == "thread_override"
        assert result.notices == []
        # Resolver MUST short-circuit before checking prefs.
        assert authz.calls == ["agent-x"]

    def test_saved_preference_used_when_no_override(self) -> None:
        overrides = OverrideStore()
        prefs = FakePrefClient(UserPreferenceResult(agent_id="agent-y", source="saved"))
        authz = FakeAuthzClient(allowed_agents={"agent-y"})

        result = _call(overrides=overrides, authz=authz, prefs=prefs)

        assert result.agent_id == "agent-y"
        assert result.source == "saved_preference"
        assert result.notices == []

    def test_dm_agent_id_used_when_no_override_no_pref(self) -> None:
        overrides = OverrideStore()
        prefs = FakePrefClient(UserPreferenceResult(agent_id=None, source="not_set"))
        authz = FakeAuthzClient(allowed_agents={"dm-fallback"})

        result = _call(overrides=overrides, authz=authz, prefs=prefs)

        assert result.agent_id == "dm-fallback"
        assert result.source == "dm_agent_id"

    def test_default_agent_id_used_when_everything_else_absent(self) -> None:
        overrides = OverrideStore()
        prefs = FakePrefClient(UserPreferenceResult(agent_id=None, source="not_set"))
        authz = FakeAuthzClient(allowed_agents={"default-fallback"})

        result = _call(
            overrides=overrides,
            authz=authz,
            prefs=prefs,
            dm_agent_id=None,
        )

        assert result.agent_id == "default-fallback"
        assert result.source == "default_agent_id"


class TestResolverDeny:
    def test_no_candidate_authorized_returns_deny(self) -> None:
        overrides = OverrideStore()
        overrides.set(_override_key(), "agent-x")
        prefs = FakePrefClient(UserPreferenceResult(agent_id="agent-y", source="saved"))
        authz = FakeAuthzClient(allowed_agents=set())  # nothing allowed

        result = _call(overrides=overrides, authz=authz, prefs=prefs)

        assert result.agent_id is None
        assert result.source == "denied"
        assert authz.calls == ["agent-x", "agent-y", "dm-fallback", "default-fallback"]

    def test_no_candidates_at_all_returns_deny(self) -> None:
        overrides = OverrideStore()
        prefs = FakePrefClient(UserPreferenceResult(agent_id=None, source="not_set"))
        authz = FakeAuthzClient(allowed_agents=set())

        result = _call(
            overrides=overrides,
            authz=authz,
            prefs=prefs,
            dm_agent_id=None,
            default_agent_id=None,
        )

        assert result.agent_id is None
        assert result.source == "no_candidates"


class TestResolverFallthroughNotices:
    def test_override_unauthorized_emits_notice_and_falls_through(self) -> None:
        overrides = OverrideStore()
        overrides.set(_override_key(), "agent-x")
        prefs = FakePrefClient(UserPreferenceResult(agent_id="agent-y", source="saved"))
        # agent-x no longer authorized; agent-y still is.
        authz = FakeAuthzClient(allowed_agents={"agent-y"})

        result = _call(overrides=overrides, authz=authz, prefs=prefs)

        assert result.agent_id == "agent-y"
        assert result.source == "saved_preference"
        assert any(
            "override" in n.lower() and "agent-x" in n for n in result.notices
        ), f"expected an override-fall-through notice; got {result.notices}"

    def test_unauthorized_override_is_auto_cleared(self) -> None:
        """If the override fails the PDP check the resolver clears it
        from the store so the user isn't stuck re-getting the notice
        on every subsequent message."""
        overrides = OverrideStore()
        overrides.set(_override_key(), "agent-x")
        prefs = FakePrefClient(UserPreferenceResult(agent_id=None, source="not_set"))
        authz = FakeAuthzClient(allowed_agents={"dm-fallback"})

        _call(overrides=overrides, authz=authz, prefs=prefs)

        assert overrides.get(_override_key()) is None

    def test_saved_pref_unauthorized_emits_notice(self) -> None:
        overrides = OverrideStore()
        prefs = FakePrefClient(UserPreferenceResult(agent_id="agent-y", source="saved"))
        authz = FakeAuthzClient(allowed_agents={"dm-fallback"})

        result = _call(overrides=overrides, authz=authz, prefs=prefs)

        assert result.agent_id == "dm-fallback"
        assert result.source == "dm_agent_id"
        assert any(
            "preference" in n.lower() and "agent-y" in n for n in result.notices
        ), f"expected a saved-pref fall-through notice; got {result.notices}"

    def test_dm_and_default_fallthroughs_are_silent(self) -> None:
        """The org-default fallbacks must not spam the user with notices."""
        overrides = OverrideStore()
        prefs = FakePrefClient(UserPreferenceResult(agent_id=None, source="not_set"))
        # Neither dm-fallback nor default-fallback are authorized.
        authz = FakeAuthzClient(allowed_agents=set())

        result = _call(overrides=overrides, authz=authz, prefs=prefs)

        # No org-default notices in the message stream — just the
        # final deny.
        org_chatter = [n for n in result.notices if "default" in n.lower()]
        assert not org_chatter, f"unexpected org-default notice: {org_chatter}"


class TestResolverPdpUnavailable:
    def test_pdp_unavailable_short_circuits_with_unavailable_status(self) -> None:
        overrides = OverrideStore()
        overrides.set(_override_key(), "agent-x")
        prefs = FakePrefClient(UserPreferenceResult(agent_id="agent-y", source="saved"))
        authz = FakeAuthzClient(allowed_agents=set(), available=False)

        result = _call(overrides=overrides, authz=authz, prefs=prefs)

        assert result.agent_id is None
        assert result.source == "pdp_unavailable"
        # The resolver MUST NOT keep probing once the PDP is unhealthy.
        assert len(authz.calls) == 1


class TestPreferenceClientUnavailableIsTransient:
    def test_pref_client_unavailable_falls_through_to_dm_agent(self) -> None:
        """When the prefs BFF is unreachable we treat it as 'no
        preference set' and fall through silently — that's the FR-027
        graceful-degradation contract."""
        overrides = OverrideStore()
        prefs = FakePrefClient(
            UserPreferenceResult(agent_id=None, source="unavailable")
        )
        authz = FakeAuthzClient(allowed_agents={"dm-fallback"})

        result = _call(overrides=overrides, authz=authz, prefs=prefs)

        assert result.agent_id == "dm-fallback"
        assert result.source == "dm_agent_id"
        # No "your preference" notice — we don't know whether they have
        # one and we never want to leak that state when the BFF is down.
        assert not any("preference" in n.lower() for n in result.notices)


@pytest.mark.parametrize("agent_value", [None, "", "  "])
def test_empty_env_defaults_treated_as_unset(agent_value: Optional[str]) -> None:
    overrides = OverrideStore()
    prefs = FakePrefClient(UserPreferenceResult(agent_id=None, source="not_set"))
    authz = FakeAuthzClient(allowed_agents={"default-fallback"})

    result = resolve_dm_agent(
        override_key=_override_key(),
        overrides=overrides,
        prefs_client=prefs,
        authz_client=authz,
        dm_agent_id=agent_value,
        default_agent_id="default-fallback",
        bearer_token="obo",
    )
    assert result.agent_id == "default-fallback"
    assert result.source == "default_agent_id"
