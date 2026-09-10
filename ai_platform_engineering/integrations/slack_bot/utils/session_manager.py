# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""
Session Manager

Provides in-memory caching for ephemeral bot state:
- Skipped threads (overthink mode)
- Escalation dedup
- User info cache (avoids Slack API rate limits)

Conversation IDs are now deterministic (UUID v5 from thread_ts)
and don't need caching or API lookups.
"""

import time
from typing import Optional, Dict, Tuple


# ---------------------------------------------------------------------------
# TTL cache
# ---------------------------------------------------------------------------


class TTLCache:
  """Simple in-memory cache with per-entry TTL."""

  def __init__(self, ttl_seconds: int = 3600):
    self._store: Dict[str, Tuple[object, float]] = {}
    self._ttl = ttl_seconds

  def get(self, key: str):
    entry = self._store.get(key)
    if entry is None:
      return None
    value, expires_at = entry
    if time.monotonic() > expires_at:
      del self._store[key]
      return None
    return value

  def set(self, key: str, value):
    self._store[key] = (value, time.monotonic() + self._ttl)

  def delete(self, key: str):
    self._store.pop(key, None)

  def __len__(self):
    return len(self._store)


# ---------------------------------------------------------------------------
# Session Manager
# ---------------------------------------------------------------------------


class SessionManager:
  """In-memory session manager for ephemeral bot state.

  Conversation IDs are deterministic (UUID v5 from thread_ts via
  sse_client.thread_ts_to_conversation_id) and need no caching.
  """

  def __init__(self):
    self._user_info_cache = TTLCache(ttl_seconds=600)
    self._skipped_cache = TTLCache(ttl_seconds=300)
    self._channel_info_cache = TTLCache(ttl_seconds=3600)
    self._thread_owner_cache = TTLCache(ttl_seconds=86400)
    self._escalated_threads: set[str] = set()

  # ------------------------------------------------------------------
  # Skipped (overthink mode)
  # ------------------------------------------------------------------

  def set_skipped(self, thread_ts: str, skipped: bool = True) -> None:
    """Mark a thread as skipped in overthink mode."""
    self._skipped_cache.set(thread_ts, skipped)

  def is_skipped(self, thread_ts: str) -> bool:
    """Check if a thread was skipped in overthink mode."""
    cached = self._skipped_cache.get(thread_ts)
    if cached is not None:
      return cached
    return False

  def clear_skipped(self, thread_ts: str) -> None:
    """Clear the skipped flag."""
    self._skipped_cache.delete(thread_ts)

  # ------------------------------------------------------------------
  # Thread ownership — ensures the first agent to respond owns all
  # follow-ups in that thread, regardless of listen mode.
  # ------------------------------------------------------------------

  def get_thread_owner(self, thread_ts: str) -> Optional[str]:
    """Return the agent_id that first responded in this thread, or None."""
    return self._thread_owner_cache.get(thread_ts)

  def set_thread_owner(self, thread_ts: str, agent_id: str) -> None:
    """Claim thread ownership for agent_id (first write wins)."""
    if self._thread_owner_cache.get(thread_ts) is None:
      self._thread_owner_cache.set(thread_ts, agent_id)

  # ------------------------------------------------------------------
  # Escalation dedup
  # ------------------------------------------------------------------

  def is_escalated(self, thread_ts: str) -> bool:
    """Check if this thread has already been escalated."""
    return thread_ts in self._escalated_threads

  def set_escalated(self, thread_ts: str) -> None:
    """Mark a thread as escalated (idempotent)."""
    self._escalated_threads.add(thread_ts)

  # ------------------------------------------------------------------
  # User info cache (pure local — avoids Slack API rate limits)
  # ------------------------------------------------------------------

  def get_user_info(self, user_id: str) -> Optional[dict]:
    """Get cached Slack user info."""
    return self._user_info_cache.get(user_id)

  def set_user_info(self, user_id: str, user_info: dict) -> None:
    """Cache Slack user info to avoid rate limits."""
    self._user_info_cache.set(user_id, user_info)

  # ------------------------------------------------------------------
  # Channel info cache (conversations.info — topic, purpose, etc.)
  # ------------------------------------------------------------------

  def get_channel_info(self, channel_id: str) -> Optional[dict]:
    """Get cached channel info."""
    return self._channel_info_cache.get(channel_id)

  def set_channel_info(self, channel_id: str, channel_info: dict) -> None:
    """Cache channel info to avoid rate limits."""
    self._channel_info_cache.set(channel_id, channel_info)

  # ------------------------------------------------------------------
  # Introspection
  # ------------------------------------------------------------------

  def get_store_type(self) -> str:
    return "memory"

  def get_stats(self) -> dict:
    return {
      "type": "memory",
      "user_cache_size": len(self._user_info_cache),
      "channel_cache_size": len(self._channel_info_cache),
      "skipped_cache_size": len(self._skipped_cache),
      "thread_owner_cache_size": len(self._thread_owner_cache),
      "escalated_threads": len(self._escalated_threads),
    }
