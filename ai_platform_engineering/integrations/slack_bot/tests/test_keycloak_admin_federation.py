# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# assisted-by Codex Codex-sonnet-4-6
"""BFF-backed tests for Slack federation-state helpers."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from ai_platform_engineering.integrations.slack_bot.utils import (
    keycloak_admin as ka,
)


class _FakeResponse:
    def __init__(self, status_code: int = 200, json_data: Any = None) -> None:
        self.status_code = status_code
        self._json = json_data if json_data is not None else {}

    def json(self) -> Any:
        return self._json

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=None,  # type: ignore[arg-type]
                response=None,  # type: ignore[arg-type]
            )


class _FakeAsyncClient:
    def __init__(self, script: list[tuple], calls: list[dict]) -> None:
        self._script = script
        self._calls = calls

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def get(self, url: str, **kwargs: Any) -> _FakeResponse:
        self._calls.append({"method": "GET", "url": url, **kwargs})
        for index, (predicate, payload) in enumerate(self._script):
            if predicate("GET", url, **kwargs):
                self._script.pop(index)
                if isinstance(payload, BaseException):
                    raise payload
                return payload
        raise AssertionError(f"No scripted response for GET {url}")


@pytest.fixture
def fake_client(monkeypatch: pytest.MonkeyPatch):
    calls: list[dict] = []

    def _install(script: list[tuple]) -> list[dict]:
        def _factory(*args: Any, **kwargs: Any) -> _FakeAsyncClient:
            return _FakeAsyncClient(script, calls)

        monkeypatch.setattr(ka.httpx, "AsyncClient", _factory)
        return calls

    return _install


@pytest.fixture(autouse=True)
def _bff_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ka, "resolve_bff_base_url", lambda *a, **k: "http://ui.test:3000")
    monkeypatch.setattr(ka, "service_account_token", lambda: "sa-token")
    ka._invalidate_user_federated_cache()
    ka._invalidate_broker_cache()
    ka._broker_last_known_good = None


def _is_resolve(method: str, url: str, **_: Any) -> bool:
    return method == "GET" and url.endswith("/api/admin/users/resolve")


def _is_identity_providers(method: str, url: str, **_: Any) -> bool:
    return method == "GET" and url.endswith("/api/admin/realm/identity-providers")


def _resolve_response(identities: list[dict[str, str]] | None) -> _FakeResponse:
    return _FakeResponse(
        200,
        {
            "success": True,
            "data": {
                "sub": "kc-user-abc",
                "enabled": True,
                "attributes": {},
                "federatedIdentities": identities,
            },
        },
    )


def _broker_response(enabled: bool) -> _FakeResponse:
    return _FakeResponse(
        200,
        {
            "success": True,
            "data": {
                "hasEnabledBroker": enabled,
                "identityProviders": [{"alias": "okta", "enabled": enabled}],
            },
        },
    )


class TestUserIsFederated:
    KC_ID = "kc-user-abc"

    def test_returns_true_when_federated_identities_non_empty(self, fake_client) -> None:
        fake_client([
            (_is_resolve, _resolve_response([{"identityProvider": "okta"}])),
        ])
        result = asyncio.run(ka.user_is_federated(self.KC_ID))
        assert result is True

    def test_returns_false_when_federated_identities_empty(self, fake_client) -> None:
        fake_client([(_is_resolve, _resolve_response([]))])
        result = asyncio.run(ka.user_is_federated(self.KC_ID))
        assert result is False

    def test_fail_closed_on_http_error(self, fake_client) -> None:
        fake_client([(_is_resolve, _FakeResponse(500, {}))])
        result = asyncio.run(ka.user_is_federated(self.KC_ID))
        assert result is False

    def test_caching_second_call_does_not_refetch(self, fake_client) -> None:
        calls = fake_client([
            (_is_resolve, _resolve_response([{"identityProvider": "okta"}])),
        ])

        assert asyncio.run(ka.user_is_federated(self.KC_ID)) is True
        after_first = len(calls)
        assert asyncio.run(ka.user_is_federated(self.KC_ID)) is True
        assert len(calls) == after_first

    def test_invalidate_single_entry_clears_cache(self, fake_client) -> None:
        calls = fake_client([
            (_is_resolve, _resolve_response([])),
            (_is_resolve, _resolve_response([{"identityProvider": "okta"}])),
        ])

        assert asyncio.run(ka.user_is_federated(self.KC_ID)) is False
        ka._invalidate_user_federated_cache(self.KC_ID)
        assert asyncio.run(ka.user_is_federated(self.KC_ID)) is True
        assert len(calls) == 2


class TestRealmHasEnabledIdpBroker:
    def test_returns_true_when_any_instance_enabled(self, fake_client) -> None:
        fake_client([(_is_identity_providers, _broker_response(True))])
        assert asyncio.run(ka.realm_has_enabled_idp_broker()) is True

    def test_returns_false_when_none_enabled(self, fake_client) -> None:
        fake_client([(_is_identity_providers, _broker_response(False))])
        assert asyncio.run(ka.realm_has_enabled_idp_broker()) is False

    def test_uses_last_known_good_on_error(self, fake_client) -> None:
        fake_client([
            (_is_identity_providers, _broker_response(True)),
            (_is_identity_providers, _FakeResponse(503, {})),
        ])

        assert asyncio.run(ka.realm_has_enabled_idp_broker()) is True
        ka._invalidate_broker_cache()
        assert asyncio.run(ka.realm_has_enabled_idp_broker()) is True

    def test_returns_false_on_error_without_last_known_good(self, fake_client) -> None:
        fake_client([(_is_identity_providers, httpx.ConnectError("timeout"))])
        assert asyncio.run(ka.realm_has_enabled_idp_broker()) is False

    def test_caching_second_call_does_not_refetch(self, fake_client) -> None:
        calls = fake_client([(_is_identity_providers, _broker_response(True))])

        assert asyncio.run(ka.realm_has_enabled_idp_broker()) is True
        after_first = len(calls)
        assert asyncio.run(ka.realm_has_enabled_idp_broker()) is True
        assert len(calls) == after_first
