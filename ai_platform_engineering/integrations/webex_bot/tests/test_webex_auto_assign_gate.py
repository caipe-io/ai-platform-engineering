# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for Webex space auto-assign integration in the runtime gate."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from unittest.mock import MagicMock, patch

import pytest

from ai_platform_engineering.integrations.webex_bot.app import REASON_DISPATCH_ALLOWED, handle_webex_message
from ai_platform_engineering.integrations.webex_bot.tests.test_runtime_gate import (
    FakeDispatcher,
    FakeIdentityLinker,
    FakeOboExchanger,
    FakeRebacChecker,
    FakeRouteResolver,
    FakeTeamResolver,
    _event,
)
from ai_platform_engineering.integrations.webex_bot.utils.space_team_resolver import (
    SpaceTeamResolution,
)
from ai_platform_engineering.integrations.webex_bot.utils.webex_space_auto_assign import (
    WebexSpaceAutoAssignResult,
)


@dataclass
class RetryTeamResolver:
    calls: int = 0
    team_slug: str = "platform-eng"

    async def resolve(self, bot_id: str, space_id: str) -> SpaceTeamResolution:
        del bot_id, space_id
        self.calls += 1
        if self.calls == 1:
            return SpaceTeamResolution(
                team_slug=None,
                team_id=None,
                team_name=None,
                deny_message="Space not mapped",
                bot_id=None,
            )
        return SpaceTeamResolution(
            team_slug=self.team_slug,
            team_id="team-1",
            team_name="Platform Eng",
            deny_message=None,
            bot_id="primary",
        )


@dataclass
class CaptureInvalidate:
    calls: list[tuple[str, str, str]] = field(default_factory=list)

    def invalidate(self, bot_id: str, workspace_id: str, space_id: str) -> None:
        self.calls.append((bot_id, workspace_id, space_id))

    def invalidate_all(self) -> None:
        pass


def test_gate_auto_assign_re_resolves_team_and_invalidates_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "WEBEX_INTEGRATION_BOTS_JSON",
        json.dumps(
            [
                {
                    "id": "primary",
                    "name": "Primary",
                    "tokenEnv": "PRIMARY_TOKEN",
                    "spaces": {
                        "accessMode": "all_spaces",
                        "defaultTeamSlug": "platform-eng",
                        "defaultAgentId": "default-agent",
                    },
                    "directMessages": {"accessMode": "disabled"},
                }
            ]
        ),
    )
    team_resolver = RetryTeamResolver()
    route_cache = CaptureInvalidate()

    with (
        patch(
            "ai_platform_engineering.integrations.webex_bot.utils.webex_space_auto_assign.get_webex_space_auto_assigner"
        ) as assigner_factory,
        patch(
            "ai_platform_engineering.integrations.webex_bot.utils.webex_agent_routes.get_webex_agent_route_resolver",
            return_value=route_cache,
        ),
    ):
        assigner = MagicMock()
        assigner.assign_space.return_value = WebexSpaceAutoAssignResult(
            True,
            "assigned",
            team_slug="platform-eng",
            agent_id="default-agent",
            team_id="team-1",
        )
        assigner_factory.return_value = assigner

        dispatcher = FakeDispatcher()
        result = asyncio.run(
            handle_webex_message(
                _event(),
                identity_linker=FakeIdentityLinker(),
                team_resolver=team_resolver,
                obo_exchanger=FakeOboExchanger(),
                rebac_checker=FakeRebacChecker(),
                route_resolver=FakeRouteResolver(),
                dispatcher=dispatcher,
            )
        )

    assert result.reason_code == REASON_DISPATCH_ALLOWED
    assert team_resolver.calls == 2
    assert route_cache.calls == [("primary", "CAIPE-WEBEX", "space12345")]
    assigner.assign_space.assert_called_once()


def test_all_spaces_repairs_missing_agent_grant_before_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "WEBEX_INTEGRATION_BOTS_JSON",
        json.dumps(
            [
                {
                    "id": "primary",
                    "name": "Primary",
                    "tokenEnv": "PRIMARY_TOKEN",
                    "spaces": {
                        "accessMode": "all_spaces",
                        "defaultTeamSlug": "platform-eng",
                        "defaultAgentId": "default-agent",
                    },
                    "directMessages": {"accessMode": "disabled"},
                }
            ]
        ),
    )

    with patch(
        "ai_platform_engineering.integrations.webex_bot.utils.webex_space_auto_assign.get_webex_space_auto_assigner"
    ) as assigner_factory:
        assigner = MagicMock()
        assigner.ensure_space_agent_grant.return_value = True
        assigner_factory.return_value = assigner
        dispatcher = FakeDispatcher()

        result = asyncio.run(
            handle_webex_message(
                _event(),
                identity_linker=FakeIdentityLinker(),
                team_resolver=FakeTeamResolver(),
                obo_exchanger=FakeOboExchanger(),
                rebac_checker=FakeRebacChecker(
                    allowed=False,
                    reason="missing_space_grant",
                ),
                route_resolver=FakeRouteResolver(agent_id="default-agent"),
                dispatcher=dispatcher,
            )
        )

    assert result.reason_code == REASON_DISPATCH_ALLOWED
    assert len(dispatcher.calls) == 1
    assigner.ensure_space_agent_grant.assert_called_once_with(
        bot_id="primary",
        workspace_id="CAIPE-WEBEX",
        space_id="space12345",
        agent_id="default-agent",
        team_slug="platform-eng",
    )
