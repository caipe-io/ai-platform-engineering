# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for Webex space ReBAC enforcement."""

from __future__ import annotations

import urllib.error
from unittest.mock import patch

from ai_platform_engineering.integrations.webex_bot.utils.webex_rebac import (
    WebexRebacEvaluator,
    WebexSpaceRebacDecision,
)


def test_space_grant_check_posts_resource_without_user_subject() -> None:
    calls: list[tuple[str, dict[str, object], str]] = []

    def fake_post(path: str, payload: dict[str, object], token: str) -> WebexSpaceRebacDecision:
        calls.append((path, payload, token))
        return WebexSpaceRebacDecision(
            allowed=True,
            space_allowed=True,
            reason="allowed",
        )

    evaluator = WebexRebacEvaluator(base_url="http://caipe-ui", post_check=fake_post)
    decision = evaluator.check_space_grant(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="space-abc",
        agent_id="incident-agent",
        obo_token="obo-token",
    )

    assert decision.allowed is True
    assert calls == [
        (
            "/api/integrations/webex/spaces/CAIPE-WEBEX/space-abc/access-check",
            {
                "bot_id": "primary",
                "resource": {"type": "agent", "id": "incident-agent"},
                "action": "use",
            },
            "obo-token",
        )
    ]


def test_space_grant_check_denies_when_space_grant_missing() -> None:
    def fake_post(_path: str, _payload: dict[str, object], _token: str) -> WebexSpaceRebacDecision:
        return WebexSpaceRebacDecision(
            allowed=False,
            space_allowed=False,
            reason="missing_space_grant",
        )

    evaluator = WebexRebacEvaluator(base_url="http://caipe-ui", post_check=fake_post)
    decision = evaluator.check_space_grant(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="space-abc",
        agent_id="incident-agent",
        obo_token="obo-token",
    )

    assert decision.allowed is False
    assert decision.reason == "missing_space_grant"


def test_space_grant_check_fail_closed_on_http_failure() -> None:
    evaluator = WebexRebacEvaluator(base_url="http://caipe-ui")

    with patch(
        "ai_platform_engineering.integrations.webex_bot.utils.webex_rebac.urllib.request.urlopen",
        side_effect=urllib.error.URLError("connection refused"),
    ):
        decision = evaluator.check_space_grant(
            bot_id="primary",
            workspace_id="CAIPE-WEBEX",
            space_id="space-abc",
            agent_id="incident-agent",
            obo_token="obo-token",
        )

    assert decision.allowed is False
    assert decision.space_allowed is False
    assert decision.reason == "pdp_unavailable"


def test_space_grant_check_fail_closed_when_bff_url_unconfigured() -> None:
    evaluator = WebexRebacEvaluator(base_url="")
    decision = evaluator.check_space_grant(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="space-abc",
        agent_id="incident-agent",
        obo_token="obo-token",
    )
    assert decision.allowed is False
    assert decision.reason == "pdp_unavailable"


def test_space_grant_check_fail_closed_when_obo_token_missing() -> None:
    evaluator = WebexRebacEvaluator(base_url="http://caipe-ui")
    decision = evaluator.check_space_grant(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="space-abc",
        agent_id="incident-agent",
        obo_token=None,
    )
    assert decision.allowed is False
    assert decision.reason == "pdp_unavailable"
