# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Phase 2.4 — Webex per-room DM agent overrides.

Mirror of the Slack-bot ``test_dm_thread_overrides.py``. Webex key is
``(person_id, room_id)`` (two components, no thread).
"""

from __future__ import annotations

import pytest

from ai_platform_engineering.integrations.webex_bot.utils.dm_thread_overrides import (
    OverrideKey,
    OverrideStore,
)


def _key(person_id: str = "p1", room_id: str = "r1") -> OverrideKey:
    return OverrideKey(person_id=person_id, room_id=room_id)


class TestOverrideStoreBasics:
    def test_set_then_get(self) -> None:
        store = OverrideStore()
        store.set(_key(), "agent-x")
        assert store.get(_key()) == "agent-x"

    def test_replace(self) -> None:
        store = OverrideStore()
        store.set(_key(), "a")
        store.set(_key(), "b")
        assert store.get(_key()) == "b"

    def test_clear(self) -> None:
        store = OverrideStore()
        store.set(_key(), "a")
        store.clear(_key())
        assert store.get(_key()) is None

    def test_clear_missing_is_noop(self) -> None:
        store = OverrideStore()
        store.clear(_key())
        assert store.get(_key()) is None

    def test_get_unknown_returns_none(self) -> None:
        assert OverrideStore().get(_key()) is None

    def test_different_rooms_independent(self) -> None:
        store = OverrideStore()
        store.set(_key(room_id="r1"), "a")
        store.set(_key(room_id="r2"), "b")
        assert store.get(_key(room_id="r1")) == "a"
        assert store.get(_key(room_id="r2")) == "b"

    def test_different_persons_in_same_room_independent(self) -> None:
        store = OverrideStore()
        store.set(_key(person_id="alice"), "a")
        store.set(_key(person_id="bob"), "b")
        assert store.get(_key(person_id="alice")) == "a"
        assert store.get(_key(person_id="bob")) == "b"


class TestOverrideStoreBounded:
    def test_lru_eviction(self) -> None:
        store = OverrideStore(max_size=3)
        store.set(_key(room_id="r1"), "1")
        store.set(_key(room_id="r2"), "2")
        store.set(_key(room_id="r3"), "3")
        store.set(_key(room_id="r4"), "4")
        assert store.get(_key(room_id="r1")) is None
        assert store.get(_key(room_id="r4")) == "4"

    def test_get_promotes_to_mru(self) -> None:
        store = OverrideStore(max_size=3)
        store.set(_key(room_id="r1"), "1")
        store.set(_key(room_id="r2"), "2")
        store.set(_key(room_id="r3"), "3")
        assert store.get(_key(room_id="r1")) == "1"
        store.set(_key(room_id="r4"), "4")
        assert store.get(_key(room_id="r2")) is None
        assert store.get(_key(room_id="r1")) == "1"

    @pytest.mark.parametrize("size", [0, -1])
    def test_invalid_max_size_raises(self, size: int) -> None:
        with pytest.raises(ValueError):
            OverrideStore(max_size=size)


class TestOverrideStoreNormalization:
    def test_empty_components_raise(self) -> None:
        with pytest.raises(ValueError):
            OverrideKey(person_id="", room_id="r1")
        with pytest.raises(ValueError):
            OverrideKey(person_id="p1", room_id="")


class TestOverrideStoreNoTtl:
    def test_no_timing_fields(self) -> None:
        store = OverrideStore()
        store.set(_key(), "a")
        snapshot = store._snapshot_for_test()  # noqa: SLF001
        assert snapshot
        entry = snapshot[0]
        assert "expires_at" not in entry
        assert "created_at" not in entry
