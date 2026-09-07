# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for ServiceAccountResolver (PRC-4 BFF-based implementation).

Verifies that the resolver:
- Returns the correct sa_sub from a healthy BFF response.
- Returns None gracefully when the BFF returns null sa_sub.
- Returns None when the BFF is not configured (no base URL).
- Returns None on HTTP errors.
- Returns None when the BFF returns success=false.
- Caches results and does not re-query within the TTL.
- Negative results are cached with the shorter negative TTL.
- Logs a warning (not raises) for unexpected BFF response shapes.

No pymongo dependency in this file (PRC-4 replaced direct Mongo with BFF).
BFF endpoint: GET /api/integrations/unlinked-service-account
"""

from __future__ import annotations

import time
from typing import Optional
from unittest.mock import MagicMock, patch

from requests.exceptions import RequestException

from ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver import (
    ServiceAccountResolver,
    get_unlinked_service_account_sub,
    _UNLINKED_SA_TTL,
    _UNLINKED_SA_NEGATIVE_TTL,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_UNLINKED_SUB = "b75d6215-0000-0000-0000-000000000001"
_BFF_URL = "http://caipe.local"


def _bff_ok(sa_sub: Optional[str] = _UNLINKED_SUB) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {"success": True, "data": {"sa_sub": sa_sub}}
    return resp


def _bff_not_found() -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {"success": True, "data": {"sa_sub": None}}
    return resp


def _bff_fail() -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {"success": False, "error": "not found"}
    return resp


def _make_resolver(mock_response: Optional[MagicMock] = None, *, raise_exc: Optional[Exception] = None) -> ServiceAccountResolver:
    """Return a resolver with its _fetch_unlinked_sub patched via requests.get mock."""
    resolver = ServiceAccountResolver()
    # We'll inject via patching at test time; this just gives us the resolver instance.
    return resolver


# ---------------------------------------------------------------------------
# Basic resolution
# ---------------------------------------------------------------------------


class TestGetUnlinkedServiceAccountSub:
    def test_returns_sa_sub_for_active_unlinked_sa(self, monkeypatch) -> None:
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get", return_value=_bff_ok(_UNLINKED_SUB)):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                result = resolver.get_unlinked_service_account_sub()
        assert result == _UNLINKED_SUB

    def test_returns_none_when_sa_sub_is_null(self, monkeypatch) -> None:
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get", return_value=_bff_not_found()):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                result = resolver.get_unlinked_service_account_sub()
        assert result is None

    def test_returns_none_when_success_false(self, monkeypatch) -> None:
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get", return_value=_bff_fail()):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                result = resolver.get_unlinked_service_account_sub()
        assert result is None

    def test_returns_none_when_sa_sub_empty_string(self, monkeypatch) -> None:
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get", return_value=_bff_ok("   ")):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                result = resolver.get_unlinked_service_account_sub()
        assert result is None

    def test_strips_whitespace_from_sa_sub(self, monkeypatch) -> None:
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get", return_value=_bff_ok(f"  {_UNLINKED_SUB}  ")):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                result = resolver.get_unlinked_service_account_sub()
        assert result == _UNLINKED_SUB


# ---------------------------------------------------------------------------
# BFF unavailable / error paths
# ---------------------------------------------------------------------------


class TestBffUnavailable:
    def test_returns_none_when_no_bff_url(self, monkeypatch) -> None:
        monkeypatch.delenv("CAIPE_API_URL", raising=False)
        monkeypatch.delenv("CAIPE_UI_URL", raising=False)
        resolver = ServiceAccountResolver()
        result = resolver.get_unlinked_service_account_sub()
        assert result is None

    def test_returns_none_on_request_exception(self, monkeypatch) -> None:
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        with patch(
            "ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get",
            side_effect=RequestException("connection refused"),
        ):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                result = resolver.get_unlinked_service_account_sub()
        assert result is None

    def test_returns_none_on_invalid_json(self, monkeypatch) -> None:
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.side_effect = ValueError("bad json")
        with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get", return_value=resp):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                result = resolver.get_unlinked_service_account_sub()
        assert result is None


# ---------------------------------------------------------------------------
# TTL cache
# ---------------------------------------------------------------------------


class TestCaching:
    def test_result_cached_within_ttl(self, monkeypatch) -> None:
        """Second call must NOT re-query BFF if within TTL."""
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        mock_get = MagicMock(return_value=_bff_ok())
        with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get", mock_get):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                resolver.get_unlinked_service_account_sub()
                resolver.get_unlinked_service_account_sub()
        assert mock_get.call_count == 1

    def test_cache_invalidated_after_ttl(self, monkeypatch) -> None:
        """After the TTL expires, the resolver must re-query BFF."""
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        # Seed cache with an expired positive result
        resolver._unlinked_cache = (_UNLINKED_SUB, time.monotonic() - 10_000)
        mock_get = MagicMock(return_value=_bff_ok())
        with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get", mock_get):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                resolver.get_unlinked_service_account_sub()
        assert mock_get.call_count == 1

    def test_invalidate_unlinked_cache_forces_reload(self, monkeypatch) -> None:
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        mock_get = MagicMock(return_value=_bff_ok())
        with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get", mock_get):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                resolver.get_unlinked_service_account_sub()
                resolver.invalidate_unlinked_cache()
                resolver.get_unlinked_service_account_sub()
        assert mock_get.call_count == 2

    def test_none_result_also_cached(self, monkeypatch) -> None:
        """A None result (SA not found) must be cached too (within negative TTL)."""
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        mock_get = MagicMock(return_value=_bff_not_found())
        with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get", mock_get):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                resolver.get_unlinked_service_account_sub()
                resolver.get_unlinked_service_account_sub()
        assert mock_get.call_count == 1

    def test_none_result_re_queried_after_negative_ttl(self, monkeypatch) -> None:
        """None (SA not bootstrapped) must expire after the SHORTER negative TTL."""
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        resolver._unlinked_cache = (None, time.monotonic() - (_UNLINKED_SA_NEGATIVE_TTL + 1))
        mock_get = MagicMock(return_value=_bff_ok())
        with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get", mock_get):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                result = resolver.get_unlinked_service_account_sub()
        assert result == _UNLINKED_SUB
        assert mock_get.call_count == 1

    def test_negative_ttl_shorter_than_positive_ttl(self) -> None:
        """PY-S4: the negative TTL must be < positive TTL (default: 30 < 300)."""
        assert _UNLINKED_SA_NEGATIVE_TTL < _UNLINKED_SA_TTL

    def test_positive_result_not_re_queried_within_positive_ttl(self, monkeypatch) -> None:
        """Positive results use the full TTL, not the shorter negative one."""
        monkeypatch.setenv("CAIPE_API_URL", _BFF_URL)
        resolver = ServiceAccountResolver()
        # Seed a fresh positive cache entry.
        resolver._unlinked_cache = (_UNLINKED_SUB, time.monotonic())
        mock_get = MagicMock(return_value=_bff_ok())
        with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver._requests.get", mock_get):
            with patch("ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver.service_account_token", return_value=None):
                result = resolver.get_unlinked_service_account_sub()
        assert result == _UNLINKED_SUB
        # Must NOT re-query — the positive TTL cache is still fresh.
        assert mock_get.call_count == 0


# ---------------------------------------------------------------------------
# Module-level convenience wrapper
# ---------------------------------------------------------------------------


def test_get_unlinked_service_account_sub_wrapper(monkeypatch) -> None:
    """The module-level wrapper delegates to the default resolver."""
    mock_resolver = MagicMock()
    mock_resolver.get_unlinked_service_account_sub.return_value = _UNLINKED_SUB

    with patch(
        "ai_platform_engineering.integrations.slack_bot.utils.service_account_resolver"
        ".get_service_account_resolver",
        return_value=mock_resolver,
    ):
        result = get_unlinked_service_account_sub()

    assert result == _UNLINKED_SUB
    mock_resolver.get_unlinked_service_account_sub.assert_called_once()
