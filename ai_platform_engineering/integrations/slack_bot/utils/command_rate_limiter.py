"""Per-user, time-windowed command rate limiter (FR-035).

In-process only — never persisted. Bounded by a max-tracked-users
count to keep memory deterministic in long-running bot pods.

The limiter is intentionally simple: a single sliding window per
user, with timestamps stored in a ``deque``. We expire timestamps on
read so memory cost is proportional to the active set of users
in the last ``window_seconds``.

Used by the ``/{cmd}-list``, ``/{cmd}-use``, ``/{cmd}-effort``, and ``/{cmd}-help``
slash command handlers in Slack (and corresponding text commands in
Webex via a separate, identical-shaped twin).
"""

from __future__ import annotations

from collections import OrderedDict, deque
from threading import Lock
from time import monotonic
from typing import Callable, Deque


class CommandRateLimiter:
    """Per-user sliding-window rate limiter.

    Args:
        max_per_window: Maximum number of commands allowed in the
            sliding window. Default 5.
        window_seconds: Sliding window length. Default 30 seconds.
        max_tracked_users: Bound on distinct users tracked at once.
            Eviction is LRU. Default 10_000.
        time_source: Monotonic time source. Injected for testability.
    """

    def __init__(
        self,
        *,
        max_per_window: int = 5,
        window_seconds: float = 30.0,
        max_tracked_users: int = 10_000,
        time_source: Callable[[], float] = monotonic,
    ) -> None:
        if max_per_window < 1:
            raise ValueError("max_per_window must be >= 1")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be > 0")
        if max_tracked_users < 1:
            raise ValueError("max_tracked_users must be >= 1")
        self._max = max_per_window
        self._window = window_seconds
        self._max_users = max_tracked_users
        self._now = time_source
        self._lock = Lock()
        self._buckets: OrderedDict[str, Deque[float]] = OrderedDict()

    def check_and_consume(self, user_key: str) -> bool:
        """Atomically check & record one command for the user.

        Returns ``True`` if the user is **under** the limit (and a
        slot has been consumed), ``False`` if the user is at or over
        the limit (no slot consumed).
        """
        if not user_key:
            return True
        now = self._now()
        cutoff = now - self._window
        with self._lock:
            timestamps = self._buckets.get(user_key)
            if timestamps is None:
                timestamps = deque()
                self._buckets[user_key] = timestamps
            else:
                self._buckets.move_to_end(user_key)
            while timestamps and timestamps[0] < cutoff:
                timestamps.popleft()
            if len(timestamps) >= self._max:
                return False
            timestamps.append(now)
            self._evict_lru_if_needed()
            return True

    def reset(self, user_key: str) -> None:
        with self._lock:
            self._buckets.pop(user_key, None)

    def _evict_lru_if_needed(self) -> None:
        while len(self._buckets) > self._max_users:
            self._buckets.popitem(last=False)
