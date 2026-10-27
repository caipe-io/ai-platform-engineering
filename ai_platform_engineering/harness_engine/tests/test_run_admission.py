from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import suppress

import mongomock
import pytest

from harness_engine.brokers import DefaultPromptCompiler
from harness_engine.coordinator import RunCoordinator
from harness_engine.models import (
    AgentBlueprint,
    CanonicalEventDraft,
    CreateRunRequest,
    RenderedPrompt,
    RunContext,
    RunRecord,
    RunStatus,
)
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import InMemoryRunRepository, MongoRunRepository, RunAdmissionError, RunRepository
from harness_engine.sessions import CAIPEAgentSessionManager
from tests.conftest import FakeHarnessAdapter, blueprint


@pytest.fixture(params=["memory", "mongo"])
async def durable_repository(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[RunRepository]:
    if request.param == "memory":
        repository = InMemoryRunRepository()
    else:
        client = mongomock.MongoClient(tz_aware=True)
        monkeypatch.setattr("harness_engine.repository.MongoClient", lambda *args, **kwargs: client)
        repository = MongoRunRepository("mongodb://example.test", "test", 3600)
    await repository.initialize()
    yield repository
    await repository.close()


class PausingCompiler(DefaultPromptCompiler):
    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.resume = asyncio.Event()

    async def compile(self, agent: AgentBlueprint) -> RenderedPrompt:
        self.entered.set()
        await self.resume.wait()
        return await super().compile(agent)


async def coordinators(
    repository: RunRepository, adapter: FakeHarnessAdapter | None = None,
) -> tuple[RunCoordinator, RunCoordinator, PausingCompiler, FakeHarnessAdapter]:
    adapter = adapter or FakeHarnessAdapter()
    registry = HarnessRegistry([adapter])
    validation = registry.validate(AgentBlueprint.model_validate(blueprint()))
    await repository.save_agent(
        validation.normalized_blueprint, validation.config_fingerprint, validation.catalog_revision, None
    )
    compiler = PausingCompiler()

    def coordinator() -> RunCoordinator:
        return RunCoordinator(
            repository, registry, CAIPEAgentSessionManager(repository, registry, b"test-key"), compiler
        )

    return coordinator(), coordinator(), compiler, adapter


def request(request_id: str = "request-1", message: str = "hello") -> CreateRunRequest:
    return CreateRunRequest(
        agent_id="agent-example", conversation_id="conversation-example", message=message, client_request_id=request_id
    )


async def test_duplicate_requests_join_one_producer_and_busy_turns_are_rejected(
    durable_repository: RunRepository,
) -> None:
    first, second, compiler, adapter = await coordinators(durable_repository)
    run = await first.start_run(request(), "test-user")
    await asyncio.wait_for(compiler.entered.wait(), 1)
    duplicate = await second.start_run(request(), "test-user")
    assert duplicate.run_id == run.run_id
    with pytest.raises(RunAdmissionError, match="active run"):
        await second.start_run(request("request-2"), "test-user")
    with pytest.raises(RunAdmissionError, match="different input"):
        await second.start_run(request(message="different"), "test-user")
    compiler.resume.set()
    await asyncio.wait_for(first._tasks[run.run_id], 1)
    assert len(adapter.calls) == 1
    retry = await second.start_run(request(), "test-user")
    assert retry.run_id == run.run_id
    assert retry.status == RunStatus.COMPLETED
    assert len(adapter.calls) == 1


async def test_clear_from_another_coordinator_fences_a_start_paused_in_compile(
    durable_repository: RunRepository,
) -> None:
    first, second, compiler, adapter = await coordinators(durable_repository)
    run = await first.start_run(request(), "test-user")
    task = first._tasks[run.run_id]
    await asyncio.wait_for(compiler.entered.wait(), 1)
    cleared = await second.clear_session("test-user", "agent-example", "conversation-example")
    assert cleared.cleared
    compiler.resume.set()
    with suppress(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert adapter.calls == []
    stored = await durable_repository.get_run(run.run_id)
    assert stored and stored.status == RunStatus.CANCELLED
    assert [event.event_type for event in await durable_repository.list_events(run.run_id, 0)] == ["run.cancelled"]


async def test_simultaneous_admission_and_dispatch_are_unique(durable_repository: RunRepository) -> None:
    first, _, _, _ = await coordinators(durable_repository)
    binding, version = await first._session_manager.resolve("test-user", "agent-example", "conversation-example")

    def run(number: int) -> RunRecord:
        return RunRecord(
            run_id=f"run-{number}",
            owner_subject="test-user",
            agent_id="agent-example",
            agent_version=version.version,
            conversation_id="conversation-example",
            binding_id=binding.binding_id,
            harness_id=binding.harness_id,
            profile_id=binding.profile_id,
            client_request_id="same-request",
            request_fingerprint="same-input",
        )

    results = await asyncio.gather(*(durable_repository.admit_run(run(number)) for number in range(8)))
    assert len({item.run_id for item, _ in results}) == 1
    assert sum(admitted for _, admitted in results) == 1
    run_id = results[0][0].run_id
    dispatched = await asyncio.gather(
        *(durable_repository.claim_dispatch(binding.binding_id, run_id) for _ in range(8))
    )
    assert sum(dispatched) == 1
    await durable_repository.close_session(binding.binding_id)
    assert not await durable_repository.claim_dispatch(binding.binding_id, run_id)


async def test_cancel_before_preparation_starts_releases_the_reservation(durable_repository: RunRepository) -> None:
    first, second, _, adapter = await coordinators(durable_repository)
    run = await first.start_run(request(), "test-user")
    cancelled = await first.cancel(run.run_id)
    assert cancelled and cancelled.status == RunStatus.CANCELLED
    assert adapter.calls == []
    binding = await second._session_manager.current("test-user", "agent-example", "conversation-example")
    assert binding and binding.active_run is None


class PausingAdapter(FakeHarnessAdapter):
    def __init__(self) -> None:
        super().__init__()
        self.entered = asyncio.Event()
        self.resume = asyncio.Event()
        self.drained = asyncio.Event()

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft]:
        self.calls.append(context)
        self.entered.set()
        try:
            await self.resume.wait()
            yield CanonicalEventDraft(event_type="content.delta", data={"text": "late"})
        finally:
            self.drained.set()


async def test_remote_cancel_keeps_the_reservation_until_the_producer_drains(
    durable_repository: RunRepository,
) -> None:
    adapter = PausingAdapter()
    first, second, compiler, _ = await coordinators(durable_repository, adapter)
    compiler.resume.set()
    run = await first.start_run(request(), "test-user")
    producer = first._tasks[run.run_id]
    try:
        await asyncio.wait_for(adapter.entered.wait(), 1)
        result = await second.cancel_active("test-user", "agent-example", "conversation-example")
        assert result.cancellation_requested
        assert not result.cancelled
        assert not producer.done()
        assert not adapter.drained.is_set()
        stored = await durable_repository.get_run(run.run_id)
        assert stored and stored.cancellation_requested and stored.status == RunStatus.RUNNING
        with pytest.raises(RunAdmissionError, match="active run"):
            await second.start_run(request("request-2"), "test-user")
        adapter.resume.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(producer, 1)
        assert adapter.drained.is_set()
        stored = await durable_repository.get_run(run.run_id)
        assert stored and stored.status == RunStatus.CANCELLED
        events = await durable_repository.list_events(run.run_id, 0)
        assert [event.event_type for event in events] == ["run.started", "run.cancelled"]
        continued = await second.start_run(request("request-2"), "test-user")
        await asyncio.wait_for(second._tasks[continued.run_id], 1)
        assert len(adapter.calls) == 2
    finally:
        adapter.resume.set()
        await first.shutdown()
        await second.shutdown()


async def test_remote_cancel_is_observed_while_prompt_preparation_is_paused(
    durable_repository: RunRepository,
) -> None:
    first, second, compiler, adapter = await coordinators(durable_repository)
    run = await first.start_run(request(), "test-user")
    await asyncio.wait_for(compiler.entered.wait(), 1)
    result = await second.cancel_active("test-user", "agent-example", "conversation-example")
    assert result.cancelled and result.cancellation_requested
    assert adapter.calls == []
    binding = await durable_repository.get_session(run.binding_id)
    assert binding and binding.active_run is None


async def test_cancel_without_a_live_owner_is_unconfirmed_and_cannot_free_the_binding(
    durable_repository: RunRepository,
) -> None:
    first, second, _, _ = await coordinators(durable_repository)
    binding, version = await first._session_manager.resolve("test-user", "agent-example", "conversation-example")
    run = RunRecord(
        run_id="run-example", owner_subject="test-user", agent_id="agent-example", agent_version=version.version,
        conversation_id="conversation-example", binding_id=binding.binding_id, harness_id=binding.harness_id,
        profile_id=binding.profile_id,
    )
    await durable_repository.admit_run(run)
    result = await second.cancel_active("test-user", "agent-example", "conversation-example")
    assert result.cancellation_requested and not result.cancelled
    with pytest.raises(RunAdmissionError, match="active run"):
        await second.start_run(request("request-2"), "test-user")
