"""Mongo-backed Claude Agent SDK transcript mirroring.

Claude session IDs are not sufficient to resume a conversation on another
process: the SDK also needs the JSONL transcript that belongs to the session.
This store implements the SDK's ``SessionStore`` protocol and keeps that
provider-owned transcript next to the CAIPE session binding in MongoDB.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from claude_agent_sdk import SessionKey, SessionStoreEntry
from pymongo import ASCENDING, InsertOne, MongoClient
from pymongo.errors import BulkWriteError


class MongoClaudeSessionStore:
    """Mirror Claude SDK transcripts into a replica-safe Mongo collection."""

    def __init__(
        self,
        mongodb_uri: str,
        database: str,
        collection: str = "claude_session_transcripts",
    ) -> None:
        self._client: MongoClient[dict[str, Any]] = MongoClient(mongodb_uri)
        self._collection = self._client[database][collection]
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

    async def append(self, key: SessionKey, entries: list[SessionStoreEntry]) -> None:
        """Append a batch while deduplicating SDK entries with stable UUIDs."""

        if not entries:
            return
        await self._ensure_indexes()
        await asyncio.to_thread(self._append_sync, key, entries)

    def _append_sync(self, key: SessionKey, entries: list[SessionStoreEntry]) -> None:
        stored_at = datetime.now(UTC)
        batch_id = ObjectId()
        writes = []
        for position, entry in enumerate(entries):
            document: dict[str, Any] = {
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
            self._collection.bulk_write(writes, ordered=False)
        except BulkWriteError as exc:
            if not exc.details:
                raise
            write_errors = exc.details.get("writeErrors", [])
            if exc.details.get("writeConcernErrors") or any(
                error.get("code") != 11000 for error in write_errors
            ):
                raise

    async def load(self, key: SessionKey) -> list[SessionStoreEntry] | None:
        """Load the full transcript in stable append order for SDK resume."""

        await self._ensure_indexes()
        return await asyncio.to_thread(self._load_sync, key)

    def _load_sync(self, key: SessionKey) -> list[SessionStoreEntry] | None:
        query = {
            "project_key": key["project_key"],
            "session_id": key["session_id"],
            "subpath": key.get("subpath"),
        }
        documents = list(
            self._collection.find(query, {"entry_json": 1}).sort(
                [("stored_at", ASCENDING), ("batch_id", ASCENDING), ("position", ASCENDING)]
            )
        )
        if not documents:
            return None
        return [json.loads(document["entry_json"]) for document in documents]
