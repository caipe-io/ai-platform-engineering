# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""In-memory Webex thread-to-agent ownership cache.

Mirrors ``slack_bot.utils.session_manager``'s thread-owner cache: the
first agent to respond in a space thread keeps that thread pinned, so a
later change to the space's agent route does not redirect an in-flight
thread. Conversation metadata (``thread_owner_agent_id``, persisted via
``WebexSSEClient.update_conversation_metadata``) is the durable fallback
that lets ownership survive bot restarts.
"""

from __future__ import annotations

import time
from typing import Dict, Optional, Tuple

_DEFAULT_TTL_SECONDS = 86400


class ThreadOwnerCache:
    """First-write-wins, TTL-bounded thread_key -> agent_id cache."""

    def __init__(self, *, ttl_seconds: int = _DEFAULT_TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        self._store: Dict[str, Tuple[str, float]] = {}

    def get(self, thread_key: str) -> Optional[str]:
        """Return the agent_id that first responded in this thread, or None."""
        entry = self._store.get(thread_key)
        if entry is None:
            return None
        agent_id, expires_at = entry
        if time.monotonic() > expires_at:
            del self._store[thread_key]
            return None
        return agent_id

    def set(self, thread_key: str, agent_id: str) -> None:
        """Claim thread ownership for agent_id (first write wins)."""
        if self.get(thread_key) is None:
            self._store[thread_key] = (agent_id, time.monotonic() + self._ttl)


_default_cache: Optional[ThreadOwnerCache] = None


def get_default_thread_owner_cache() -> ThreadOwnerCache:
    global _default_cache
    if _default_cache is None:
        _default_cache = ThreadOwnerCache()
    return _default_cache
