"""Opaque Claude state under the existing Engine lease and canonical database.

GridFS bytes and immutable manifests are not publication authority. The single
head in harness_sessions is updated atomically with the Engine's live producer
fence, after the complete archive has passed integrity checks. Nothing here
creates an execution journal, reclaims work or replays an accepted prompt.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from bson import ObjectId
from gridfs import GridFSBucket
from gridfs.errors import CorruptGridFile, NoFile
from pymongo import timeout
from pymongo.errors import PyMongoError

from harness_engine.coding.admission import CodingAdmissionError, RunFence
from harness_engine.coding.sandbox import SandboxAllocation, SandboxProfile
from harness_engine.coding.state_protocol import MAX_STATE_CHUNK, NativeStateExport

BUCKET = "harness_provider_state"
MANIFESTS = "harness_provider_checkpoints"


class ProviderStateError(RuntimeError):
    """Provider state could not be safely published or restored."""


class ProviderStateStore:
    def __init__(
        self,
        fence: RunFence,
        *,
        connection: str,
        profile: SandboxProfile,
        operator_profile: dict[str, Any] | None = None,
    ) -> None:
        self.fence, self.db = fence, fence.db
        self.connection = hashlib.sha256(connection.encode()).hexdigest()
        self.profile = profile
        self.operator_policy_hash = hashlib.sha256(
            json.dumps(operator_profile or {}, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        self.bucket = GridFSBucket(self.db, bucket_name=BUCKET)

    async def _io(self, operation: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            with timeout(30):
                return await asyncio.to_thread(operation, *args, **kwargs)
        except (PyMongoError, CorruptGridFile, NoFile):
            raise ProviderStateError("Provider state persistence or integrity verification failed") from None

    def _identity(self) -> dict[str, Any]:
        binding = self.fence.context.binding
        return {
            "binding_id": binding.binding_id,
            "owner_subject": binding.owner_subject,
            "agent_id": binding.agent_id,
            "conversation_id": binding.conversation_id,
            "profile": self.profile.model_dump(mode="json"),
            "connection": self.connection,
            "operator_policy_hash": self.operator_policy_hash,
        }

    async def head(self) -> dict[str, Any] | None:
        _, session = await self.fence.require(allow_cancelled=True)
        head = session.get("_provider_state_head")
        if head is None:
            if self.fence.context.binding.provider_session_id:
                raise ProviderStateError("The saved provider session has no canonical native state")
            return None
        if not isinstance(head, dict) or any(head.get(key) != value for key, value in self._identity().items()):
            raise ProviderStateError(
                "The provider connection or pinned profile changed; explicit migration is required"
            )
        saved_id = self.fence.context.binding.provider_session_id
        if saved_id and saved_id != head.get("provider_session_id"):
            raise ProviderStateError("The canonical provider session identity changed")
        return deepcopy(head)

    async def pin_new(self, allocation: SandboxAllocation, provider_session_id: str) -> dict[str, Any]:
        await self.fence.require()
        if not provider_session_id or len(provider_session_id) > 1024:
            raise ProviderStateError("The provider returned an invalid session identity")
        head = {
            **self._identity(),
            "generation": uuid4().hex,
            "phase": "initial_capture_pending",
            "allocation": allocation.model_dump(mode="json"),
            "provider_session_id": provider_session_id,
        }
        query = {**self.fence.query(), "_provider_state_head": {"$exists": False}}
        result = await self._io(self.db.harness_sessions.update_one, query, {"$set": {"_provider_state_head": head}})
        if result.modified_count != 1:
            raise CodingAdmissionError("The provider session no longer owns its initial state admission")
        return head

    async def manifest(self, head: dict[str, Any]) -> dict[str, Any]:
        if head.get("phase") != "ready" or not isinstance(head.get("checkpoint_id"), str):
            raise ProviderStateError("The provider's initial native state has not been acknowledged")
        manifest = await self._io(self.db[MANIFESTS].find_one, {"_id": head["checkpoint_id"], **self._identity()})
        if not manifest or manifest.get("provider_session_id") != head.get("provider_session_id"):
            raise ProviderStateError("The committed provider checkpoint is missing or changed")
        return manifest

    async def record_restore(self, head: dict[str, Any], allocation: SandboxAllocation) -> dict[str, Any]:
        """Persist one exact restore identity before any remote import effect."""
        await self.fence.require()
        restore = head.get("restore")
        if restore and restore.get("allocation") == allocation.model_dump(mode="json"):
            return head
        changed = {
            **head,
            "generation": uuid4().hex,
            "restore": {
                "id": str(uuid4()),
                "allocation": allocation.model_dump(mode="json"),
            },
        }
        await self._replace(head, changed)
        return changed

    async def restored(self, head: dict[str, Any], allocation: SandboxAllocation) -> dict[str, Any]:
        changed = {key: value for key, value in head.items() if key != "restore"}
        changed.update(generation=uuid4().hex, allocation=allocation.model_dump(mode="json"))
        await self._replace(head, changed)
        return changed

    async def _replace(self, previous: dict[str, Any], changed: dict[str, Any]) -> None:
        await self.fence.require(allow_cancelled=True)
        query = {**self.fence.query(), "_provider_state_head": previous}
        result = await self._io(self.db.harness_sessions.update_one, query, {"$set": {"_provider_state_head": changed}})
        if result.modified_count != 1:
            raise CodingAdmissionError("The provider state publication lost its Engine lease")

    async def capture(
        self,
        previous: dict[str, Any],
        allocation: SandboxAllocation,
        exported: NativeStateExport,
        *,
        outcome: str,
        artifacts: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        run, _ = await self.fence.require(allow_cancelled=True)
        header = exported.header
        if (
            header.get("provider_session_id") != previous["provider_session_id"]
            or header.get("profile_id") != self.profile.id
            or header.get("profile_revision") != self.profile.revision
            or header.get("harness") != "claude-code"
            or header.get("cwd") != allocation.cwd
        ):
            raise ProviderStateError("The provider archive changed its admitted identity")
        identifier = ObjectId()
        stream = await self._io(
            self.bucket.open_upload_stream_with_id,
            identifier,
            header["checkpoint_id"],
            metadata={
                **self._identity(),
                "run_id": self.fence.context.turn.run_id,
                "created_at": datetime.now(timezone.utc),
            },
        )
        published = False
        try:
            async for chunk in exported.chunks():
                await self.fence.require(allow_cancelled=True)
                await self._io(stream.write, chunk)
            if exported.complete is None:
                raise ProviderStateError("The native-state archive was not verified")
            await self._io(stream.close)
            manifest = {
                "_id": header["checkpoint_id"],
                **self._identity(),
                "provider_session_id": previous["provider_session_id"],
                "file_id": identifier,
                "header": header,
                "complete": exported.complete,
                "run_id": self.fence.context.turn.run_id,
                "journal_cursor": run["last_sequence"],
                "outcome": outcome,
                "artifacts": artifacts or {"files": [], "warnings": []},
                "created_at": datetime.now(timezone.utc),
            }
            await self._io(self.db[MANIFESTS].insert_one, manifest)
            changed = {
                **previous,
                "generation": uuid4().hex,
                "phase": "ready",
                "checkpoint_id": header["checkpoint_id"],
                "allocation": allocation.model_dump(mode="json"),
            }
            changed.pop("restore", None)
            await self._replace(previous, changed)
            published = True
            return changed
        finally:
            if not published:
                # A stale producer cannot publish; deleting its private upload
                # cannot affect the previous canonical head.
                try:
                    if not stream.closed:
                        await self._io(stream.abort)
                    else:
                        await self._io(self.bucket.delete, identifier)
                    await self._io(
                        self.db[MANIFESTS].delete_one, {"_id": header["checkpoint_id"], "file_id": identifier}
                    )
                except ProviderStateError:
                    pass  # Backup retains unreferenced bytes; never assume publication.

    async def chunks(self, manifest: dict[str, Any]) -> AsyncIterator[bytes]:
        await self.fence.require()
        source = await self._io(self.bucket.open_download_stream, manifest["file_id"])
        digest, size = hashlib.sha256(), 0
        try:
            while chunk := await self._io(source.read, MAX_STATE_CHUNK):
                await self.fence.require()
                size += len(chunk)
                if size > manifest["header"]["bytes"]:
                    raise ProviderStateError("The stored provider archive exceeds its declared size")
                digest.update(chunk)
                yield chunk
            if size != manifest["header"]["bytes"] or digest.hexdigest() != manifest["header"]["sha256"]:
                raise ProviderStateError("The stored provider archive failed integrity verification")
        finally:
            await self._io(source.close)
