# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for B1 dispatch identity-selection logic (anonymous-and-obo-routing).

Covers the full decision table:
  1. obo_user + linked user → user OBO token preserved (context unchanged)
  2. obo_user + unlinked    → anon SA token already stashed by middleware; preserved
  3. service_account route  → named SA token minted + bound (overrides context)
  4. service_account + mint fails → dispatch aborted, ephemeral error sent, NO wrong bind
  5. service_account + missing sub → dispatch aborted, error sent
  6. ExecutionIdentity propagation through _route_to_agent_binding
  7. ExecutionIdentity Pydantic model validation (validator for SA sub requirement)
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.config_models import (
    AgentBinding,
    ExecutionIdentity,
    UsersConfig,
)
from ai_platform_engineering.integrations.slack_bot.utils.dispatch_identity import (
    apply_execution_identity,
)
from ai_platform_engineering.integrations.slack_bot.utils.slack_agent_routes import (
    _route_to_agent_binding,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SA_SUB = "aaaa1111-0000-0000-0000-000000000001"
_USER_TOKEN = "user.obo.token"
_SA_TOKEN = "sa.minted.token"
_ANON_TOKEN = "anon.sa.token"


@dataclass(frozen=True)
class _OboToken:
    access_token: str
    token_type: str = "Bearer"
    expires_in: int = 300


def _make_sa_token(token: str = _SA_TOKEN) -> _OboToken:
    return _OboToken(access_token=token)


def _make_event(
    *,
    channel: str = "C123",
    user: str | None = "U999",
    ts: str = "1700000001.000000",
) -> dict[str, Any]:
    e: dict[str, Any] = {"channel": channel, "ts": ts}
    if user is not None:
        e["user"] = user
    return e


def _make_impersonate_fn(token: str = _SA_TOKEN, raises: Exception | None = None):
    """Return an async impersonate stub."""
    async def _fn(sa_sub: str):  # noqa: ARG001
        if raises is not None:
            raise raises
        return _make_sa_token(token)
    return _fn


# ---------------------------------------------------------------------------
# 1. ExecutionIdentity propagation via _route_to_agent_binding
# ---------------------------------------------------------------------------


class TestRouteToAgentBindingExecutionIdentity:
    def test_no_execution_identity_defaults_to_obo_user(self) -> None:
        route: dict[str, Any] = {
            "agent_id": "agent-1",
            "users": {"enabled": True, "listen": "mention"},
        }
        binding = _route_to_agent_binding(route)
        assert binding is not None
        assert binding.execution_identity.mode == "obo_user"
        assert binding.execution_identity.service_account_sub is None

    def test_obo_user_mode_from_route_doc(self) -> None:
        route: dict[str, Any] = {
            "agent_id": "agent-2",
            "users": {"enabled": True, "listen": "all"},
            "execution_identity": {"mode": "obo_user"},
        }
        binding = _route_to_agent_binding(route)
        assert binding is not None
        assert binding.execution_identity.mode == "obo_user"

    def test_service_account_mode_from_route_doc(self) -> None:
        route: dict[str, Any] = {
            "agent_id": "agent-3",
            "users": {"enabled": True, "listen": "message"},
            "execution_identity": {
                "mode": "service_account",
                "service_account_sub": _SA_SUB,
                "service_account_name": "incident-bot",
            },
        }
        binding = _route_to_agent_binding(route)
        assert binding is not None
        assert binding.execution_identity.mode == "service_account"
        assert binding.execution_identity.service_account_sub == _SA_SUB
        assert binding.execution_identity.service_account_name == "incident-bot"

    def test_invalid_execution_identity_defaults_to_obo_user(self) -> None:
        route: dict[str, Any] = {
            "agent_id": "agent-4",
            "users": {"enabled": True, "listen": "mention"},
            "execution_identity": {"mode": "UNKNOWN_INVALID_MODE"},
        }
        binding = _route_to_agent_binding(route)
        assert binding is not None
        # Falls back to obo_user on validation error
        assert binding.execution_identity.mode == "obo_user"

    def test_non_dict_execution_identity_defaults_to_obo_user(self) -> None:
        route: dict[str, Any] = {
            "agent_id": "agent-5",
            "users": {"enabled": True, "listen": "mention"},
            "execution_identity": "invalid-string",
        }
        binding = _route_to_agent_binding(route)
        assert binding is not None
        assert binding.execution_identity.mode == "obo_user"

    def test_service_account_without_sub_defaults_to_obo_user(self) -> None:
        """A service_account route with no sub is invalid; resolver falls back to obo_user."""
        route: dict[str, Any] = {
            "agent_id": "agent-6",
            "users": {"enabled": True, "listen": "mention"},
            "execution_identity": {"mode": "service_account"},
        }
        binding = _route_to_agent_binding(route)
        assert binding is not None
        # Validator rejects it → fallback to obo_user in _route_to_agent_binding
        assert binding.execution_identity.mode == "obo_user"


# ---------------------------------------------------------------------------
# 2. AgentBinding default execution_identity
# ---------------------------------------------------------------------------


class TestAgentBindingDefaults:
    def test_default_execution_identity_is_obo_user(self) -> None:
        binding = AgentBinding(
            agent_id="x",
            users=UsersConfig(enabled=True, listen="mention"),
        )
        assert binding.execution_identity.mode == "obo_user"
        assert binding.execution_identity.service_account_sub is None

    def test_execution_identity_service_account_roundtrip(self) -> None:
        ei = ExecutionIdentity(mode="service_account", service_account_sub=_SA_SUB)
        binding = AgentBinding(agent_id="y", execution_identity=ei)
        assert binding.execution_identity.mode == "service_account"
        assert binding.execution_identity.service_account_sub == _SA_SUB


# ---------------------------------------------------------------------------
# 3. Decision table — apply_execution_identity behavior tests
#    These replace the old source-string tests in TestNudgeCopyReworded,
#    TestMintAnonymousOboToken, and TestServiceAccountDispatchWiring.
# ---------------------------------------------------------------------------


class TestDecisionTableOboUser:
    """obo_user rows: apply_execution_identity must be a no-op."""

    def test_obo_user_linked_context_token_preserved(self) -> None:
        """obo_user + linked → context["obo_token"] unchanged, proceed=True."""
        context: dict[str, Any] = {"obo_token": _USER_TOKEN}
        impersonate = _make_impersonate_fn()
        result = apply_execution_identity(
            exec_mode="obo_user",
            sa_sub=None,
            agent_id="agent-obo",
            context=context,
            event=_make_event(),
            client=MagicMock(),
            say=MagicMock(),
            is_bot=False,
            impersonate_fn=impersonate,
        )
        assert result is True
        # Token must not be touched.
        assert context["obo_token"] == _USER_TOKEN

    def test_obo_user_unlinked_anon_token_preserved(self) -> None:
        """obo_user + unlinked → anon token already in context; preserved, proceed=True."""
        context: dict[str, Any] = {"obo_token": _ANON_TOKEN}
        impersonate = _make_impersonate_fn()
        result = apply_execution_identity(
            exec_mode="obo_user",
            sa_sub=None,
            agent_id="agent-obo",
            context=context,
            event=_make_event(),
            client=MagicMock(),
            say=MagicMock(),
            is_bot=False,
            impersonate_fn=impersonate,
        )
        assert result is True
        assert context["obo_token"] == _ANON_TOKEN

    def test_obo_user_does_not_call_impersonate(self) -> None:
        """obo_user must never call impersonate_fn."""
        called: list[str] = []

        async def _spy_impersonate(sub: str) -> _OboToken:
            called.append(sub)
            return _make_sa_token()

        apply_execution_identity(
            exec_mode="obo_user",
            sa_sub=_SA_SUB,
            agent_id="agent-spy",
            context={"obo_token": _USER_TOKEN},
            event=_make_event(),
            client=MagicMock(),
            say=MagicMock(),
            is_bot=False,
            impersonate_fn=_spy_impersonate,
        )
        assert called == [], "impersonate_fn must not be called for obo_user routes"


class TestDecisionTableServiceAccount:
    """service_account rows: mint SA token, bind it, proceed=True."""

    def test_sa_route_mints_and_binds_token(self) -> None:
        """service_account + mint ok → context["obo_token"] = SA token, proceed=True."""
        context: dict[str, Any] = {"obo_token": _USER_TOKEN}
        impersonate = _make_impersonate_fn(_SA_TOKEN)
        result = apply_execution_identity(
            exec_mode="service_account",
            sa_sub=_SA_SUB,
            agent_id="agent-sa",
            context=context,
            event=_make_event(),
            client=MagicMock(),
            say=MagicMock(),
            is_bot=False,
            impersonate_fn=impersonate,
        )
        assert result is True
        # SA token must OVERRIDE the user OBO token.
        assert context["obo_token"] == _SA_TOKEN

    def test_sa_route_overrides_anon_token_for_bot(self) -> None:
        """service_account bot message → SA token replaces whatever was in context."""
        context: dict[str, Any] = {}  # bot has no user OBO token
        impersonate = _make_impersonate_fn(_SA_TOKEN)
        result = apply_execution_identity(
            exec_mode="service_account",
            sa_sub=_SA_SUB,
            agent_id="agent-sa-bot",
            context=context,
            event=_make_event(user=None),
            client=MagicMock(),
            say=MagicMock(),
            is_bot=True,
            impersonate_fn=impersonate,
        )
        assert result is True
        assert context["obo_token"] == _SA_TOKEN

    def test_sa_route_impersonate_called_with_correct_sub(self) -> None:
        """impersonate_fn is called exactly once with the configured sa_sub."""
        captured: list[str] = []

        async def _capture(sub: str) -> _OboToken:
            captured.append(sub)
            return _make_sa_token()

        apply_execution_identity(
            exec_mode="service_account",
            sa_sub=_SA_SUB,
            agent_id="agent-cap",
            context={},
            event=_make_event(),
            client=MagicMock(),
            say=MagicMock(),
            is_bot=False,
            impersonate_fn=_capture,
        )
        assert captured == [_SA_SUB]


class TestDecisionTableServiceAccountMintFails:
    """service_account + mint failure → abort, error notice sent, NO wrong-identity bind.

    This is PY-B2: we must NEVER fall through to dispatch under the wrong identity.
    """

    def _run_failing_sa(
        self,
        exc: Exception,
        *,
        is_bot: bool = False,
        user: str | None = "U999",
    ) -> tuple[bool, dict[str, Any], MagicMock, MagicMock]:
        context: dict[str, Any] = {"obo_token": _USER_TOKEN}
        client = MagicMock()
        say = MagicMock()
        result = apply_execution_identity(
            exec_mode="service_account",
            sa_sub=_SA_SUB,
            agent_id="agent-fail",
            context=context,
            event=_make_event(user=user),
            client=client,
            say=say,
            is_bot=is_bot,
            impersonate_fn=_make_impersonate_fn(raises=exc),
        )
        return result, context, client, say

    def test_mint_failure_returns_false(self) -> None:
        """Dispatch must be aborted (False) when mint fails."""
        from ai_platform_engineering.integrations.slack_bot.utils.obo_exchange import OboExchangeError
        result, _, _, _ = self._run_failing_sa(OboExchangeError("kc unavailable"))
        assert result is False

    def test_mint_failure_no_wrong_identity_bind(self) -> None:
        """context["obo_token"] must NOT be overwritten when mint fails (PY-B2)."""
        from ai_platform_engineering.integrations.slack_bot.utils.obo_exchange import OboExchangeError
        _, context, _, _ = self._run_failing_sa(OboExchangeError("kc unavailable"))
        # Original user token must still be there — NOT the SA token.
        assert context.get("obo_token") == _USER_TOKEN

    def test_mint_failure_sends_ephemeral_error_to_human(self) -> None:
        """On mint failure for a human message, chat_postEphemeral is called."""
        from ai_platform_engineering.integrations.slack_bot.utils.obo_exchange import OboExchangeError
        _, _, client, say = self._run_failing_sa(OboExchangeError("kc unavailable"), is_bot=False)
        client.chat_postEphemeral.assert_called_once()
        say.assert_not_called()

    def test_mint_failure_uses_say_for_bot_message(self) -> None:
        """On mint failure for a bot message, say() is used (no user to target)."""
        from ai_platform_engineering.integrations.slack_bot.utils.obo_exchange import OboExchangeError
        _, _, client, say = self._run_failing_sa(
            OboExchangeError("kc unavailable"), is_bot=True, user=None
        )
        say.assert_called_once()
        client.chat_postEphemeral.assert_not_called()

    def test_runtime_error_also_aborts(self) -> None:
        """PY-S3: any exception (not just OboExchangeError) must abort dispatch."""
        result, _, _, _ = self._run_failing_sa(RuntimeError("event loop closed"))
        assert result is False

    def test_cancelled_error_also_aborts(self) -> None:
        """asyncio.CancelledError must also abort dispatch."""
        result, _, _, _ = self._run_failing_sa(asyncio.CancelledError())
        assert result is False

    def test_mint_failure_no_wrong_token_for_generic_exception(self) -> None:
        """On generic exception, obo_token must not be overwritten."""
        _, context, _, _ = self._run_failing_sa(RuntimeError("boom"))
        assert context.get("obo_token") == _USER_TOKEN


class TestDecisionTableServiceAccountMissingSub:
    """service_account with no sub → abort, error sent, no bind."""

    def test_missing_sub_returns_false(self) -> None:
        result = apply_execution_identity(
            exec_mode="service_account",
            sa_sub=None,
            agent_id="agent-nosub",
            context={"obo_token": _USER_TOKEN},
            event=_make_event(),
            client=MagicMock(),
            say=MagicMock(),
            is_bot=False,
            impersonate_fn=_make_impersonate_fn(),
        )
        assert result is False

    def test_empty_sub_returns_false(self) -> None:
        result = apply_execution_identity(
            exec_mode="service_account",
            sa_sub="   ",
            agent_id="agent-emptysub",
            context={"obo_token": _USER_TOKEN},
            event=_make_event(),
            client=MagicMock(),
            say=MagicMock(),
            is_bot=False,
            impersonate_fn=_make_impersonate_fn(),
        )
        assert result is False

    def test_missing_sub_sends_error_notice(self) -> None:
        client = MagicMock()
        apply_execution_identity(
            exec_mode="service_account",
            sa_sub=None,
            agent_id="agent-nosub",
            context={"obo_token": _USER_TOKEN},
            event=_make_event(),
            client=client,
            say=MagicMock(),
            is_bot=False,
            impersonate_fn=_make_impersonate_fn(),
        )
        client.chat_postEphemeral.assert_called_once()

    def test_missing_sub_does_not_overwrite_context_token(self) -> None:
        context: dict[str, Any] = {"obo_token": _USER_TOKEN}
        apply_execution_identity(
            exec_mode="service_account",
            sa_sub=None,
            agent_id="agent-nosub",
            context=context,
            event=_make_event(),
            client=MagicMock(),
            say=MagicMock(),
            is_bot=False,
            impersonate_fn=_make_impersonate_fn(),
        )
        assert context.get("obo_token") == _USER_TOKEN


# ---------------------------------------------------------------------------
# 4. ExecutionIdentity model validation (PY-S2 / PY-N3)
# ---------------------------------------------------------------------------


class TestExecutionIdentityModel:
    def test_default_mode_is_obo_user(self) -> None:
        ei = ExecutionIdentity()
        assert ei.mode == "obo_user"

    def test_service_account_mode_accepted_with_sub(self) -> None:
        ei = ExecutionIdentity(mode="service_account", service_account_sub=_SA_SUB)
        assert ei.mode == "service_account"
        assert ei.service_account_sub == _SA_SUB

    def test_service_account_without_sub_raises(self) -> None:
        """C1 contract: service_account_sub is REQUIRED when mode=service_account."""
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="service_account_sub"):
            ExecutionIdentity(mode="service_account")

    def test_service_account_with_empty_sub_raises(self) -> None:
        """Whitespace-only sub must also be rejected."""
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="service_account_sub"):
            ExecutionIdentity(mode="service_account", service_account_sub="   ")

    def test_invalid_mode_raises(self) -> None:
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            ExecutionIdentity(mode="bad_mode")  # type: ignore[arg-type]

    def test_optional_fields_are_none_by_default(self) -> None:
        ei = ExecutionIdentity(mode="obo_user")
        assert ei.service_account_sub is None
        assert ei.service_account_name is None

    def test_obo_user_does_not_require_sub(self) -> None:
        """obo_user must parse cleanly with no service_account_sub."""
        ei = ExecutionIdentity(mode="obo_user")
        assert ei.mode == "obo_user"
        assert ei.service_account_sub is None

    def test_service_account_sub_stripped_whitespace_passes(self) -> None:
        """A sub that is non-empty after stripping should be valid."""
        ei = ExecutionIdentity(mode="service_account", service_account_sub=f"  {_SA_SUB}  ")
        # Pydantic doesn't strip on its own — the validator only REJECTS blank subs.
        # The value is stored as-is; dispatch_identity.apply_execution_identity
        # passes it verbatim to impersonate_fn (which strips if needed).
        assert ei.service_account_sub is not None
