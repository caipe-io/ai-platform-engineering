# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for Webex identity linking."""

from __future__ import annotations

import asyncio
from typing import Optional

import pytest

from ai_platform_engineering.integrations.webex_bot.utils import identity_linker as il
from ai_platform_engineering.integrations.webex_bot.utils.identity_linker import (
    WebexIdentityLinker,
)
from ai_platform_engineering.integrations.webex_bot.utils.keycloak_admin import (
    WEBEX_USER_ATTRIBUTE,
)


def test_webex_user_attribute_name() -> None:
    assert WEBEX_USER_ATTRIBUTE == "webex_user_id"


def test_resolve_webex_user_rejects_invalid_person_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called = False

    async def fake_lookup(_attr: str, _value: str):
        nonlocal called
        called = True
        return None

    monkeypatch.setattr(il, "get_user_by_attribute", fake_lookup)
    assert asyncio.run(il.resolve_webex_user("bad/id")) is None
    assert called is False


def test_resolve_webex_user_returns_none_when_unlinked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_lookup(_attr: str, _value: str):
        return None

    monkeypatch.setattr(il, "get_user_by_attribute", fake_lookup)
    assert asyncio.run(il.resolve_webex_user("person1234")) is None


def test_resolve_webex_user_returns_keycloak_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_lookup(_attr: str, _value: str):
        return {"id": "kc-uuid", "enabled": True}

    monkeypatch.setattr(il, "get_user_by_attribute", fake_lookup)
    assert asyncio.run(il.resolve_webex_user("person1234")) == "kc-uuid"


def test_webex_identity_linker_protocol(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    linker = WebexIdentityLinker()

    async def fake_resolve(webex_user_id: str) -> Optional[str]:
        return "kc-1" if webex_user_id == "person1234" else None

    monkeypatch.setattr(linker, "resolve", fake_resolve)
    assert asyncio.run(linker.resolve("person1234")) == "kc-1"


def test_generate_linking_url_returns_oauth_start_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(il, "_LINK_BASE_URL", "https://caipe.example.com")
    monkeypatch.delenv("NODE_ENV", raising=False)
    url = asyncio.run(il.generate_linking_url("person1234"))
    assert url == "https://caipe.example.com/api/auth/webex-link/start"


def test_generate_linking_url_ignores_webex_user_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(il, "_LINK_BASE_URL", "https://caipe.example.com")
    monkeypatch.delenv("NODE_ENV", raising=False)
    url_a = asyncio.run(il.generate_linking_url("person1234"))
    url_b = asyncio.run(il.generate_linking_url("someone-elses-person-id"))
    assert url_a == url_b


def test_generate_linking_url_rejects_non_https_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(il, "_LINK_BASE_URL", "http://localhost:3000")
    monkeypatch.setenv("NODE_ENV", "production")
    with pytest.raises(ValueError):
        asyncio.run(il.generate_linking_url("person1234"))


def test_generate_linking_url_allows_https_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(il, "_LINK_BASE_URL", "https://caipe.example.com")
    monkeypatch.setenv("NODE_ENV", "production")
    url = asyncio.run(il.generate_linking_url("person1234"))
    assert url == "https://caipe.example.com/api/auth/webex-link/start"
