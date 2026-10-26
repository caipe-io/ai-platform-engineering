"""Mongo-backed Claude Agent SDK transcript mirroring.

Claude session IDs are not sufficient to resume a conversation on another
process: the SDK also needs the JSONL transcript that belongs to the session.
This store implements the SDK's ``SessionStore`` protocol and keeps that
provider-owned transcript next to the CAIPE session binding in MongoDB.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol, TypeVar

from bson import ObjectId
from claude_agent_sdk import SessionKey, SessionStoreEntry
from pymongo import ASCENDING, InsertOne, MongoClient
from pymongo.errors import BulkWriteError

from harness_engine.models import RunContext, SessionBinding
from harness_engine.repository import RunFencedError

T = TypeVar("T")


class ScopedClaudeTranscriptStore(Protocol):
    """A single admitted producer's SDK transcript view."""

    async def ready(self) -> None: ...

    async def append(self, key: SessionKey, entries: list[SessionStoreEntry]) -> None: ...

    async def load(self, key: SessionKey) -> list[SessionStoreEntry] | None: ...

    async def close(self) -> None: ...


class ClaudeTranscriptStore(Protocol):
    def for_run(self, context: RunContext) -> ScopedClaudeTranscriptStore: ...

    async def purge_for_binding(self, binding: SessionBinding) -> None: ...


class MongoClaudeSessionStore:
    """Mirror transcripts without exposing an unbound SDK store.

    Ownership tags live outside ``entry_json``; SDK transcript objects retain
    their original format. All SDK access uses a run-scoped view, including
    partial transcripts written before the provider reports its session ID.
    """

    def __init__(
        self,
        mongodb_uri: str,
        database: str,
        collection: str = "claude_session_transcripts",
    ) -> None:
        self._client: MongoClient[dict[str, Any]] = MongoClient(mongodb_uri)
        self._db = self._client[database]
        self._collection = self._db[collection]
        self._indexes_ready = False
        self._index_lock = asyncio.Lock()

    async def _ensure_indexes(self) -> None:
        if self._indexes_ready:
            return
        async with self._index_lock:
            if self._indexes_ready:
                return
            await asyncio.to_thread(self._ensure_indexes_sync)
            self._indexes_ready = True

    def _ensure_indexes_sync(self) -> None:
        self._collection.create_index(
            [
                ("project_key", ASCENDING),
                ("session_id", ASCENDING),
                ("subpath", ASCENDING),
                ("entry_uuid", ASCENDING),
            ],
            name="claude_session_entry_uuid",
            unique=True,
            partialFilterExpression={"entry_uuid": {"$type": "string"}},
        )
        self._collection.create_index(
            [
                ("project_key", ASCENDING),
                ("session_id", ASCENDING),
                ("subpath", ASCENDING),
                ("stored_at", ASCENDING),
                ("batch_id", ASCENDING),
                ("position", ASCENDING),
            ],
            name="claude_session_load_order",
        )
        self._collection.create_index(
            [("binding_id", ASCENDING), ("run_id", ASCENDING)],
            name="claude_binding_cleanup",
        )
        self._collection.create_index(
            [("session_id", ASCENDING), ("binding_id", ASCENDING)],
            name="claude_legacy_session_cleanup",
        )

    def for_run(self, context: RunContext) -> MongoScopedClaudeSessionStore:
        if not context.producer_token:
            raise RunFencedError("A transcript writer requires an admitted producer")
        return MongoScopedClaudeSessionStore(self, context)

    async def purge_for_binding(self, binding: SessionBinding) -> None:
        """Delete bounded binding rows, including unfinished provider sessions.

        The coordinator closes admission and acknowledges producer shutdown
        before invoking this hook. Ambiguous legacy rows are never adopted or
        deleted through another binding's provider ID.
        """
        await self._ensure_indexes()
        await asyncio.to_thread(self._purge_for_binding_sync, binding)

    def _purge_for_binding_sync(self, binding: SessionBinding) -> None:
        current = self._db.harness_sessions.find_one(
            {
                "binding_id": binding.binding_id,
                "owner_subject": binding.owner_subject,
                "agent_id": binding.agent_id,
                "conversation_id": binding.conversation_id,
                "status": "closed",
            }
        )
        if current is None:
            raise RunFencedError("Transcript deletion requires a closed canonical binding")
        self._collection.delete_many({"binding_id": binding.binding_id})
        if not binding.provider_session_id:
            return
        legacy = {"session_id": binding.provider_session_id, "binding_id": {"$exists": False}}
        if self._collection.find_one(legacy, {"_id": 1}) is None:
            return
        collision = self._db.harness_sessions.find_one(
            {
                "harness_id": "claude_agent_sdk",
                "provider_session_id": binding.provider_session_id,
                "binding_id": {"$ne": binding.binding_id},
            },
            {"_id": 1},
        )
        if collision:
            raise RunFencedError("Legacy transcript ownership is ambiguous; deletion needs reconciliation")
        self._collection.delete_many(legacy)


class MongoScopedClaudeSessionStore:
    """Fence a transcript writer to its immutable binding and producer token."""

    def __init__(self, store: MongoClaudeSessionStore, context: RunContext) -> None:
        self._store = store
        self._binding = context.binding
        self._run_id = context.turn.run_id
        self._producer_token = context.producer_token
        self._closed = False
        self._pending: set[asyncio.Task[Any]] = set()

    def _assert_active_sync(self) -> None:
        now = datetime.now(UTC)
        binding = self._binding
        if self._store._db.harness_deleted_contexts.find_one({"_id": binding.conversation_id}, {"_id": 1}):
            raise RunFencedError("The transcript binding is no longer admitted")
        if (
            self._store._db.harness_sessions.find_one(
                {
                    "binding_id": binding.binding_id,
                    "owner_subject": binding.owner_subject,
                    "agent_id": binding.agent_id,
                    "conversation_id": binding.conversation_id,
                    "status": "active",
                    "_active_run_id": self._run_id,
                    "_producer_id": self._producer_token,
                    "_lease_expires_at": {"$gt": now},
                },
                {"_id": 1},
            )
            is None
            or self._store._db.harness_runs.find_one(
                {
                    "run_id": self._run_id,
                    "binding_id": binding.binding_id,
                    "owner_subject": binding.owner_subject,
                    "agent_id": binding.agent_id,
                    "conversation_id": binding.conversation_id,
                    "_owner_token": self._producer_token,
                    "_producer_id": self._producer_token,
                    # Pending cancellation drains the admitted provider. Its
                    # transcript must remain resumable until cleanup finishes;
                    # closed bindings, tombstones and stop ack still fence it.
                    "status": {"$in": ["queued", "running"]},
                    "_producer_stopped": {"$ne": True},
                },
                {"_id": 1},
            )
            is None
        ):
            raise RunFencedError("The transcript producer no longer owns its canonical run")

    async def _operation(self, operation: Callable[[], T]) -> T:
        if self._closed:
            raise RunFencedError("The transcript writer is closed")
        task = asyncio.create_task(asyncio.to_thread(operation))
        self._pending.add(task)

        def finished(completed: asyncio.Task[Any]) -> None:
            self._pending.discard(completed)
            # The SDK can cancel its await after a mirror timeout. Retain the
            # thread until completion and consume its exception in that case.
            if not completed.cancelled():
                completed.exception()

        task.add_done_callback(finished)
        return await asyncio.shield(task)

    async def ready(self) -> None:
        await self._store._ensure_indexes()
        await self._operation(self._assert_active_sync)

    async def close(self) -> None:
        """Stop new callbacks and drain threads before producer shutdown ack."""
        self._closed = True
        cancelled = False
        while self._pending:
            drain = asyncio.gather(*self._pending, return_exceptions=True)
            while not drain.done():
                try:
                    await asyncio.shield(drain)
                except asyncio.CancelledError:
                    cancelled = True
        if cancelled:
            raise asyncio.CancelledError

    def _assert_key_sync(self, key: SessionKey) -> None:
        self._assert_active_sync()
        identity = {"project_key": key["project_key"], "session_id": key["session_id"]}
        if self._store._collection.find_one(
            {**identity, "binding_id": {"$exists": True, "$ne": self._binding.binding_id}}, {"_id": 1}
        ) or self._store._db.harness_sessions.find_one(
            {
                "harness_id": "claude_agent_sdk",
                "provider_session_id": key["session_id"],
                "binding_id": {"$ne": self._binding.binding_id},
            },
            {"_id": 1},
        ):
            raise RunFencedError("Another binding owns this transcript key; session migration requires reconciliation")
        legacy = {**identity, "binding_id": {"$exists": False}}
        if self._store._collection.find_one(legacy, {"_id": 1}):
            # Old mirrors have no CAIPE tags. Only the exact, uniquely bound
            # canonical provider session can establish their ownership, and
            # no unresolved older writer may still be appending to that key.
            if self._binding.provider_session_id != key["session_id"] or self._store._db.harness_runs.find_one(
                {
                    "binding_id": self._binding.binding_id,
                    "run_id": {"$ne": self._run_id},
                    "$or": [
                        {"status": {"$in": ["queued", "running"]}},
                        {"_producer_id": {"$exists": True, "$ne": None}, "_producer_stopped": {"$ne": True}},
                    ],
                },
                {"_id": 1},
            ):
                raise RunFencedError("Legacy transcript ownership requires reconciliation before resume")
            self._store._collection.update_many(
                legacy, {"$set": {"binding_id": self._binding.binding_id, "legacy_adopted": True}}
            )
            self._assert_active_sync()

    async def append(self, key: SessionKey, entries: list[SessionStoreEntry]) -> None:
        if entries:
            await self._operation(lambda: self._append_sync(key, entries))

    def _append_sync(self, key: SessionKey, entries: list[SessionStoreEntry]) -> None:
        self._assert_key_sync(key)
        stored_at = datetime.now(UTC)
        batch_id = ObjectId()
        writes = []
        for position, entry in enumerate(entries):
            document: dict[str, Any] = {
                "binding_id": self._binding.binding_id,
                "run_id": self._run_id,
                "project_key": key["project_key"],
                "session_id": key["session_id"],
                "subpath": key.get("subpath"),
                "entry_json": json.dumps(entry, separators=(",", ":"), ensure_ascii=False),
                "stored_at": stored_at,
                "batch_id": batch_id,
                "position": position,
            }
            entry_uuid = entry.get("uuid")
            if isinstance(entry_uuid, str) and entry_uuid:
                document["entry_uuid"] = entry_uuid
            writes.append(InsertOne(document))
        try:
            self._store._collection.bulk_write(writes, ordered=False)
        except BulkWriteError as exc:
            if not exc.details:
                raise
            write_errors = exc.details.get("writeErrors", [])
            if exc.details.get("writeConcernErrors") or any(error.get("code") != 11000 for error in write_errors):
                raise
        finally:
            # If admission closed during the blocking write, remove this
            # run's partial mirror before its producer can acknowledge stop.
            try:
                self._assert_active_sync()
            except RunFencedError:
                self._store._collection.delete_many({"binding_id": self._binding.binding_id, "run_id": self._run_id})
                raise

    async def load(self, key: SessionKey) -> list[SessionStoreEntry] | None:
        """Load the full transcript in stable append order for SDK resume."""

        return await self._operation(lambda: self._load_sync(key))

    def _load_sync(self, key: SessionKey) -> list[SessionStoreEntry] | None:
        self._assert_key_sync(key)
        if key["session_id"] != self._binding.provider_session_id:
            raise RunFencedError("Resume must use the canonical binding's provider session")
        query = {
            "binding_id": self._binding.binding_id,
            "project_key": key["project_key"],
            "session_id": key["session_id"],
            "subpath": key.get("subpath"),
        }
        documents = list(
            self._store._collection.find(query, {"entry_json": 1}).sort(
                [("stored_at", ASCENDING), ("batch_id", ASCENDING), ("position", ASCENDING)]
            )
        )
        self._assert_active_sync()
        if not documents and not key.get("subpath"):
            # Returning None lets the SDK fall back to an unrelated local
            # transcript. An admitted resume needs its owned mirror.
            raise RunFencedError("The owned transcript is unavailable; clear the session before another turn")
        return [json.loads(document["entry_json"]) for document in documents]

    async def list_subkeys(self, key: SessionKey) -> list[str]:
        def read() -> list[str]:
            self._assert_key_sync(key)
            if key["session_id"] != self._binding.provider_session_id:
                raise RunFencedError("Resume must use the canonical binding's provider session")
            documents = self._store._collection.find(
                {
                    "binding_id": self._binding.binding_id,
                    "project_key": key["project_key"],
                    "session_id": key["session_id"],
                    "subpath": {"$type": "string"},
                },
                {"subpath": 1},
            )
            result = sorted({document["subpath"] for document in documents})
            self._assert_active_sync()
            return result

        return await self._operation(read)
