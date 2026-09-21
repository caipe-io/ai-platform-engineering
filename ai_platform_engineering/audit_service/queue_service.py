"""Async queue and batch worker for audit ingest."""

from __future__ import annotations

import asyncio
import logging
from abc import abstractmethod
from datetime import datetime, timezone
from typing import Any, Protocol

logger = logging.getLogger(__name__)

# assisted-by Codex Codex-sonnet-4-6
PUBLIC_FLUSH_ERROR = "audit flush failed; see audit-service logs"


class AuditStore(Protocol):
    @property
    @abstractmethod
    def backend_name(self) -> str:
        """Storage backend identifier."""
        raise NotImplementedError

    @abstractmethod
    def readiness_check(self) -> None:
        """Raise if the backing storage cannot accept audit records."""
        raise NotImplementedError

    @abstractmethod
    def write_batch(self, records: list[dict[str, Any]]) -> str | None:
        """Persist one batch and return a storage reference when available."""
        raise NotImplementedError


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class AuditQueueService:
    """Bounded in-memory audit queue with an async batch flusher."""

    def __init__(
        self,
        store: AuditStore,
        *,
        queue_max_size: int,
        flush_batch_size: int,
        flush_interval_seconds: float,
    ) -> None:
        self.store = store
        self.queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=queue_max_size)
        self.flush_batch_size = flush_batch_size
        self.flush_interval_seconds = flush_interval_seconds
        self.accepted_events = 0
        self.rejected_events = 0
        self.flushed_events = 0
        self.failed_flushes = 0
        self.last_received_at: str | None = None
        self.last_flush_at: str | None = None
        self.last_error: str | None = None
        self._task: asyncio.Task[None] | None = None
        self._stopping = False

    @property
    def is_stopping(self) -> bool:
        """True from the moment shutdown begins, before the drain completes.

        `/readyz` reads this so Kubernetes can pull the pod out of Service
        endpoints as soon as SIGTERM starts a shutdown, rather than only once
        `status()["running"]` goes False at the end of the drain.
        """
        return self._stopping

    async def start(self) -> None:
        if self._task is not None:
            return
        self.store.readiness_check()
        self._task = asyncio.create_task(self._run(), name="audit-queue-worker")

    async def stop(self) -> None:
        self._stopping = True
        if self._task is None:
            return
        try:
            self.queue.put_nowait(None)
        except asyncio.QueueFull:
            self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            await self._flush_remaining()
        finally:
            self._task = None

    def enqueue_many(self, records: list[dict[str, Any]]) -> bool:
        if self._stopping:
            self.rejected_events += len(records)
            return False
        remaining = self.queue.maxsize - self.queue.qsize()
        if len(records) > remaining:
            self.rejected_events += len(records)
            return False
        for record in records:
            self.queue.put_nowait(record)
        self.accepted_events += len(records)
        self.last_received_at = _utc_now_iso()
        return True

    def status(self) -> dict[str, Any]:
        return {
            "running": self._task is not None and not self._task.done(),
            "backend": self.store.backend_name,
            "queue_size": self.queue.qsize(),
            "queue_max_size": self.queue.maxsize,
            "flush_batch_size": self.flush_batch_size,
            "flush_interval_seconds": self.flush_interval_seconds,
            "accepted_events": self.accepted_events,
            "rejected_events": self.rejected_events,
            "flushed_events": self.flushed_events,
            "failed_flushes": self.failed_flushes,
            "last_received_at": self.last_received_at,
            "last_flush_at": self.last_flush_at,
            "last_error": self.last_error,
        }

    async def _run(self) -> None:
        while True:
            item = await self.queue.get()
            if item is None:
                self.queue.task_done()
                await self._flush_remaining()
                return

            batch = [item]
            deadline = asyncio.get_running_loop().time() + self.flush_interval_seconds
            while len(batch) < self.flush_batch_size:
                try:
                    batch.append(self.queue.get_nowait())
                    continue
                except asyncio.QueueEmpty:
                    # Empty queue is expected; wait until the batch deadline for another event.
                    timeout = deadline - asyncio.get_running_loop().time()
                if timeout <= 0:
                    break
                try:
                    next_item = await asyncio.wait_for(self.queue.get(), timeout=timeout)
                except TimeoutError:
                    break
                if next_item is None:
                    self.queue.task_done()
                    await self._flush_batch(batch)
                    await self._flush_remaining()
                    return
                batch.append(next_item)

            await self._flush_batch(batch)

    async def _flush_remaining(self) -> None:
        batch: list[dict[str, Any]] = []
        while True:
            try:
                item = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if item is not None:
                batch.append(item)
            else:
                self.queue.task_done()
        await self._flush_batch(batch)

    async def _flush_batch(self, batch: list[dict[str, Any]]) -> None:
        if not batch:
            return
        try:
            await asyncio.to_thread(self.store.write_batch, batch)
            self.flushed_events += len(batch)
            self.last_flush_at = _utc_now_iso()
            self.last_error = None
        except Exception:  # noqa: BLE001
            self.failed_flushes += 1
            self.last_error = PUBLIC_FLUSH_ERROR
            logger.exception("failed to flush audit batch")
        finally:
            for _ in batch:
                self.queue.task_done()
