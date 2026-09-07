# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Thread-owner pinning cache — mirrors Slack's session_manager thread-owner tests."""

from __future__ import annotations

from ai_platform_engineering.integrations.webex_bot.utils.thread_ownership import (
    ThreadOwnerCache,
    get_default_thread_owner_cache,
)


class TestThreadOwnerCache:
    def test_unknown_thread_returns_none(self) -> None:
        assert ThreadOwnerCache().get("space:root") is None

    def test_set_then_get(self) -> None:
        cache = ThreadOwnerCache()
        cache.set("space:root", "agent-a")
        assert cache.get("space:root") == "agent-a"

    def test_first_write_wins(self) -> None:
        cache = ThreadOwnerCache()
        cache.set("space:root", "agent-a")
        cache.set("space:root", "agent-b")
        assert cache.get("space:root") == "agent-a"

    def test_different_threads_independent(self) -> None:
        cache = ThreadOwnerCache()
        cache.set("space:root-1", "agent-a")
        cache.set("space:root-2", "agent-b")
        assert cache.get("space:root-1") == "agent-a"
        assert cache.get("space:root-2") == "agent-b"

    def test_entry_expires_after_ttl(self, monkeypatch) -> None:
        cache = ThreadOwnerCache(ttl_seconds=1)
        monkeypatch.setattr(
            "ai_platform_engineering.integrations.webex_bot.utils.thread_ownership.time.monotonic",
            lambda: 100.0,
        )
        cache.set("space:root", "agent-a")
        monkeypatch.setattr(
            "ai_platform_engineering.integrations.webex_bot.utils.thread_ownership.time.monotonic",
            lambda: 102.0,
        )
        assert cache.get("space:root") is None


def test_get_default_thread_owner_cache_is_a_singleton() -> None:
    assert get_default_thread_owner_cache() is get_default_thread_owner_cache()
