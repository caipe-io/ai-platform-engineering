"""Opaque native harness state in the canonical MongoDB backup boundary.

The lease document is the sole publication authority. GridFS uploads and
manifests are invisible until one atomic update publishes their verified head
under the exact live execution lease. An interrupted upload never replaces the
previous checkpoint. Archives are provider-owned bytes, not transcript replay.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import AsyncIterable, AsyncIterator, Callable
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Literal
from uuid import UUID, uuid4

from bson import ObjectId
from gridfs import GridFSBucket
from gridfs.errors import CorruptGridFile, NoFile
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from pymongo import DESCENDING, ReturnDocument, timeout
from pymongo.errors import PyMongoError

from dynamic_agents.services.native_state_protocol import MAX_STATE_BYTES, MAX_STATE_CHUNK, MAX_STATE_MEMBERS
from dynamic_agents.services.sandbox_client import SandboxAllocation
from dynamic_agents.services.session_bindings import SessionBindingError, get_sandbox_binding
from dynamic_agents.services.session_runs import await_session_operation

if TYPE_CHECKING:
    from gridfs.grid_file import GridIn

    from dynamic_agents.services.mongo import MongoDBService

CHECKPOINTS_COLLECTION = "native_acp_checkpoints"
CHECKPOINT_CLEANUP_COLLECTION = "native_acp_checkpoint_cleanup"
CHECKPOINT_BUCKET = "native_acp_checkpoint_blobs"
MAX_CHECKPOINT_BYTES = MAX_STATE_BYTES
MAX_CHUNK_BYTES = MAX_STATE_CHUNK
MAX_CHECKPOINT_MEMBERS = MAX_STATE_MEMBERS
RETAINED_CHECKPOINTS = 3
MAX_PENDING_UPLOADS = 4
DOWNLOAD_CHUNK_BYTES = 64 * 1024
CHECKPOINT_DB_TIMEOUT_SECONDS = 30
ORPHAN_GRACE_SECONDS = CHECKPOINT_DB_TIMEOUT_SECONDS * 2
ORPHAN_SWEEP_SECONDS = 30
logger = logging.getLogger(__name__)


class CheckpointError(RuntimeError):
    """Native state could not be saved or restored without losing identity."""


class CheckpointFenceError(CheckpointError):
    """The uploader no longer owns this session's admitted generation."""


async def _checkpoint_operation[**P, T](operation: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    try:
        # CSOT also applies to GridFS's individual Mongo commands and carries
        # into to_thread. A suspended stale writer cannot issue another chunk
        # after this deadline, which bounds orphan cleanup's grace period.
        with timeout(CHECKPOINT_DB_TIMEOUT_SECONDS):
            return await await_session_operation(operation, *args, **kwargs)
    except (PyMongoError, CorruptGridFile, NoFile):
        # Driver errors can contain BSON command details. Native state is
        # protected data and must not be copied into exception/log text.
        raise CheckpointError("Native checkpoint persistence or integrity verification failed") from None


class CheckpointIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    agent_id: str = Field(min_length=1, max_length=256)
    session_id: str = Field(min_length=1, max_length=256)
    owner_subject: str = Field(min_length=1, max_length=1024, repr=False)
    profile_id: str = Field(min_length=1, max_length=256)
    profile_revision: str = Field(min_length=1, max_length=256)
    harness: str = Field(min_length=1, max_length=64)
    provider_session_id: str = Field(min_length=1, max_length=512)
    connection_version: str = Field(pattern=r"^[a-f0-9]{64}$")

    def digest(self) -> str:
        return hashlib.sha256(json.dumps(self.model_dump(), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class CheckpointMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    format: Literal["caipe.native-state.v1"] = "caipe.native-state.v1"
    archive: Literal["pax-tar"] = "pax-tar"
    cwd: str = Field(min_length=1, max_length=4096)
    source_allocation_uid: str = Field(min_length=1, max_length=512)
    run_id: str = Field(min_length=1, max_length=256)
    journal_cursor: int = Field(ge=0)
    runtime_versions: dict[str, str] = Field(min_length=1, max_length=16)
    capture_status: Literal["completed", "interrupted", "cancelled"] = "completed"
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    bytes: int = Field(gt=0, le=MAX_CHECKPOINT_BYTES)
    members: int = Field(ge=0, le=MAX_CHECKPOINT_MEMBERS)
    expanded_bytes: int = Field(ge=0, le=MAX_CHECKPOINT_BYTES)

    @field_validator("runtime_versions")
    @classmethod
    def bounded_versions(cls, value: dict[str, str]) -> dict[str, str]:
        if any(not key or not item or len(key) > 128 or len(item) > 1024 for key, item in value.items()):
            raise ValueError("Native checkpoint runtime versions are empty or exceed the supported bounds")
        return value


class CheckpointManifest(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    schema_version: Literal[1] = 1
    checkpoint_id: str
    blob_id: str = Field(pattern=r"^[a-f0-9]{24}$")
    generation: int = Field(ge=1)
    identity: CheckpointIdentity
    metadata: CheckpointMetadata
    created_at: datetime


def _now() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(microsecond=(now.microsecond // 1000) * 1000)


def _uuid(value: str) -> str:
    try:
        parsed = UUID(value)
    except (ValueError, TypeError, AttributeError):
        raise CheckpointError("The native checkpoint ID must be a UUID") from None
    if str(parsed) != value:
        raise CheckpointError("The native checkpoint ID must use canonical UUID notation")
    return value


def _base_metadata(value: dict[str, Any]) -> dict[str, Any]:
    """Validate the header before allocating any persistent upload state."""
    candidate = {**value, "sha256": "0" * 64, "bytes": 1, "members": 0, "expanded_bytes": 0}
    try:
        validated = CheckpointMetadata.model_validate(candidate)
    except ValidationError:
        raise CheckpointError("The native checkpoint header is invalid") from None
    return validated.model_dump(exclude={"sha256", "bytes", "members", "expanded_bytes"})


class CheckpointStore:
    """Bounded streaming storage using the existing database and session lease."""

    def __init__(self, mongo: MongoDBService) -> None:
        if mongo._db is None:
            raise CheckpointError("Native checkpoint persistence is unavailable")
        self.mongo = mongo
        self.db = mongo._db
        self.manifests = self.db[CHECKPOINTS_COLLECTION]
        self.cleanup_records = self.db[CHECKPOINT_CLEANUP_COLLECTION]
        self.runs = mongo.get_session_runs_collection()
        self.executions = self.db["native_acp_execution_runs"]
        self.bucket = GridFSBucket(self.db, bucket_name=CHECKPOINT_BUCKET)
        with timeout(CHECKPOINT_DB_TIMEOUT_SECONDS):
            self.manifests.create_index("checkpoint_id", unique=True, name="native_checkpoint_unique")
            self.manifests.create_index([("identity.agent_id", 1), ("identity.session_id", 1), ("generation", DESCENDING)],
                                        name="native_checkpoint_session")
            self.cleanup_records.create_index([("agent_id", 1), ("session_id", 1)], name="native_checkpoint_cleanup_session")
            self.manifests.create_index([("status", 1), ("gc_checked_at", 1)], name="native_checkpoint_orphan_scan")
            self.executions.create_index("checkpoint_before.checkpoint_id", sparse=True, name="native_checkpoint_turn_reference")

    def _key(self, identity: CheckpointIdentity) -> dict[str, str]:
        return {"agent_id": identity.agent_id, "session_id": identity.session_id}

    def _require_identity(self, identity: CheckpointIdentity, *, allow_deleted: bool = False) -> dict[str, Any]:
        if not allow_deleted and self.db["native_acp_deleted_sessions"].find_one({"_id": identity.session_id}, {"_id": 1}):
            raise CheckpointFenceError("This native execution context was permanently deleted")
        try:
            state = get_sandbox_binding(self.mongo, identity.agent_id, identity.session_id)
        except SessionBindingError:
            raise CheckpointFenceError("Native checkpoint session admission is unavailable") from None
        profile = state.get("profile", {}) if state else {}
        if (state is None or state.get("owner_subject") != identity.owner_subject
                or state.get("connection_version") != identity.connection_version
                or state.get("provider_session_id") != identity.provider_session_id
                or profile.get("id") != identity.profile_id or profile.get("revision") != identity.profile_revision
                or profile.get("harness") != identity.harness):
            raise CheckpointFenceError("The native checkpoint does not match the admitted session identity")
        return state

    def _lease_query(self, identity: CheckpointIdentity, lease_id: str, *, allow_cancelled: bool = False) -> dict[str, Any]:
        query: dict[str, Any] = {**self._key(identity), "lease_id": lease_id, "lease_expires_at": {"$gt": _now()}}
        if not allow_cancelled:
            query["cancel_requested"] = {"$ne": True}
        return query

    def _require_run(self, identity: CheckpointIdentity, lease_id: str, metadata: dict[str, Any]) -> None:
        # The archive is bound to a real admitted run and an already observable
        # journal cursor, never caller-selected history from another session.
        run = self.db["native_acp_execution_runs"].find_one({
            "run_id": metadata["run_id"], **self._key(identity), "owner_subject": identity.owner_subject,
            "lease_id": lease_id, "active": True,
        })
        if run is None or run.get("last_sequence", 0) < metadata["journal_cursor"]:
            raise CheckpointFenceError("The native checkpoint does not match its admitted run and journal cursor")

    async def open_writer(
        self, identity: CheckpointIdentity, *, checkpoint_id: str, lease_id: str, base_metadata: dict[str, Any],
    ) -> CheckpointWriter:
        checkpoint_id = _uuid(checkpoint_id)
        base = _base_metadata(base_metadata)
        return await _checkpoint_operation(self._open_writer, identity, checkpoint_id, lease_id, base)

    def _open_writer(
        self, identity: CheckpointIdentity, checkpoint_id: str, lease_id: str, base: dict[str, Any],
    ) -> CheckpointWriter:
        state = self._require_identity(identity)
        if self.runs.find_one({**self._key(identity), "checkpoint_restore": {"$exists": True}}, {"_id": 1}):
            raise CheckpointFenceError("Finish the admitted native-state restore before capturing another checkpoint")
        allocation = state.get("allocation") or {}
        if allocation.get("uid") != base["source_allocation_uid"] or allocation.get("cwd") != base["cwd"]:
            raise CheckpointFenceError("The native checkpoint source is outside its admitted allocation")
        self._require_run(identity, lease_id, base)
        self._sweep(identity.agent_id, identity.session_id)
        self._collect_abandoned_uploads(identity)
        # Do not grow history indefinitely if a previous post-publication
        # deletion failed. Retry retention before admitting another upload.
        self._retain(identity)
        if self.manifests.count_documents({"identity.agent_id": identity.agent_id, "identity.session_id": identity.session_id,
                                           "status": "uploading"}, limit=MAX_PENDING_UPLOADS) >= MAX_PENDING_UPLOADS:
            raise CheckpointError("The session has too many unfinished native checkpoint uploads")
        token = str(uuid4())
        blob_id = ObjectId()
        # Intent precedes GridFS writes, so every partial upload has an owned
        # cleanup coordinate even if the worker dies before closing the file.
        self.manifests.insert_one({"_id": checkpoint_id, "checkpoint_id": checkpoint_id, "schema_version": 1,
            "identity": identity.model_dump(), "blob_id": str(blob_id), "writer_token": token,
            "lease_id": lease_id, "status": "uploading", "base_metadata": base, "created_at": _now()})
        query = self._lease_query(identity, lease_id, allow_cancelled=base["capture_status"] != "completed")
        record = self.runs.find_one_and_update(query, {"$inc": {"checkpoint_generation": 1}, "$set": {
            "checkpoint_writer": {"checkpoint_id": checkpoint_id, "token": token, "identity_hash": identity.digest()},
        }}, return_document=ReturnDocument.AFTER)
        if record is None:
            self._discard(checkpoint_id, quiescent=True)
            raise CheckpointFenceError("The native checkpoint writer no longer owns the active session lease")
        generation = record["checkpoint_generation"]
        self.manifests.update_one({"_id": checkpoint_id, "writer_token": token}, {"$set": {"generation": generation}})
        stream = self.bucket.open_upload_stream_with_id(blob_id, checkpoint_id, chunk_size_bytes=DOWNLOAD_CHUNK_BYTES,
            metadata={"checkpoint_id": checkpoint_id, "agent_id": identity.agent_id, "session_id": identity.session_id})
        return CheckpointWriter(self, identity, checkpoint_id, lease_id, token, generation, base, stream)

    async def save_stream(
        self, identity: CheckpointIdentity, chunks: AsyncIterable[bytes], *, checkpoint_id: str, lease_id: str,
        base_metadata: dict[str, Any], metadata: dict[str, Any],
    ) -> CheckpointManifest:
        writer = await self.open_writer(identity, checkpoint_id=checkpoint_id, lease_id=lease_id, base_metadata=base_metadata)
        try:
            async for chunk in chunks:
                await writer.write(chunk)
            return await writer.commit(metadata)
        except BaseException:
            await writer.abort()
            raise

    def _read_manifest(self, identity: CheckpointIdentity, checkpoint_id: str) -> CheckpointManifest:
        record = self.manifests.find_one({"_id": checkpoint_id, "identity": identity.model_dump(), "status": "ready"})
        if record is None:
            raise CheckpointError("The committed native checkpoint manifest is unavailable")
        try:
            return CheckpointManifest.model_validate(record)
        except ValidationError:
            raise CheckpointError("The native checkpoint manifest is invalid") from None

    async def latest(self, identity: CheckpointIdentity) -> CheckpointManifest | None:
        return await _checkpoint_operation(self._latest, identity)

    def _latest(self, identity: CheckpointIdentity) -> CheckpointManifest | None:
        self._require_identity(identity)
        authority = self.runs.find_one(self._key(identity)) or {}
        head = authority.get("checkpoint_head")
        if head is None:
            return None
        if head.get("identity_hash") != identity.digest():
            raise CheckpointError("The native checkpoint head belongs to a different admitted identity")
        manifest = self._read_manifest(identity, head["checkpoint_id"])
        if manifest.generation != head.get("generation") or manifest.metadata.sha256 != head.get("sha256"):
            raise CheckpointError("The native checkpoint head failed manifest verification")
        return manifest

    async def download(self, identity: CheckpointIdentity, manifest: CheckpointManifest) -> AsyncIterator[bytes]:
        """Stream bounded binary data and verify its final size and digest.

        A provider must stage these bytes and verify completion before making
        them executable; a partially consumed download is not a restore grant.
        """
        checked = await _checkpoint_operation(self._download_open, identity, manifest)
        digest = hashlib.sha256()
        total = 0
        try:
            while True:
                chunk = await _checkpoint_operation(checked.read, DOWNLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > manifest.metadata.bytes or total > MAX_CHECKPOINT_BYTES:
                    raise CheckpointError("The native checkpoint exceeds its committed size")
                digest.update(chunk)
                yield chunk
        finally:
            await _checkpoint_operation(checked.close)
        if total != manifest.metadata.bytes or digest.hexdigest() != manifest.metadata.sha256:
            raise CheckpointError("The native checkpoint bytes failed integrity verification")

    def _download_open(self, identity: CheckpointIdentity, manifest: CheckpointManifest) -> Any:
        self._require_identity(identity)
        stored = self._read_manifest(identity, manifest.checkpoint_id)
        if stored != manifest:
            raise CheckpointError("The native checkpoint manifest changed before download")
        try:
            stream = self.bucket.open_download_stream(ObjectId(stored.blob_id))
        except NoFile:
            raise CheckpointError("The native checkpoint payload is unavailable") from None
        if stream.length != manifest.metadata.bytes:
            stream.close()
            raise CheckpointError("The native checkpoint payload has an invalid stored size")
        return stream

    def _discard(self, checkpoint_id: str, *, quiescent: bool = False) -> None:
        record = self.manifests.find_one({"_id": checkpoint_id})
        if record is None:
            return
        # The tombstone contains only deletion coordinates. Keep it while a
        # delayed chunk write could finish; it cannot authorize a restore.
        blob_id = ObjectId(record["blob_id"])
        self.cleanup_records.update_one({"_id": record["blob_id"]}, {"$setOnInsert": {
            "agent_id": record["identity"]["agent_id"], "session_id": record["identity"]["session_id"],
            "created_at": _now(), "retire_after": _now() + timedelta(seconds=ORPHAN_GRACE_SECONDS),
        }}, upsert=True)
        self.db[f"{CHECKPOINT_BUCKET}.files"].delete_one({"_id": blob_id})
        self.db[f"{CHECKPOINT_BUCKET}.chunks"].delete_many({"files_id": blob_id})
        self.manifests.delete_one({"_id": checkpoint_id})
        if quiescent or record.get("status") == "ready":
            # Ready archives have closed their upload stream. An explicitly
            # drained abort also cannot send another write after this point.
            self.cleanup_records.delete_one({"_id": str(blob_id)})

    def _sweep(self, agent_id: str, session_id: str) -> int:
        count = 0
        for record in self.cleanup_records.find({"agent_id": agent_id, "session_id": session_id}).limit(128):
            blob_id = ObjectId(record["_id"])
            self.db[f"{CHECKPOINT_BUCKET}.files"].delete_one({"_id": blob_id})
            count += self.db[f"{CHECKPOINT_BUCKET}.chunks"].delete_many({"files_id": blob_id}).deleted_count
            if record.get("retire_after") is not None and record["retire_after"] <= _now():
                self.cleanup_records.delete_one({"_id": record["_id"]})
        return count

    async def sweep_orphans(self, *, limit: int = 128) -> int:
        """Retry owned deletions, including late chunks after a deleted session.

        Minimal abandoned-upload coordinates cover bounded in-flight writes.
        They hold no archive bytes or restorable manifest and are retired after
        a final sweep beyond the database-operation grace period, or earlier
        when the owning writer confirms its drained abort.
        """
        if type(limit) is not int or not 1 <= limit <= 1024:
            raise ValueError("Native checkpoint sweep limit must be between 1 and 1024")
        return await _checkpoint_operation(self._sweep_orphans, limit)

    def _sweep_orphans(self, limit: int) -> int:
        count = self._sweep_abandoned_manifests(limit)
        records = self.cleanup_records.find().sort("last_swept_at", 1).limit(limit)
        for record in records:
            blob_id = ObjectId(record["_id"])
            count += self.db[f"{CHECKPOINT_BUCKET}.files"].delete_one({"_id": blob_id}).deleted_count
            count += self.db[f"{CHECKPOINT_BUCKET}.chunks"].delete_many({"files_id": blob_id}).deleted_count
            if record.get("retire_after") is not None and record["retire_after"] <= _now():
                self.cleanup_records.delete_one({"_id": record["_id"]})
            else:
                self.cleanup_records.update_one({"_id": record["_id"]}, {"$set": {"last_swept_at": _now()}})
        return count

    def _sweep_abandoned_manifests(self, limit: int) -> int:
        count = 0
        now = _now()
        records = self.manifests.find({"status": {"$in": ["uploading", "ready"]}}).sort("gc_checked_at", 1).limit(limit)
        for record in records:
            identity = record.get("identity", {})
            authority = self.runs.find_one({"agent_id": identity.get("agent_id"), "session_id": identity.get("session_id")}) or {}
            protected = set(authority.get("checkpoint_history", []))
            protected.update(item.get("checkpoint_id") for item in (
                authority.get("checkpoint_head", {}), authority.get("checkpoint_allocation", {}), authority.get("checkpoint_restore", {}),
            ))
            active_writer = (authority.get("checkpoint_writer", {}).get("checkpoint_id") == record["_id"]
                and authority.get("lease_id") == record.get("lease_id")
                and authority.get("checkpoint_generation") == record.get("generation")
                and authority.get("lease_expires_at", now) > now)
            safe_after = max(record["created_at"], record.get("publication_started_at", record["created_at"]))
            if (record["_id"] not in protected and not self._turn_reference(record["_id"]) and not active_writer
                    and safe_after + timedelta(seconds=ORPHAN_GRACE_SECONDS) <= now):
                self._discard(record["_id"])
                count += 1
            else:
                self.manifests.update_one({"_id": record["_id"]}, {"$set": {"gc_checked_at": now}})
        return count

    def _collect_abandoned_uploads(self, identity: CheckpointIdentity) -> None:
        authority = self.runs.find_one(self._key(identity)) or {}
        current_writer = authority.get("checkpoint_writer", {})
        for record in self.manifests.find({"identity.agent_id": identity.agent_id,
                "identity.session_id": identity.session_id, "status": "uploading"}).limit(MAX_PENDING_UPLOADS + 1):
            if (record.get("lease_id") != authority.get("lease_id")
                    or record.get("writer_token") != current_writer.get("token")
                    or record.get("generation") != authority.get("checkpoint_generation")):
                self._discard(record["_id"])

    def _retain(self, identity: CheckpointIdentity) -> None:
        authority = self.runs.find_one(self._key(identity)) or {}
        protected = {item.get("checkpoint_id") for item in (
            authority.get("checkpoint_head", {}), authority.get("checkpoint_allocation", {}),
            authority.get("checkpoint_writer", {}), authority.get("checkpoint_restore", {}),
        )}
        protected.update(authority.get("checkpoint_history", []))
        ready = list(self.manifests.find({"identity": identity.model_dump(), "status": "ready"}, {"_id": 1})
                     .sort("generation", DESCENDING))
        for item in ready:
            if item["_id"] not in protected and not self._turn_reference(item["_id"]):
                self._discard(item["_id"])

    def _turn_reference(self, checkpoint_id: str) -> bool:
        # User-visible edit history outlives the small crash-recovery window.
        # Keep its opaque states for the same lifecycle as canonical run history.
        return self.executions.find_one({"checkpoint_before.checkpoint_id": checkpoint_id}, {"_id": 1}) is not None

    async def record_turn(
        self, identity: CheckpointIdentity, *, run_id: str, message: str, lease_id: str,
        delegated_states: list[dict[str, Any]] | None = None,
    ) -> None:
        """Pin the actual native state before a prompt, without retaining its text.

        Run records hold immutable boundary references; the existing session
        authority alone selects the current branch. A crash between those writes
        leaves a conservative archive pin and cannot admit an unrecorded prompt.
        """
        await _checkpoint_operation(self._record_turn, identity, run_id, message, lease_id, delegated_states or [])

    def _record_turn(
        self, identity: CheckpointIdentity, run_id: str, message: str, lease_id: str, delegated_states: list[dict[str, Any]],
    ) -> None:
        state = self._require_identity(identity)
        authority = self.runs.find_one(self._lease_query(identity, lease_id))
        run = self.executions.find_one({"run_id": run_id, **self._key(identity),
            "owner_subject": identity.owner_subject, "lease_id": lease_id, "active": True})
        if authority is None or run is None:
            raise CheckpointFenceError("The native turn boundary requires its admitted run and live lease")
        if authority.get("checkpoint_restore") or authority.get("checkpoint_rewind"):
            raise CheckpointFenceError("Finish native-state recovery before admitting another prompt")
        if authority.get("checkpoint_turn_head") == run_id:
            return
        latest = self._latest(identity)
        if latest is None and (state.get("checkpoint_phase") != "initial_capture_pending"
                               or authority.get("checkpoint_turn_head") is not None):
            raise CheckpointError("The native session has no verified state before this prompt")
        boundary = {"checkpoint_id": latest.checkpoint_id if latest else None,
            "identity_hash": identity.digest(), "previous_run_id": authority.get("checkpoint_turn_head"),
            "message_sha256": hashlib.sha256(message.encode()).hexdigest(), "turn_id": run["turn_id"],
            "delegated_states": delegated_states}
        changed = self.executions.update_one({"run_id": run_id, "lease_id": lease_id, "active": True,
            "$or": [{"checkpoint_before": {"$exists": False}}, {"checkpoint_before": boundary}]},
            {"$set": {"checkpoint_before": boundary}})
        if not changed.matched_count:
            raise CheckpointFenceError("The native prompt already has a different state boundary")
        changed = self.runs.update_one({**self._lease_query(identity, lease_id),
            "checkpoint_turn_head": authority.get("checkpoint_turn_head")},
            {"$set": {"checkpoint_turn_head": run_id}, "$inc": {"checkpoint_generation": 1}})
        if not changed.matched_count:
            raise CheckpointFenceError("The native prompt lost its state boundary admission")

    async def rewind_boundary(
        self, identity: CheckpointIdentity, *, turn_id: str, message: str, occurrence: int, lease_id: str,
    ) -> dict[str, Any]:
        """Resolve a selected user message only within the active native branch."""
        return await _checkpoint_operation(self._rewind_boundary, identity, turn_id, message, occurrence, lease_id)

    def _rewind_boundary(
        self, identity: CheckpointIdentity, turn_id: str, message: str, occurrence: int, lease_id: str,
    ) -> dict[str, Any]:
        self._require_identity(identity)
        authority = self.runs.find_one(self._lease_query(identity, lease_id))
        if authority is None:
            raise CheckpointFenceError("Native rewind requires the active session lease")
        if authority.get("checkpoint_restore"):
            raise CheckpointError("Finish the pending native-state recovery before editing this conversation")
        run_id = authority.get("checkpoint_turn_head")
        seen: set[str] = set()
        matches = []
        digest = hashlib.sha256(message.encode()).hexdigest()
        while run_id is not None:
            if run_id in seen:
                raise CheckpointError("The native turn history contains an invalid branch")
            seen.add(run_id)
            run = self.executions.find_one({"run_id": run_id, **self._key(identity), "owner_subject": identity.owner_subject})
            boundary = run.get("checkpoint_before") if run else None
            if not isinstance(boundary, dict) or boundary.get("identity_hash") != identity.digest():
                raise CheckpointError("The selected message has no retained native-state boundary")
            selected = {**boundary, "run_id": run_id, "branch_head": authority.get("checkpoint_turn_head")}
            if boundary.get("turn_id") == turn_id:
                return selected
            if boundary.get("message_sha256") == digest:
                matches.append(selected)
            run_id = boundary.get("previous_run_id")
        if type(occurrence) is not int or occurrence < 1 or occurrence > len(matches):
            raise ValueError("Unable to match the selected message to native checkpoint history")
        return matches[-occurrence]

    async def begin_rewind(
        self, identity: CheckpointIdentity, *, boundary: dict[str, Any], lease_id: str,
        requested_turn_id: str, requested_occurrence: int,
    ) -> dict[str, Any]:
        """Fence prompts before any parent or child state mutation."""
        return await _checkpoint_operation(
            self._begin_rewind, identity, boundary, lease_id, requested_turn_id, requested_occurrence,
        )

    def _begin_rewind(
        self, identity: CheckpointIdentity, boundary: dict[str, Any], lease_id: str,
        requested_turn_id: str, requested_occurrence: int,
    ) -> dict[str, Any]:
        self._require_identity(identity)
        run = self.executions.find_one({"run_id": boundary["run_id"], **self._key(identity),
            "owner_subject": identity.owner_subject})
        expected = {key: value for key, value in boundary.items() if key not in {"run_id", "branch_head"}}
        if run is None or run.get("checkpoint_before") != expected or expected.get("identity_hash") != identity.digest():
            raise CheckpointFenceError("The selected native-state boundary changed")
        if boundary["checkpoint_id"] is not None:
            self._read_manifest(identity, boundary["checkpoint_id"])
        intent = {"rewind_id": str(uuid4()), "identity": identity.model_dump(), "boundary": boundary, "created_at": _now(),
            "requested_turn_id": requested_turn_id, "requested_occurrence": requested_occurrence}
        changed = self.runs.update_one({**self._lease_query(identity, lease_id),
            "checkpoint_turn_head": boundary["branch_head"], "checkpoint_restore": {"$exists": False},
            "checkpoint_rewind": {"$exists": False}},
            {"$set": {"checkpoint_rewind": intent},
                "$inc": {"checkpoint_generation": 1}, "$unset": {"checkpoint_writer": ""}})
        if not changed.matched_count:
            raise CheckpointFenceError("The selected native-state branch lost its admission")
        return intent

    async def pending_rewind(
        self, agent_id: str, session_id: str, *, owner_subject: str, lease_id: str,
    ) -> dict[str, Any] | None:
        def read() -> dict[str, Any] | None:
            authority = self.runs.find_one({"agent_id": agent_id, "session_id": session_id, "lease_id": lease_id,
                "lease_expires_at": {"$gt": _now()}, "cancel_requested": {"$ne": True}})
            if authority is None:
                raise CheckpointFenceError("Native rewind recovery requires the active session lease")
            intent = authority.get("checkpoint_rewind")
            if intent is None:
                return None
            try:
                identity = CheckpointIdentity.model_validate(intent["identity"])
                _uuid(intent["rewind_id"])
            except (KeyError, TypeError, ValidationError):
                raise CheckpointError("The pending native-state rewind is invalid") from None
            if (identity.agent_id, identity.session_id, identity.owner_subject) != (agent_id, session_id, owner_subject):
                raise CheckpointFenceError("The pending native-state rewind belongs to another caller")
            return intent
        return await _checkpoint_operation(read)

    async def completed_rewind(
        self, agent_id: str, session_id: str, *, owner_subject: str, lease_id: str,
        turn_id: str, message: str, occurrence: int,
    ) -> str | None:
        """Recover a lost final acknowledgement only before a new turn branches."""
        def read() -> str | None:
            authority = self.runs.find_one({"agent_id": agent_id, "session_id": session_id, "lease_id": lease_id,
                "lease_expires_at": {"$gt": _now()}, "cancel_requested": {"$ne": True}})
            if authority is None:
                raise CheckpointFenceError("Native rewind recovery requires the active session lease")
            receipt = authority.get("checkpoint_rewind_receipt") or {}
            if (receipt.get("owner_subject") == owner_subject and receipt.get("requested_turn_id") == turn_id
                    and receipt.get("requested_occurrence") == occurrence
                    and receipt.get("message_sha256") == hashlib.sha256(message.encode()).hexdigest()
                    and authority.get("checkpoint_turn_head") == receipt.get("branch_head")):
                return receipt["checkpoint_id"]
            return None
        return await _checkpoint_operation(read)

    async def finish_rewind(self, intent: dict[str, Any], *, lease_id: str) -> str:
        return await _checkpoint_operation(self._finish_rewind, intent, lease_id)

    def _finish_rewind(self, intent: dict[str, Any], lease_id: str) -> str:
        identity = CheckpointIdentity.model_validate(intent["identity"])
        boundary = intent["boundary"]
        result_id = boundary["checkpoint_id"] or boundary["run_id"]
        changes: dict[str, Any] = {"checkpoint_turn_head": boundary["previous_run_id"],
            "checkpoint_rewind_confirmation_required": True,
            "checkpoint_rewind_receipt": {"rewind_id": intent["rewind_id"], "checkpoint_id": result_id,
                "confirmed": False,
                "owner_subject": identity.owner_subject, "branch_head": boundary["previous_run_id"],
                "requested_turn_id": intent["requested_turn_id"], "requested_occurrence": intent["requested_occurrence"],
                "message_sha256": boundary["message_sha256"]}}
        if boundary["checkpoint_id"] is None:
            if get_sandbox_binding(self.mongo, identity.agent_id, identity.session_id) is not None:
                raise CheckpointError("Delete the first native environment before completing its rewind")
        else:
            self._require_identity(identity)
            manifest = self._read_manifest(identity, boundary["checkpoint_id"])
            changes.update(checkpoint_head={"checkpoint_id": manifest.checkpoint_id, "generation": manifest.generation,
                "sha256": manifest.metadata.sha256, "identity_hash": identity.digest()}, checkpoint_phase="rewind_pending")
        changed = self.runs.update_one({**self._lease_query(identity, lease_id), "checkpoint_rewind": intent},
            {"$set": changes, "$inc": {"checkpoint_generation": 1},
             "$unset": {"checkpoint_writer": "", "checkpoint_rewind": ""}})
        if not changed.matched_count:
            raise CheckpointFenceError("The native-state rewind lost its admitted session lease")
        return result_id

    async def confirm_rewind(
        self, agent_id: str, session_id: str, *, owner_subject: str, lease_id: str,
        checkpoint_id: str, turn_id: str, message: str, occurrence: int,
    ) -> None:
        """Release execution only after the canonical UI history edit succeeds."""
        def confirm() -> None:
            key = {"agent_id": agent_id, "session_id": session_id, "lease_id": lease_id,
                "lease_expires_at": {"$gt": _now()}, "cancel_requested": {"$ne": True},
                "checkpoint_rewind": {"$exists": False},
                "checkpoint_rewind_receipt.owner_subject": owner_subject,
                "checkpoint_rewind_receipt.checkpoint_id": checkpoint_id,
                "checkpoint_rewind_receipt.requested_turn_id": turn_id,
                "checkpoint_rewind_receipt.requested_occurrence": occurrence,
                "checkpoint_rewind_receipt.message_sha256": hashlib.sha256(message.encode()).hexdigest()}
            authority = self.runs.find_one(key)
            if authority is None:
                raise CheckpointFenceError("The native-state edit confirmation does not match its completed branch")
            if authority["checkpoint_rewind_receipt"].get("confirmed") is True:
                return
            if authority.get("checkpoint_turn_head") != authority["checkpoint_rewind_receipt"]["branch_head"]:
                raise CheckpointFenceError("The native-state edit confirmation does not match its completed branch")
            changed = self.runs.update_one({**key, "checkpoint_turn_head": authority.get("checkpoint_turn_head")},
                {"$unset": {"checkpoint_rewind_confirmation_required": ""},
                 "$set": {"checkpoint_rewind_receipt.confirmed": True}})
            if not changed.matched_count:
                raise CheckpointFenceError("The native-state edit confirmation lost its admitted session lease")
        await _checkpoint_operation(confirm)

    async def cleanup(
        self, agent_id: str, session_id: str, owner_subject: str, lease_id: str, *, preserve_rewind: bool = False,
    ) -> dict[str, int]:
        return await _checkpoint_operation(self._cleanup, agent_id, session_id, owner_subject, lease_id, preserve_rewind)

    def _cleanup(
        self, agent_id: str, session_id: str, owner_subject: str, lease_id: str, preserve_rewind: bool,
    ) -> dict[str, int]:
        state = get_sandbox_binding(self.mongo, agent_id, session_id)
        if not state or state.get("owner_subject") != owner_subject:
            raise CheckpointFenceError("Only the original sandbox owner can clear its native checkpoints")
        # Invalidate the writer before physical deletion. Old workers cannot
        # publish even if an already sent GridFS chunk finishes afterward.
        removed = {
                "checkpoint_head": "", "checkpoint_writer": "", "checkpoint_allocation": "",
                "checkpoint_restore": "", "checkpoint_history": "",
                "checkpoint_turn_head": "", "checkpoint_phase": "", "checkpoint_profile": "",
            }
        if not preserve_rewind:
            removed["checkpoint_rewind"] = ""
            removed["checkpoint_rewind_receipt"] = ""
            removed["checkpoint_rewind_confirmation_required"] = ""
        changed = self.runs.update_one({"agent_id": agent_id, "session_id": session_id, "lease_id": lease_id,
            "lease_expires_at": {"$gt": _now()}}, {"$inc": {"checkpoint_generation": 1}, "$unset": removed})
        if not changed.matched_count:
            raise CheckpointFenceError("Native checkpoint cleanup requires the active session lease")
        self.executions.update_many({"agent_id": agent_id, "session_id": session_id}, {"$unset": {"checkpoint_before": ""}})
        records = list(self.manifests.find({"identity.agent_id": agent_id, "identity.session_id": session_id}, {"_id": 1}))
        for record in records:
            self._discard(record["_id"])
        self._sweep(agent_id, session_id)
        return {"checkpoints_deleted": len(records)}

    async def restore_intent(self, identity: CheckpointIdentity) -> dict[str, Any] | None:
        return await _checkpoint_operation(self._restore_intent, identity)

    async def restore_intent_for_cleanup(self, identity: CheckpointIdentity, lease_id: str) -> dict[str, Any] | None:
        """Read deletion coordinates after the permanent fence, never restore bytes."""
        def read() -> dict[str, Any] | None:
            if self.runs.find_one(self._lease_query(identity, lease_id, allow_cancelled=True), {"_id": 1}) is None:
                raise CheckpointFenceError("Pending native-state cleanup requires the active session lease")
            return self._restore_intent(identity, allow_deleted=True)

        return await _checkpoint_operation(read)

    def _restore_intent(self, identity: CheckpointIdentity, *, allow_deleted: bool = False) -> dict[str, Any] | None:
        self._require_identity(identity, allow_deleted=allow_deleted)
        authority = self.runs.find_one(self._key(identity)) or {}
        intent = authority.get("checkpoint_restore")
        if intent is None:
            return None
        head = authority.get("checkpoint_head") or {}
        if (intent.get("identity_hash") != identity.digest() or intent.get("checkpoint_id") != head.get("checkpoint_id")
                or intent.get("sha256") != head.get("sha256") or not isinstance(intent.get("restore_id"), str)):
            raise CheckpointError("The pending native-state restore does not match the committed checkpoint")
        _uuid(intent["restore_id"])
        return intent

    async def begin_restore(
        self, identity: CheckpointIdentity, *, checkpoint_id: str, lease_id: str,
    ) -> dict[str, Any]:
        return await _checkpoint_operation(self._begin_restore, identity, checkpoint_id, lease_id)

    def _begin_restore(self, identity: CheckpointIdentity, checkpoint_id: str, lease_id: str) -> dict[str, Any]:
        latest = self._latest(identity)
        if latest is None or latest.checkpoint_id != checkpoint_id:
            raise CheckpointFenceError("Native-state restore requires the latest verified checkpoint")
        intent = self._restore_intent(identity) or {"restore_id": str(uuid4()), "checkpoint_id": checkpoint_id,
            "sha256": latest.metadata.sha256, "identity_hash": identity.digest(), "allocation": None, "created_at": _now()}
        result = self.runs.update_one({**self._lease_query(identity, lease_id), "checkpoint_head.checkpoint_id": checkpoint_id,
            "checkpoint_head.sha256": latest.metadata.sha256}, {"$set": {"checkpoint_restore": intent,
            "checkpoint_phase": "restoring"}, "$inc": {"checkpoint_generation": 1}, "$unset": {"checkpoint_writer": ""}})
        if not result.matched_count:
            raise CheckpointFenceError("Native-state restore no longer owns the checkpoint admission")
        return intent

    def _validate_allocation(self, identity: CheckpointIdentity, allocation: dict[str, Any], manifest: CheckpointManifest) -> dict[str, Any]:
        state = self._require_identity(identity)
        try:
            validated = SandboxAllocation.model_validate(allocation)
        except ValidationError:
            raise CheckpointError("The restored sandbox allocation is invalid") from None
        previous = state.get("allocation") or {}
        if (validated.conversation_id != previous.get("conversation_id") or validated.profile_id != identity.profile_id
                or validated.revision != identity.profile_revision or validated.cwd != manifest.metadata.cwd
                or validated.id != previous.get("id") or validated.namespace != previous.get("namespace")
                or not validated.uid):
            raise CheckpointFenceError("The restored allocation does not match the native checkpoint identity")
        return validated.model_dump()

    @staticmethod
    def _allocation_identity(allocation: dict[str, Any]) -> dict[str, Any]:
        return {key: allocation.get(key) for key in ("id", "uid", "namespace", "conversation_id", "profile_id", "revision", "cwd")}

    async def record_restore_allocation(
        self, identity: CheckpointIdentity, *, checkpoint_id: str, restore_id: str,
        allocation: dict[str, Any], lease_id: str,
    ) -> dict[str, Any]:
        return await _checkpoint_operation(self._record_restore_allocation, identity, checkpoint_id, restore_id, allocation, lease_id)

    def _record_restore_allocation(
        self, identity: CheckpointIdentity, checkpoint_id: str, restore_id: str, allocation: dict[str, Any], lease_id: str,
    ) -> dict[str, Any]:
        intent = self._restore_intent(identity)
        manifest = self._latest(identity)
        if intent is None or manifest is None or intent["restore_id"] != restore_id or intent["checkpoint_id"] != checkpoint_id:
            raise CheckpointFenceError("The native-state allocation has no matching restore intent")
        destination = self._validate_allocation(identity, allocation, manifest)
        if (intent.get("allocation") is not None
                and self._allocation_identity(intent["allocation"]) != self._allocation_identity(destination)):
            raise CheckpointFenceError("The pending native-state destination changed; explicit recovery is required")
        changed = self.runs.update_one({**self._lease_query(identity, lease_id),
            "checkpoint_head.checkpoint_id": checkpoint_id, "checkpoint_restore.restore_id": restore_id},
            {"$set": {"checkpoint_restore.allocation": destination}})
        if not changed.matched_count:
            raise CheckpointFenceError("The native-state restore no longer owns its pending allocation")
        return {**intent, "allocation": destination}

    async def replace_allocation(
        self, identity: CheckpointIdentity, *, checkpoint_id: str, restore_id: str, allocation: dict[str, Any], lease_id: str,
    ) -> dict[str, Any]:
        """Publish a verified provider restore without changing native identity.

        The caller first stages and verifies the full committed checkpoint at
        the provider. This method is its sole controlled allocation rebind.
        """
        return await _checkpoint_operation(self._replace_allocation, identity, checkpoint_id, restore_id, allocation, lease_id)

    def _replace_allocation(
        self, identity: CheckpointIdentity, checkpoint_id: str, restore_id: str, allocation: dict[str, Any], lease_id: str,
    ) -> dict[str, Any]:
        state = self._require_identity(identity)
        latest = self._latest(identity)
        if latest is None or latest.checkpoint_id != checkpoint_id:
            raise CheckpointFenceError("Allocation replacement requires the latest verified native checkpoint")
        destination = self._validate_allocation(identity, allocation, latest)
        intent = self._restore_intent(identity)
        if (intent is None or intent["restore_id"] != restore_id or intent["checkpoint_id"] != checkpoint_id
                or intent.get("allocation") is None
                or self._allocation_identity(intent["allocation"]) != self._allocation_identity(destination)):
            raise CheckpointFenceError("The verified restore does not match its admitted destination")
        result = self.runs.update_one({**self._lease_query(identity, lease_id), "checkpoint_head.checkpoint_id": checkpoint_id,
            "checkpoint_head.sha256": latest.metadata.sha256, "checkpoint_restore.restore_id": restore_id,
            "checkpoint_restore.allocation": intent["allocation"]}, {"$set": {"checkpoint_allocation": {
                "checkpoint_id": checkpoint_id, "identity_hash": identity.digest(), "allocation": destination,
                "owner_subject": identity.owner_subject,
            }, "checkpoint_phase": "active"}, "$unset": {"checkpoint_restore": ""}})
        if not result.matched_count:
            raise CheckpointFenceError("The restore no longer owns the checkpoint admission")
        return {**state, "allocation": destination, "checkpoint_phase": "active"}

    async def restage_restore_allocation(
        self, identity: CheckpointIdentity, *, checkpoint_id: str, restore_id: str,
        expected_allocation: dict[str, Any], new_allocation: dict[str, Any], lease_id: str,
    ) -> dict[str, Any]:
        """Replace a lost pending cache after an authenticated provider lookup.

        The caller must establish that the old destination is absent/replaced.
        Retain the immutable hydration's restore ID: its retained HOME journal
        may already contain that operation. Provider receipts remain UID-bound.
        """
        return await _checkpoint_operation(self._restage_restore_allocation, identity, checkpoint_id, restore_id,
                                           expected_allocation, new_allocation, lease_id)

    def _restage_restore_allocation(
        self, identity: CheckpointIdentity, checkpoint_id: str, restore_id: str,
        expected_allocation: dict[str, Any], new_allocation: dict[str, Any], lease_id: str,
    ) -> dict[str, Any]:
        intent = self._restore_intent(identity)
        latest = self._latest(identity)
        if (intent is None or latest is None or latest.checkpoint_id != checkpoint_id
                or intent["restore_id"] != restore_id or intent.get("allocation") != expected_allocation):
            raise CheckpointFenceError("The pending native-state destination changed before recovery")
        destination = self._validate_allocation(identity, new_allocation, latest)
        if destination["uid"] == expected_allocation.get("uid"):
            raise CheckpointFenceError("Pending cache replacement requires a different allocation UID")
        result = self.runs.update_one({**self._lease_query(identity, lease_id),
            "checkpoint_head.checkpoint_id": checkpoint_id, "checkpoint_head.sha256": latest.metadata.sha256,
            "checkpoint_restore.restore_id": restore_id, "checkpoint_restore.allocation": expected_allocation},
            {"$set": {"checkpoint_restore.allocation": destination}, "$inc": {"checkpoint_generation": 1}})
        if not result.matched_count:
            raise CheckpointFenceError("The native-state destination replacement lost its admission")
        return {**intent, "allocation": destination}


class CheckpointWriter:
    """One sequential bounded upload; publication is always an explicit commit."""

    def __init__(
        self, store: CheckpointStore, identity: CheckpointIdentity, checkpoint_id: str, lease_id: str,
        token: str, generation: int, base: dict[str, Any], stream: GridIn,
    ) -> None:
        self.store, self.identity, self.checkpoint_id, self.lease_id = store, identity, checkpoint_id, lease_id
        self.token, self.generation, self.base, self.stream = token, generation, base, stream
        self.digest = hashlib.sha256()
        self.total = 0
        self.closed = False
        self.publication_attempted = False
        self.lock = asyncio.Lock()

    def _query(self) -> dict[str, Any]:
        return {**self.store._lease_query(self.identity, self.lease_id,
                    allow_cancelled=self.base["capture_status"] != "completed"),
                "checkpoint_generation": self.generation, "checkpoint_writer.token": self.token,
                "checkpoint_writer.checkpoint_id": self.checkpoint_id}

    def _require_fence(self) -> None:
        if self.closed or self.store.runs.find_one(self._query(), {"_id": 1}) is None:
            raise CheckpointFenceError("The native checkpoint writer lost its active admission")

    async def write(self, chunk: bytes) -> None:
        if not isinstance(chunk, bytes) or not chunk or len(chunk) > MAX_CHUNK_BYTES:
            raise CheckpointError("A native checkpoint chunk is empty or exceeds the supported bound")
        async with self.lock:
            if self.total + len(chunk) > MAX_CHECKPOINT_BYTES:
                raise CheckpointError("The native checkpoint exceeds the supported archive size")
            await _checkpoint_operation(self._write, chunk)

    def _write(self, chunk: bytes) -> None:
        self._require_fence()
        self.stream.write(chunk)
        self._require_fence()
        self.digest.update(chunk)
        self.total += len(chunk)

    async def commit(self, metadata: dict[str, Any]) -> CheckpointManifest:
        async with self.lock:
            try:
                return await _checkpoint_operation(self._commit, metadata)
            except BaseException:
                if self.publication_attempted:
                    # A lost write acknowledgement may still have published the
                    # head. Retain its already verified payload; GC reconciles
                    # unreferenced ready uploads after the bounded write window.
                    self.closed = True
                else:
                    await _checkpoint_operation(self._abort)
                raise

    def _commit(self, metadata: dict[str, Any]) -> CheckpointManifest:
        self._require_fence()
        try:
            final = CheckpointMetadata.model_validate({**self.base, **metadata})
        except ValidationError:
            raise CheckpointError("The native checkpoint completion metadata is invalid") from None
        if (final.model_dump(exclude={"sha256", "bytes", "members", "expanded_bytes"}) != self.base
                or final.bytes != self.total or final.sha256 != self.digest.hexdigest()):
            raise CheckpointError("The native checkpoint completion does not match its streamed bytes or header")
        self.store._require_identity(self.identity)
        self.store._require_run(self.identity, self.lease_id, self.base)
        self.stream.close()
        # Verify persisted bytes rather than trusting only the upload stream's
        # local hash. The provider independently verifies again before restore.
        stored_hash = hashlib.sha256()
        stored_bytes = 0
        with self.store.bucket.open_download_stream(self.stream._id) as reader:
            while chunk := reader.read(DOWNLOAD_CHUNK_BYTES):
                stored_bytes += len(chunk)
                if stored_bytes > final.bytes:
                    raise CheckpointError("The stored native checkpoint exceeds its completion size")
                stored_hash.update(chunk)
        if stored_bytes != final.bytes or stored_hash.hexdigest() != final.sha256:
            raise CheckpointError("The stored native checkpoint failed integrity verification")
        manifest = CheckpointManifest(checkpoint_id=self.checkpoint_id, blob_id=str(self.stream._id),
            generation=self.generation, identity=self.identity, metadata=final, created_at=_now())
        changed = self.store.manifests.update_one({"_id": self.checkpoint_id, "writer_token": self.token,
            "status": "uploading"}, {"$set": {**manifest.model_dump(), "status": "ready", "publication_started_at": _now()},
                                      "$unset": {"base_metadata": ""}})
        if not changed.matched_count:
            raise CheckpointFenceError("The native checkpoint upload was removed before publication")
        authority = self.store.runs.find_one(self._query())
        if authority is None:
            raise CheckpointFenceError("The native checkpoint writer lost admission before publication")
        history = [self.checkpoint_id, *authority.get("checkpoint_history", [])]
        previous_head = authority.get("checkpoint_head", {}).get("checkpoint_id")
        if previous_head is not None:
            history.append(previous_head)
        history = list(dict.fromkeys(history))[:RETAINED_CHECKPOINTS]
        self.publication_attempted = True
        result = self.store.runs.update_one(self._query(), {"$set": {"checkpoint_head": {
            "checkpoint_id": self.checkpoint_id, "generation": self.generation,
            "sha256": final.sha256, "identity_hash": self.identity.digest(),
        }, "checkpoint_phase": "active", "checkpoint_history": history}, "$unset": {"checkpoint_writer": ""}})
        if not result.matched_count:
            raise CheckpointFenceError("The native checkpoint writer lost admission before publication")
        self.closed = True
        # Retention cannot change publication outcome. A failed sweep is safely
        # retried on the next save/clear, while the verified head remains usable.
        try:
            self.store._retain(self.identity)
        except PyMongoError:
            logger.exception("Native checkpoint retention cleanup failed for agent %s", self.identity.agent_id)
        return manifest

    async def abort(self) -> None:
        async with self.lock:
            await _checkpoint_operation(self._abort)

    def _abort(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            if not self.stream.closed:
                self.stream.abort()
        finally:
            self.store._discard(self.checkpoint_id, quiescent=True)
            # Clear may already have removed the manifest while this writer
            # was finishing a chunk. Its own drained abort retires the minimal
            # orphan coordinate after deleting any such late chunk.
            self.store.db[f"{CHECKPOINT_BUCKET}.files"].delete_one({"_id": self.stream._id})
            self.store.db[f"{CHECKPOINT_BUCKET}.chunks"].delete_many({"files_id": self.stream._id})
            self.store.cleanup_records.delete_one({"_id": str(self.stream._id)})
            self.store.runs.update_one(self._query(), {"$unset": {"checkpoint_writer": ""}})


async def checkpoint_orphan_sweeper(mongo: MongoDBService) -> None:
    """Run from application lifespan; cleanup does not require session reuse."""
    store: CheckpointStore | None = None
    while True:
        try:
            if store is None:
                store = await _checkpoint_operation(CheckpointStore, mongo)
            await store.sweep_orphans()
        except CheckpointError:
            logger.exception("Native checkpoint orphan sweep failed")
        await asyncio.sleep(ORPHAN_SWEEP_SECONDS)
