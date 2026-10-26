from __future__ import annotations

import asyncio
import hashlib
import os
from collections.abc import AsyncIterator
from datetime import datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from harness_engine.brokers import DefaultPromptCompiler
from harness_engine.config import Settings
from harness_engine.coordinator import AgentNotRunnableError, RunCoordinator
from harness_engine.main import create_app
from harness_engine.models import (
    AgentBlueprint,
    CanonicalEventDraft,
    CreateRunRequest,
    RenderedPrompt,
    RunContext,
    RunRecord,
    RunStatus,
    SessionBinding,
    utc_now,
)
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import (
    InMemoryRunRepository,
    MongoRunRepository,
    ReplayUnavailableError,
    RunAdmissionConflict,
    RunFencedError,
)
from harness_engine.sessions import CAIPEAgentSessionManager
from tests.conftest import FakeHarnessAdapter, auth_headers, blueprint

Repository = InMemoryRunRepository | MongoRunRepository


@pytest.fixture(params=["memory", "mongodb"])
async def stores(request: pytest.FixtureRequest) -> AsyncIterator[tuple[Repository, Repository]]:
    if request.param == "memory":
        memory = InMemoryRunRepository()
        yield memory, memory
        return
    uri = os.environ.get("HARNESS_ENGINE_TEST_MONGODB_URI")
    if not uri:
        pytest.skip("Set HARNESS_ENGINE_TEST_MONGODB_URI to test standalone Mongo atomicity")
    database = "harness_engine_test_" + uuid4().hex
    first = MongoRunRepository(uri, database, 3600)
    second = MongoRunRepository(uri, database, 3600)
    await first.initialize()
    await second.initialize()
    try:
        yield first, second
    finally:
        await asyncio.to_thread(first._client.drop_database, database)
        await first.close()
        await second.close()


class PausedAdapter(FakeHarnessAdapter):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft]:
        self.calls.append(context)
        self.started.set()
        await self.release.wait()
        yield CanonicalEventDraft(event_type="content.delta", data={"text": "done"})


async def setup_coordinators(
    stores: tuple[Repository, Repository], adapter: FakeHarnessAdapter, compiler: DefaultPromptCompiler | None = None
) -> tuple[RunCoordinator, RunCoordinator]:
    registry = HarnessRegistry([adapter])
    definition = AgentBlueprint.model_validate(blueprint())
    await stores[0].save_agent(definition, "fingerprint", registry.catalog_revision, None)
    return tuple(
        RunCoordinator(
            repository,
            registry,
            CAIPEAgentSessionManager(repository, registry, b"test-key"),
            compiler or DefaultPromptCompiler(),
            lease_seconds=2,
        )
        for repository in stores
    )


def request_turn(client_request_id: str = "turn-example", **changes: Any) -> CreateRunRequest:
    return CreateRunRequest.model_validate(
        {
            "agent_id": "agent-example",
            "conversation_id": "conversation-example",
            "message": "test question",
            "client_request_id": client_request_id,
            **changes,
        }
    )


async def test_two_replicas_deduplicate_the_same_turn_and_reject_changed_payload(
    stores: tuple[Repository, Repository],
) -> None:
    adapter = PausedAdapter()
    first, second = await setup_coordinators(stores, adapter)
    try:
        one, two = await asyncio.gather(
            first.start_run(request_turn(protocol="custom"), "test-owner"),
            second.start_run(request_turn(protocol="custom"), "test-owner"),
        )
        await asyncio.wait_for(adapter.started.wait(), 2)
        assert one.run_id == two.run_id
        assert one.protocol == two.protocol == "custom"
        assert len(adapter.calls) == 1
        with pytest.raises(RunAdmissionConflict):
            await second.start_run(request_turn(message="changed question", protocol="custom"), "test-owner")
        with pytest.raises(RunAdmissionConflict):
            await second.start_run(request_turn(protocol="agui"), "test-owner")
        assert len(adapter.calls) == 1
    finally:
        await first.shutdown()
        await second.shutdown()


async def test_two_replicas_cannot_admit_distinct_turns_to_one_binding(stores: tuple[Repository, Repository]) -> None:
    adapter = PausedAdapter()
    first, second = await setup_coordinators(stores, adapter)
    try:
        results = await asyncio.gather(
            first.start_run(request_turn("turn-one"), "test-owner"),
            second.start_run(request_turn("turn-two"), "test-owner"),
            return_exceptions=True,
        )
        assert sum(isinstance(result, RunRecord) for result in results) == 1
        assert sum(isinstance(result, RunAdmissionConflict) for result in results) == 1
        await asyncio.wait_for(adapter.started.wait(), 2)
        assert len(adapter.calls) == 1
        active = await stores[1].get_latest_run("test-owner", "agent-example", "conversation-example")
        assert active is not None and active.status in {RunStatus.QUEUED, RunStatus.RUNNING}
    finally:
        await first.shutdown()
        await second.shutdown()


class PausedCompiler(DefaultPromptCompiler):
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def compile(self, definition: AgentBlueprint) -> RenderedPrompt:
        self.started.set()
        await self.release.wait()
        return await super().compile(definition)


async def test_other_replica_clear_during_compile_fences_before_provider_work(
    stores: tuple[Repository, Repository],
) -> None:
    compiler = PausedCompiler()
    adapter = PausedAdapter()
    first, second = await setup_coordinators(stores, adapter, compiler)
    try:
        run = await first.start_run(request_turn(), "test-owner")
        await asyncio.wait_for(compiler.started.wait(), 2)
        cleared = await second.clear_session("test-owner", "agent-example", "conversation-example")
        compiler.release.set()
        await asyncio.wait_for(asyncio.gather(*list(first._tasks.values()), return_exceptions=True), 2)
        current = await stores[1].get_run(run.run_id)
        assert cleared.cleared
        assert current is not None and current.status == RunStatus.CANCELLED
        assert adapter.calls == []
        duplicate = await second.start_run(request_turn(), "test-owner")
        assert duplicate.run_id == run.run_id and duplicate.status == RunStatus.CANCELLED
        assert adapter.calls == []
    finally:
        compiler.release.set()
        await first.shutdown()
        await second.shutdown()


async def test_compile_failure_has_a_terminal_event_and_releases_admission(
    stores: tuple[Repository, Repository],
) -> None:
    class BrokenCompiler(DefaultPromptCompiler):
        async def compile(self, definition: AgentBlueprint) -> RenderedPrompt:
            raise ValueError("test invalid prompt")

    adapter = PausedAdapter()
    first, second = await setup_coordinators(stores, adapter, BrokenCompiler())
    run = await first.start_run(request_turn(), "test-owner")
    await asyncio.gather(*list(first._tasks.values()))
    current = await stores[1].get_run(run.run_id)
    assert current is not None and current.status == RunStatus.FAILED
    events = await stores[1].list_events(run.run_id, 0)
    assert [event.event_type for event in events] == ["run.failed"]
    assert adapter.calls == []
    assert await stores[1].get_active_run("test-owner", "agent-example", "conversation-example") is None
    await first.shutdown()
    await second.shutdown()


async def test_cancel_is_bound_to_requested_turn_and_works_from_other_replica(
    stores: tuple[Repository, Repository],
) -> None:
    adapter = PausedAdapter()
    first, second = await setup_coordinators(stores, adapter)
    try:
        run = await first.start_run(request_turn(), "test-owner")
        await asyncio.wait_for(adapter.started.wait(), 2)
        wrong = await second.cancel_active("test-owner", "agent-example", "conversation-example", "old-turn")
        assert not wrong.cancelled and not wrong.cancellation_requested
        current = await stores[0].get_run(run.run_id)
        assert current is not None and current.status == RunStatus.RUNNING
        right = await second.cancel_active("test-owner", "agent-example", "conversation-example", "turn-example")
        assert right.cancellation_requested and not right.cancelled
        await asyncio.sleep(2.1)
        draining = await stores[1].get_run(run.run_id)
        assert draining and draining.status == RunStatus.RUNNING and draining.cancellation_requested
        adapter.release.set()
        await asyncio.wait_for(asyncio.gather(*list(first._tasks.values()), return_exceptions=True), 2)
        current = await stores[1].get_run(run.run_id)
        assert current is not None and current.status == RunStatus.CANCELLED
        assert (await second.start_run(request_turn(), "test-owner")).run_id == run.run_id
        assert len(adapter.calls) == 1
    finally:
        await first.shutdown()
        await second.shutdown()


async def test_cancel_before_task_starts_is_terminal_without_waiting_for_expiry(
    stores: tuple[Repository, Repository],
) -> None:
    adapter = PausedAdapter()
    first, second = await setup_coordinators(stores, adapter)
    run = await first.start_run(request_turn(), "test-owner")
    current = await first.cancel(run.run_id)
    assert current is not None and current.status == RunStatus.CANCELLED
    await first.shutdown()
    await second.shutdown()


async def make_claim(repository: Repository, run_id: str = "run-example") -> tuple[RunRecord, str]:
    registry = HarnessRegistry([FakeHarnessAdapter()])
    definition = AgentBlueprint.model_validate(blueprint())
    await repository.save_agent(definition, "fingerprint", registry.catalog_revision, None)
    manager = CAIPEAgentSessionManager(repository, registry, b"test-key")
    binding, _ = await manager.resolve("test-owner", "agent-example", "conversation-example")
    run = RunRecord(
        run_id=run_id,
        owner_subject="test-owner",
        agent_id=binding.agent_id,
        agent_version=1,
        conversation_id=binding.conversation_id,
        binding_id=binding.binding_id,
        harness_id=binding.harness_id,
        profile_id=binding.profile_id,
        provider_session_id=binding.provider_session_id,
        client_request_id="turn-example",
    )
    await repository.admit_run(run, "fingerprint", "producer-example", 30)
    return run, "producer-example"


async def expire_claim(repository: Repository, run: RunRecord) -> None:
    expired = utc_now() - timedelta(seconds=1)
    if isinstance(repository, MongoRunRepository):
        await asyncio.to_thread(
            repository._db.harness_sessions.update_one,
            {"binding_id": run.binding_id},
            {"$set": {"_lease_expires_at": expired}},
        )
    else:
        repository._session_claims[run.binding_id]["_lease_expires_at"] = expired


async def test_worker_loss_is_interrupted_and_never_replayed(stores: tuple[Repository, Repository]) -> None:
    run, producer = await make_claim(stores[0])
    await expire_claim(stores[0], run)
    interrupted = await stores[1].get_run(run.run_id)
    assert interrupted is not None and interrupted.status == RunStatus.FAILED
    assert interrupted.error_code == "execution_interrupted"
    binding = await stores[1].get_session(run.binding_id)
    assert binding is not None and binding.status == "degraded"
    duplicate = await stores[1].lookup_request(run.run_id, "fingerprint")
    assert duplicate is not None and duplicate.status == RunStatus.FAILED
    with pytest.raises(RunFencedError):
        await stores[0].append_event(run.run_id, "content.delta", {"text": "late"}, producer_id=producer)
    assert not await stores[0].renew_run(run.run_id, producer, 30)
    registry = HarnessRegistry([FakeHarnessAdapter()])
    manager = CAIPEAgentSessionManager(stores[1], registry, b"test-key")
    coordinator = RunCoordinator(stores[1], registry, manager, DefaultPromptCompiler())
    with pytest.raises(AgentNotRunnableError):
        await coordinator.start_run(request_turn("new-turn"), "test-owner")
    assert [event.event_type for event in await stores[1].list_events(run.run_id, 0)] == ["run.failed"]


async def test_lost_admission_before_claim_gets_a_bounded_terminal_result(
    stores: tuple[Repository, Repository],
) -> None:
    run = RunRecord(
        run_id="run-orphan",
        owner_subject="test-owner",
        agent_id="agent-example",
        agent_version=1,
        conversation_id="conversation-example",
        binding_id="binding-example",
        harness_id="agentcore",
        profile_id="primary",
    )
    await stores[0]._insert_run(
        {
            **run.model_dump(mode="python"),
            "_request_fingerprint": "fingerprint",
            "_producer_id": "lost-producer",
            "_admission_deadline": utc_now() - timedelta(seconds=1),
        }
    )
    current = await stores[1].get_run(run.run_id)
    assert current is not None and current.status == RunStatus.FAILED and current.error_code == "execution_interrupted"
    assert current.last_sequence == 1


class InjectedCrash(Exception):
    pass


@pytest.mark.parametrize("failure", ["before-event", "before-head"])
async def test_terminal_append_recovers_after_process_loss_without_publishing_a_missing_head(
    stores: tuple[Repository, Repository],
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    run, producer = await make_claim(stores[0])
    store = stores[0]._store_event
    change = stores[0]._change_run
    if failure == "before-event":

        async def fail_store(document: dict[str, Any]) -> None:
            raise InjectedCrash("test process stopped before event insert")

        monkeypatch.setattr(stores[0], "_store_event", fail_store)
    else:

        async def fail_head(
            run_id: str, expected: dict[str, Any], values: dict[str, Any], unset: tuple[str, ...] = ()
        ) -> dict[str, Any] | None:
            if "last_sequence" in values:
                raise InjectedCrash("test process stopped before head publication")
            return await change(run_id, expected, values, unset)

        monkeypatch.setattr(stores[0], "_change_run", fail_head)
    with pytest.raises(InjectedCrash):
        await stores[0].append_event(run.run_id, "run.completed", {}, RunStatus.COMPLETED, producer_id=producer)
    raw = await stores[0]._read_run(run.run_id)
    assert raw is not None and raw["last_sequence"] == 0 and raw["status"] == "queued"
    monkeypatch.setattr(stores[0], "_store_event", store)
    monkeypatch.setattr(stores[0], "_change_run", change)
    recovered = await stores[1].get_run(run.run_id)
    assert recovered is not None and recovered.status == RunStatus.COMPLETED and recovered.last_sequence == 1
    events = await stores[1].list_events(run.run_id, 0)
    assert [event.event_type for event in events] == ["run.completed"]
    assert [event.sequence for event in events] == [1]
    assert await stores[0].get_run(run.run_id) == recovered


async def test_replay_is_bounded_and_rejects_expired_or_missing_sequences(
    stores: tuple[Repository, Repository],
) -> None:
    run, producer = await make_claim(stores[0])
    for index in range(260):
        await stores[0].append_event(run.run_id, "content.delta", {"text": str(index)}, producer_id=producer)
    await stores[0].append_event(run.run_id, "run.completed", {}, RunStatus.COMPLETED, producer_id=producer)
    page = await stores[1].list_events(run.run_id, 0)
    assert len(page) == 256 and page[-1].sequence == 256
    tail = await stores[1].list_events(run.run_id, 256)
    assert tail[-1].event_type == "run.completed" and tail[-1].sequence == 261
    if isinstance(stores[0], MongoRunRepository):
        await asyncio.to_thread(stores[0]._db.harness_events.delete_one, {"run_id": run.run_id, "sequence": 1})
    else:
        stores[0]._events[run.run_id] = stores[0]._events[run.run_id][1:]
    with pytest.raises(ReplayUnavailableError):
        await stores[1].list_events(run.run_id, 0)
    with pytest.raises(ReplayUnavailableError):
        await stores[1].list_events(run.run_id, 999)


def test_http_retry_conflict_latest_owner_and_expired_replay(settings: Settings) -> None:
    adapter = FakeHarnessAdapter(delay=0.2)
    repository = InMemoryRunRepository()
    app = create_app(settings=settings, repository=repository, adapters=[adapter])
    with TestClient(app) as client:
        saved = client.put("/api/v1/agents/agent-example", headers=auth_headers(), json={"blueprint": blueprint()})
        assert saved.status_code == 200
        request = request_turn(protocol="custom").model_dump(mode="json")
        first = client.post("/api/v1/runs", headers=auth_headers(), json=request)
        duplicate = client.post("/api/v1/runs", headers=auth_headers(), json=request)
        assert first.status_code == duplicate.status_code == 202
        assert first.json()["data"]["run_id"] == duplicate.json()["data"]["run_id"]
        assert first.json()["data"]["protocol"] == "custom"
        changed = client.post("/api/v1/runs", headers=auth_headers(), json={**request, "message": "changed"})
        assert changed.status_code == 409
        params = {"agent_id": "agent-example", "conversation_id": "conversation-example"}
        latest = client.get("/api/v1/runs/latest", params=params, headers=auth_headers())
        assert latest.json()["data"]["run_id"] == first.json()["data"]["run_id"]
        hidden = client.get("/api/v1/runs/latest", params=params, headers=auth_headers("other-owner"))
        assert hidden.json()["data"] is None
        run_id = first.json()["data"]["run_id"]
        client.delete("/api/v1/runs/" + run_id, headers=auth_headers())
        repository._events[run_id] = []
        assert client.get(f"/api/v1/runs/{run_id}/events", headers=auth_headers()).status_code == 410
        assert client.get(f"/api/v1/runs/{run_id}/events/stream", headers=auth_headers()).status_code == 410


async def test_two_replicas_recover_the_same_pending_event_exactly_once(
    stores: tuple[Repository, Repository],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run, producer = await make_claim(stores[0])
    original = stores[0]._store_event

    async def crash(document: dict[str, Any]) -> None:
        raise InjectedCrash("test process loss")

    monkeypatch.setattr(stores[0], "_store_event", crash)
    with pytest.raises(InjectedCrash):
        await stores[0].append_event(run.run_id, "run.completed", {}, RunStatus.COMPLETED, producer_id=producer)
    monkeypatch.setattr(stores[0], "_store_event", original)
    one, two = await asyncio.gather(stores[0].get_run(run.run_id), stores[1].get_run(run.run_id))
    assert one is not None and two is not None and one.last_sequence == two.last_sequence == 1
    assert one.status == two.status == RunStatus.COMPLETED
    assert len(await stores[0].list_events(run.run_id, 0)) == 1


async def test_interrupt_revokes_an_unexpired_claim_and_blocks_late_publication(
    stores: tuple[Repository, Repository],
) -> None:
    run, producer = await make_claim(stores[0])
    assert await stores[0].renew_run(run.run_id, producer, 30)
    current = await stores[1].interrupt_run(run.run_id, producer)
    assert current is not None and current.status == RunStatus.FAILED and current.error_code == "execution_interrupted"
    assert not await stores[0].renew_run(run.run_id, producer, 30)
    with pytest.raises(RunFencedError):
        await stores[0].append_event(run.run_id, "content.delta", {"text": "late"}, producer_id=producer)


async def test_event_and_page_bytes_are_bounded_without_losing_the_cursor(
    stores: tuple[Repository, Repository],
) -> None:
    run, producer = await make_claim(stores[0])
    with pytest.raises(ValueError, match="size limit"):
        await stores[0].append_event(run.run_id, "content.delta", {"text": "x" * 1_048_576}, producer_id=producer)
    assert (await stores[0].get_run(run.run_id)).last_sequence == 0
    for _ in range(10):
        await stores[0].append_event(run.run_id, "content.delta", {"text": "x" * 900_000}, producer_id=producer)
    await stores[0].append_event(run.run_id, "run.completed", {}, RunStatus.COMPLETED, producer_id=producer)
    page = await stores[1].list_events(run.run_id, 0)
    assert 1 <= len(page) < 10
    rest = await stores[1].list_events(run.run_id, page[-1].sequence)
    assert rest[0].sequence == page[-1].sequence + 1
    assert rest[-1].event_type == "run.completed"


@pytest.mark.parametrize(
    "backend,header,expected",
    [
        ("memory", "matched", 503),
        ("mongodb", "matched", 200),
        ("mongodb", "0" * 64, 503),
        ("mongodb", "invalid", 503),
        ("memory", None, 200),
    ],
)
def test_integrated_storage_binding_fails_closed_without_exposing_coordinates(
    settings: Settings, backend: str, header: str | None, expected: int
) -> None:
    configured = settings.model_copy(update={"storage_backend": backend})
    app = create_app(settings=configured, repository=InMemoryRunRepository(), adapters=[FakeHarnessAdapter()])
    headers = auth_headers()
    if header is not None:
        headers["X-Harness-Engine-Storage-Binding"] = configured.storage_binding if header == "matched" else header
    with TestClient(app) as client:
        response = client.get("/api/v1/harnesses", headers=headers)
        assert response.status_code == expected
        assert configured.mongodb_uri not in response.text


async def tombstone(repository: Repository, conversation_id: str = "conversation-example") -> None:
    if isinstance(repository, MongoRunRepository):
        await asyncio.to_thread(
            repository._db.native_acp_deleted_sessions.update_one,
            {"_id": conversation_id},
            {"$setOnInsert": {"deleted_at": utc_now()}},
            upsert=True,
        )
    else:
        repository._deleted_contexts.add(conversation_id)


async def test_permanent_delete_requires_tombstone_drains_and_preserves_other_owner(
    stores: tuple[Repository, Repository],
) -> None:
    class DeletingAdapter(PausedAdapter):
        def __init__(self) -> None:
            super().__init__()
            self.deleted: list[str] = []

        async def delete_session(self, binding: SessionBinding) -> None:
            self.deleted.append(binding.binding_id)

    adapter = DeletingAdapter()
    first, second = await setup_coordinators(stores, adapter)
    try:
        run = await first.start_run(request_turn(), "test-owner")
        await asyncio.wait_for(adapter.started.wait(), 2)
        registry = HarnessRegistry([adapter])
        other, _ = await CAIPEAgentSessionManager(stores[0], registry, b"test-key").resolve(
            "other-owner", "agent-example", "conversation-example"
        )
        with pytest.raises(RunAdmissionConflict, match="first fence"):
            await second.delete_session("test-owner", "agent-example", "conversation-example")
        await tombstone(stores[0])
        with pytest.raises(RunAdmissionConflict, match="execution owner"):
            await second.delete_session("test-owner", "agent-example", "conversation-example")
        assert await stores[1].get_run(run.run_id) is None
        assert await stores[1]._read_run(run.run_id) is not None
        with pytest.raises(RunAdmissionConflict, match="deleted"):
            await second.start_run(request_turn("late-turn"), "test-owner")
        adapter.release.set()
        await asyncio.wait_for(asyncio.gather(*list(first._tasks.values()), return_exceptions=True), 2)
        await second.delete_session("test-owner", "agent-example", "conversation-example")
        assert adapter.deleted == [run.binding_id]
        assert await stores[0]._read_run(run.run_id) is None
        assert await stores[0].get_session(run.binding_id) is None
        assert await stores[0].get_session(other.binding_id) is not None
        assert await stores[0].is_context_deleted("conversation-example")
        assert len(adapter.calls) == 1
        await second.delete_session("test-owner", "agent-example", "conversation-example")
    finally:
        await first.shutdown()
        await second.shutdown()


async def test_delete_while_compiling_cannot_enter_provider_after_records_are_purged(
    stores: tuple[Repository, Repository],
) -> None:
    compiler = PausedCompiler()
    adapter = PausedAdapter()
    first, second = await setup_coordinators(stores, adapter, compiler)
    try:
        run = await first.start_run(request_turn(), "test-owner")
        await asyncio.wait_for(compiler.started.wait(), 2)
        await tombstone(stores[1])
        await second.delete_session("test-owner", "agent-example", "conversation-example")
        assert await stores[0]._read_run(run.run_id) is None
        compiler.release.set()
        await asyncio.wait_for(asyncio.gather(*list(first._tasks.values()), return_exceptions=True), 2)
        assert adapter.calls == []
        assert await stores[0]._read_run(run.run_id) is None
    finally:
        compiler.release.set()
        await first.shutdown()
        await second.shutdown()


async def test_clear_between_provider_marker_and_binding_admission_blocks_invocation(
    stores: tuple[Repository, Repository],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run, producer = await make_claim(stores[0])
    await stores[0].append_event(run.run_id, "run.started", {}, RunStatus.RUNNING, producer_id=producer)
    renew = stores[0]._renew_binding

    async def clear_then_renew(
        binding_id: str, run_id: str, producer_id: str, now: datetime, deadline: datetime
    ) -> bool:
        await stores[1].close_session(binding_id)
        return await renew(binding_id, run_id, producer_id, now, deadline)

    monkeypatch.setattr(stores[0], "_renew_binding", clear_then_renew)
    assert not await stores[0].begin_provider(run.run_id, producer, 30)
    current = await stores[1].get_run(run.run_id)
    assert current is not None and current.status == RunStatus.CANCELLED


async def test_deleted_after_claim_is_rejected_before_scheduling_provider(
    stores: tuple[Repository, Repository],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = PausedAdapter()
    first, second = await setup_coordinators(stores, adapter)
    claim = stores[0]._claim_binding

    async def claim_then_delete(binding_id: str, run_id: str, producer_id: str, deadline: datetime) -> bool:
        admitted = await claim(binding_id, run_id, producer_id, deadline)
        await tombstone(stores[1])
        return admitted

    monkeypatch.setattr(stores[0], "_claim_binding", claim_then_delete)
    with pytest.raises(RunAdmissionConflict, match="deleted"):
        await first.start_run(request_turn(), "test-owner")
    assert adapter.calls == [] and first._tasks == {}
    await second.delete_session("test-owner", "agent-example", "conversation-example")
    assert await stores[0].context_sessions("test-owner", "agent-example", "conversation-example") == []


async def test_unknown_expired_provider_owner_requires_ack_before_destructive_purge(
    stores: tuple[Repository, Repository],
) -> None:
    run, producer = await make_claim(stores[0])
    await stores[0].append_event(run.run_id, "run.started", {}, RunStatus.RUNNING, producer_id=producer)
    assert await stores[0].begin_provider(run.run_id, producer, 30)
    await expire_claim(stores[0], run)
    interrupted = await stores[1].get_run(run.run_id)
    assert interrupted is not None and interrupted.error_code == "execution_interrupted"
    await tombstone(stores[0])
    registry = HarnessRegistry([FakeHarnessAdapter()])
    coordinator = RunCoordinator(
        stores[1], registry, CAIPEAgentSessionManager(stores[1], registry, b"test-key"), DefaultPromptCompiler()
    )
    with pytest.raises(RunAdmissionConflict, match="unknown owner"):
        await coordinator.delete_session("test-owner", "agent-example", "conversation-example")
    assert await stores[1]._read_run(run.run_id) is not None
    await stores[0].release_run(run.run_id, producer)
    with pytest.raises(RunAdmissionConflict, match="unknown owner"):
        await coordinator.delete_session("test-owner", "agent-example", "conversation-example")
    # Explicit provider-drain confirmation is stronger than a stopped local task.
    await stores[0].release_run(run.run_id, producer, provider_drained=True)
    await coordinator.delete_session("test-owner", "agent-example", "conversation-example")
    assert await stores[1]._read_run(run.run_id) is None


def test_delete_api_requires_canonical_fence_and_blocks_late_create(settings: Settings) -> None:
    repository = InMemoryRunRepository()
    app = create_app(settings=settings, repository=repository, adapters=[FakeHarnessAdapter()])
    body = {"agent_id": "agent-example", "conversation_id": "conversation-example"}
    with TestClient(app) as client:
        assert client.post("/api/v1/sessions/delete", headers=auth_headers(), json=body).status_code == 409
        repository._deleted_contexts.add("conversation-example")
        assert client.post("/api/v1/sessions/delete", headers=auth_headers(), json=body).json() == {
            "success": True,
            "data": {"deleted": True},
        }
        late = client.post("/api/v1/runs", headers=auth_headers(), json={**body, "message": "late"})
        assert late.status_code == 409 and "deleted" in late.json()["detail"]


def test_rejected_capability_is_json422_instead_of_serialization_failure(settings: Settings) -> None:
    app = create_app(settings=settings, repository=InMemoryRunRepository(), adapters=[FakeHarnessAdapter()])
    definition = blueprint()
    definition["memory"] = {"enabled": True}
    with TestClient(app) as client:
        response = client.put("/api/v1/agents/agent-example", headers=auth_headers(), json={"blueprint": definition})
        assert response.status_code == 422
        assert response.json()["detail"]["issues"][0]["capability"] == "memory.long_term"


async def test_terminal_journal_does_not_admit_another_producer_until_cleanup_ack(
    stores: tuple[Repository, Repository],
) -> None:
    run, producer = await make_claim(stores[0])
    await stores[0].append_event(run.run_id, "run.completed", {}, RunStatus.COMPLETED, producer_id=producer)
    assert (await stores[1].get_run(run.run_id)).status == RunStatus.COMPLETED
    next_run = run.model_copy(update={"run_id": "run-next", "client_request_id": "turn-next"})
    with pytest.raises(RunAdmissionConflict):
        await stores[1].admit_run(next_run, "next-fingerprint", "next-producer", 30)
    await stores[0].release_run(run.run_id, producer)
    final_run = run.model_copy(update={"run_id": "run-final", "client_request_id": "turn-final"})
    admitted, created = await stores[1].admit_run(final_run, "final-fingerprint", "final-producer", 30)
    assert created and admitted.run_id == "run-final"


async def test_completed_run_with_lost_cleanup_owner_degrades_instead_of_holding_a_permanent_claim(
    stores: tuple[Repository, Repository],
) -> None:
    run, producer = await make_claim(stores[0])
    await stores[0].append_event(run.run_id, "run.completed", {}, RunStatus.COMPLETED, producer_id=producer)
    await expire_claim(stores[0], run)
    recovered = await stores[1].get_run(run.run_id)
    assert recovered is not None and recovered.status == RunStatus.COMPLETED
    binding = await stores[1].get_session(run.binding_id)
    assert binding is not None and binding.status == "degraded"
    assert not await stores[0].renew_run(run.run_id, producer, 30)
    registry = HarnessRegistry([FakeHarnessAdapter()])
    coordinator = RunCoordinator(
        stores[1], registry, CAIPEAgentSessionManager(stores[1], registry, b"test-key"), DefaultPromptCompiler()
    )
    await coordinator.clear_session("test-owner", "agent-example", "conversation-example")
    manager = CAIPEAgentSessionManager(stores[0], registry, b"test-key")
    fresh, _ = await manager.resolve("test-owner", "agent-example", "conversation-example")
    assert fresh.epoch == 1 and fresh.binding_id != run.binding_id


async def test_engine_admission_honors_the_existing_canonical_gateway_owner(
    stores: tuple[Repository, Repository],
) -> None:

    adapter = PausedAdapter()
    first, second = await setup_coordinators(stores, adapter)
    if isinstance(stores[0], MongoRunRepository):
        key = hashlib.sha256(b"agent-example\0conversation-example").hexdigest()
        await asyncio.to_thread(
            stores[0]._db.harness_gateway_bindings.insert_one,
            {
                "_id": key,
                "agent_id": "agent-example",
                "session_id": "conversation-example",
                "harness_id": "dynamic_agents",
            },
        )
    else:
        stores[0]._gateway_owners[("agent-example", "conversation-example")] = "dynamic_agents"
    with pytest.raises(RunAdmissionConflict, match="different harness"):
        await first.start_run(request_turn(), "test-owner")
    assert adapter.calls == [] and first._tasks == {}
    await first.shutdown()
    await second.shutdown()


async def test_pending_private_stop_migrates_to_public_contract_without_dispatch(
    stores: tuple[Repository, Repository],
) -> None:
    run, producer = await make_claim(stores[0])
    await stores[0]._change_run(run.run_id, {}, {"_cancel_requested": True}, ("cancellation_requested",))
    migrated = await stores[1].get_run(run.run_id)
    assert migrated and migrated.cancellation_requested
    raw = await stores[0]._read_run(run.run_id)
    assert raw and raw["cancellation_requested"] and "_cancel_requested" not in raw
    assert not await stores[0].renew_run(run.run_id, producer, 30)
    await stores[0].append_event(run.run_id, "run.started", {}, RunStatus.RUNNING, producer_id=producer)
    assert not await stores[0].begin_provider(run.run_id, producer, 30)


async def test_stopped_local_iterator_is_not_remote_provider_drain_proof(
    stores: tuple[Repository, Repository],
) -> None:
    adapter = PausedAdapter()
    first, second = await setup_coordinators(stores, adapter)
    run = await first.start_run(request_turn(), "test-owner")
    await asyncio.wait_for(adapter.started.wait(), 2)
    await first.shutdown()
    raw = await stores[0]._read_run(run.run_id)
    assert raw and raw["_producer_stopped"] and raw["_provider_started"] and not raw["_provider_drained"]
    await tombstone(stores[0])
    with pytest.raises(RunAdmissionConflict, match="unknown owner"):
        await second.delete_session("test-owner", "agent-example", "conversation-example")
    assert await stores[0]._read_run(run.run_id) is not None
    await second.shutdown()


async def test_direct_engine_admission_cannot_bypass_a_retained_app_binding(stores: tuple[Repository, Repository]) -> None:
    adapter = PausedAdapter()
    first, second = await setup_coordinators(stores, adapter)
    if isinstance(stores[0], MongoRunRepository):
        await asyncio.to_thread(stores[0]._db.conversations.insert_one, {
            "_id": "conversation-example",
            "app_binding": {"app_id": "example-app", "agent_id": "agent-example"},
        })
    else:
        stores[0]._gateway_owners[("agent-example", "conversation-example")] = "app:example-app"
    with pytest.raises(RunAdmissionConflict):
        await first.start_run(request_turn(), "test-owner")
    assert adapter.calls == [] and first._tasks == {}
    await first.shutdown()
    await second.shutdown()
