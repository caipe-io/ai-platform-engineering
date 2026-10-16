"""Durable native runs and replay against the canonical MongoDB database.

These tests own a random database through the native checkpoint fixture.
Providers are deterministic; journal writes, cursor ordering and cross-worker
reads use real MongoDB rather than an in-memory repository.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from threading import Event
from types import SimpleNamespace
from typing import Any

import pytest
from pymongo.errors import OperationFailure

from dynamic_agents.services import native_run_repository
from dynamic_agents.services.native_run_coordinator import (
    NativeRunCoordinator,
    mark_native_run_admitted,
    mark_native_run_released,
)
from dynamic_agents.services.native_run_repository import (
    EXECUTION_EVENTS_COLLECTION,
    EXECUTION_RUNS_COLLECTION,
    NativeReplayUnavailableError,
    NativeRunBusyError,
    NativeRunConflictError,
    NativeRunLimitError,
    NativeRunRepository,
    NativeRunStorageError,
)
from dynamic_agents.services.session_runs import SESSION_RUNS_COLLECTION, native_session_run
from tests.test_native_acp_mongodb import native_database as native_database

OWNER = "example-owner"
AGENT = "example-agent"
SESSION = "original-thread"


def _frame(event_type: str, **data: Any) -> str:
    return f"event: {event_type}\ndata: {json.dumps({'type': event_type, **data})}\n\n"


def _scope() -> dict[str, str]:
    return {"owner_subject": OWNER, "agent_id": AGENT, "session_id": SESSION}


def _request(turn_id: str = "original-turn", fingerprint: str = "original-payload") -> dict[str, str]:
    return {**_scope(), "turn_id": turn_id, "fingerprint": fingerprint, "protocol": "agui"}


async def _wait_for(predicate: Callable[[], Any]) -> Any:
    async with asyncio.timeout(5):
        while True:
            result = await predicate()
            if result:
                return result
            await asyncio.sleep(0.01)


async def _terminal(repository: NativeRunRepository, run_id: str) -> Any:
    async def complete() -> Any:
        run = await repository.get(run_id, **_scope())
        return run if run and run.status not in {"queued", "running"} else None

    return await _wait_for(complete)


@asynccontextmanager
async def _admitted(state: SimpleNamespace) -> AsyncGenerator[None, None]:
    async with native_session_run(state.mongo, AGENT, SESSION) as lease_id:
        await mark_native_run_admitted(lease_id)
        try:
            yield
        finally:
            await mark_native_run_released()


async def test_detached_native_run_finishes_and_replays_identical_frames_from_another_worker(
    native_database: SimpleNamespace,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    coordinator = NativeRunCoordinator(repository)
    entered, release, cleaned = asyncio.Event(), asyncio.Event(), asyncio.Event()
    frames = [
        _frame("RUN_STARTED", runId="native-run", threadId=SESSION),
        _frame("TEXT_MESSAGE_START", messageId="native-answer", role="assistant"),
        _frame("TEXT_MESSAGE_CONTENT", messageId="native-answer", delta="first "),
        _frame("TEXT_MESSAGE_CONTENT", messageId="native-answer", delta="second"),
        _frame("TEXT_MESSAGE_END", messageId="native-answer"),
        _frame("RUN_FINISHED", runId="native-run", threadId=SESSION, outcome="success"),
    ]

    async def produce() -> AsyncGenerator[str, None]:
        async with _admitted(native_database):
            try:
                yield frames[0]
                entered.set()
                await release.wait()
                for frame in frames[1:]:
                    yield frame
            finally:
                cleaned.set()

    run = await coordinator.start(**_request(), producer=produce, outcome=lambda: "completed")
    try:
        await asyncio.wait_for(entered.wait(), 5)
        consumer = coordinator.subscribe(run, after=0)
        first = await asyncio.wait_for(anext(consumer), 5)
        assert f"id: {run.run_id}:1\n" in first and frames[0] in first
        await consumer.aclose()
        assert not cleaned.is_set()
        assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 1
        release.set()
        completed = await _terminal(repository, run.run_id)
        assert completed.status == "completed" and cleaned.is_set()
        assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0

        fresh_repository = NativeRunRepository(native_database.mongo)
        await fresh_repository.initialize()
        fresh_worker = NativeRunCoordinator(fresh_repository)
        restored = await fresh_repository.get(run.run_id, **_scope())
        replay = [frame async for frame in fresh_worker.subscribe(restored, after=0)]
        assert [frame.split("\n", 1)[1] for frame in replay if "event: CAIPE_RUN_STATUS\n" not in frame] == frames
        assert f"id: {run.run_id}:{restored.last_sequence}\n" in replay[-1]
        terminal = json.loads(replay[-1].split("data: ", 1)[1])
        assert terminal == {"run_id": run.run_id, "status": "completed", "failure_code": None}
        suffix = [frame async for frame in fresh_worker.subscribe(restored, after=3)]
        assert suffix == replay[3:]
        assert frames[2] not in "".join(suffix)
        assert await fresh_repository.latest(**_scope()) == restored
    finally:
        release.set()
        await coordinator.shutdown()


async def test_retry_of_same_turn_reattaches_without_running_producer_twice(native_database: SimpleNamespace) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    coordinator = NativeRunCoordinator(repository)
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def produce() -> AsyncGenerator[str, None]:
        nonlocal calls
        async with _admitted(native_database):
            calls += 1
            entered.set()
            await release.wait()
            yield _frame("RUN_FINISHED", runId="native-run", threadId=SESSION, outcome="success")

    try:
        first = await coordinator.start(**_request(), producer=produce, outcome=lambda: "completed")
        await asyncio.wait_for(entered.wait(), 5)
        retried = await NativeRunCoordinator(NativeRunRepository(native_database.mongo)).start(
            **_request(), producer=produce, outcome=lambda: "completed",
        )
        assert retried.run_id == first.run_id and calls == 1
        release.set()
        await _terminal(repository, first.run_id)
        completed_retry = await coordinator.start(**_request(), producer=produce, outcome=lambda: "completed")
        assert completed_retry.run_id == first.run_id and calls == 1
    finally:
        release.set()
        await coordinator.shutdown()


async def test_expired_execution_is_interrupted_and_replay_does_not_restart_it(native_database: SimpleNamespace) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, created = await repository.create(**_request())
    assert created
    lease_id = "example-expired-lease"
    native_database.db[SESSION_RUNS_COLLECTION].insert_one({
        "agent_id": AGENT, "session_id": SESSION, "lease_id": lease_id,
        "lease_expires_at": datetime.now(timezone.utc) - timedelta(seconds=1),
    })
    await repository.bind_lease(run.run_id, lease_id)
    await repository.append_frame(run.run_id, _frame("TEXT_MESSAGE_CONTENT", messageId="native-answer", delta="saved"))
    fresh_repository = NativeRunRepository(native_database.mongo)
    restored = await fresh_repository.get(run.run_id, **_scope())
    assert restored.status == "interrupted"
    fresh_worker = NativeRunCoordinator(fresh_repository)
    frames = [frame async for frame in fresh_worker.subscribe(restored, after=0)]
    assert any("saved" in frame for frame in frames)
    assert json.loads(frames[-1].split("data: ", 1)[1])["status"] == "interrupted"
    assert "worker_interrupted" in frames[-1]
    assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 1


async def test_new_turn_is_not_admitted_while_detached_execution_is_active(native_database: SimpleNamespace) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, _ = await repository.create(**_request())
    with pytest.raises(NativeRunBusyError, match="active request"):
        await NativeRunRepository(native_database.mongo).create(**_request(turn_id="next-turn"))
    assert native_database.db[EXECUTION_RUNS_COLLECTION].count_documents({}) == 1
    await repository.finish(run.run_id, "completed")
    following, created = await repository.create(**_request(turn_id="next-turn"))
    assert created and following.run_id != run.run_id


@pytest.mark.parametrize("changed", [{"fingerprint": "different-payload"}, {"protocol": "custom"}])
async def test_retry_with_changed_validated_input_is_rejected_without_duplicate_run(
    native_database: SimpleNamespace, changed: dict[str, str],
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    original, _ = await repository.create(**_request())
    with pytest.raises(NativeRunConflictError, match="different request"):
        await repository.create(**{**_request(), **changed})
    assert native_database.db[EXECUTION_RUNS_COLLECTION].count_documents({}) == 1
    assert (await repository.get(original.run_id, **_scope())).fingerprint == "original-payload"


@pytest.mark.parametrize("changed", [
    {"owner_subject": "other-owner"}, {"agent_id": "other-agent"}, {"session_id": "other-session"},
])
async def test_other_run_scope_cannot_read_status_or_replay_frames(
    native_database: SimpleNamespace, changed: dict[str, str],
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, _ = await repository.create(**_request())
    await repository.append_frame(run.run_id, _frame("TEXT_MESSAGE_CONTENT", messageId="native-answer", delta="private result"))
    await repository.finish(run.run_id, "completed")
    scope = {**_scope(), **changed}
    assert await repository.get(run.run_id, **scope) is None
    assert await repository.latest(**scope) is None
    assert await repository.replay(run.run_id, 0, **scope) is None
    assert (await repository.replay(run.run_id, 0, **_scope())).events[0].frame.endswith("\n\n")


async def test_cursor_pages_preserve_every_frame_and_do_not_silently_skip_missing_events(native_database: SimpleNamespace) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, _ = await repository.create(**_request())
    frames = [_frame("TEXT_MESSAGE_CONTENT", messageId="native-answer", delta=str(number)) for number in range(5)]
    for frame in frames:
        await repository.append_frame(run.run_id, frame)
    completed = await repository.finish(run.run_id, "completed")
    observed, cursor = [], 0
    while cursor < completed.last_sequence:
        page = await repository.replay(run.run_id, cursor, **_scope(), limit=2)
        assert [event.sequence for event in page.events] == list(range(cursor + 1, page.next_cursor + 1))
        observed.extend(event.frame for event in page.events if event.frame is not None)
        cursor = page.next_cursor
    assert observed == frames and cursor == 6
    assert (await repository.replay(run.run_id, cursor, **_scope())).events == []
    with pytest.raises(NativeReplayUnavailableError, match="ahead"):
        await repository.replay(run.run_id, cursor + 1, **_scope())
    native_database.db[EXECUTION_EVENTS_COLLECTION].delete_one({"run_id": run.run_id, "sequence": 2})
    with pytest.raises(NativeReplayUnavailableError):
        await repository.replay(run.run_id, 0, **_scope())


async def test_cross_replica_cancel_keeps_admission_until_producer_cleanup_finishes(native_database: SimpleNamespace) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    coordinator = NativeRunCoordinator(repository)
    entered, cleanup_started, cleanup_release, cleaned = (asyncio.Event() for _ in range(4))

    async def produce() -> AsyncGenerator[str, None]:
        async with _admitted(native_database):
            try:
                yield _frame("RUN_STARTED", runId="native-run", threadId=SESSION)
                entered.set()
                await asyncio.Event().wait()
            finally:
                cleanup_started.set()
                assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 1
                await cleanup_release.wait()
                assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 1
                cleaned.set()

    run = await coordinator.start(**_request(), producer=produce, outcome=lambda: None)
    try:
        await asyncio.wait_for(entered.wait(), 5)
        remote = NativeRunCoordinator(NativeRunRepository(native_database.mongo))
        assert await remote.cancel(AGENT, SESSION)
        await asyncio.wait_for(cleanup_started.wait(), 5)
        assert not cleaned.is_set()
        assert (await repository.get(run.run_id, **_scope())).status == "running"
        with pytest.raises(NativeRunBusyError):
            await repository.create(**_request(turn_id="next-turn"))
        cleanup_release.set()
        cancelled = await _terminal(repository, run.run_id)
        assert cancelled.status == "cancelled" and cleaned.is_set()
        assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
        replay = [frame async for frame in remote.subscribe(cancelled)]
        assert json.loads(replay[-1].split("data: ", 1)[1])["status"] == "cancelled"
    finally:
        cleanup_release.set()
        await coordinator.shutdown()


@pytest.mark.parametrize("terminal", [False, True], ids=["frame-inserted", "terminal-inserted"])
async def test_crash_after_event_insert_is_repaired_once_without_advertising_unstored_events(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, terminal: bool,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, _ = await repository.create(**_request())
    frame = _frame("TEXT_MESSAGE_CONTENT", messageId="native-answer", delta="persisted before cursor")
    if terminal:
        await repository.append_frame(run.run_id, frame)
    committed = native_database.db[EXECUTION_RUNS_COLLECTION].find_one({"run_id": run.run_id})
    previous_cursor = committed["last_sequence"]
    update_one = repository.runs.update_one

    def fail_cursor_update(query: dict[str, Any], update: dict[str, Any], **options: Any) -> Any:
        if query.get("run_id") == run.run_id and "last_sequence" in update.get("$set", {}):
            raise OperationFailure("Simulated worker loss after the event insert")
        return update_one(query, update, **options)

    monkeypatch.setattr(repository.runs, "update_one", fail_cursor_update)
    with pytest.raises(NativeRunStorageError) as failure:
        if terminal:
            await repository.finish(run.run_id, "completed")
        else:
            await repository.append_frame(run.run_id, frame)
    assert isinstance(failure.value.__cause__, OperationFailure)
    stored = native_database.db[EXECUTION_RUNS_COLLECTION].find_one({"run_id": run.run_id})
    assert stored["last_sequence"] == previous_cursor and stored["status"] == "queued"
    assert native_database.db[EXECUTION_EVENTS_COLLECTION].count_documents({"run_id": run.run_id}) == previous_cursor + 1

    reconstructed = NativeRunRepository(native_database.mongo)
    page = await reconstructed.replay(run.run_id, 0, **_scope())
    assert page.next_cursor == previous_cursor + 1
    assert [event.sequence for event in page.events] == list(range(1, page.next_cursor + 1))
    assert [event.frame for event in page.events if event.frame is not None] == [frame]
    assert page.run.status == ("completed" if terminal else "queued")
    assert page.run.total_bytes == len(frame.encode("utf-8")) and page.run.frame_count == 1
    second = await reconstructed.replay(run.run_id, page.next_cursor, **_scope())
    assert second.events == [] and second.run.total_bytes == page.run.total_bytes
    assert native_database.db[EXECUTION_EVENTS_COLLECTION].count_documents({"run_id": run.run_id}) == page.next_cursor


async def test_immediate_cancel_before_producer_runs_persists_cancelled_status(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    coordinator = NativeRunCoordinator(repository)
    calls = 0
    pump = coordinator._pump

    async def delay_pump(*arguments: Any) -> None:
        await asyncio.Event().wait()
        await pump(*arguments)

    monkeypatch.setattr(coordinator, "_pump", delay_pump)

    async def produce() -> AsyncGenerator[str, None]:
        nonlocal calls
        calls += 1
        await asyncio.Event().wait()
        yield _frame("RUN_FINISHED", outcome="success")

    run = await coordinator.start(**_request(), producer=produce, outcome=lambda: None)
    try:
        assert await coordinator.cancel(AGENT, SESSION)
        cancelled = await _terminal(repository, run.run_id)
        assert cancelled.status == "cancelled"
        assert calls == 0
        assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
        retried = await coordinator.start(**_request(), producer=produce, outcome=lambda: None)
        assert retried.run_id == run.run_id and calls == 0
    finally:
        await coordinator.shutdown()


async def test_exhausted_stream_without_native_terminal_event_is_interrupted(native_database: SimpleNamespace) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    coordinator = NativeRunCoordinator(repository)

    async def produce() -> AsyncGenerator[str, None]:
        async with _admitted(native_database):
            yield _frame("TEXT_MESSAGE_CONTENT", messageId="native-answer", delta="partial result")

    run = await coordinator.start(**_request(), producer=produce, outcome=lambda: None)
    try:
        interrupted = await _terminal(repository, run.run_id)
        assert interrupted.status == "interrupted" and interrupted.failure_code == "missing_terminal_event"
        replay = [frame async for frame in coordinator.subscribe(interrupted)]
        assert any("partial result" in frame for frame in replay)
        assert json.loads(replay[-1].split("data: ", 1)[1]) == {
            "run_id": run.run_id, "status": "interrupted", "failure_code": "missing_terminal_event",
        }
    finally:
        await coordinator.shutdown()


async def test_normal_lease_release_and_delayed_terminal_write_do_not_report_false_interruption(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    coordinator = NativeRunCoordinator(repository)
    finishing, release_finish = asyncio.Event(), asyncio.Event()
    finish = repository.finish

    async def delayed_finish(run_id: str, status: str, error_code: str | None = None) -> Any:
        finishing.set()
        await release_finish.wait()
        return await finish(run_id, status, error_code)

    monkeypatch.setattr(repository, "finish", delayed_finish)

    async def produce() -> AsyncGenerator[str, None]:
        async with _admitted(native_database):
            yield _frame("RUN_FINISHED", runId="native-run", threadId=SESSION, outcome="success")

    run = await coordinator.start(**_request(), producer=produce, outcome=lambda: "completed")
    try:
        await asyncio.wait_for(finishing.wait(), 5)
        assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
        remote = NativeRunRepository(native_database.mongo)
        assert (await remote.get(run.run_id, **_scope())).status == "running"
        assert (await remote.replay(run.run_id, 0, **_scope())).run.status == "running"
        release_finish.set()
        assert (await _terminal(repository, run.run_id)).status == "completed"
    finally:
        release_finish.set()
        await coordinator.shutdown()


async def test_finishing_grace_is_bounded_and_polling_does_not_extend_it(native_database: SimpleNamespace) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, _ = await repository.create(**_request())
    lease_id = "example-owner-lease"
    native_database.db[SESSION_RUNS_COLLECTION].insert_one({
        "agent_id": AGENT, "session_id": SESSION, "lease_id": lease_id,
        "lease_expires_at": datetime.now(timezone.utc) + timedelta(minutes=1),
    })
    await repository.bind_lease(run.run_id, lease_id)
    await repository.prepare_finish(run.run_id)
    native_database.db[SESSION_RUNS_COLLECTION].delete_one({"lease_id": lease_id})
    first = await repository.get(run.run_id, **_scope())
    second = await NativeRunRepository(native_database.mongo).get(run.run_id, **_scope())
    assert first.status == second.status == "running" and first.updated_at == second.updated_at
    native_database.db[EXECUTION_RUNS_COLLECTION].update_one(
        {"run_id": run.run_id}, {"$set": {
            "updated_at": datetime.now(timezone.utc) - timedelta(seconds=native_run_repository.STARTUP_TIMEOUT_SECONDS + 1),
        }},
    )
    interrupted = await repository.get(run.run_id, **_scope())
    assert interrupted.status == "interrupted" and interrupted.failure_code == "worker_interrupted"
    assert (await repository.create(**_request()))[0].run_id == run.run_id


@pytest.mark.parametrize("finishing", [False, True])
async def test_replaced_native_lease_interrupts_previous_owner_without_deleting_successor(
    native_database: SimpleNamespace, finishing: bool,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, _ = await repository.create(**_request())
    native_database.db[SESSION_RUNS_COLLECTION].insert_one({
        "agent_id": AGENT, "session_id": SESSION, "lease_id": "original-lease",
        "lease_expires_at": datetime.now(timezone.utc) + timedelta(minutes=1),
    })
    await repository.bind_lease(run.run_id, "original-lease")
    if finishing:
        await repository.prepare_finish(run.run_id)
    native_database.db[SESSION_RUNS_COLLECTION].update_one(
        {"agent_id": AGENT, "session_id": SESSION}, {"$set": {"lease_id": "successor-lease"}},
    )
    interrupted = await repository.get(run.run_id, **_scope())
    assert interrupted.status == "interrupted"
    assert native_database.db[SESSION_RUNS_COLLECTION].find_one()["lease_id"] == "successor-lease"
    assert (await repository.create(**_request()))[0].run_id == run.run_id


@pytest.mark.parametrize("limit", ["frame", "total", "frame_count"])
async def test_storage_limit_rejects_frame_before_publishing_its_cursor(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, limit: str,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, _ = await repository.create(**_request())
    frame = _frame("TEXT_MESSAGE_CONTENT", messageId="native-answer", delta="bounded stream")
    if limit == "frame":
        monkeypatch.setattr(native_run_repository, "MAX_FRAME_BYTES", len(frame.encode("utf-8")) - 1)
    else:
        key, bound = ("MAX_RUN_BYTES", len(frame.encode("utf-8"))) if limit == "total" else ("MAX_RUN_FRAMES", 1)
        monkeypatch.setattr(native_run_repository, key, bound)
        await repository.append_frame(run.run_id, frame)
    before = await repository.get(run.run_id, **_scope())
    with pytest.raises(NativeRunLimitError):
        await repository.append_frame(run.run_id, frame)
    after = await repository.get(run.run_id, **_scope())
    assert after.last_sequence == before.last_sequence
    assert after.total_bytes == before.total_bytes and after.frame_count == before.frame_count
    assert native_database.db[EXECUTION_EVENTS_COLLECTION].count_documents({"run_id": run.run_id}) == before.last_sequence
    assert repository.runs.database.name == repository.events.database.name == native_database.db.name


async def test_disconnected_start_during_mongo_insert_keeps_accepted_execution_and_retry_identity(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    coordinator = NativeRunCoordinator(repository)
    insert_entered, insert_release = Event(), Event()
    producer_entered = asyncio.Event()
    insert = repository.runs.insert_one
    calls = 0

    def blocked_insert(document: dict[str, Any], **options: Any) -> Any:
        insert_entered.set()
        assert insert_release.wait(5), "The test did not release the pending Mongo insert"
        return insert(document, **options)

    monkeypatch.setattr(repository.runs, "insert_one", blocked_insert)

    async def produce() -> AsyncGenerator[str, None]:
        nonlocal calls
        async with _admitted(native_database):
            calls += 1
            producer_entered.set()
            yield _frame("RUN_FINISHED", runId="native-run", threadId=SESSION, outcome="success")

    caller = asyncio.create_task(coordinator.start(**_request(), producer=produce, outcome=lambda: "completed"))
    try:
        assert await asyncio.to_thread(insert_entered.wait, 5)
        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(caller, 5)
        insert_release.set()
        await asyncio.wait_for(producer_entered.wait(), 5)
        accepted = await repository.latest(**_scope())
        assert (await _terminal(repository, accepted.run_id)).status == "completed" and calls == 1
        retried = await coordinator.start(**_request(), producer=produce, outcome=lambda: "completed")
        assert retried.run_id == accepted.run_id and calls == 1
        assert native_database.db[EXECUTION_RUNS_COLLECTION].count_documents({}) == 1
        assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
    finally:
        insert_release.set()
        await asyncio.gather(caller, return_exceptions=True)
        await coordinator.shutdown()


async def test_shutdown_drains_pending_admission_without_orphaning_a_queued_run_or_starting_provider(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    coordinator = NativeRunCoordinator(repository)
    insert_entered, insert_release = Event(), Event()
    insert = repository.runs.insert_one
    calls = 0

    def blocked_insert(document: dict[str, Any], **options: Any) -> Any:
        insert_entered.set()
        assert insert_release.wait(5), "The test did not release the pending Mongo insert"
        return insert(document, **options)

    monkeypatch.setattr(repository.runs, "insert_one", blocked_insert)

    async def produce() -> AsyncGenerator[str, None]:
        nonlocal calls
        calls += 1
        yield _frame("RUN_FINISHED", runId="native-run", threadId=SESSION, outcome="success")

    caller = asyncio.create_task(coordinator.start(**_request(), producer=produce, outcome=lambda: "completed"))
    closing = None
    try:
        assert await asyncio.to_thread(insert_entered.wait, 5)
        closing = asyncio.create_task(coordinator.shutdown())
        await asyncio.sleep(0)
        assert not closing.done()
        insert_release.set()
        await asyncio.wait_for(closing, 5)
        await asyncio.gather(caller, return_exceptions=True)
        accepted = await repository.latest(**_scope())
        assert accepted.status == "interrupted" and calls == 0
        assert native_database.db[EXECUTION_RUNS_COLLECTION].count_documents({"active": True}) == 0
        assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
        with pytest.raises(NativeRunStorageError, match="shutting down"):
            await coordinator.start(**_request(turn_id="next-turn"), producer=produce, outcome=lambda: "completed")
    finally:
        insert_release.set()
        await asyncio.gather(caller, *([closing] if closing is not None else []), return_exceptions=True)
        await coordinator.shutdown()


async def test_late_stop_for_completed_turn_cannot_cancel_its_successor(native_database: SimpleNamespace) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    coordinator = NativeRunCoordinator(repository)
    entered, cleaned = asyncio.Event(), asyncio.Event()

    async def first() -> AsyncGenerator[str, None]:
        async with _admitted(native_database):
            yield _frame("RUN_FINISHED", runId="first-run", threadId=SESSION, outcome="success")

    async def second() -> AsyncGenerator[str, None]:
        async with _admitted(native_database):
            try:
                yield _frame("RUN_STARTED", runId="second-run", threadId=SESSION)
                entered.set()
                await asyncio.Event().wait()
            finally:
                cleaned.set()

    original = await coordinator.start(**_request(), producer=first, outcome=lambda: "completed")
    try:
        assert (await _terminal(repository, original.run_id)).status == "completed"
        successor = await coordinator.start(**_request(turn_id="next-turn"), producer=second, outcome=lambda: None)
        await asyncio.wait_for(entered.wait(), 5)
        assert not await coordinator.cancel(AGENT, SESSION, turn_id="original-turn")
        assert not cleaned.is_set() and (await repository.get(successor.run_id, **_scope())).status == "running"
        assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 1
        assert await coordinator.cancel(AGENT, SESSION, turn_id="next-turn")
        assert (await _terminal(repository, successor.run_id)).status == "cancelled" and cleaned.is_set()
        assert (await repository.get(original.run_id, **_scope())).status == "completed"
        assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
    finally:
        await coordinator.shutdown()


async def test_scoped_stop_during_pending_insert_cancels_only_that_request_before_provider_start(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    coordinator = NativeRunCoordinator(repository)
    insert_entered, insert_release = Event(), Event()
    insert = repository.runs.insert_one
    calls = 0

    def blocked_insert(document: dict[str, Any], **options: Any) -> Any:
        insert_entered.set()
        assert insert_release.wait(5), "The test did not release the pending Mongo insert"
        return insert(document, **options)

    monkeypatch.setattr(repository.runs, "insert_one", blocked_insert)

    async def produce() -> AsyncGenerator[str, None]:
        nonlocal calls
        calls += 1
        yield _frame("RUN_FINISHED", runId="native-run", threadId=SESSION, outcome="success")

    caller = asyncio.create_task(coordinator.start(**_request(), producer=produce, outcome=lambda: "completed"))
    stop = None
    try:
        assert await asyncio.to_thread(insert_entered.wait, 5)
        assert not await coordinator.cancel(AGENT, SESSION, turn_id="other-turn")
        assert not caller.done() and calls == 0
        stop = asyncio.create_task(coordinator.cancel(AGENT, SESSION, turn_id="original-turn"))
        await asyncio.sleep(0)
        assert not stop.done()
        insert_release.set()
        assert await asyncio.wait_for(stop, 5)
        accepted = await caller
        assert (await _terminal(repository, accepted.run_id)).status == "cancelled" and calls == 0
        assert native_database.db[EXECUTION_RUNS_COLLECTION].count_documents({"active": True}) == 0
        assert native_database.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
    finally:
        insert_release.set()
        await asyncio.gather(caller, *([stop] if stop is not None else []), return_exceptions=True)
        await coordinator.shutdown()


@pytest.mark.parametrize("terminal", [False, True], ids=["live-frame", "terminal-event"])
async def test_subscriber_tail_repair_acknowledges_pending_producer_write_without_failure_or_double_counting(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, terminal: bool,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, _ = await repository.create(**_request())
    frame = _frame("TEXT_MESSAGE_CONTENT", messageId="native-answer", delta="saved before cursor")
    if terminal:
        await repository.append_frame(run.run_id, frame)
    expected_cursor = 2 if terminal else 1
    update_entered, update_release = Event(), Event()
    update_one = repository.runs.update_one

    def blocked_cursor_update(query: dict[str, Any], update: dict[str, Any], **options: Any) -> Any:
        if query.get("active") is True and update.get("$set", {}).get("last_sequence") == expected_cursor:
            update_entered.set()
            assert update_release.wait(5), "The test did not release the pending cursor write"
        return update_one(query, update, **options)

    monkeypatch.setattr(repository.runs, "update_one", blocked_cursor_update)
    pending = asyncio.create_task(
        repository.finish(run.run_id, "completed") if terminal else repository.append_frame(run.run_id, frame),
    )
    try:
        assert await asyncio.to_thread(update_entered.wait, 5)
        remote = NativeRunRepository(native_database.mongo)
        repaired = await remote.replay(run.run_id, 0, **_scope())
        assert repaired.next_cursor == expected_cursor
        assert repaired.run.total_bytes == len(frame.encode("utf-8")) and repaired.run.frame_count == 1
        update_release.set()
        acknowledged = await asyncio.wait_for(pending, 5)
        assert (acknowledged.status == "completed") if terminal else (acknowledged.sequence == 1)
        completed = await repository.finish(run.run_id, "completed")
        assert completed.status == "completed" and completed.last_sequence == 2
        assert completed.total_bytes == repaired.run.total_bytes and completed.frame_count == 1
        assert native_database.db[EXECUTION_EVENTS_COLLECTION].count_documents({"run_id": run.run_id}) == 2
        assert [event.frame for event in (await remote.replay(run.run_id, 0, **_scope())).events if event.frame] == [frame]
    finally:
        update_release.set()
        await asyncio.gather(pending, return_exceptions=True)


async def test_permanently_removed_run_rejects_pending_cursor_write_and_removes_only_its_new_orphan(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, _ = await repository.create(**_request())
    original = _frame("TEXT_MESSAGE_CONTENT", messageId="native-answer", delta="previously acknowledged")
    orphan = _frame("TEXT_MESSAGE_CONTENT", messageId="native-answer", delta="new unacknowledged frame")
    await repository.append_frame(run.run_id, original)
    update_entered, update_release = Event(), Event()
    update_one = repository.runs.update_one

    def blocked_cursor_update(query: dict[str, Any], update: dict[str, Any], **options: Any) -> Any:
        if query.get("active") is True and update.get("$set", {}).get("last_sequence") == 2:
            update_entered.set()
            assert update_release.wait(5), "The test did not release the pending cursor write"
        return update_one(query, update, **options)

    monkeypatch.setattr(repository.runs, "update_one", blocked_cursor_update)
    pending = asyncio.create_task(repository.append_frame(run.run_id, orphan))
    try:
        assert await asyncio.to_thread(update_entered.wait, 5)
        native_database.db[EXECUTION_RUNS_COLLECTION].delete_one({"run_id": run.run_id})
        update_release.set()
        with pytest.raises(NativeRunStorageError):
            await asyncio.wait_for(pending, 5)
        stored = list(native_database.db[EXECUTION_EVENTS_COLLECTION].find({"run_id": run.run_id}))
        assert len(stored) == 1 and stored[0]["sequence"] == 1 and stored[0]["frame"] == original
        assert await repository.get(run.run_id, **_scope()) is None
    finally:
        update_release.set()
        await asyncio.gather(pending, return_exceptions=True)


async def test_reader_with_pre_cleanup_snapshot_rechecks_finishing_before_reporting_interruption(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, _ = await repository.create(**_request())
    lease_id = "example-live-lease"
    native_database.db[SESSION_RUNS_COLLECTION].insert_one({
        "agent_id": AGENT, "session_id": SESSION, "lease_id": lease_id,
        "lease_expires_at": datetime.now(timezone.utc) + timedelta(minutes=1),
    })
    await repository.bind_lease(run.run_id, lease_id)
    snapshot_read, release_read = Event(), Event()
    find_one = repository.runs.find_one
    blocked = False

    def snapshot_before_cleanup(query: dict[str, Any], *arguments: Any, **options: Any) -> Any:
        nonlocal blocked
        record = find_one(query, *arguments, **options)
        if query.get("run_id") == run.run_id and not blocked:
            blocked = True
            assert record["status"] == "running" and not record.get("finishing")
            snapshot_read.set()
            assert release_read.wait(5), "The test did not release the stale reader snapshot"
        return record

    monkeypatch.setattr(repository.runs, "find_one", snapshot_before_cleanup)
    pending = asyncio.create_task(repository.get(run.run_id, **_scope()))
    try:
        assert await asyncio.to_thread(snapshot_read.wait, 5)
        actor = NativeRunRepository(native_database.mongo)
        await actor.prepare_finish(run.run_id)
        native_database.db[SESSION_RUNS_COLLECTION].delete_one({"lease_id": lease_id})
        release_read.set()
        observed = await asyncio.wait_for(pending, 5)
        assert observed.status == "running"
        assert native_database.db[EXECUTION_RUNS_COLLECTION].find_one({"run_id": run.run_id})["status"] == "running"
        assert (await actor.finish(run.run_id, "completed")).status == "completed"
    finally:
        release_read.set()
        await asyncio.gather(pending, return_exceptions=True)


async def test_tail_repair_does_not_replace_newer_cleanup_time_with_an_old_event_timestamp(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = datetime.now(timezone.utc)
    monkeypatch.setattr(native_run_repository, "_now", lambda: clock)
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    run, _ = await repository.create(**_request())
    native_database.db[SESSION_RUNS_COLLECTION].insert_one({
        "agent_id": AGENT, "session_id": SESSION, "lease_id": "example-live-lease",
        "lease_expires_at": clock + timedelta(minutes=2),
    })
    await repository.bind_lease(run.run_id, "example-live-lease")
    update_one = repository.runs.update_one

    def fail_cursor_update(query: dict[str, Any], update: dict[str, Any], **options: Any) -> Any:
        if query.get("active") is True and "last_sequence" in update.get("$set", {}):
            raise OperationFailure("Simulated cursor write failure")
        return update_one(query, update, **options)

    monkeypatch.setattr(repository.runs, "update_one", fail_cursor_update)
    with pytest.raises(NativeRunStorageError):
        await repository.append_frame(run.run_id, _frame("RUN_FINISHED", outcome="success"))
    actor = NativeRunRepository(native_database.mongo)
    clock += timedelta(seconds=native_run_repository.STARTUP_TIMEOUT_SECONDS + 10)
    await actor.prepare_finish(run.run_id)
    cleanup_time = native_database.db[EXECUTION_RUNS_COLLECTION].find_one({"run_id": run.run_id})["updated_at"]
    native_database.db[SESSION_RUNS_COLLECTION].delete_one({"lease_id": "example-live-lease"})
    observed = await actor.replay(run.run_id, 0, **_scope())
    assert observed.run.status == "running" and observed.run.updated_at == cleanup_time
    assert observed.next_cursor == 1
    assert (await actor.finish(run.run_id, "completed")).status == "completed"
