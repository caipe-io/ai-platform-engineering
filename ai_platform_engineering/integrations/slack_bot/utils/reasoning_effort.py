"""Bounded staging store for Slack DM reasoning-effort commands."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from threading import Lock
from typing import Literal

ReasoningEffort = Literal["low", "medium", "high", "max"]
REASONING_EFFORTS: tuple[ReasoningEffort, ...] = ("low", "medium", "high", "max")


@dataclass(frozen=True)
class PendingEffortKey:
    workspace_id: str
    channel_id: str
    user_id: str

    def as_tuple(self) -> tuple[str, str, str]:
        return (self.workspace_id, self.channel_id, self.user_id)


class PendingEffortStore:
    """Stage an effort until the user's next DM identifies its conversation."""

    def __init__(self, max_size: int = 1000) -> None:
        self.max_size = max_size
        self._items: OrderedDict[tuple[str, str, str], ReasoningEffort] = OrderedDict()
        self._lock = Lock()

    def set(self, key: PendingEffortKey, effort: ReasoningEffort) -> None:
        item_key = key.as_tuple()
        with self._lock:
            self._items[item_key] = effort
            self._items.move_to_end(item_key)
            while len(self._items) > self.max_size:
                self._items.popitem(last=False)

    def consume(self, key: PendingEffortKey) -> ReasoningEffort | None:
        with self._lock:
            return self._items.pop(key.as_tuple(), None)


_default_store: PendingEffortStore | None = None


def get_default_pending_effort_store() -> PendingEffortStore:
    global _default_store
    if _default_store is None:
        _default_store = PendingEffortStore()
    return _default_store
