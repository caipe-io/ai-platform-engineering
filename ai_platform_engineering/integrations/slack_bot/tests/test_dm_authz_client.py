# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Phase 2 — DM authorization client (spec 2026-05-24-derive-team-from-channel).

Tests for ``slack_bot/utils/dm_authz_client.py`` which calls the BFF
``/api/user/check_agent_access`` endpoint. This client is invoked on
every DM message to verify the dispatched agent is allowed for the
signed-in user — `user_subject=user:<sub>` only, no team subject (T111).
"""

from __future__ import annotations

import dataclasses
import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.dm_authz_client import (
    DmAgentAccessDecision,
    DmAuthzClient,
)


class _FakeResponse:
    """Drop-in for urllib.urlopen context manager."""

    def __init__(self, status: int, payload: dict[str, Any] | bytes | None):
        self.status = status
        self.code = status
        if isinstance(payload, bytes):
            self._raw = payload
        elif payload is None:
            self._raw = b""
        else:
            self._raw = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def read(self) -> bytes:
        return self._raw


class TestDmAuthzClient:
    def test_returns_allowed_on_pdp_allow(self) -> None:
        client = DmAuthzClient(base_url="http://bff.local")
        with patch.object(
            DmAuthzClient,
            "_open",
            MagicMock(
                return_value=_FakeResponse(
                    200,
                    {
                        "success": True,
                        "data": {
                            "allowed": True,
                            "reason": "ALLOW_DIRECT",
                            "path": "direct_user_grant",
                        },
                    },
                )
            ),
        ):
            decision = client.check_agent_access(
                agent_id="argocd-agent", bearer_token="obo-token"
            )

        assert decision == DmAgentAccessDecision(
            allowed=True,
            reason="ALLOW_DIRECT",
            path="direct_user_grant",
            available=True,
            matched_team_slug=None,
        )

    def test_returns_allowed_via_team_union_with_matched_slug(self) -> None:
        client = DmAuthzClient(base_url="http://bff.local")
        with patch.object(
            DmAuthzClient,
            "_open",
            MagicMock(
                return_value=_FakeResponse(
                    200,
                    {
                        "success": True,
                        "data": {
                            "allowed": True,
                            "reason": "ALLOW_TEAM_UNION",
                            "path": "team_union",
                            "matched_team_slug": "platform-eng",
                        },
                    },
                )
            ),
        ):
            decision = client.check_agent_access(
                agent_id="argocd-agent", bearer_token="obo-token"
            )

        assert decision.allowed is True
        assert decision.matched_team_slug == "platform-eng"
        assert decision.path == "team_union"

    def test_returns_denied_with_reason(self) -> None:
        client = DmAuthzClient(base_url="http://bff.local")
        with patch.object(
            DmAuthzClient,
            "_open",
            MagicMock(
                return_value=_FakeResponse(
                    200,
                    {
                        "success": True,
                        "data": {
                            "allowed": False,
                            "reason": "DENY_NO_CAPABILITY",
                            "path": "denied",
                        },
                    },
                )
            ),
        ):
            decision = client.check_agent_access(
                agent_id="argocd-agent", bearer_token="obo-token"
            )

        assert decision.allowed is False
        assert decision.reason == "DENY_NO_CAPABILITY"
        assert decision.available is True

    def test_no_base_url_returns_unavailable_and_denies(self) -> None:
        client = DmAuthzClient(base_url="")
        decision = client.check_agent_access(
            agent_id="argocd-agent", bearer_token="obo-token"
        )
        # Fail closed: caller treats unavailable as "deny + soft notice".
        assert decision.allowed is False
        assert decision.available is False
        assert decision.reason == "PDP_UNAVAILABLE"

    def test_no_bearer_token_returns_unavailable(self) -> None:
        client = DmAuthzClient(base_url="http://bff.local")
        decision = client.check_agent_access(
            agent_id="argocd-agent", bearer_token=""
        )
        assert decision.available is False
        assert decision.allowed is False

    def test_502_response_returns_unavailable(self) -> None:
        client = DmAuthzClient(base_url="http://bff.local")
        with patch.object(
            DmAuthzClient,
            "_open",
            MagicMock(return_value=_FakeResponse(502, None)),
        ):
            decision = client.check_agent_access(
                agent_id="argocd-agent", bearer_token="obo-token"
            )

        assert decision.available is False
        assert decision.allowed is False
        assert decision.reason == "PDP_UNAVAILABLE"

    def test_network_error_returns_unavailable(self) -> None:
        client = DmAuthzClient(base_url="http://bff.local")
        with patch.object(
            DmAuthzClient,
            "_open",
            MagicMock(side_effect=OSError("connection refused")),
        ):
            decision = client.check_agent_access(
                agent_id="argocd-agent", bearer_token="obo-token"
            )

        assert decision.available is False
        assert decision.allowed is False
        assert decision.reason == "PDP_UNAVAILABLE"

    def test_malformed_json_returns_unavailable(self) -> None:
        client = DmAuthzClient(base_url="http://bff.local")
        with patch.object(
            DmAuthzClient,
            "_open",
            MagicMock(return_value=_FakeResponse(200, b"not-json")),
        ):
            decision = client.check_agent_access(
                agent_id="argocd-agent", bearer_token="obo-token"
            )

        assert decision.available is False
        assert decision.allowed is False

    def test_sends_correct_headers_and_body(self) -> None:
        captured: dict[str, Any] = {}

        def _capture(self_, request, *, timeout):  # noqa: ARG001
            captured["url"] = request.full_url
            captured["headers"] = dict(request.headers)
            captured["method"] = request.get_method()
            captured["body"] = request.data
            return _FakeResponse(
                200,
                {
                    "success": True,
                    "data": {
                        "allowed": True,
                        "reason": "ALLOW_DIRECT",
                        "path": "direct_user_grant",
                    },
                },
            )

        client = DmAuthzClient(base_url="http://bff.local")
        with patch.object(DmAuthzClient, "_open", _capture):
            client.check_agent_access(
                agent_id="argocd-agent", bearer_token="obo-token"
            )

        assert captured["url"] == "http://bff.local/api/user/check_agent_access"
        assert captured["method"] == "POST"
        # urllib lower-cases header keys when stored.
        header_keys_lower = {k.lower(): v for k, v in captured["headers"].items()}
        assert header_keys_lower["authorization"] == "Bearer obo-token"
        assert header_keys_lower["content-type"] == "application/json"
        body = json.loads(captured["body"].decode("utf-8"))
        assert body == {"agent_id": "argocd-agent"}

    def test_dm_agent_access_decision_is_immutable(self) -> None:
        decision = DmAgentAccessDecision(
            allowed=False,
            reason="DENY_NO_CAPABILITY",
            path="denied",
            available=True,
            matched_team_slug=None,
        )
        # `DmAgentAccessDecision` is a frozen dataclass, so any mutation must raise.
        with pytest.raises(dataclasses.FrozenInstanceError):
            decision.allowed = True  # type: ignore[misc]
        assert decision.allowed is False
