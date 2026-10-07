# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for the JIT branch in ``identity_linker.auto_bootstrap_slack_user``.

Spec 103 G1 / FR-001 / FR-006 / FR-007 / FR-010 / FR-011.

We patch the three external surfaces (Slack profile fetch, Keycloak
user-by-email lookup, JIT create) so we can exercise the decision matrix
without spinning up either system.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

import pytest

from ai_platform_engineering.integrations.slack_bot.utils import (
    identity_linker as il,
)
from ai_platform_engineering.integrations.slack_bot.utils import (
    keycloak_admin as ka,
)


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each test starts with the JIT flag and allowlist explicitly cleared
    so behaviour is whatever the test sets, not whatever .env contains."""
    monkeypatch.delenv("SLACK_JIT_CREATE_USER", raising=False)
    monkeypatch.delenv("SLACK_JIT_ALLOWED_EMAIL_DOMAINS", raising=False)


def _patch_async(monkeypatch: pytest.MonkeyPatch, target: str, fn) -> None:
    monkeypatch.setattr(target, fn)


def test_existing_user_path_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When a Keycloak user with the email already exists, the helper
    sets the slack_user_id attribute and returns its id — JIT MUST NOT
    fire on this path."""
    set_calls: list[tuple] = []
    create_calls: list[tuple] = []

    async def fake_email(_sid: str) -> Optional[str]:
        return "alice@corp.com"

    async def fake_lookup(_email: str):
        return {"id": "existing-uuid", "enabled": True}

    async def fake_set_attr(uid: str, attr: str, value: str) -> None:
        set_calls.append((uid, attr, value))

    async def fake_create(_sid: str, _email: str, config=None):
        create_calls.append((_sid, _email))
        raise AssertionError("JIT MUST NOT be invoked when user exists")

    monkeypatch.setattr(il, "_get_slack_user_email", fake_email)
    monkeypatch.setattr(il, "get_user_by_email", fake_lookup)
    monkeypatch.setattr(il, "set_user_attribute", fake_set_attr)
    monkeypatch.setattr(il, "create_user_from_slack", fake_create)

    result = asyncio.run(il.auto_bootstrap_slack_user("U1"))
    assert result == "existing-uuid"
    assert set_calls == [("existing-uuid", "slack_user_id", "U1")]
    assert create_calls == []


def test_jit_disabled_falls_back_to_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SLACK_JIT_CREATE_USER=false MUST short-circuit before calling
    create_user_from_slack, returning None so the caller emits the HMAC
    link prompt (FR-007)."""
    monkeypatch.setenv("SLACK_JIT_CREATE_USER", "false")

    async def fake_email(_sid: str) -> Optional[str]:
        return "alice@corp.com"

    async def fake_lookup(_email: str):
        return None

    async def fake_create(_sid: str, _email: str, config=None):
        raise AssertionError("JIT must not be called when flag is false")

    monkeypatch.setattr(il, "_get_slack_user_email", fake_email)
    monkeypatch.setattr(il, "get_user_by_email", fake_lookup)
    monkeypatch.setattr(il, "create_user_from_slack", fake_create)

    assert asyncio.run(il.auto_bootstrap_slack_user("U1")) is None


def test_jit_enabled_creates_user_and_returns_uuid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Default behaviour: JIT flag unset (=> on), no existing user,
    create_user_from_slack returns a new id, helper returns it."""
    create_calls: list[tuple] = []

    async def fake_email(_sid: str) -> Optional[str]:
        return "alice@corp.com"

    async def fake_lookup(_email: str):
        return None

    async def fake_create(sid: str, email: str, config=None):
        create_calls.append((sid, email))
        return "new-jit-uuid"

    monkeypatch.setattr(il, "_get_slack_user_email", fake_email)
    monkeypatch.setattr(il, "get_user_by_email", fake_lookup)
    monkeypatch.setattr(il, "create_user_from_slack", fake_create)

    assert asyncio.run(il.auto_bootstrap_slack_user("U1")) == "new-jit-uuid"
    assert create_calls == [("U1", "alice@corp.com")]


def test_jit_allowlist_blocks_unlisted_domain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only emails in SLACK_JIT_ALLOWED_EMAIL_DOMAINS get JIT'd
    (FR-006). Anything else falls back to None."""
    monkeypatch.setenv("SLACK_JIT_ALLOWED_EMAIL_DOMAINS", "corp.com,acme.io")

    async def fake_email(_sid: str) -> Optional[str]:
        return "evil@external.example"

    async def fake_lookup(_email: str):
        return None

    async def fake_create(_sid: str, _email: str, config=None):
        raise AssertionError("JIT must not run for non-allowlisted domain")

    monkeypatch.setattr(il, "_get_slack_user_email", fake_email)
    monkeypatch.setattr(il, "get_user_by_email", fake_lookup)
    monkeypatch.setattr(il, "create_user_from_slack", fake_create)

    assert asyncio.run(il.auto_bootstrap_slack_user("U1")) is None


def test_jit_allowlist_allows_listed_domain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SLACK_JIT_ALLOWED_EMAIL_DOMAINS", "corp.com,acme.io")

    async def fake_email(_sid: str) -> Optional[str]:
        return "alice@ACME.IO"  # case-insensitive match

    async def fake_lookup(_email: str):
        return None

    async def fake_create(_sid: str, _email: str, config=None):
        return "ok-uuid"

    monkeypatch.setattr(il, "_get_slack_user_email", fake_email)
    monkeypatch.setattr(il, "get_user_by_email", fake_lookup)
    monkeypatch.setattr(il, "create_user_from_slack", fake_create)

    assert asyncio.run(il.auto_bootstrap_slack_user("U1")) == "ok-uuid"


def test_jit_failure_logs_error_kind_and_returns_none(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A typed JitError MUST be logged with a stable error_kind token
    (FR-011) and the helper MUST return None so the caller falls back to
    the HMAC link prompt rather than failing the user message."""

    async def fake_email(_sid: str) -> Optional[str]:
        return "alice@corp.com"

    async def fake_lookup(_email: str):
        return None

    async def fake_create(_sid: str, _email: str, config=None):
        raise ka.JitForbiddenError("manage-users missing on caipe-platform")

    monkeypatch.setattr(il, "_get_slack_user_email", fake_email)
    monkeypatch.setattr(il, "get_user_by_email", fake_lookup)
    monkeypatch.setattr(il, "create_user_from_slack", fake_create)

    with caplog.at_level(logging.WARNING, logger="caipe.slack_bot.identity_linker"):
        assert asyncio.run(il.auto_bootstrap_slack_user("U1")) is None

    record_text = "\n".join(r.getMessage() for r in caplog.records)
    assert "event=jit_failed" in record_text
    assert "error_kind=forbidden" in record_text


def test_jit_log_lines_never_leak_full_email(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """FR-010: every log line that mentions the email MUST go through
    the masking helper. We assert the literal "alice@corp.com" never
    appears in any record produced by the JIT path."""

    async def fake_email(_sid: str) -> Optional[str]:
        return "alice@corp.com"

    async def fake_lookup(_email: str):
        return None

    async def fake_create(sid: str, email: str, config=None):
        return "uuid-1"

    monkeypatch.setattr(il, "_get_slack_user_email", fake_email)
    monkeypatch.setattr(il, "get_user_by_email", fake_lookup)
    monkeypatch.setattr(il, "create_user_from_slack", fake_create)

    with caplog.at_level(logging.DEBUG, logger="caipe.slack_bot.identity_linker"):
        asyncio.run(il.auto_bootstrap_slack_user("U1"))

    for r in caplog.records:
        assert "alice@corp.com" not in r.getMessage(), (
            f"Full email leaked in log: {r.getMessage()!r}"
        )
