# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Regression tests for `get_channel_context` graceful handling of
`missing_scope` from Slack's `conversations.info` endpoint.

Why these tests exist:
    Operators kept seeing repeated "Could not fetch channel info" warnings
    in production when the Slack app manifest was missing `channels:read`
    (and friends). The bot still worked — channel topic/purpose context just
    came back empty — but the warning fired on *every* message, which
    drowned out real errors. The fix is a one-shot warning + result caching
    so we don't keep hammering Slack with calls that will always fail.
"""

from unittest.mock import MagicMock

import pytest
from loguru import logger as loguru_logger

from ai_platform_engineering.integrations.slack_bot.utils import utils
from ai_platform_engineering.integrations.slack_bot.utils.session_manager import SessionManager


class _FakeSlackApiError(Exception):
    """Mirrors the shape of slack_sdk.errors.SlackApiError without the dep."""

    def __init__(self, error_code: str):
        super().__init__(error_code)
        self.response = MagicMock()
        self.response.data = {"error": error_code}


@pytest.fixture(autouse=True)
def _reset_one_shot_flag():
    """Each test gets a clean module-level flag so order doesn't matter."""
    utils._MISSING_CHANNEL_SCOPE_LOGGED = False
    yield
    utils._MISSING_CHANNEL_SCOPE_LOGGED = False


@pytest.fixture
def loguru_sink():
    """Capture loguru WARNING records into a list. Loguru bypasses stdlib
    logging by default, so pytest's `caplog` doesn't see anything from
    `from loguru import logger`."""
    captured: list[str] = []
    sink_id = loguru_logger.add(
        lambda msg: captured.append(msg.record["message"]),
        level="WARNING",
        format="{message}",
    )
    yield captured
    loguru_logger.remove(sink_id)


def test_missing_scope_logs_once_then_silently_caches(loguru_sink):
    """First missing_scope hit warns with operator guidance; subsequent
    hits stay silent and serve from the in-memory cache."""
    session_mgr = SessionManager()
    client = MagicMock()
    client.conversations_info.side_effect = _FakeSlackApiError("missing_scope")

    first = utils.get_channel_context(client, "C123", session_mgr)
    assert first == {"topic": "", "purpose": ""}
    assert client.conversations_info.call_count == 1

    # The warning should mention the remediation (which scopes to add) so
    # operators can fix it without grepping the codebase.
    assert len(loguru_sink) == 1
    assert "channels:read" in loguru_sink[0]
    assert "groups:read" in loguru_sink[0]

    # Same channel: served from cache, no re-call, no new warning.
    loguru_sink.clear()
    second = utils.get_channel_context(client, "C123", session_mgr)
    assert second == first
    assert client.conversations_info.call_count == 1
    assert loguru_sink == []

    # Different channel still caches but does NOT re-warn (one-shot guard).
    third = utils.get_channel_context(client, "C999", session_mgr)
    assert third == {"topic": "", "purpose": ""}
    assert client.conversations_info.call_count == 2
    assert loguru_sink == []


def test_other_errors_still_log_per_call(loguru_sink):
    """Non-missing_scope errors are transient (rate limit, timeout, etc.)
    and SHOULD keep logging — they may resolve on the next call so silencing
    them would hide real outages."""
    session_mgr = SessionManager()
    client = MagicMock()
    client.conversations_info.side_effect = _FakeSlackApiError("ratelimited")

    utils.get_channel_context(client, "C111", session_mgr)
    utils.get_channel_context(client, "C222", session_mgr)

    assert client.conversations_info.call_count == 2
    assert len(loguru_sink) == 2
    assert all("Could not fetch channel info" in m for m in loguru_sink)


def test_happy_path_returns_topic_and_purpose():
    session_mgr = SessionManager()
    client = MagicMock()
    client.conversations_info.return_value = {
        "channel": {
            "topic": {"value": "Platform Eng standup"},
            "purpose": {"value": "Daily sync"},
        }
    }

    info = utils.get_channel_context(client, "C123", session_mgr)
    assert info == {"topic": "Platform Eng standup", "purpose": "Daily sync"}

    # Cache hit on second call — no extra Slack call.
    utils.get_channel_context(client, "C123", session_mgr)
    assert client.conversations_info.call_count == 1
