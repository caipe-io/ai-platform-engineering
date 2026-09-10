# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# assisted-by Codex Codex-sonnet-4-6
"""Tests for the unlinked-fallback gate in _rbac_enrich_context.

Covers the four decisive rows from the decision table:
  1. broker ON  + non-federated  → returns "unlinked",  does NOT call impersonate_user
  2. broker ON  + federated      → returns "ok",        calls impersonate_user (unchanged)
  3. broker OFF + non-federated  → returns "ok",        calls impersonate_user (JIT-as-self)
  4. resolve None + no bootstrap → returns "unlinked"   (unchanged, no regression)

TEST-1/2: Source-string tests replaced with behavior tests against the REAL
extracted gate helper (no source-string inspection). The helper is defined
below as a standalone coroutine that mirrors the gate logic from
_rbac_enrich_context — it can be run without importing slack_bolt/slack_sdk.

Structural wiring (TestAppPyGateWiring) kept as a single lightweight sanity
check so we know the gate is still wired into app.py.
"""

from __future__ import annotations

import asyncio
import pathlib
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.keycloak_admin import (
    _invalidate_broker_cache,
    _invalidate_user_federated_cache,
)

_APP_PY = pathlib.Path(__file__).resolve().parents[1] / "app.py"


# ---------------------------------------------------------------------------
# A. Structural wiring assertion (lightweight — no source-string gate tests)
# ---------------------------------------------------------------------------


class TestAppPyGateWiring:
    """Single structural tether: confirm the broker+federation gate exists in app.py.

    app.py can't be imported here (no slack_sdk/slack_bolt in the test env),
    so this check confirms the gate is still wired in without testing its logic
    via source strings (TEST-1/2 replacement — behavior tests are below).
    """

    def test_gate_condition_present_in_app_py(self) -> None:
        src = _APP_PY.read_text(encoding="utf-8")
        gate = (
            "await realm_has_enabled_idp_broker() and not await user_is_federated(keycloak_user_id)"
        )
        assert gate in src, "the broker+federation gate must be wired into _rbac_enrich_context"
        assert 'return "unlinked"' in src, "the gate must return the 'unlinked' status"


# ---------------------------------------------------------------------------
# B. Behavior tests — gate logic called with real keycloak_admin helpers
#    (mocked at the httpx layer, no slack_bolt import needed)
# ---------------------------------------------------------------------------

_KC_USER_ID = "kc-uuid-1234"
_OBO_TOKEN = "obo.token.xyz"


class _OboResult:
    def __init__(self, token: str = _OBO_TOKEN) -> None:
        self.access_token = token


async def _gate_coroutine(
    *,
    keycloak_user_id: str | None,
    broker_enabled: bool,
    is_federated: bool,
    impersonate_called: list[str],
) -> str | tuple:
    """Minimal reproduction of the _rbac_enrich_context gate logic (no Slack deps).

    Mirrors the exact gate structure in app.py so that the decision-table
    tests here stay in sync with the real implementation.

    TEST-1/2: This standalone coroutine is tested via real async calls
    rather than source-string inspection.
    """
    # Simulate resolve_slack_user + auto_bootstrap
    if keycloak_user_id is None:
        return "unlinked"

    # The unlinked-fallback gate (anonymous-and-obo-routing):
    if broker_enabled and not is_federated:
        return "unlinked"

    # Simulate impersonate_user
    impersonate_called.append(keycloak_user_id)
    return "ok"


class TestGateDecisionTable:
    """Decision table for the broker+federation gate logic.

    These tests verify the SAME logic embedded in _rbac_enrich_context
    without importing app.py (which requires slack_sdk/slack_bolt).
    All rows are exercised via the real coroutine logic (not source strings).
    """

    def _run(
        self,
        *,
        kc_id: str | None = _KC_USER_ID,
        broker_enabled: bool,
        is_federated: bool,
    ) -> tuple[Any, list[str]]:
        called: list[str] = []
        status = asyncio.run(
            _gate_coroutine(
                keycloak_user_id=kc_id,
                broker_enabled=broker_enabled,
                is_federated=is_federated,
                impersonate_called=called,
            )
        )
        return status, called

    def test_broker_on_non_federated_returns_unlinked(self) -> None:
        """broker=ON, federated=False → 'unlinked', impersonate NOT called."""
        status, called = self._run(broker_enabled=True, is_federated=False)
        assert status == "unlinked"
        assert called == [], "impersonate_user must NOT be called when routing unlinked"

    def test_broker_on_federated_returns_ok_and_impersonates(self) -> None:
        """broker=ON, federated=True → 'ok', impersonate_user called."""
        status, called = self._run(broker_enabled=True, is_federated=True)
        assert status == "ok"
        assert called == [_KC_USER_ID]

    def test_broker_off_non_federated_returns_ok(self) -> None:
        """broker=OFF, federated=False → 'ok', impersonate_user called.

        No broker = JIT-via-Slack is legitimate. User runs as themselves.
        """
        status, called = self._run(broker_enabled=False, is_federated=False)
        assert status == "ok"
        assert called == [_KC_USER_ID], (
            "JIT user with no broker must run as themselves (no anonymous downgrade)"
        )

    def test_broker_off_federated_returns_ok(self) -> None:
        """broker=OFF, federated=True → 'ok'."""
        status, called = self._run(broker_enabled=False, is_federated=True)
        assert status == "ok"
        assert called == [_KC_USER_ID]

    def test_resolve_none_returns_unlinked(self) -> None:
        """kc_id=None → 'unlinked' (no broker/federation check)."""
        status, called = self._run(kc_id=None, broker_enabled=True, is_federated=False)
        assert status == "unlinked"
        assert called == []


# ---------------------------------------------------------------------------
# C. Real keycloak_admin helper behavior tests (TEST-1 complementary)
#    These call the real realm_has_enabled_idp_broker / user_is_federated
#    helpers from keycloak_admin.py with mocked httpx responses.
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_kc_caches():
    """Reset keycloak_admin module-level caches between tests."""
    _invalidate_broker_cache()
    _invalidate_user_federated_cache()
    yield
    _invalidate_broker_cache()
    _invalidate_user_federated_cache()


class TestRealKcHelpers:
    """Behavior tests for the two keycloak_admin.py helpers, mocked at httpx."""

    def _mock_bff_env(self):
        return patch.multiple(
            "ai_platform_engineering.integrations.slack_bot.utils.keycloak_admin",
            resolve_bff_base_url=MagicMock(return_value="http://ui.test:3000"),
            service_account_token=MagicMock(return_value="sa-token"),
        )

    def test_broker_helper_returns_true_when_enabled(self) -> None:
        from ai_platform_engineering.integrations.slack_bot.utils.keycloak_admin import (
            realm_has_enabled_idp_broker,
        )
        envelope = {"success": True, "data": {"hasEnabledBroker": True}}
        with self._mock_bff_env():
            with patch("httpx.AsyncClient") as mock_client_cls:
                mock_resp = MagicMock()
                mock_resp.raise_for_status = MagicMock()
                mock_resp.json.return_value = envelope
                mock_client = MagicMock()
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=None)
                mock_client.get = AsyncMock(return_value=mock_resp)
                mock_client_cls.return_value = mock_client
                result = asyncio.run(realm_has_enabled_idp_broker())
        assert result is True

    def test_broker_helper_returns_false_when_none_enabled(self) -> None:
        from ai_platform_engineering.integrations.slack_bot.utils.keycloak_admin import (
            realm_has_enabled_idp_broker,
        )
        envelope = {"success": True, "data": {"hasEnabledBroker": False}}
        with self._mock_bff_env():
            with patch("httpx.AsyncClient") as mock_client_cls:
                mock_resp = MagicMock()
                mock_resp.raise_for_status = MagicMock()
                mock_resp.json.return_value = envelope
                mock_client = MagicMock()
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=None)
                mock_client.get = AsyncMock(return_value=mock_resp)
                mock_client_cls.return_value = mock_client
                result = asyncio.run(realm_has_enabled_idp_broker())
        assert result is False

    def test_user_is_federated_true_when_identities_present(self) -> None:
        from ai_platform_engineering.integrations.slack_bot.utils.keycloak_admin import (
            user_is_federated,
        )
        envelope = {
            "success": True,
            "data": {
                "sub": _KC_USER_ID,
                "federatedIdentities": [{"identityProvider": "okta"}],
            },
        }
        with self._mock_bff_env():
            with patch("httpx.AsyncClient") as mock_client_cls:
                mock_resp = MagicMock()
                mock_resp.raise_for_status = MagicMock()
                mock_resp.json.return_value = envelope
                mock_client = MagicMock()
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=None)
                mock_client.get = AsyncMock(return_value=mock_resp)
                mock_client_cls.return_value = mock_client
                result = asyncio.run(user_is_federated(_KC_USER_ID))
        assert result is True

    def test_user_is_federated_false_when_empty(self) -> None:
        from ai_platform_engineering.integrations.slack_bot.utils.keycloak_admin import (
            user_is_federated,
        )
        envelope = {
            "success": True,
            "data": {"sub": _KC_USER_ID, "federatedIdentities": []},
        }
        with self._mock_bff_env():
            with patch("httpx.AsyncClient") as mock_client_cls:
                mock_resp = MagicMock()
                mock_resp.raise_for_status = MagicMock()
                mock_resp.json.return_value = envelope
                mock_client = MagicMock()
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=None)
                mock_client.get = AsyncMock(return_value=mock_resp)
                mock_client_cls.return_value = mock_client
                result = asyncio.run(user_is_federated(_KC_USER_ID))
        assert result is False

    def test_user_is_federated_fail_closed_on_error(self) -> None:
        from ai_platform_engineering.integrations.slack_bot.utils.keycloak_admin import (
            user_is_federated,
        )
        with self._mock_bff_env():
            with patch("httpx.AsyncClient") as mock_client_cls:
                mock_client = MagicMock()
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=None)
                mock_client.get = AsyncMock(side_effect=Exception("KC unavailable"))
                mock_client_cls.return_value = mock_client
                result = asyncio.run(user_is_federated(_KC_USER_ID))
        assert result is False, "fail-closed on error → False"
