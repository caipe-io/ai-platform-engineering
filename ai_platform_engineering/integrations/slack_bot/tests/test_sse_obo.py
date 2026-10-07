# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for Spec 104 Story 3 — OBO token plumbing in SSEClient.

Verifies the precedence rules implemented in ``SSEClient._get_headers``:

  1. Explicit ``bearer_token`` kwarg wins over everything.
  2. ``ContextVar`` (set via ``set_obo_token``) wins over the SA fallback.
  3. SA ``auth_client`` is used only when neither of the above is set.
  4. With no token source at all, no Authorization header is added.

These tests also pin the contract that callers DO NOT need to thread
``bearer_token`` through every utils/ai.py helper — binding the token
on the ContextVar at the Slack handler entry point is sufficient.
"""

from unittest.mock import MagicMock

import pytest

from ai_platform_engineering.integrations.slack_bot.sse_client import (
    SSEClient,
    set_obo_token,
)


@pytest.fixture(autouse=True)
def _reset_obo_token():
    """Ensure each test starts with no OBO token bound on the ContextVar.

    Without this, leakage between tests would mask precedence bugs (the
    very thing we're trying to test).
    """
    set_obo_token(None)
    yield
    set_obo_token(None)


def _make_client_with_sa(sa_token: str = "sa-fallback-token") -> SSEClient:
    """Build an SSEClient wired to a fake SA auth_client returning ``sa_token``."""
    auth_client = MagicMock()
    auth_client.get_access_token.return_value = sa_token
    return SSEClient(base_url="http://caipe-ui:3000", auth_client=auth_client)


class TestHeaderPrecedence:
    def test_explicit_bearer_wins_over_obo_and_sa(self):
        client = _make_client_with_sa("sa-token")
        set_obo_token("obo-token")

        headers = client._get_headers(bearer_token="explicit-token")

        assert headers["Authorization"] == "Bearer explicit-token"
        # SA token must NOT be fetched when explicit token is provided —
        # this protects against accidentally minting SA tokens (and
        # blowing through KC throttling) on every call.
        client.auth_client.get_access_token.assert_not_called()

    def test_obo_contextvar_wins_over_sa(self):
        """When no explicit token is passed, the ContextVar wins over SA."""
        client = _make_client_with_sa("sa-token")
        set_obo_token("obo-from-contextvar")

        headers = client._get_headers()

        assert headers["Authorization"] == "Bearer obo-from-contextvar"
        client.auth_client.get_access_token.assert_not_called()

    def test_sa_used_when_no_obo_bound(self):
        """When the ContextVar is empty, fall back to the SA auth client."""
        client = _make_client_with_sa("sa-token")

        headers = client._get_headers()

        assert headers["Authorization"] == "Bearer sa-token"
        client.auth_client.get_access_token.assert_called_once()

    def test_no_auth_header_when_no_sources(self):
        client = SSEClient(base_url="http://caipe-ui:3000", auth_client=None)

        headers = client._get_headers()

        assert "Authorization" not in headers


class TestContextVarLifecycle:
    def test_set_obo_token_isolated_per_test(self):
        """Sanity check: ContextVar is cleared by the autouse fixture so a
        token set in one test does NOT leak into the next."""
        from ai_platform_engineering.integrations.slack_bot.sse_client import (
            get_obo_token,
        )

        assert get_obo_token() is None
        set_obo_token("xyz")
        assert get_obo_token() == "xyz"

    def test_setting_none_clears_token(self):
        """Slack handlers call set_obo_token(None) defensively when the OBO
        exchange failed; verify that wipes any previously-bound token."""
        from ai_platform_engineering.integrations.slack_bot.sse_client import (
            get_obo_token,
        )

        set_obo_token("stale-token")
        set_obo_token(None)

        assert get_obo_token() is None
