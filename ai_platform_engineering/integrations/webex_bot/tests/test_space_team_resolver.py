# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for Webex space-to-team resolution."""

from __future__ import annotations

import asyncio
from unittest.mock import Mock

import pytest

from ai_platform_engineering.integrations.webex_bot.utils.space_team_resolver import (
    WebexSpaceTeamResolver,
)


def test_resolve_denies_when_mongo_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    resolver = WebexSpaceTeamResolver()
    monkeypatch.setattr(resolver, "_get_client", lambda: None)

    result = asyncio.run(resolver.resolve("primary", "space-12345678"))
    assert result.team_slug is None
    assert result.deny_message is not None


def test_resolve_returns_team_slug_without_membership_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resolver = WebexSpaceTeamResolver()

    team_doc = {
        "_id": "507f1f77bcf86cd799439011",
        "slug": "platform-eng",
        "name": "Platform Eng",
        "members": [],
    }

    monkeypatch.setattr(
        resolver,
        "_load_space_team_sync",
        lambda _bot_id, _space_id: {"team": team_doc, "bot_id": "primary"},
    )

    result = asyncio.run(resolver.resolve("primary", "space-12345678"))
    assert result.team_slug == "platform-eng"
    assert result.bot_id == "primary"
    assert result.deny_message is None


def test_resolve_denies_invalid_team_slug(monkeypatch: pytest.MonkeyPatch) -> None:
    resolver = WebexSpaceTeamResolver()

    team_doc = {
        "_id": "507f1f77bcf86cd799439011",
        "slug": "",
        "name": "Broken Team",
        "members": [{"user_id": "kc-user-1"}],
    }

    monkeypatch.setattr(
        resolver,
        "_load_space_team_sync",
        lambda _bot_id, _space_id: {"team": team_doc, "bot_id": "primary"},
    )

    result = asyncio.run(resolver.resolve("primary", "space-12345678"))
    assert result.team_slug is None
    assert result.deny_message is not None


def test_botless_legacy_mapping_is_not_used_at_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mappings = Mock()
    mappings.find_one.return_value = None
    teams = Mock()
    teams.find_one.return_value = {
        "_id": "507f1f77bcf86cd799439011",
        "slug": "platform-eng",
        "name": "Platform Eng",
    }
    resolver = WebexSpaceTeamResolver()
    monkeypatch.setattr(
        resolver,
        "_coll",
        lambda name: mappings if name == "webex_space_team_mappings" else teams,
    )

    result = resolver._load_space_team_sync("primary", "space-12345678")

    assert result is None
    assert mappings.find_one.call_count == 1
    assert mappings.find_one.call_args.args[0]["bot_id"] == "primary"
