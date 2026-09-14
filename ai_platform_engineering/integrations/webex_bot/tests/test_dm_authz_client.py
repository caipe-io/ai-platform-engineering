# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Phase 2 — Webex DM authorization client.

Mirror of the Slack-bot ``test_dm_authz_client.py`` for the Webex twin.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch

from ai_platform_engineering.integrations.webex_bot.utils.dm_authz_client import (
    DmAgentAccessDecision,
    DmAuthzClient,
)


class _FakeResponse:
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


class TestWebexDmAuthzClient:
    def test_allow_direct(self) -> None:
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
                agent_id="incident-agent", bearer_token="obo"
            )
        assert decision == DmAgentAccessDecision(
            allowed=True,
            reason="ALLOW_DIRECT",
            path="direct_user_grant",
            available=True,
        )

    def test_allow_team_union_does_not_add_dm_team_context(self) -> None:
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
                            "matched_team_slug": "ops",
                        },
                    },
                )
            ),
        ):
            decision = client.check_agent_access(
                agent_id="incident-agent", bearer_token="obo"
            )
        assert decision.allowed is True
        assert not hasattr(decision, "matched_team_slug")

    def test_deny(self) -> None:
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
                agent_id="incident-agent", bearer_token="obo"
            )
        assert decision.allowed is False
        assert decision.available is True

    def test_no_base_url_returns_unavailable(self) -> None:
        client = DmAuthzClient(base_url="")
        decision = client.check_agent_access(
            agent_id="incident-agent", bearer_token="obo"
        )
        assert decision.available is False
        assert decision.allowed is False

    def test_5xx_returns_unavailable(self) -> None:
        client = DmAuthzClient(base_url="http://bff.local")
        with patch.object(
            DmAuthzClient,
            "_open",
            MagicMock(return_value=_FakeResponse(503, None)),
        ):
            decision = client.check_agent_access(
                agent_id="incident-agent", bearer_token="obo"
            )
        assert decision.available is False

    def test_network_error_returns_unavailable(self) -> None:
        client = DmAuthzClient(base_url="http://bff.local")
        with patch.object(
            DmAuthzClient,
            "_open",
            MagicMock(side_effect=OSError("connection refused")),
        ):
            decision = client.check_agent_access(
                agent_id="incident-agent", bearer_token="obo"
            )
        assert decision.available is False
        assert decision.allowed is False

    def test_malformed_json_returns_unavailable(self) -> None:
        client = DmAuthzClient(base_url="http://bff.local")
        with patch.object(
            DmAuthzClient,
            "_open",
            MagicMock(return_value=_FakeResponse(200, b"not-json")),
        ):
            decision = client.check_agent_access(
                agent_id="incident-agent", bearer_token="obo"
            )
        assert decision.available is False

    def test_request_shape(self) -> None:
        captured: dict[str, Any] = {}

        def _capture(self_, request, *, timeout):  # noqa: ARG001
            captured["url"] = request.full_url
            captured["headers"] = dict(request.headers)
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
            client.check_agent_access(agent_id="incident-agent", bearer_token="obo")

        assert captured["url"] == "http://bff.local/api/user/check_agent_access"
        header_keys_lower = {k.lower(): v for k, v in captured["headers"].items()}
        assert header_keys_lower["authorization"] == "Bearer obo"
        body = json.loads(captured["body"].decode("utf-8"))
        assert body == {"agent_id": "incident-agent"}
