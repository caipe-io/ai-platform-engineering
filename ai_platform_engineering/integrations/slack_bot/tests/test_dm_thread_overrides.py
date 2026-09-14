# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Phase 2.4 — In-process Slack DM thread overrides.

Spec 2026-05-24-derive-team-from-channel FR-026 (no TTL; persistent
until cleared or process restart). The store is bounded (LRU on size
only, time-free) so a long-lived bot can't leak memory.

Key shape: ``(workspace_id, channel_id, user_id, thread_ts)`` — four
strings, normalized. Two different threads in the same DM channel keep
independent overrides.
"""

from __future__ import annotations

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.dm_thread_overrides import (
    OverrideKey,
    OverrideStore,
)


def _key(thread_ts: str = "t1", user_id: str = "u1") -> OverrideKey:
    return OverrideKey(
        workspace_id="W1", channel_id="C1", user_id=user_id, thread_ts=thread_ts
    )


class TestOverrideStoreBasics:
    def test_set_then_get_returns_value(self) -> None:
        store = OverrideStore()
        store.set(_key(), "agent-x")
        assert store.get(_key()) == "agent-x"

    def test_second_set_replaces_first(self) -> None:
        store = OverrideStore()
        store.set(_key(), "agent-x")
        store.set(_key(), "agent-y")
        assert store.get(_key()) == "agent-y"

    def test_clear_removes(self) -> None:
        store = OverrideStore()
        store.set(_key(), "agent-x")
        store.clear(_key())
        assert store.get(_key()) is None

    def test_clear_missing_key_is_a_noop(self) -> None:
        store = OverrideStore()
        store.clear(_key())  # MUST NOT raise
        assert store.get(_key()) is None

    def test_get_unknown_key_returns_none(self) -> None:
        store = OverrideStore()
        assert store.get(_key()) is None

    def test_different_threads_are_independent(self) -> None:
        store = OverrideStore()
        store.set(_key(thread_ts="t1"), "agent-x")
        store.set(_key(thread_ts="t2"), "agent-y")
        assert store.get(_key(thread_ts="t1")) == "agent-x"
        assert store.get(_key(thread_ts="t2")) == "agent-y"

    def test_different_users_in_same_thread_are_independent(self) -> None:
        store = OverrideStore()
        store.set(_key(user_id="alice"), "agent-x")
        store.set(_key(user_id="bob"), "agent-y")
        assert store.get(_key(user_id="alice")) == "agent-x"
        assert store.get(_key(user_id="bob")) == "agent-y"


class TestOverrideStoreBounded:
    def test_lru_evicts_oldest_when_max_size_exceeded(self) -> None:
        store = OverrideStore(max_size=3)
        store.set(_key(thread_ts="t1"), "agent-1")
        store.set(_key(thread_ts="t2"), "agent-2")
        store.set(_key(thread_ts="t3"), "agent-3")
        store.set(_key(thread_ts="t4"), "agent-4")  # evicts t1

        assert store.get(_key(thread_ts="t1")) is None
        assert store.get(_key(thread_ts="t2")) == "agent-2"
        assert store.get(_key(thread_ts="t3")) == "agent-3"
        assert store.get(_key(thread_ts="t4")) == "agent-4"

    def test_get_promotes_to_most_recently_used(self) -> None:
        store = OverrideStore(max_size=3)
        store.set(_key(thread_ts="t1"), "agent-1")
        store.set(_key(thread_ts="t2"), "agent-2")
        store.set(_key(thread_ts="t3"), "agent-3")
        # Touch t1; now LRU order from oldest → newest is t2, t3, t1.
        assert store.get(_key(thread_ts="t1")) == "agent-1"
        store.set(_key(thread_ts="t4"), "agent-4")  # evicts t2 (oldest)

        assert store.get(_key(thread_ts="t2")) is None
        assert store.get(_key(thread_ts="t1")) == "agent-1"

    def test_default_max_size_is_a_thousand(self) -> None:
        store = OverrideStore()
        assert store.max_size == 1000

    @pytest.mark.parametrize("invalid_size", [0, -1, -100])
    def test_max_size_must_be_positive(self, invalid_size: int) -> None:
        with pytest.raises(ValueError):
            OverrideStore(max_size=invalid_size)


class TestOverrideStoreNormalization:
    def test_key_components_are_normalized_to_strings(self) -> None:
        # Slack thread_ts is sometimes passed as float-ish; the key MUST
        # treat it as an opaque string and not crash on numeric inputs.
        store = OverrideStore()
        key = OverrideKey(
            workspace_id="W1", channel_id="C1", user_id="u1", thread_ts="1234.5"
        )
        store.set(key, "agent-x")
        assert store.get(key) == "agent-x"

    def test_empty_components_raise(self) -> None:
        with pytest.raises(ValueError):
            OverrideKey(workspace_id="", channel_id="C1", user_id="u1", thread_ts="t")
        with pytest.raises(ValueError):
            OverrideKey(workspace_id="W1", channel_id="", user_id="u1", thread_ts="t")
        with pytest.raises(ValueError):
            OverrideKey(workspace_id="W1", channel_id="C1", user_id="", thread_ts="t")
        with pytest.raises(ValueError):
            OverrideKey(workspace_id="W1", channel_id="C1", user_id="u1", thread_ts="")


class TestOverrideStoreNoTtl:
    """FR-026: overrides MUST NOT expire by time. Phase 2 deliberately
    deletes the 30-minute TTL that lived in the legacy DM flow.

    We can't easily fake the wall clock without monkeypatching every
    timing call site; instead the test simply documents the contract by
    asserting that no monotonic-time-related field exists on the entry.
    """

    def test_entries_have_no_expires_at_or_created_at_field(self) -> None:
        store = OverrideStore()
        store.set(_key(), "agent-x")
        snapshot = store._snapshot_for_test()  # noqa: SLF001 — test-only hatch
        assert snapshot, "expected at least one entry"
        entry = snapshot[0]
        assert "expires_at" not in entry
        assert "created_at" not in entry
        assert "ttl" not in entry
