# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for ``impersonate_service_account`` in obo_exchange.py.

Verifies the SA token-minting path (C3, anonymous-and-obo-routing) mirrors
``impersonate_user`` exactly: same endpoint, same grant_type, same
client_id/secret/audience — only ``requested_subject`` differs.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import patch

from ai_platform_engineering.integrations.slack_bot.utils import obo_exchange
from ai_platform_engineering.integrations.slack_bot.utils.obo_exchange import (
    OboExchangeConfig,
    OboToken,
    impersonate_service_account,
)

# ---------------------------------------------------------------------------
# Helpers — mirrors test_obo_team_agnostic.py style
# ---------------------------------------------------------------------------

_SA_SUB = "b75d6215-0000-0000-0000-000000000001"
_SA_TOKEN = "sa.access.token"


def _config() -> OboExchangeConfig:
    return OboExchangeConfig(
        server_url="http://kc.example",
        realm="caipe",
        bot_client_id="caipe-slack-bot",
        bot_client_secret="shh",
        caipe_platform_audience="caipe-platform",
    )


class FakeResponse:
    """Drop-in for httpx.Response used by ``_do_exchange``."""

    def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self) -> dict[str, Any]:
        return self._payload


def _fake_ok_response() -> FakeResponse:
    return FakeResponse(
        200,
        {"access_token": _SA_TOKEN, "token_type": "Bearer", "expires_in": 300},
    )


def _run_with_capture(sa_sub: str, cfg: OboExchangeConfig) -> tuple[dict[str, Any], OboToken]:
    """Run ``impersonate_service_account`` and capture the POST body + return value."""
    captured: dict[str, Any] = {}
    fake_resp = _fake_ok_response()

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
        token = asyncio.run(impersonate_service_account(sa_sub, cfg))

    return captured, token


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestImpersonateServiceAccountPostBody:
    """The POST body sent to Keycloak must match the naked-impersonation contract."""

    def test_grant_type_is_token_exchange(self) -> None:
        captured, _ = _run_with_capture(_SA_SUB, _config())
        assert captured["data"]["grant_type"] == (
            "urn:ietf:params:oauth:grant-type:token-exchange"
        )

    def test_requested_subject_is_sa_user_sub(self) -> None:
        captured, _ = _run_with_capture(_SA_SUB, _config())
        assert captured["data"]["requested_subject"] == _SA_SUB

    def test_client_id_is_bot_client(self) -> None:
        captured, _ = _run_with_capture(_SA_SUB, _config())
        assert captured["data"]["client_id"] == "caipe-slack-bot"

    def test_audience_is_caipe_platform(self) -> None:
        captured, _ = _run_with_capture(_SA_SUB, _config())
        assert captured["data"]["audience"] == "caipe-platform"

    def test_client_secret_included_when_present(self) -> None:
        captured, _ = _run_with_capture(_SA_SUB, _config())
        assert captured["data"].get("client_secret") == "shh"

    def test_client_secret_omitted_when_absent(self) -> None:
        cfg = OboExchangeConfig(
            server_url="http://kc.example",
            realm="caipe",
            bot_client_id="caipe-slack-bot",
            bot_client_secret=None,
            caipe_platform_audience="caipe-platform",
        )
        captured, _ = _run_with_capture(_SA_SUB, cfg)
        assert "client_secret" not in captured["data"]

    def test_no_subject_token_in_body(self) -> None:
        """Naked impersonation — no subject_token (that's exchange_token's job)."""
        captured, _ = _run_with_capture(_SA_SUB, _config())
        assert "subject_token" not in captured["data"]

    def test_endpoint_url_uses_config(self) -> None:
        captured, _ = _run_with_capture(_SA_SUB, _config())
        assert captured["url"] == (
            "http://kc.example/realms/caipe/protocol/openid-connect/token"
        )


class TestImpersonateServiceAccountReturn:
    """The function must return a well-formed OboToken."""

    def test_returns_obo_token(self) -> None:
        _, token = _run_with_capture(_SA_SUB, _config())
        assert isinstance(token, OboToken)

    def test_access_token_matches_response(self) -> None:
        _, token = _run_with_capture(_SA_SUB, _config())
        assert token.access_token == _SA_TOKEN

    def test_token_type_is_bearer(self) -> None:
        _, token = _run_with_capture(_SA_SUB, _config())
        assert token.token_type == "Bearer"

    def test_expires_in_from_response(self) -> None:
        _, token = _run_with_capture(_SA_SUB, _config())
        assert token.expires_in == 300

    def test_different_sa_subs_produce_different_requested_subjects(self) -> None:
        """Each SA sub must be forwarded verbatim as requested_subject."""
        sub_a = "aaaaaaaa-0000-0000-0000-000000000001"
        sub_b = "bbbbbbbb-0000-0000-0000-000000000002"

        captured_a, _ = _run_with_capture(sub_a, _config())
        captured_b, _ = _run_with_capture(sub_b, _config())

        assert captured_a["data"]["requested_subject"] == sub_a
        assert captured_b["data"]["requested_subject"] == sub_b


class TestImpersonateServiceAccountParity:
    """``impersonate_service_account`` must be structurally identical to
    ``impersonate_user`` — same endpoint, grant_type, client_id, audience."""

    def test_body_matches_impersonate_user_structure(self) -> None:
        """All keys present in impersonate_user body are present here too
        (minus subject_token which is the key structural difference)."""
        from ai_platform_engineering.integrations.slack_bot.utils.obo_exchange import (
            impersonate_user,
        )

        captured_user: dict[str, Any] = {}
        captured_sa: dict[str, Any] = {}
        fake_resp = _fake_ok_response()

        class CapturingClient:
            def __init__(self, target: dict[str, Any]) -> None:
                self._target = target

            async def __aenter__(self) -> "CapturingClient":
                return self

            async def __aexit__(self, *exc: object) -> None:
                return None

            async def post(
                self, url: str, *, data: dict[str, str], **_: object
            ) -> FakeResponse:
                self._target["url"] = url
                self._target["data"] = data
                return fake_resp

        cfg = _config()

        with patch.object(
            obo_exchange.httpx,
            "AsyncClient",
            lambda *a, **kw: CapturingClient(captured_user),
        ):
            asyncio.run(impersonate_user("user-sub-xyz", cfg))

        with patch.object(
            obo_exchange.httpx,
            "AsyncClient",
            lambda *a, **kw: CapturingClient(captured_sa),
        ):
            asyncio.run(impersonate_service_account(_SA_SUB, cfg))

        # Both must hit the same endpoint.
        assert captured_user["url"] == captured_sa["url"]

        # Keys that must be identical between both.
        for key in ("grant_type", "client_id", "client_secret", "audience"):
            assert captured_user["data"].get(key) == captured_sa["data"].get(key), (
                f"Key '{key}' differs between impersonate_user and impersonate_service_account"
            )

        # The only body-level difference: SA uses requested_subject (no subject_token).
        assert "requested_subject" in captured_sa["data"]
        assert "subject_token" not in captured_sa["data"]
