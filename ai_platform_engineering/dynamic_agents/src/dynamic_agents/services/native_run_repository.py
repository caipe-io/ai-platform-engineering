"""Canonical native runs and immutable, cursor-addressed stream events.

The durable task/event lifecycle adapts the Harness Engine repository pattern
to the existing native session authority. No caller credentials or turn input
are stored here. Events are inserted before their cursor becomes observable;
tail reconciliation repairs a worker crash between those two writes without
requiring MongoDB transactions or replaying a tool operation.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field
from pymongo import ASCENDING, DESCENDING
from pymongo.errors import DuplicateKeyError, PyMongoError

from dynamic_agents.services.session_runs import await_session_operation

if TYPE_CHECKING:
    from pymongo.collection import Collection

    from dynamic_agents.services.mongo import MongoDBService

EXECUTION_RUNS_COLLECTION = "native_acp_execution_runs"
EXECUTION_EVENTS_COLLECTION = "native_acp_execution_events"
DELETED_SESSIONS_COLLECTION = "native_acp_deleted_sessions"
MAX_FRAME_BYTES = 8 * 1024 * 1024
MAX_RUN_BYTES = 64 * 1024 * 1024
MAX_RUN_FRAMES = 100_000
STARTUP_TIMEOUT_SECONDS = 30
REPLAY_PAGE_SIZE = 100

RunStatus = Literal["queued", "running", "awaiting_input", "completed", "failed", "cancelled", "interrupted"]
TERMINAL_STATUSES = frozenset({"awaiting_input", "completed", "failed", "cancelled", "interrupted"})


class NativeRunBusyError(RuntimeError):
    """The session already has a reserved or executing request."""


class NativeRunConflictError(RuntimeError):
    """A retry reused its request identity with different validated input."""


class NativeReplayUnavailableError(RuntimeError):
    """The requested cursor cannot be replayed without silently losing events."""


class NativeRunStorageError(RuntimeError):
    """A run cannot be persisted or exceeds the explicit stream limits."""


class NativeRunLimitError(NativeRunStorageError):
    """The producer exceeded an explicit, bounded stream storage limit."""


class NativeExecutionRun(BaseModel):
    model_config = ConfigDict(extra="ignore")

    run_id: str
    agent_id: str
    session_id: str
    owner_subject: str = Field(repr=False)
    turn_id: str
    fingerprint: str = Field(repr=False)
    protocol: str
    active: bool = True
    current_turn_id: str | None = None
    first_sequence: int = 0
    result: dict | None = Field(default=None, repr=False)
    status: RunStatus = "queued"
    last_sequence: int = 0
    total_bytes: int = 0
    frame_count: int = 0
    lease_id: str | None = Field(default=None, repr=False)
    created_at: datetime
    started_at: datetime | None = None
    updated_at: datetime
    cancel_requested: bool = False
    finishing: bool = False
    retired: bool = False
    failure_code: str | None = None

    def public(self) -> dict[str, object]:
        """Return lifecycle metadata, excluding execution authority and ownership."""
        result = self.model_dump(mode="json", exclude={
            "owner_subject", "fingerprint", "lease_id", "total_bytes", "frame_count", "cancel_requested", "finishing", "retired",
            "active", "current_turn_id",
            "result",
        })
        result["turn_id"] = self.current_turn_id or self.turn_id
        return result


class NativeRunEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    run_id: str
    sequence: int
    frame: str | None = None
    status: RunStatus | None = None
    failure_code: str | None = None
    continue_execution: bool = False
    created_at: datetime


class NativeReplayPage(BaseModel):
    run: NativeExecutionRun
    events: list[NativeRunEvent]
    next_cursor: int


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


async def _repository_operation[**P, T](operation: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    """Keep driver failures behind the same sanitized persistence boundary."""
    try:
        return await await_session_operation(operation, *args, **kwargs)
    except PyMongoError as exc:
        raise NativeRunStorageError("Native run persistence is unavailable") from exc


class NativeRunRepository:
    """Use the configured canonical database and the existing native turn lease."""

    def __init__(self, mongo: MongoDBService) -> None:
        if mongo._db is None:
            raise NativeRunStorageError("Database not connected")
        self.mongo = mongo
        self.runs: Collection = mongo._db[EXECUTION_RUNS_COLLECTION]
        self.events: Collection = mongo._db[EXECUTION_EVENTS_COLLECTION]
        self.deleted_sessions: Collection = mongo._db[DELETED_SESSIONS_COLLECTION]

    def _is_deleted(self, session_id: str) -> bool:
        """A permanent deletion remains authoritative across delayed admissions."""
        return self.deleted_sessions.find_one({"_id": session_id}, {"_id": 1}) is not None

    def _require_existing_context(self, session_id: str) -> None:
        if self._is_deleted(session_id):
            raise NativeRunConflictError("This execution context was permanently deleted")

    def ensure_indexes(self) -> None:
        self.runs.create_index("run_id", unique=True, name="native_execution_run_unique")
        self.runs.create_index("session_id", name="native_execution_run_session")
        self.runs.create_index(
            [("owner_subject", ASCENDING), ("agent_id", ASCENDING), ("session_id", ASCENDING), ("turn_id", ASCENDING)],
            unique=True, name="native_execution_request_unique",
        )
        # This reserves a request while its sole execution lease is admitted.
        # It never authorizes runtime execution or replaces native_acp_runs.
        self.runs.create_index(
            [("agent_id", ASCENDING), ("session_id", ASCENDING)], unique=True,
            partialFilterExpression={"active": True}, name="native_execution_active_request_unique",
        )
        self.runs.create_index(
            [("owner_subject", ASCENDING), ("agent_id", ASCENDING), ("session_id", ASCENDING),
             ("active", DESCENDING), ("created_at", DESCENDING), ("updated_at", DESCENDING), ("_id", DESCENDING)],
            name="native_execution_latest",
        )
        self.runs.create_index(
            [("agent_id", ASCENDING), ("session_id", ASCENDING), ("active", DESCENDING),
             ("created_at", DESCENDING), ("updated_at", DESCENDING), ("_id", DESCENDING)],
            name="native_execution_conversation_latest",
        )
        self.events.create_index(
            [("run_id", ASCENDING), ("sequence", ASCENDING)], unique=True, name="native_execution_event_unique",
        )
        self.events.create_index("session_id", name="native_execution_event_session")
        # No TTL is introduced: replay records share CAIPE's history/backup
        # policy until an explicit retention contract is adopted.

    async def initialize(self) -> None:
        await _repository_operation(self.ensure_indexes)

    def _repair_tail(self, doc: dict) -> dict:
        """Make a fully inserted event visible after a cursor-update crash."""
        tail = self.events.find_one({"run_id": doc["run_id"]}, {"frame": 0}, sort=[("sequence", DESCENDING)])
        if tail is None or tail["sequence"] <= doc["last_sequence"]:
            return doc
        if not doc.get("active") and tail.get("status") is None:
            # A worker that lost admission cannot append beyond a terminal run.
            return doc
        previous = doc["last_sequence"]
        if tail["sequence"] - previous > REPLAY_PAGE_SIZE:
            # The admitted producer stops on an unacknowledged cursor write,
            # so recovery normally repairs one event. Bound corrupted tails.
            raise NativeReplayUnavailableError("The stored run has an invalid event tail")
        pending = list(self.events.find(
            {"run_id": doc["run_id"], "sequence": {"$gt": previous, "$lte": tail["sequence"]}},
            {"frame": 0},
        ).sort("sequence", ASCENDING))
        if [event["sequence"] for event in pending] != list(range(previous + 1, tail["sequence"] + 1)):
            raise NativeReplayUnavailableError("The stored run has an event gap")
        update: dict[str, object] = {"last_sequence": tail["sequence"]}
        terminal = next((event for event in reversed(pending) if event.get("status") in TERMINAL_STATUSES), None)
        if terminal is not None:
            update.update(status=terminal["status"], active=terminal.get("continue_execution", False), failure_code=terminal.get("failure_code"))
        result = self.runs.update_one(
            {"run_id": doc["run_id"], "last_sequence": previous},
            {"$set": update, "$max": {"updated_at": tail["created_at"]}, "$inc": {
                "total_bytes": sum(event.get("byte_count", 0) for event in pending),
                "frame_count": sum(event.get("frame_count", 0) for event in pending),
            }},
        )
        if result.matched_count:
            doc.update(update)
            doc["updated_at"] = max(_aware(doc["updated_at"]), _aware(tail["created_at"]))
            doc["total_bytes"] += sum(event.get("byte_count", 0) for event in pending)
            doc["frame_count"] += sum(event.get("frame_count", 0) for event in pending)
            return doc
        refreshed = self.runs.find_one({"run_id": doc["run_id"]})
        if refreshed is None:
            raise NativeReplayUnavailableError("The run is no longer available")
        return refreshed

    def _get(
        self, query: dict, *, reconcile: bool = True, include_retired: bool = False,
    ) -> NativeExecutionRun | None:
        doc = self.runs.find_one(query if include_retired else {**query, "retired": {"$ne": True}})
        if doc is None:
            return None
        if self._is_deleted(doc["session_id"]):
            return None
        doc = self._repair_tail(doc)
        if reconcile and doc.get("active"):
            now = _now()
            queued_expired = doc["status"] == "queued" and _aware(doc["created_at"]) + timedelta(
                seconds=STARTUP_TIMEOUT_SECONDS,
            ) <= now
            lease = self.mongo.get_session_runs_collection().find_one({
                "agent_id": doc["agent_id"], "session_id": doc["session_id"], "lease_id": {"$exists": True},
            }) if doc["status"] in {"running", "awaiting_input"} else None
            if lease is None and doc["status"] in {"running", "awaiting_input"}:
                # prepare_finish is acknowledged before native lease deletion.
                # Read that newer marker after observing a missing lease, not
                # from a snapshot obtained while runtime cleanup was beginning.
                refreshed = self.runs.find_one({"run_id": doc["run_id"]})
                if refreshed is None or self._is_deleted(doc["session_id"]):
                    return None
                doc = self._repair_tail(refreshed)
            lease_lost = doc["status"] in {"running", "awaiting_input"} and (
                (lease is not None and (
                    lease.get("lease_id") != doc["lease_id"] or _aware(lease["lease_expires_at"]) <= now
                )) or (lease is None and (
                    not doc.get("finishing") or _aware(doc["updated_at"]) + timedelta(
                        seconds=STARTUP_TIMEOUT_SECONDS,
                    ) <= now
                ))
            )
            if queued_expired or lease_lost:
                return self._finish(doc["run_id"], "interrupted", "worker_interrupted")
        return NativeExecutionRun.model_validate(doc)

    def _create(
        self, *, owner_subject: str, agent_id: str, session_id: str, turn_id: str, fingerprint: str, protocol: str,
    ) -> tuple[NativeExecutionRun, bool]:
        self._require_existing_context(session_id)
        scope = {"owner_subject": owner_subject, "agent_id": agent_id, "session_id": session_id, "turn_id": turn_id}
        current = self._get(scope, include_retired=True)
        if current is not None:
            if current.retired:
                raise NativeRunConflictError("This turn belongs to a cleared or rewound execution context")
            if current.fingerprint != fingerprint or current.protocol != protocol:
                raise NativeRunConflictError("This turn ID belongs to a different request")
            return current, False
        # Reconcile a crashed request before the unique active reservation check.
        self._get({"agent_id": agent_id, "session_id": session_id, "active": True})
        now = _now()
        run = NativeExecutionRun(
            run_id=str(uuid4()), **scope, fingerprint=fingerprint, protocol=protocol, created_at=now, updated_at=now,
        )
        try:
            self.runs.insert_one({**run.model_dump(mode="python"), "active": True})
        except DuplicateKeyError:
            self._require_existing_context(session_id)
            current = self._get(scope, include_retired=True)
            if current is not None:
                if current.retired:
                    raise NativeRunConflictError("This turn belongs to a cleared or rewound execution context") from None
                if current.fingerprint != fingerprint or current.protocol != protocol:
                    raise NativeRunConflictError("This turn ID belongs to a different request") from None
                return current, False
            raise NativeRunBusyError("This agent session already has an active request") from None
        if self._is_deleted(session_id):
            # The BFF records deletion before purging. An admission whose Mongo
            # insert was already in flight must not resurrect a queued request.
            self.runs.delete_one({"run_id": run.run_id})
            raise NativeRunConflictError("This execution context was permanently deleted")
        return run, True

    async def create(
        self, *, owner_subject: str, agent_id: str, session_id: str, turn_id: str, fingerprint: str, protocol: str,
    ) -> tuple[NativeExecutionRun, bool]:
        return await _repository_operation(
            self._create, owner_subject=owner_subject, agent_id=agent_id, session_id=session_id,
            turn_id=turn_id, fingerprint=fingerprint, protocol=protocol,
        )

    async def get(
        self, run_id: str, *, owner_subject: str | None, agent_id: str | None = None, session_id: str | None = None,
        reconcile: bool = True,
    ) -> NativeExecutionRun | None:
        query = {"run_id": run_id}
        if owner_subject is not None:
            query["owner_subject"] = owner_subject
        if agent_id is not None:
            query["agent_id"] = agent_id
        if session_id is not None:
            query["session_id"] = session_id
        return await _repository_operation(self._get, query, reconcile=reconcile)

    async def latest(self, *, owner_subject: str | None, agent_id: str, session_id: str) -> NativeExecutionRun | None:
        def read() -> NativeExecutionRun | None:
            if self._is_deleted(session_id):
                return None
            query = {"agent_id": agent_id, "session_id": session_id, "retired": {"$ne": True}}
            if owner_subject is not None:
                query["owner_subject"] = owner_subject
            doc = self.runs.find_one(
                query, {"run_id": 1}, sort=[
                    ("active", DESCENDING), ("created_at", DESCENDING), ("updated_at", DESCENDING), ("_id", DESCENDING),
                ],
            )
            return self._get({"run_id": doc["run_id"]}) if doc else None

        return await _repository_operation(read)

    async def bind_lease(self, run_id: str, lease_id: str) -> None:
        def bind() -> None:
            run = self.runs.find_one({"run_id": run_id}, {"session_id": 1})
            if run is None:
                raise NativeRunStorageError("The request is no longer admitted")
            self._require_existing_context(run["session_id"])
            now = _now()
            result = self.runs.update_one(
                {"run_id": run_id, "active": True, "status": "queued", "retired": {"$ne": True}},
                {"$set": {"lease_id": lease_id, "status": "running", "started_at": now, "updated_at": now}},
            )
            if not result.matched_count:
                raise NativeRunStorageError("The request is no longer admitted")
            self._require_existing_context(run["session_id"])

        await _repository_operation(bind)

    async def prepare_finish(self, run_id: str) -> None:
        """Record normal cleanup while still holding the native lease.

        Runtime cleanup may release that lease before the detached pump writes
        its outcome. A bounded finishing marker distinguishes this transition
        from a vanished worker without claiming a terminal outcome early.
        """
        await _repository_operation(
            self.runs.update_one, {"run_id": run_id, "active": True, "status": {"$in": ["running", "awaiting_input"]}},
            {"$set": {"finishing": True, "updated_at": _now()}},
        )

    def _append(self, run_id: str, frame: str | None, status: RunStatus | None, failure_code: str | None,
                continue_execution: bool = False) -> NativeRunEvent:
        run = self._get({"run_id": run_id}, reconcile=False)
        if run is None or not run.active:
            raise NativeRunStorageError("The run is no longer active")
        size = len(frame.encode("utf-8")) if frame is not None else 0
        if frame is not None and (
            size > MAX_FRAME_BYTES or run.total_bytes + size > MAX_RUN_BYTES or run.frame_count >= MAX_RUN_FRAMES
        ):
            raise NativeRunLimitError("Native run stream storage limit exceeded")
        event = NativeRunEvent(
            run_id=run_id, sequence=run.last_sequence + 1, frame=frame, status=status,
            failure_code=failure_code, created_at=_now(),
            continue_execution=continue_execution,
        )
        # A single admitted producer owns sequencing. Insert first so publication
        # never advertises bytes that failed to reach canonical storage.
        inserted = self.events.insert_one({
            **event.model_dump(mode="python"), "byte_count": size, "frame_count": int(frame is not None),
            "session_id": run.session_id,
        })
        if self._is_deleted(run.session_id):
            self.events.delete_one({"_id": inserted.inserted_id})
            raise NativeRunStorageError("The native execution context was permanently deleted")
        update: dict[str, object] = {"last_sequence": event.sequence, "updated_at": event.created_at}
        if status is not None:
            update.update(status=status, active=continue_execution, failure_code=failure_code)
        result = self.runs.update_one(
            {"run_id": run_id, "active": True, "last_sequence": run.last_sequence},
            {"$set": update, "$inc": {"total_bytes": size, "frame_count": int(frame is not None)}},
        )
        if not result.matched_count:
            refreshed = self.runs.find_one({"run_id": run_id})
            if refreshed is None:
                # A permanent deletion can race with this in-flight insert.
                # Remove only this producer's orphan, never a replayed event.
                self.events.delete_one({"_id": inserted.inserted_id})
                raise NativeRunStorageError("The native run was removed during event persistence")
            acknowledged = refreshed["last_sequence"] >= event.sequence and self.events.find_one({
                "_id": inserted.inserted_id, "run_id": run_id, "sequence": event.sequence,
            }, {"_id": 1}) is not None
            still_active = refreshed.get("active") and not refreshed.get("retired")
            same_terminal = status is not None and refreshed["status"] == status
            if acknowledged and (still_active or same_terminal):
                # A concurrent replay reader can commit this inserted event's
                # tail repair before the producer's cursor update. Its counters
                # are already correct; acknowledge without incrementing twice.
                return event
            raise NativeRunStorageError("Native run admission changed while persisting its event")
        return event

    async def append_frame(self, run_id: str, frame: str) -> NativeRunEvent:
        return await _repository_operation(self._append, run_id, frame, None, None)

    async def store_result(self, run_id: str, result: dict) -> None:
        """Retain a bounded invoke result before publishing its terminal state."""
        if len(json.dumps(result, ensure_ascii=False).encode()) > MAX_FRAME_BYTES:
            raise NativeRunLimitError("Native invocation result exceeds its storage limit")
        updated = await _repository_operation(self.runs.update_one, {"run_id": run_id, "active": True}, {
            "$set": {"result": result},
        })
        if not updated.matched_count:
            raise NativeRunStorageError("The invocation lost its execution admission")

    def _finish(self, run_id: str, status: RunStatus, error_code: str | None = None) -> NativeExecutionRun:
        if status not in TERMINAL_STATUSES:
            raise ValueError("Only terminal or awaiting-input statuses may finish a run")
        run = self._get({"run_id": run_id}, reconcile=False, include_retired=True)
        if run is None:
            raise NativeRunStorageError("The run is no longer available")
        if run.retired:
            return run
        if run.active:
            for attempt in range(3):
                try:
                    self._append(run_id, None, status, error_code)
                    break
                except DuplicateKeyError:
                    # A stale-reader interruption and the final producer frame
                    # may race. Reconcile the committed event before reserving
                    # the next contiguous terminal sequence.
                    run = self._get({"run_id": run_id}, reconcile=False, include_retired=True)
                    if run is None:
                        raise NativeRunStorageError("The run is no longer available") from None
                    if not run.active:
                        break
                    if attempt == 2:
                        raise NativeRunStorageError("Native run finalization conflicted") from None
            run = self._get({"run_id": run_id}, reconcile=False, include_retired=True)
        if run is None:
            raise NativeRunStorageError("The run is no longer available")
        return run

    async def finish(self, run_id: str, status: RunStatus, error_code: str | None = None) -> NativeExecutionRun:
        return await _repository_operation(self._finish, run_id, status, error_code)

    async def retire_session(self, agent_id: str, session_id: str) -> int:
        """Invalidate recovery after a clear/rewind while the native lease is held.

        Canonical conversation history and immutable events are retained. A
        queued request must complete or be cancelled before destructive state
        changes, rather than retiring its reservation and losing its producer.
        """
        def retire() -> int:
            scope = {"agent_id": agent_id, "session_id": session_id}
            active = self._get({**scope, "active": True})
            if active is not None and active.active:
                raise NativeRunBusyError("This agent session already has an active request")
            result = self.runs.update_many(
                {**scope, "active": False, "retired": {"$ne": True}},
                {"$set": {"retired": True, "retired_at": _now()}},
            )
            return result.modified_count

        return await _repository_operation(retire)

    async def request_cancel(self, agent_id: str, session_id: str, *, turn_id: str | None = None) -> bool:
        query = {"agent_id": agent_id, "session_id": session_id, "active": True}
        if turn_id is not None:
            query["$or"] = [{"current_turn_id": turn_id}, {"current_turn_id": None, "turn_id": turn_id}]
        result = await _repository_operation(
            self.runs.update_one, query,
            {"$set": {"cancel_requested": True}},
        )
        return bool(result.matched_count)

    async def replay(
        self, run_id: str, after: int, *, owner_subject: str | None, agent_id: str | None = None,
        session_id: str | None = None, limit: int = REPLAY_PAGE_SIZE,
    ) -> NativeReplayPage | None:
        if after < 0 or not 1 <= limit <= REPLAY_PAGE_SIZE:
            raise ValueError("Replay cursor and page size are outside the supported range")
        run = await self.get(run_id, owner_subject=owner_subject, agent_id=agent_id, session_id=session_id)
        if run is None:
            return None
        if after > run.last_sequence:
            raise NativeReplayUnavailableError("The replay cursor is ahead of the stored run")

        def read() -> list[NativeRunEvent]:
            docs = list(self.events.find(
                {"run_id": run_id, "sequence": {"$gt": after, "$lte": run.last_sequence}},
            ).sort("sequence", ASCENDING).limit(limit))
            expected = list(range(after + 1, min(run.last_sequence, after + limit) + 1))
            if [doc["sequence"] for doc in docs] != expected:
                raise NativeReplayUnavailableError("Stored replay events are missing or expired")
            return [NativeRunEvent.model_validate(doc) for doc in docs]

        events = await _repository_operation(read)
        return NativeReplayPage(run=run, events=events, next_cursor=events[-1].sequence if events else after)
