"""Stage Webex direct-message effort changes until the next chat message."""

from __future__ import annotations

from collections import OrderedDict
from threading import Lock
from typing import Literal

ReasoningEffort = Literal["low", "medium", "high", "max"]
REASONING_EFFORTS: tuple[ReasoningEffort, ...] = ("low", "medium", "high", "max")


class PendingEffortStore:
    def __init__(self, max_size: int = 1000) -> None:
        self.max_size = max_size
        self._items: OrderedDict[tuple[str, str], ReasoningEffort] = OrderedDict()
        self._lock = Lock()

    def set(self, person_id: str, space_id: str, effort: ReasoningEffort) -> None:
        key = (person_id, space_id)
        with self._lock:
            self._items[key] = effort
            self._items.move_to_end(key)
            while len(self._items) > self.max_size:
                self._items.popitem(last=False)

    def consume(self, person_id: str, space_id: str) -> ReasoningEffort | None:
        with self._lock:
            return self._items.pop((person_id, space_id), None)


_default_store: PendingEffortStore | None = None


def get_default_pending_effort_store() -> PendingEffortStore:
    global _default_store
    if _default_store is None:
        _default_store = PendingEffortStore()
    return _default_store
