# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for slack_context thread context building and message truncation."""

from unittest.mock import MagicMock

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.slack_context import (
    MESSAGE_CHAR_LIMIT,
    _truncate_message,
    build_delta_context,
    build_thread_context,
)

BOT_USER_ID = "UBOT123"


def _mock_app(messages: list) -> MagicMock:
    app = MagicMock()
    app.client.conversations_replies.return_value = {"messages": messages}
    app.client.users_info.return_value = {
        "user": {"profile": {"display_name": "Alice"}, "real_name": "Alice", "name": "alice"}
    }
    return app


# ---------------------------------------------------------------------------
# _truncate_message
# ---------------------------------------------------------------------------


def test_truncate_short_message_unchanged():
    assert _truncate_message("hello", limit=100) == "hello"


def test_truncate_exactly_at_limit_unchanged():
    msg = "x" * 100
    assert _truncate_message(msg, limit=100) == msg


def test_truncate_long_message_cuts_at_limit():
    msg = "x" * 2500
    result = _truncate_message(msg, limit=2000)
    kept, _, note = result.partition("[... truncated")
    assert len(kept.rstrip("\n")) == 2000
    assert "500 characters omitted" in note


def test_truncate_uses_default_limit():
    msg = "x" * (MESSAGE_CHAR_LIMIT + 100)
    result = _truncate_message(msg)
    assert "[... truncated" in result
    assert "100 characters omitted" in result


# ---------------------------------------------------------------------------
# build_thread_context — deduplication
# ---------------------------------------------------------------------------


def test_build_thread_context_no_history_returns_message():
    app = _mock_app([])
    result = build_thread_context(app, "C1", "100.0", "hello", BOT_USER_ID)
    assert result == "hello"


def test_build_thread_context_current_message_not_duplicated(monkeypatch):
    """The triggering message must appear only in 'Current question', not in history."""
    messages = [{"ts": "100.0", "text": "big paste here", "user": "U1"}]
    app = _mock_app(messages)

    result = build_thread_context(
        app, "C1", "100.0", "big paste here", BOT_USER_ID, current_ts="100.0"
    )

    assert result.count("big paste here") == 1
    assert "Current question: big paste here" in result


def test_build_thread_context_without_current_ts_includes_message_twice():
    """Without current_ts the old behaviour is preserved (message appears in history AND question)."""
    messages = [{"ts": "100.0", "text": "hi there", "user": "U1"}]
    app = _mock_app(messages)

    result = build_thread_context(app, "C1", "100.0", "hi there", BOT_USER_ID)

    assert result.count("hi there") == 2


def test_build_thread_context_prior_messages_kept(monkeypatch):
    messages = [
        {"ts": "99.0", "text": "prior message", "user": "U1"},
        {"ts": "100.0", "text": "current question", "user": "U1"},
    ]
    app = _mock_app(messages)

    result = build_thread_context(
        app, "C1", "100.0", "current question", BOT_USER_ID, current_ts="100.0"
    )

    assert "prior message" in result
    assert "Current question: current question" in result


# ---------------------------------------------------------------------------
# build_thread_context — truncation
# ---------------------------------------------------------------------------


def test_build_thread_context_truncates_long_history_message():
    big = "x" * 3000
    messages = [{"ts": "98.0", "text": big, "user": "U1"}]  # history message
    app = _mock_app(messages)

    result = build_thread_context(app, "C1", "98.0", "q", BOT_USER_ID, current_ts="99.0")

    assert "truncated" in result
    assert big not in result


# ---------------------------------------------------------------------------
# build_delta_context — truncation
# ---------------------------------------------------------------------------


def test_build_delta_context_truncates_long_message():
    big = "y" * 3000
    messages = [
        {"ts": "98.0", "text": big, "user": "U1"},
        {"ts": "99.0", "text": "current", "user": "U1"},
    ]
    app = _mock_app(messages)

    result = build_delta_context(
        app, "C1", "97.0", "current", BOT_USER_ID, since_ts="97.0"
    )

    assert "truncated" in result
    assert big not in result


def test_build_delta_context_no_new_messages_returns_current():
    app = _mock_app([])
    result = build_delta_context(app, "C1", "100.0", "hello", BOT_USER_ID, since_ts="99.0")
    assert result == "hello"


# ---------------------------------------------------------------------------
# build_thread_context — single-message thread (regression for filtered=empty)
# ---------------------------------------------------------------------------


def test_build_thread_context_single_message_filtered_returns_current():
    """When the only thread message is the current one (filtered by ts),
    the function must return current_message directly, not an empty scaffold."""
    messages = [{"ts": "100.0", "text": "only message", "user": "U1"}]
    app = _mock_app(messages)

    result = build_thread_context(
        app, "C1", "100.0", "only message", BOT_USER_ID, current_ts="100.0"
    )

    assert result == "only message"
    assert "Previous conversation:" not in result
