# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for the unlinked-fallback gate in _rbac_enrich_context.

Covers the four decisive rows from the decision table:
  1. broker ON  + non-federated  → returns "unlinked",  does NOT call impersonate_user
  2. broker ON  + federated      → returns "ok",        calls impersonate_user (unchanged)
  3. broker OFF + non-federated  → returns "ok",        calls impersonate_user (JIT-as-self)
  4. resolve None + no bootstrap → returns "unlinked"   (unchanged, no regression)

The decision table exercises the extracted authorization module directly.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.keycloak_admin import (
    _invalidate_broker_cache,
    _invalidate_user_federated_cache,
)
from .handler_test_utils import load_handler_module


# ---------------------------------------------------------------------------
# A. Extracted authorization behavior
# ---------------------------------------------------------------------------

_KC_USER_ID = "kc-uuid-1234"
_OBO_TOKEN = "obo.token.xyz"


class _OboResult:
    def __init__(self, token: str = _OBO_TOKEN) -> None:
        self.access_token = token


class TestGateDecisionTable:
    """Decision table for the broker and federation gate."""

    def _run(
        self,
        *,
        kc_id: str | None = _KC_USER_ID,
        broker_enabled: bool,
        is_federated: bool,
    ) -> tuple[object, list[str]]:
        authorization = load_handler_module("authorization", rbac_enabled=True)
        impersonate = AsyncMock(return_value=_OboResult())
        with (
            patch.object(
                authorization,
                "resolve_slack_user",
                AsyncMock(return_value=kc_id),
            ),
            patch.object(
                authorization,
                "auto_bootstrap_slack_user",
                AsyncMock(return_value=None),
            ),
            patch.object(
                authorization,
                "realm_has_enabled_idp_broker",
                AsyncMock(return_value=broker_enabled),
            ),
            patch.object(
                authorization,
                "user_is_federated",
                AsyncMock(return_value=is_federated),
            ),
            patch.object(authorization, "impersonate_user", impersonate),
        ):
            status = asyncio.run(
                authorization._rbac_enrich_context(
                    {"event": {"channel": "D123", "team": "T123"}},
                    "U123",
                    {},
                )
            )
        called = [call.args[0] for call in impersonate.await_args_list]
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
# B. Keycloak helper behavior with mocked HTTP
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
