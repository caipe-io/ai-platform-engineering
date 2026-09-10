# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""OBO contract for the Slack bot — team-agnostic (Phase 3).

Spec 2026-05-24-derive-team-from-channel completes the demolition of the
per-team OBO model. After Phase 3 the bot's OBO exchange is team-agnostic:

1. ``impersonate_user`` takes only the Keycloak ``sub`` — no team
   parameter. The bot does not select a Keycloak client scope per team.
2. The OBO request body has ``scope=openid`` and does NOT include any
   ``team-<slug>`` / ``team-personal`` scope.
3. The returned ``OboToken`` carries no team field — the only signal is
   the opaque JWT, which downstream PDPs verify themselves.
4. ``downstream_auth_headers`` keeps emitting just ``Authorization`` —
   the legacy ``X-Team-Id`` header was removed earlier.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
from typing import Any
from unittest.mock import patch

import pytest

from ai_platform_engineering.integrations.slack_bot.utils import obo_exchange
from ai_platform_engineering.integrations.slack_bot.utils.obo_exchange import (
    OboExchangeConfig,
    downstream_auth_headers,
    exchange_token,
    impersonate_user,
)


def _make_jwt(claims: dict[str, Any]) -> str:
    """Build an unsigned JWT-shaped string with the given payload claims."""
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    payload = (
        base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    )
    return f"{header}.{payload}.sig"


def _config() -> OboExchangeConfig:
    return OboExchangeConfig(
        server_url="http://kc.example",
        realm="caipe",
        bot_client_id="caipe-slack-bot",
        bot_client_secret="shh",
        caipe_platform_audience="caipe-platform",
    )


class FakeResponse:
    """Drop-in for httpx.Response used by `_do_exchange`."""

    def __init__(self, status_code: int, payload: dict[str, Any]):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self) -> dict[str, Any]:
        return self._payload


def test_default_audience_targets_caipe_ui_bff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KEYCLOAK_BOT_AUDIENCE", raising=False)
    monkeypatch.delenv("CAIPE_PLATFORM_AUDIENCE", raising=False)

    assert OboExchangeConfig().caipe_platform_audience == "caipe-platform"


def test_caipe_platform_audience_env_overrides_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("KEYCLOAK_BOT_AUDIENCE", raising=False)
    monkeypatch.setenv("CAIPE_PLATFORM_AUDIENCE", "custom-platform")

    assert OboExchangeConfig().caipe_platform_audience == "custom-platform"


class TestTeamAgnosticSignatures:
    """The public OBO functions must not accept a team parameter."""

    _ALLOWED_IMPERSONATE = {"keycloak_user_id", "config"}
    _ALLOWED_EXCHANGE = {"subject_token", "config"}

    def test_impersonate_user_signature(self) -> None:
        sig = inspect.signature(impersonate_user)
        unexpected = set(sig.parameters) - self._ALLOWED_IMPERSONATE
        assert not unexpected, (
            f"impersonate_user must stay team-agnostic; unexpected: {unexpected}"
        )

    def test_exchange_token_signature(self) -> None:
        sig = inspect.signature(exchange_token)
        unexpected = set(sig.parameters) - self._ALLOWED_EXCHANGE
        assert not unexpected, (
            f"exchange_token must stay team-agnostic; unexpected: {unexpected}"
        )


class TestRequestBodyHasNoTeamScope:
    """The OBO POST body MUST NOT include any team-<slug> / team-personal scope."""

    def _run_impersonate(self, captured: dict[str, Any]) -> None:
        minted = _make_jwt({"sub": "u1"})
        fake_resp = FakeResponse(
            200,
            {"access_token": minted, "token_type": "Bearer", "expires_in": 60},
        )

        class FakeClient:
            async def __aenter__(self) -> "FakeClient":
                return self

            async def __aexit__(self, *exc: object) -> None:
                return None

            async def post(
                self, url: str, *, data: dict[str, str], **_: object
            ) -> FakeResponse:
                captured["url"] = url
                captured["data"] = data
                return fake_resp

        with patch.object(obo_exchange.httpx, "AsyncClient", lambda *a, **kw: FakeClient()):
            asyncio.run(impersonate_user("u1", _config()))

    def test_impersonate_user_does_not_request_team_scope(self) -> None:
        captured: dict[str, Any] = {}
        self._run_impersonate(captured)

        data = captured["data"]
        scope_tokens = data.get("scope", "").split() if data.get("scope") else []
        assert all(not t.startswith("team-") for t in scope_tokens), (
            f"OBO request body must not include a team-<slug> scope; "
            f"got scope={data.get('scope')!r}"
        )
        # Audience pin remains — that's the platform-token contract.
        assert data.get("audience") == "caipe-platform"

    def test_exchange_token_does_not_request_team_scope(self) -> None:
        captured: dict[str, Any] = {}
        minted = _make_jwt({"sub": "u1"})
        fake_resp = FakeResponse(
            200,
            {"access_token": minted, "token_type": "Bearer", "expires_in": 60},
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
            asyncio.run(exchange_token("user-token", _config()))

        data = captured["data"]
        scope_tokens = data.get("scope", "").split() if data.get("scope") else []
        assert all(not t.startswith("team-") for t in scope_tokens)


class TestStaleClaimToleration:
    """A leftover team claim from a stale Keycloak mapper MUST NOT block exchange.

    The OBO request itself never asks for a team scope, so the returned
    JWT shouldn't carry one — but if some lingering Keycloak mapper still
    emits a value, the bot has to ignore it gracefully. Downstream PDPs
    are the only authorities on team scope (Phase 3 demolition).
    """

    def test_response_with_stale_legacy_team_claim_is_accepted(self) -> None:
        # Use a generic legacy-looking key name — Phase 3 forbids the
        # demolished claim name anywhere in production or test source.
        minted = _make_jwt({"sub": "u1", "legacy_team_claim": "leftover-from-old-mapper"})
        fake_resp = FakeResponse(
            200,
            {"access_token": minted, "token_type": "Bearer", "expires_in": 60},
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
        # OboToken intentionally has no team field — Phase 3 deleted it.
        assert not hasattr(token, "team_slug")


def test_downstream_auth_headers_drops_x_team_id() -> None:
    """The legacy X-Team-Id header is gone."""
    headers = downstream_auth_headers("any-token")
    assert headers == {"Authorization": "Bearer any-token"}
    assert "X-Team-Id" not in headers
    assert "x-team-id" not in {k.lower() for k in headers}
