"""Cross-worker cooperative admission and cancellation for native agent turns."""

import asyncio
from collections.abc import AsyncGenerator
from contextlib import aclosing
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from threading import Event, Lock
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from pymongo import ASCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError, OperationFailure

from dynamic_agents.config import Settings
from dynamic_agents.services import session_runs
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.native_acp import cancel_native_acp, native_acp_stream, native_acp_turn
from dynamic_agents.services.session_runs import (
    SESSION_RUNS_COLLECTION,
    SessionRunBusyError,
    SessionRunError,
    await_session_operation,
    native_session_run,
    request_native_session_cancel,
)
from dynamic_agents.services.stream_encoders import StreamEncoder, get_encoder


def _matches(row: dict, query: dict) -> bool:
    for field, value in query.items():
        if field == "$or":
            if not any(_matches(row, predicate) for predicate in value):
                return False
        elif isinstance(value, dict):
            for operator, expected in value.items():
                if operator == "$exists" and (field in row) != expected:
                    return False
                if operator == "$gt" and (field not in row or row[field] <= expected):
                    return False
                if operator == "$lte" and (field not in row or row[field] > expected):
                    return False
        elif row.get(field) != value:
            return False
    return True


class _LeaseCollection:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict] = {}
        self.lock = Lock()
        self.fail_heartbeat = False

    def find_one_and_update(
        self, query: dict, update: dict, *, upsert: bool = False, return_document: bool,
    ) -> dict | None:
        assert return_document == ReturnDocument.AFTER
        if self.fail_heartbeat and "lease_id" in query:
            raise OperationFailure("database unavailable")
        key = (query["agent_id"], query["session_id"])
        with self.lock:
            row = self.rows.get(key)
            if row is not None and not _matches(row, query):
                if upsert:
                    raise DuplicateKeyError("unique agent/session")
                return None
            if row is None:
                if not upsert:
                    return None
                row = {}
                self.rows[key] = row
            row.update(deepcopy(update["$set"]))
            return deepcopy(row)

    def delete_one(self, query: dict) -> SimpleNamespace:
        key = (query["agent_id"], query["session_id"])
        with self.lock:
            row = self.rows.get(key)
            if row is not None and _matches(row, query):
                del self.rows[key]
                return SimpleNamespace(deleted_count=1)
            return SimpleNamespace(deleted_count=0)


def _mongo(collection: _LeaseCollection | MagicMock) -> MongoDBService:
    mongo = MongoDBService(Settings(mongodb_database="example"))
    mongo._db = {SESSION_RUNS_COLLECTION: collection}  # type: ignore[assignment]
    return mongo


async def _worker(mongo: MongoDBService, entered: asyncio.Event, release: asyncio.Event) -> None:
    async with native_session_run(mongo, "primary", "shared-thread"):
        entered.set()
        await release.wait()


async def test_two_workers_admit_only_one_active_turn() -> None:
    collection = _LeaseCollection()
    entered, release = asyncio.Event(), asyncio.Event()
    owner = asyncio.create_task(_worker(_mongo(collection), entered, release))
    await entered.wait()
    try:
        with pytest.raises(SessionRunBusyError, match="active turn"):
            async with native_session_run(_mongo(collection), "primary", "shared-thread"):
                pytest.fail("second worker entered an active session")
        assert len(collection.rows) == 1
    finally:
        release.set()
        await owner
    assert collection.rows == {}


async def test_cancellation_from_another_worker_stops_and_releases_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_runs, "HEARTBEAT_SECONDS", 0.01)
    collection = _LeaseCollection()
    entered, release = asyncio.Event(), asyncio.Event()
    owner = asyncio.create_task(_worker(_mongo(collection), entered, release))
    await entered.wait()

    assert request_native_session_cancel(_mongo(collection), "primary", "shared-thread") is True
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(owner, timeout=2)
    assert collection.rows == {}
    assert request_native_session_cancel(_mongo(collection), "primary", "shared-thread") is False


async def test_remote_cancellation_awaits_actual_acp_runtime_cleanup_before_releasing_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(session_runs, "HEARTBEAT_SECONDS", 0.01)
    collection = _LeaseCollection()
    entered, closed = asyncio.Event(), asyncio.Event()

    class BlockingRuntime:
        config = SimpleNamespace(id="primary")
        cancelled = False
        cleanup_had_lease = False

        async def stream(
            self, message: str, session_id: str, user_email: str, trace_id: str | None,
            encoder: StreamEncoder, **kwargs: object,
        ) -> AsyncGenerator[str, None]:
            del message, user_email, trace_id, kwargs
            try:
                for frame in encoder.on_run_start("example-run", session_id):
                    yield frame
                entered.set()
                await asyncio.Event().wait()
            finally:
                self.cleanup_had_lease = ("primary", "shared-thread") in collection.rows
                closed.set()

        def cancel(self) -> bool:
            self.cancelled = True
            return True

    runtime = BlockingRuntime()

    async def consume() -> None:
        async with native_session_run(_mongo(collection), "primary", "shared-thread"):
            async with aclosing(native_acp_stream(
                runtime, message="hello", session_id="shared-thread", user_email="test-user@example.com",
                encoder=get_encoder("agui"),
            )) as frames:
                async for _frame in frames:
                    pass

    owner = asyncio.create_task(consume())
    try:
        async with asyncio.timeout(5):
            await entered.wait()
            assert request_native_session_cancel(_mongo(collection), "primary", "shared-thread") is True
            with pytest.raises(asyncio.CancelledError):
                await owner
    finally:
        if not owner.done():
            owner.cancel()
        await asyncio.gather(owner, return_exceptions=True)

    assert closed.is_set()
    assert runtime.cancelled
    assert runtime.cleanup_had_lease
    assert collection.rows == {}
    assert not cancel_native_acp("primary", "shared-thread")
    # A fresh owner can enter the same slot; no cancelled ACP registry entry remains.
    async with native_acp_turn("primary", "shared-thread"):
        pass


async def test_expired_lease_can_be_replaced_and_old_cleanup_does_not_release_new_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(session_runs, "HEARTBEAT_SECONDS", 60)
    collection = _LeaseCollection()
    first_entered, first_release = asyncio.Event(), asyncio.Event()
    first = asyncio.create_task(_worker(_mongo(collection), first_entered, first_release))
    await first_entered.wait()
    original_lease = collection.rows[("primary", "shared-thread")]["lease_id"]
    collection.rows[("primary", "shared-thread")]["lease_expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert request_native_session_cancel(_mongo(collection), "primary", "shared-thread") is False

    next_entered, next_release = asyncio.Event(), asyncio.Event()
    successor = asyncio.create_task(_worker(_mongo(collection), next_entered, next_release))
    await next_entered.wait()
    next_lease = collection.rows[("primary", "shared-thread")]["lease_id"]
    assert next_lease != original_lease
    try:
        first_release.set()
        await first
        assert collection.rows[("primary", "shared-thread")]["lease_id"] == next_lease
    finally:
        first_release.set()
        next_release.set()
        await asyncio.gather(first, successor)
    assert collection.rows == {}


async def test_lost_lease_cancels_old_worker_on_next_heartbeat(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_runs, "HEARTBEAT_SECONDS", 0.01)
    collection = _LeaseCollection()
    entered, release = asyncio.Event(), asyncio.Event()
    owner = asyncio.create_task(_worker(_mongo(collection), entered, release))
    await entered.wait()
    collection.rows[("primary", "shared-thread")]["lease_id"] = "new-worker-lease"

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(owner, timeout=2)
    assert collection.rows[("primary", "shared-thread")]["lease_id"] == "new-worker-lease"


async def test_heartbeat_extends_lease_and_database_loss_stops_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_runs, "HEARTBEAT_SECONDS", 0.01)
    collection = _LeaseCollection()
    entered, release = asyncio.Event(), asyncio.Event()
    owner = asyncio.create_task(_worker(_mongo(collection), entered, release))
    await entered.wait()
    initial_expiry = collection.rows[("primary", "shared-thread")]["lease_expires_at"]
    for _ in range(100):
        if collection.rows[("primary", "shared-thread")]["lease_expires_at"] > initial_expiry:
            break
        await asyncio.sleep(0.01)
    assert collection.rows[("primary", "shared-thread")]["lease_expires_at"] > initial_expiry
    collection.fail_heartbeat = True

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(owner, timeout=2)
    assert collection.rows == {}


async def test_expired_owner_is_cancelled_instead_of_renewing_lost_admission(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_runs, "HEARTBEAT_SECONDS", 0.01)
    collection = _LeaseCollection()
    entered, release = asyncio.Event(), asyncio.Event()
    owner = asyncio.create_task(_worker(_mongo(collection), entered, release))
    await entered.wait()
    collection.rows[("primary", "shared-thread")]["lease_expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(owner, timeout=2)
    assert collection.rows == {}


async def test_body_exception_releases_owned_lease() -> None:
    collection = _LeaseCollection()
    with pytest.raises(ValueError, match="turn failed"):
        async with native_session_run(_mongo(collection), "primary", "shared-thread"):
            raise ValueError("turn failed")
    assert collection.rows == {}


async def test_repeated_cancellation_waits_for_database_mutation_before_releasing_lease() -> None:
    collection = _LeaseCollection()
    started, unblock, completed = Event(), Event(), Event()
    owned_during_mutation: list[bool] = []

    def mutate() -> None:
        started.set()
        assert unblock.wait(timeout=5)
        owned_during_mutation.append(("primary", "shared-thread") in collection.rows)
        completed.set()

    async def worker() -> None:
        async with native_session_run(_mongo(collection), "primary", "shared-thread"):
            await await_session_operation(mutate)

    owner = asyncio.create_task(worker())
    try:
        assert await asyncio.to_thread(started.wait, 2)
        owner.cancel()
        await asyncio.sleep(0)
        owner.cancel()
        await asyncio.sleep(0)
        assert not owner.done()
        assert ("primary", "shared-thread") in collection.rows
        unblock.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(owner, timeout=2)
    finally:
        unblock.set()
        await asyncio.gather(owner, return_exceptions=True)

    assert completed.is_set()
    assert owned_during_mutation == [True]
    assert collection.rows == {}


async def test_cancelled_acquisition_waits_then_removes_owned_lease() -> None:
    started, unblock = Event(), Event()

    class SlowAdmissionCollection(_LeaseCollection):
        def find_one_and_update(
            self, query: dict, update: dict, *, upsert: bool = False, return_document: bool,
        ) -> dict | None:
            if upsert:
                started.set()
                assert unblock.wait(timeout=5)
            return super().find_one_and_update(query, update, upsert=upsert, return_document=return_document)

    collection = SlowAdmissionCollection()
    entered, release = asyncio.Event(), asyncio.Event()
    owner = asyncio.create_task(_worker(_mongo(collection), entered, release))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        owner.cancel()
        await asyncio.sleep(0)
        owner.cancel()
        await asyncio.sleep(0)
        assert not owner.done()
        unblock.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(owner, timeout=2)
    finally:
        unblock.set()
        await asyncio.gather(owner, return_exceptions=True)

    assert not entered.is_set()
    assert collection.rows == {}


async def test_repeated_cancellation_waits_for_owned_lease_deletion() -> None:
    started, unblock = Event(), Event()

    class SlowReleaseCollection(_LeaseCollection):
        def delete_one(self, query: dict) -> SimpleNamespace:
            started.set()
            assert unblock.wait(timeout=5)
            return super().delete_one(query)

    collection = SlowReleaseCollection()
    entered, release = asyncio.Event(), asyncio.Event()
    owner = asyncio.create_task(_worker(_mongo(collection), entered, release))
    try:
        await entered.wait()
        release.set()
        assert await asyncio.to_thread(started.wait, 2)
        owner.cancel()
        await asyncio.sleep(0)
        owner.cancel()
        await asyncio.sleep(0)
        assert not owner.done()
        assert ("primary", "shared-thread") in collection.rows
        unblock.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(owner, timeout=2)
    finally:
        unblock.set()
        await asyncio.gather(owner, return_exceptions=True)

    assert collection.rows == {}


async def test_database_error_after_cancellation_is_retrieved_without_masking_cancel(
    caplog: pytest.LogCaptureFixture,
) -> None:
    collection = _LeaseCollection()
    started, unblock = Event(), Event()

    def mutate() -> None:
        started.set()
        assert unblock.wait(timeout=5)
        raise OperationFailure("example database failure")

    async def worker() -> None:
        async with native_session_run(_mongo(collection), "primary", "shared-thread"):
            await await_session_operation(mutate)

    owner = asyncio.create_task(worker())
    try:
        assert await asyncio.to_thread(started.wait, 2)
        owner.cancel()
        await asyncio.sleep(0)
        unblock.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(owner, timeout=2)
    finally:
        unblock.set()
        await asyncio.gather(owner, return_exceptions=True)

    assert "database operation failed while caller was cancelled" in caplog.text
    assert collection.rows == {}


async def test_cleanup_database_loss_does_not_mask_turn_failure() -> None:
    collection = _LeaseCollection()
    mongo = _mongo(collection)
    with pytest.raises(ValueError, match="turn failed"):
        async with native_session_run(mongo, "primary", "shared-thread"):
            mongo._db = None
            raise ValueError("turn failed")
    # The unavailable database leaves only the bounded lease to expire.
    assert len(collection.rows) == 1


async def test_admission_database_failure_is_loud() -> None:
    collection = MagicMock()
    collection.find_one_and_update.side_effect = OperationFailure("unavailable")
    with pytest.raises(SessionRunError, match="admission is unavailable"):
        async with native_session_run(_mongo(collection), "primary", "shared-thread"):
            pytest.fail("turn admitted without canonical coordination")


def test_cancel_database_failure_is_loud() -> None:
    collection = MagicMock()
    collection.find_one_and_update.side_effect = OperationFailure("unavailable")
    with pytest.raises(SessionRunError, match="cancellation is unavailable"):
        request_native_session_cancel(_mongo(collection), "primary", "shared-thread")


async def test_lease_contains_only_coordination_state() -> None:
    collection = _LeaseCollection()
    async with native_session_run(_mongo(collection), "primary", "shared-thread"):
        row = collection.rows[("primary", "shared-thread")]
        assert set(row) == {
            "agent_id", "session_id", "lease_id", "lease_expires_at", "heartbeat_at", "cancel_requested",
        }
        assert row["cancel_requested"] is False
        assert (row["lease_expires_at"] - row["heartbeat_at"]).total_seconds() == 120


def test_unique_active_turn_index_shares_existing_database() -> None:
    mongo = MongoDBService(Settings())
    collections: dict[str, MagicMock] = {}
    db = MagicMock()
    db.__getitem__.side_effect = lambda name: collections.setdefault(name, MagicMock())
    mongo._db = db

    mongo._ensure_indexes()

    collections[SESSION_RUNS_COLLECTION].create_index.assert_called_once_with(
        [("agent_id", ASCENDING), ("session_id", ASCENDING)],
        unique=True,
        name="native_acp_active_turn_unique",
    )
