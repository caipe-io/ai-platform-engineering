# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for the in-memory SessionManager."""

from ai_platform_engineering.integrations.slack_bot.utils.session_manager import (
  SessionManager,
  TTLCache,
)


class TestTTLCache:
  def test_set_and_get(self):
    cache = TTLCache(ttl_seconds=60)
    cache.set("k1", "v1")
    assert cache.get("k1") == "v1"

  def test_missing_key(self):
    cache = TTLCache(ttl_seconds=60)
    assert cache.get("missing") is None

  def test_delete(self):
    cache = TTLCache(ttl_seconds=60)
    cache.set("k1", "v1")
    cache.delete("k1")
    assert cache.get("k1") is None

  def test_len(self):
    cache = TTLCache(ttl_seconds=60)
    cache.set("a", 1)
    cache.set("b", 2)
    assert len(cache) == 2


class TestSessionManager:
  def _make_manager(self):
    return SessionManager()

  def test_store_type(self):
    mgr = self._make_manager()
    assert mgr.get_store_type() == "memory"

  def test_skipped_roundtrip(self):
    mgr = self._make_manager()
    assert mgr.is_skipped("t1") is False
    mgr.set_skipped("t1", True)
    assert mgr.is_skipped("t1") is True
    mgr.clear_skipped("t1")
    assert mgr.is_skipped("t1") is False

  def test_escalation_dedup(self):
    mgr = self._make_manager()
    assert mgr.is_escalated("t1") is False
    mgr.set_escalated("t1")
    assert mgr.is_escalated("t1") is True

  def test_user_info_cache(self):
    mgr = self._make_manager()
    info = {"user": {"profile": {"email": "test@example.com"}}}
    mgr.set_user_info("U123", info)
    assert mgr.get_user_info("U123") == info
    assert mgr.get_user_info("U999") is None

  def test_stats(self):
    mgr = self._make_manager()
    stats = mgr.get_stats()
    assert stats["type"] == "memory"
    assert "user_cache_size" in stats
    assert "skipped_cache_size" in stats
    assert "escalated_threads" in stats
