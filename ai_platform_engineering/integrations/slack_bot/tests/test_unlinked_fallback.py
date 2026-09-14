# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for the extracted apply_unlinked_fallback function (TEST-5/6).

Covers:
  - mint success → token stashed in context + proceed (True)
  - mint returns None → nudge+stop (False)
  - DM channel → chat_postMessage (UX-2)
  - Non-DM channel → chat_postEphemeral (UX-2)
  - Rate-limiting (cooldown still active → no nudge)
  - Non-relevant rbac_status values → no-op, returns True
  - is_explicit_invocation=False → nudges suppressed for passive channel posts

Importable without slack_sdk: apply_unlinked_fallback lives in
utils/unlinked_fallback.py which has no slack_bolt dependency.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Optional
from unittest.mock import MagicMock

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.unlinked_fallback import (
    apply_unlinked_fallback,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SLACK_USER = "USLACK001"
_CHANNEL = "C1234"
_DM_CHANNEL = "D5678"
_UNLINKED_TOKEN = "unlinked.sa.token"


def _make_context() -> dict[str, Any]:
    ctx: dict[str, Any] = {}
    ctx["client"] = MagicMock()
    return ctx


def _run(coro) -> Any:
    return asyncio.run(coro)


async def _mint_ok() -> Optional[str]:
    return _UNLINKED_TOKEN


async def _mint_none() -> Optional[str]:
    return None


async def _mint_raises() -> Optional[str]:
    raise RuntimeError("Keycloak down")


async def _linking_url(uid: str) -> Optional[str]:
    return f"https://caipe.example.com/link?user={uid}"


def _is_dm(channel_id: Optional[str]) -> bool:
    return bool(channel_id) and str(channel_id).startswith("D")


# ---------------------------------------------------------------------------
# Non-relevant status → no-op
# ---------------------------------------------------------------------------


class TestNonRelevantStatus:
    @pytest.mark.parametrize("status", ["ok", ("deny", "msg"), None, "other"])
    def test_non_relevant_status_returns_true_immediately(self, status) -> None:
        ctx = _make_context()
        result = _run(
            apply_unlinked_fallback(
                rbac_status=status,
                slack_user_id=_SLACK_USER,
                channel=_CHANNEL,
                context=ctx,
                mint_fn=_mint_ok,
                linking_url_fn=_linking_url,
                last_sent=0.0,
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
            )
        )
        assert result is True
        assert "obo_token" not in ctx
        ctx["client"].chat_postEphemeral.assert_not_called()
        ctx["client"].chat_postMessage.assert_not_called()


# ---------------------------------------------------------------------------
# Mint success paths
# ---------------------------------------------------------------------------


class TestMintSuccess:
    def test_token_stashed_and_proceed(self) -> None:
        ctx = _make_context()
        result = _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=_CHANNEL,
                context=ctx,
                mint_fn=_mint_ok,
                linking_url_fn=_linking_url,
                last_sent=0.0,
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
                is_explicit_invocation=True,
            )
        )
        assert result is True
        assert ctx["obo_token"] == _UNLINKED_TOKEN
        assert ctx["unlinked_fallback"] is True

    def test_nudge_sent_in_channel_as_ephemeral(self) -> None:
        ctx = _make_context()
        _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=_CHANNEL,
                context=ctx,
                mint_fn=_mint_ok,
                linking_url_fn=_linking_url,
                last_sent=0.0,
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
                is_explicit_invocation=True,
            )
        )
        ctx["client"].chat_postEphemeral.assert_called_once()
        ctx["client"].chat_postMessage.assert_not_called()
        call_kwargs = ctx["client"].chat_postEphemeral.call_args[1]
        assert call_kwargs["channel"] == _CHANNEL
        assert call_kwargs["user"] == _SLACK_USER

    def test_nudge_sent_in_dm_as_post_message(self) -> None:
        """UX-2: in a DM channel, use chat_postMessage not chat_postEphemeral."""
        ctx = _make_context()
        _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=_DM_CHANNEL,
                context=ctx,
                mint_fn=_mint_ok,
                linking_url_fn=_linking_url,
                last_sent=0.0,
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
                is_explicit_invocation=True,
            )
        )
        ctx["client"].chat_postMessage.assert_called_once()
        ctx["client"].chat_postEphemeral.assert_not_called()
        call_kwargs = ctx["client"].chat_postMessage.call_args[1]
        assert call_kwargs["channel"] == _DM_CHANNEL

    def test_unlinked_status_uses_sso_copy(self) -> None:
        """'unlinked' status → "Link your enterprise (SSO) identity" copy."""
        ctx = _make_context()
        _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=_CHANNEL,
                context=ctx,
                mint_fn=_mint_ok,
                linking_url_fn=_linking_url,
                last_sent=0.0,
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
                is_explicit_invocation=True,
            )
        )
        ctx["client"].chat_postEphemeral.assert_called_once()
        text = ctx["client"].chat_postEphemeral.call_args[1]["text"]
        assert "enterprise" in text.lower() or "SSO" in text or "sso" in text.lower()

    def test_cooldown_suppresses_nudge(self) -> None:
        """If cooldown has not elapsed, no nudge is sent, but we still PROCEED."""
        ctx = _make_context()
        now = time.time()
        result = _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=_CHANNEL,
                context=ctx,
                mint_fn=_mint_ok,
                linking_url_fn=_linking_url,
                last_sent=now - 10,  # 10s ago, well within 3600s cooldown
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
                is_explicit_invocation=True,
            )
        )
        assert result is True
        ctx["client"].chat_postEphemeral.assert_not_called()
        ctx["client"].chat_postMessage.assert_not_called()
        # Token should still be stashed
        assert ctx["obo_token"] == _UNLINKED_TOKEN

    def test_no_channel_no_nudge(self) -> None:
        """When channel is None, still proceed but no nudge is attempted."""
        ctx = _make_context()
        result = _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=None,
                context=ctx,
                mint_fn=_mint_ok,
                linking_url_fn=_linking_url,
                last_sent=0.0,
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
                is_explicit_invocation=True,
            )
        )
        assert result is True
        assert ctx["obo_token"] == _UNLINKED_TOKEN
        ctx["client"].chat_postEphemeral.assert_not_called()


# ---------------------------------------------------------------------------
# Mint failure paths
# ---------------------------------------------------------------------------


class TestMintFailure:
    def test_mint_none_returns_abort(self) -> None:
        """mint returns None → ABORT (False)."""
        ctx = _make_context()
        result = _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=_CHANNEL,
                context=ctx,
                mint_fn=_mint_none,
                linking_url_fn=_linking_url,
                last_sent=0.0,
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
            )
        )
        assert result is False
        assert "obo_token" not in ctx

    def test_mint_exception_returns_abort(self) -> None:
        """mint raises → ABORT (False), does not propagate."""
        ctx = _make_context()
        result = _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=_CHANNEL,
                context=ctx,
                mint_fn=_mint_raises,
                linking_url_fn=_linking_url,
                last_sent=0.0,
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
            )
        )
        assert result is False
        assert "obo_token" not in ctx

    def test_mint_none_sends_stop_nudge(self) -> None:
        """When SA unavailable and explicitly invoked, nudge is sent."""
        ctx = _make_context()
        _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=_CHANNEL,
                context=ctx,
                mint_fn=_mint_none,
                linking_url_fn=_linking_url,
                last_sent=0.0,
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
                is_explicit_invocation=True,
            )
        )
        ctx["client"].chat_postEphemeral.assert_called_once()

    def test_mint_none_cooldown_suppresses_stop_nudge(self) -> None:
        """When SA unavailable AND cooldown active, no nudge and ABORT."""
        ctx = _make_context()
        now = time.time()
        result = _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=_CHANNEL,
                context=ctx,
                mint_fn=_mint_none,
                linking_url_fn=_linking_url,
                last_sent=now - 10,  # recent send, within cooldown
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
            )
        )
        assert result is False
        ctx["client"].chat_postEphemeral.assert_not_called()


# ---------------------------------------------------------------------------
# Passive channel posts (is_explicit_invocation=False)
# ---------------------------------------------------------------------------


class TestPassiveChannelPosts:
    """Nudges must be suppressed when the user did not address the bot."""

    def test_passive_mint_success_no_nudge_but_proceeds(self) -> None:
        """Passive message + token acquired → proceed silently, no nudge."""
        ctx = _make_context()
        result = _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=_CHANNEL,
                context=ctx,
                mint_fn=_mint_ok,
                linking_url_fn=_linking_url,
                last_sent=0.0,
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
                is_explicit_invocation=False,
            )
        )
        assert result is True
        assert ctx["obo_token"] == _UNLINKED_TOKEN
        assert ctx["unlinked_fallback"] is True
        ctx["client"].chat_postEphemeral.assert_not_called()
        ctx["client"].chat_postMessage.assert_not_called()

    def test_passive_mint_none_no_nudge_aborts(self) -> None:
        """Passive message + SA unavailable → ABORT silently, no nudge."""
        ctx = _make_context()
        result = _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=_CHANNEL,
                context=ctx,
                mint_fn=_mint_none,
                linking_url_fn=_linking_url,
                last_sent=0.0,
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
                is_explicit_invocation=False,
            )
        )
        assert result is False
        ctx["client"].chat_postEphemeral.assert_not_called()
        ctx["client"].chat_postMessage.assert_not_called()

    def test_explicit_mention_sends_nudge(self) -> None:
        """Explicit @mention → nudge IS sent (default / explicit True)."""
        ctx = _make_context()
        _run(
            apply_unlinked_fallback(
                rbac_status="unlinked",
                slack_user_id=_SLACK_USER,
                channel=_CHANNEL,
                context=ctx,
                mint_fn=_mint_ok,
                linking_url_fn=_linking_url,
                last_sent=0.0,
                linking_prompt_cooldown=3600.0,
                is_dm_channel_fn=_is_dm,
                is_explicit_invocation=True,
            )
        )
        ctx["client"].chat_postEphemeral.assert_called_once()
