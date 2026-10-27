"""Retryable archival of durably accepted Mongo events, shared by all replicas."""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any
from uuid import uuid4

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from ai_platform_engineering.audit_service.query_store import MongoAuditStore, query_scope, utc_now
from ai_platform_engineering.audit_service.storage import LocalAuditStore, S3AuditStore

logger = logging.getLogger(__name__)


class ArchiveWorker:
    def __init__(
        self, query_store: MongoAuditStore, archive: LocalAuditStore | S3AuditStore, *, batch_size: int, interval: float, retention_days: int = 0
    ) -> None:
        self.query_store = query_store
        self.archive = archive
        self.batch_size = batch_size
        self.interval = interval
        self.retention_days = retention_days
        self.owner = str(uuid4())
        self.task: asyncio.Task[None] | None = None
        self.failed_flushes = 0
        self.flushed_events = 0
        self.last_error: str | None = None
        self.last_flush_at: str | None = None
        self.is_stopping = False

    async def start(self) -> None:
        self.task = asyncio.create_task(self.run(), name="audit-archive-worker")

    async def stop(self) -> None:
        self.is_stopping = True
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        # A cancelled to_thread write may still finish. Keep the durable lease
        # until expiry; its replacement will replay the same deterministic batch.

    def status(self) -> dict[str, Any]:
        return {
            "running": self.task is not None and not self.task.done(),
            "backend": self.archive.backend_name,
            "flushed_events": self.flushed_events,
            "failed_flushes": self.failed_flushes,
            "last_error": self.last_error,
            "last_flush_at": self.last_flush_at,
        }

    def flush_once(self) -> int:
        now = utc_now()
        try:
            lease = self.query_store.progress.find_one_and_update(
                {"_id": "archive", "$or": [{"owner": self.owner}, {"lease_until": {"$lte": now}}]},
                {"$set": {"owner": self.owner, "lease_until": now + timedelta(seconds=60)}},
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )
        except DuplicateKeyError:
            return 0  # Another replica owns the lease.
        batch = lease.get("batch")
        if not batch:
            docs = list(
                self.query_store.events.find({"archived": False})
                .sort([("ingested_at", 1), ("_id", 1)])
                .limit(self.batch_size)
            )
            if not docs:
                return 0
            ids = [doc["_id"] for doc in docs]
            batch = {"id": query_scope({"event_ids": ids}), "events": ids}
            written = self.query_store.progress.update_one(
                {"_id": "archive", "owner": self.owner, "lease_until": {"$gt": utc_now()}},
                {"$set": {"batch": batch}},
            )
            if not written.matched_count:
                return 0
        if "archived_at" not in batch:
            by_id = {doc["_id"]: doc for doc in self.query_store.events.find({"_id": {"$in": batch["events"]}})}
            if len(by_id) != len(batch["events"]):
                raise RuntimeError("Audit archive batch is missing durable records")
            records = [by_id[event_id]["event"] for event_id in batch["events"]]
            self.archive.write_batch(records, batch_id=batch["id"])
            batch["archived_at"] = utc_now()
            # Persist completion before enabling TTL. Recovery can finish the batch
            # even if its already-archived query records have since expired.
            written = self.query_store.progress.update_one(
                {"_id": "archive", "owner": self.owner, "batch.id": batch["id"], "lease_until": {"$gt": utc_now()}},
                {"$set": {"batch.archived_at": batch["archived_at"]}},
            )
            if not written.matched_count:
                return 0
        updates: dict[str, Any] = {"archived": True, "archived_at": batch["archived_at"]}
        if self.retention_days:
            updates["expires_at"] = batch["archived_at"] + timedelta(days=self.retention_days)
        self.query_store.events.update_many({"_id": {"$in": batch["events"]}}, {"$set": updates})
        self.query_store.progress.update_one(
            {"_id": "archive", "owner": self.owner, "batch.id": batch["id"]},
            {"$unset": {"batch": ""}},
        )
        return len(batch["events"])

    async def run(self) -> None:
        while True:
            count = 0
            try:
                count = await asyncio.to_thread(self.flush_once)
                self.flushed_events += count
                if count:
                    self.last_flush_at = utc_now().isoformat()
                self.last_error = None
            except Exception:  # noqa: BLE001 - keep durable backlog for retry.
                self.failed_flushes += 1
                self.last_error = "Archival failed; durable events remain queued in MongoDB"
                logger.exception("Audit archive batch failed; will retry")
            # Yield between full batches; wait only when caught up or retrying.
            await asyncio.sleep(0 if count >= self.batch_size else self.interval)
