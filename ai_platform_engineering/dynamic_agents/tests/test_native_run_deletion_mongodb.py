"""Permanent canonical deletion closes native admission and replay races."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from threading import Event
from types import SimpleNamespace
from typing import Any

import pytest

from dynamic_agents.services.native_run_coordinator import NativeRunCoordinator
from dynamic_agents.services.native_run_repository import (
    DELETED_SESSIONS_COLLECTION,
    EXECUTION_EVENTS_COLLECTION,
    EXECUTION_RUNS_COLLECTION,
    NativeRunConflictError,
    NativeRunRepository,
)
from dynamic_agents.services.session_runs import SESSION_RUNS_COLLECTION
from tests.test_native_acp_mongodb import native_database as native_database
from tests.test_native_execution_runs_mongodb import SESSION, _frame, _request, _scope


def _delete_guard(state: SimpleNamespace) -> None:
    state.db[DELETED_SESSIONS_COLLECTION].insert_one({"_id": SESSION, "deleted_at": datetime.now(timezone.utc)})


async def test_original_owner_cannot_read_deleted_session_before_event_purge_finishes(native_database: SimpleNamespace) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, _ = await repository.create(**_request())
    await repository.append_frame(run.run_id, _frame("TEXT_MESSAGE_CONTENT", messageId="native-answer", delta="private result"))
    await repository.finish(run.run_id, "completed")
    assert all(event["session_id"] == SESSION for event in native_database.db[EXECUTION_EVENTS_COLLECTION].find({"run_id": run.run_id}))
    _delete_guard(native_database)
    assert await repository.get(run.run_id, **_scope()) is None
    assert await repository.get(run.run_id, owner_subject=None) is None
    assert await repository.latest(**_scope()) is None
    assert await repository.replay(run.run_id, 0, **_scope()) is None
    assert native_database.db[EXECUTION_RUNS_COLLECTION].count_documents({"run_id": run.run_id}) == 1
    assert native_database.db[EXECUTION_EVENTS_COLLECTION].count_documents({"run_id": run.run_id}) > 0


async def test_deleted_execution_context_rejects_a_fresh_turn_before_starting_any_producer(native_database: SimpleNamespace) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    coordinator = NativeRunCoordinator(repository)
    _delete_guard(native_database)
    calls = 0

    async def produce() -> Any:
        nonlocal calls
        calls += 1
        yield _frame("RUN_FINISHED", outcome="success")

    try:
        with pytest.raises(NativeRunConflictError, match="permanently deleted"):
            await coordinator.start(**_request(), producer=produce, outcome=lambda: "completed")
        assert calls == 0
        assert native_database.db[EXECUTION_RUNS_COLLECTION].count_documents({}) == 0
        assert native_database.db[EXECUTION_EVENTS_COLLECTION].count_documents({}) == 0
        assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
    finally:
        await coordinator.shutdown()


async def test_delete_during_pending_run_insert_cannot_recreate_a_purged_session_or_launch_provider(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    other, _ = await repository.create(**{**_request(), "session_id": "other-thread"})
    coordinator = NativeRunCoordinator(repository)
    entered, release = Event(), Event()
    insert = repository.runs.insert_one
    calls = 0

    def blocked_insert(document: dict[str, Any], **options: Any) -> Any:
        if document["session_id"] == SESSION:
            entered.set()
            assert release.wait(5), "The test did not release the pending run insertion"
        return insert(document, **options)

    monkeypatch.setattr(repository.runs, "insert_one", blocked_insert)

    async def produce() -> Any:
        nonlocal calls
        calls += 1
        yield _frame("RUN_FINISHED", outcome="success")

    pending = asyncio.create_task(coordinator.start(**_request(), producer=produce, outcome=lambda: "completed"))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        _delete_guard(native_database)
        native_database.db[EXECUTION_RUNS_COLLECTION].delete_many({"session_id": SESSION})
        native_database.db[EXECUTION_EVENTS_COLLECTION].delete_many({"session_id": SESSION})
        release.set()
        with pytest.raises(NativeRunConflictError, match="permanently deleted"):
            await asyncio.wait_for(pending, 5)
        assert calls == 0
        assert native_database.db[EXECUTION_RUNS_COLLECTION].count_documents({"session_id": SESSION}) == 0
        assert native_database.db[EXECUTION_EVENTS_COLLECTION].count_documents({"session_id": SESSION}) == 0
        assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
        assert (await repository.get(other.run_id, **{**_scope(), "session_id": "other-thread"})).run_id == other.run_id
    finally:
        release.set()
        await asyncio.gather(pending, return_exceptions=True)
        await coordinator.shutdown()
