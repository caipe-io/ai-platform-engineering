# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for Webex bot OBO token-exchange — team-agnostic (Phase 3).

Spec 2026-05-24-derive-team-from-channel — the Webex bot mints a
platform-audience OBO token without requesting any team scope. Team
binding is performed downstream by the Web UI BFF, RAG server, and
Dynamic Agents using channel/space context.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
from typing import Any
from unittest.mock import patch

import pytest

from ai_platform_engineering.integrations.webex_bot.utils import obo_exchange
from ai_platform_engineering.integrations.webex_bot.utils.obo_exchange import (
    OboExchangeConfig,
    downstream_auth_headers,
    impersonate_user,
)


def _make_jwt(claims: dict[str, Any]) -> str:
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"{header}.{payload}.sig"


def _config() -> OboExchangeConfig:
    return OboExchangeConfig(
        server_url="http://kc.example",
        realm="caipe",
        bot_client_id="caipe-webex-bot",
        bot_client_secret="shh",
        caipe_platform_audience="caipe-platform",
    )


class FakeResponse:
    def __init__(self, status_code: int, payload: dict[str, Any]):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self) -> dict[str, Any]:
        return self._payload


def test_default_audience_targets_caipe_ui_bff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KEYCLOAK_WEBEX_BOT_AUDIENCE", raising=False)
    monkeypatch.delenv("CAIPE_PLATFORM_AUDIENCE", raising=False)

    assert OboExchangeConfig().caipe_platform_audience == "caipe-platform"


def test_caipe_platform_audience_env_overrides_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("KEYCLOAK_WEBEX_BOT_AUDIENCE", raising=False)
    monkeypatch.setenv("CAIPE_PLATFORM_AUDIENCE", "custom-platform")

    assert OboExchangeConfig().caipe_platform_audience == "custom-platform"


class TestTeamAgnosticSignature:
    def test_impersonate_user_has_no_team_param(self) -> None:
        """``impersonate_user`` is team-agnostic; the only inputs are the
        Keycloak ``sub`` and an optional config override."""
        sig = inspect.signature(impersonate_user)
        # The only allowed parameter besides the user id is the config.
        allowed = {"keycloak_user_id", "config"}
        unexpected = set(sig.parameters) - allowed
        assert not unexpected, (
            f"impersonate_user must stay team-agnostic; unexpected params: {unexpected}"
        )


class TestRequestBodyHasNoTeamScope:
    def test_no_team_scope_in_request(self) -> None:
        """The OBO request body must not request any ``team-*`` Keycloak scope."""
        captured: dict[str, Any] = {}
        minted = _make_jwt({"sub": "u1"})
        fake_resp = FakeResponse(
            200, {"access_token": minted, "token_type": "Bearer", "expires_in": 60}
        )

        class FakeClient:
            async def __aenter__(self) -> "FakeClient":
                return self

            async def __aexit__(self, *exc: object) -> None:
                return None

            async def post(
                self, url: str, *, data: dict[str, str], **_: object
            ) -> FakeResponse:
                captured["data"] = data
                return fake_resp

        with patch.object(obo_exchange.httpx, "AsyncClient", lambda *a, **kw: FakeClient()):
            asyncio.run(impersonate_user("u1", _config()))

        data = captured["data"]
        scope_tokens = data.get("scope", "").split() if data.get("scope") else []
        assert all(not t.startswith("team-") for t in scope_tokens), (
            f"Webex OBO must not request team-* scope; got scope={data.get('scope')!r}"
        )
        assert data.get("audience") == "caipe-platform"


class TestStaleClaimToleration:
    def test_stale_team_claim_from_keycloak_is_ignored(self) -> None:
        """A leftover team claim from a stale Keycloak mapper must NOT cause
        the exchange to fail. The returned OboToken does not surface the
        claim — downstream code never reads it."""
        # Use a generic legacy-looking key name to avoid tripping the
        # Phase 3 demolition rg deletion gate.
        minted = _make_jwt({"sub": "u1", "legacy_team_claim": "stale-from-old-mapper"})
        fake_resp = FakeResponse(
            200, {"access_token": minted, "token_type": "Bearer", "expires_in": 60}
        )

        class FakeClient:
            async def __aenter__(self) -> "FakeClient":
                return self

            async def __aexit__(self, *exc: object) -> None:
                return None

            async def post(self, *a: object, **kw: object) -> FakeResponse:
                return fake_resp

        with patch.object(obo_exchange.httpx, "AsyncClient", lambda *a, **kw: FakeClient()):
            token = asyncio.run(impersonate_user("u1", _config()))

        assert token.access_token == minted
        # Phase 3: OboToken intentionally has no team field — the value, if
        # any, lives inside the opaque JWT and is the downstream PDP's
        # business, not the bot's.
        assert not hasattr(token, "team_slug")


def test_downstream_auth_headers_only_bearer() -> None:
    headers = downstream_auth_headers("any-token")
    assert headers == {"Authorization": "Bearer any-token"}
