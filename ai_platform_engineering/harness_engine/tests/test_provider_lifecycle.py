from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest
from pydantic import ValidationError

from harness_engine.brokers import DefaultPromptCompiler
from harness_engine.coordinator import RunCoordinator
from harness_engine.models import (
    AgentBlueprint,
    AttachmentReference,
    CanonicalEventDraft,
    CapabilityLevel,
    CapabilityResult,
    CreateRunRequest,
    HarnessDescriptor,
    ProviderTurnOutcome,
    RunContext,
    RunRecord,
    RunStatus,
)
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import RunAdmissionConflict
from harness_engine.sessions import CAIPEAgentSessionManager
from tests.conftest import FakeHarnessAdapter, blueprint
from tests.test_durable_run_admission import Repository, request_turn
from tests.test_durable_run_admission import stores as stores


class OutcomeAdapter(FakeHarnessAdapter):
    def __init__(
        self, events: list[CanonicalEventDraft | ProviderTurnOutcome], *, attachments: bool = False, server_history: bool = False,
    ) -> None:
        super().__init__()
        self.events = events
        self.attachments = attachments
        self.server_history = server_history

    @property
    def descriptor(self) -> HarnessDescriptor:
        descriptor = super().descriptor
        if self.attachments:
            descriptor.capabilities["attachments"] = CapabilityResult(level=CapabilityLevel.NATIVE)
        if self.server_history:
            descriptor.capabilities["history.server_owned"] = CapabilityResult(level=CapabilityLevel.EMULATED)
        return descriptor.model_copy(update={"contract_version": 2})

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | ProviderTurnOutcome]:
        self.calls.append(context)
        for event in self.events:
            yield event


async def setup(
    repository: Repository, adapter: FakeHarnessAdapter, projector: object | None = None,
) -> RunCoordinator:
    registry = HarnessRegistry([adapter])
    definition = AgentBlueprint.model_validate(blueprint())
    await repository.save_agent(definition, "fingerprint", registry.catalog_revision, None)
    return RunCoordinator(
        repository, registry, CAIPEAgentSessionManager(repository, registry, b"test-key"),
        DefaultPromptCompiler(), lease_seconds=2, history_projector=projector,
    )


async def finish(coordinator: RunCoordinator, run: RunRecord) -> None:
    if task := coordinator._tasks.get(run.run_id):
        await asyncio.wait_for(asyncio.shield(task), 2)


@pytest.mark.parametrize("status", ["completed", "cancelled", "interrupted"])
async def test_explicit_outcome_is_the_only_terminal_event(
    stores: tuple[Repository, Repository], status: str,
) -> None:
    adapter = OutcomeAdapter([
        CanonicalEventDraft(event_type="content.delta", data={"text": "answer"}),
        ProviderTurnOutcome(status=status, checkpoint="checkpoint-example"),
    ])
    coordinator = await setup(stores[0], adapter)
    run = await coordinator.start_run(request_turn(), "test-user")
    await finish(coordinator, run)
    stored = await stores[1].get_run(run.run_id)
    assert stored and stored.status == RunStatus(status)
    events = await stores[1].list_events(run.run_id, 0)
    assert [event.event_type for event in events] == ["run.started", "content.delta", f"run.{status}"]
    assert events[-1].data == {"checkpoint": "checkpoint-example"}
    assert adapter.calls[0].producer_token
    assert "producer_token" not in adapter.calls[0].model_dump()


@pytest.mark.parametrize("events", [
    [],
    [ProviderTurnOutcome(status="completed"), ProviderTurnOutcome(status="completed")],
    [CanonicalEventDraft(event_type="run.completed")],
])
async def test_contract_two_fails_closed_without_one_final_outcome(
    stores: tuple[Repository, Repository], events: list[CanonicalEventDraft | ProviderTurnOutcome],
) -> None:
    coordinator = await setup(stores[0], OutcomeAdapter(events))
    run = await coordinator.start_run(request_turn(), "test-user")
    await finish(coordinator, run)
    stored = await stores[1].get_run(run.run_id)
    assert stored and stored.status == RunStatus.FAILED and stored.error_code == "provider_contract_error"
    assert [event.event_type for event in await stores[1].list_events(run.run_id, 0)] == ["run.started", "run.failed"]


class InteractiveAdapter(OutcomeAdapter):
    def __init__(self) -> None:
        super().__init__([])
        self.waiting = asyncio.Event()
        self.resume = asyncio.Event()
        self.stop_requested = asyncio.Event()
        self.stopped = asyncio.Event()
        self.cancel_calls = 0

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | ProviderTurnOutcome]:
        self.calls.append(context)
        yield CanonicalEventDraft(event_type="interrupt.requested", data={"id": "decision-example"})
        self.waiting.set()
        await self.resume.wait()
        if self.stop_requested.is_set():
            await self.stopped.wait()
            yield ProviderTurnOutcome(status="cancelled")
        else:
            yield CanonicalEventDraft(event_type="interrupt.resolved", data={"id": "decision-example"})
            yield CanonicalEventDraft(event_type="content.delta", data={"text": "resumed"})
            yield ProviderTurnOutcome(status="completed")

    async def cancel(self, context: RunContext) -> None:
        assert context.producer_token
        self.cancel_calls += 1
        self.stop_requested.set()
        self.resume.set()


async def test_pending_input_keeps_owner_and_resumes_the_same_run(stores: tuple[Repository, Repository]) -> None:
    adapter = InteractiveAdapter()
    coordinator = await setup(stores[0], adapter)
    run = await coordinator.start_run(request_turn(), "test-user")
    await asyncio.wait_for(adapter.waiting.wait(), 2)
    waiting = await stores[1].get_active_run("test-user", run.agent_id, run.conversation_id)
    assert waiting and waiting.status == RunStatus.AWAITING_INPUT
    assert waiting.pending_interrupt_id == "decision-example"
    assert await stores[1].renew_run(run.run_id, adapter.calls[0].producer_token, 2)
    assert [event.event_type for event in await stores[1].list_events(run.run_id, 0)] == ["run.started", "interrupt.requested"]
    adapter.resume.set()
    await finish(coordinator, run)
    completed = await stores[1].get_run(run.run_id)
    assert completed and completed.pending_interrupt_id is None
    assert [event.event_type for event in await stores[1].list_events(run.run_id, 0)] == [
        "run.started", "interrupt.requested", "interrupt.resolved", "content.delta", "run.completed",
    ]


async def test_cross_replica_cancel_calls_provider_once_and_holds_reservation_until_stopped(
    stores: tuple[Repository, Repository],
) -> None:
    adapter = InteractiveAdapter()
    coordinator = await setup(stores[0], adapter)
    run = await coordinator.start_run(request_turn(), "test-user")
    await asyncio.wait_for(adapter.waiting.wait(), 2)
    await stores[1].request_cancellation(run.run_id)
    await asyncio.wait_for(adapter.stop_requested.wait(), 2)
    for _ in range(3):
        coordinator._request_provider_stop(run.run_id)
    assert adapter.cancel_calls == 1
    active = await stores[1].get_active_run("test-user", run.agent_id, run.conversation_id)
    assert active and active.cancellation_requested and active.status == RunStatus.AWAITING_INPUT
    with pytest.raises(RunAdmissionConflict, match="active run"):
        await coordinator.start_run(request_turn("second-turn"), "test-user")
    task = coordinator._tasks[run.run_id]
    adapter.stopped.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(asyncio.shield(task), 2)
    stored = await stores[1].get_run(run.run_id)
    assert stored and stored.status == RunStatus.CANCELLED
    assert stored.pending_interrupt_id is None
    assert await stores[1].get_active_run("test-user", run.agent_id, run.conversation_id) is None
    binding = await stores[1]._read_binding(run.binding_id)
    assert binding and binding.get("_active_run_id") is None


def attachment() -> AttachmentReference:
    return AttachmentReference(id="artifact-example", name="example.txt", media_type="text/plain", size_bytes=7)


async def test_unsupported_attachments_fail_before_session_or_run_mutation(stores: tuple[Repository, Repository]) -> None:
    adapter = FakeHarnessAdapter()
    coordinator = await setup(stores[0], adapter)
    with pytest.raises(RunAdmissionConflict, match="attachments"):
        await coordinator.start_run(request_turn(attachments=[attachment()]), "test-user")
    assert adapter.calls == []
    assert await stores[1].get_latest_session("test-user", "agent-example", "conversation-example") is None
    assert await stores[1].get_latest_run("test-user", "agent-example", "conversation-example") is None


async def test_attachment_metadata_is_in_request_identity_and_provider_turn(stores: tuple[Repository, Repository]) -> None:
    adapter = OutcomeAdapter([ProviderTurnOutcome(status="completed")], attachments=True)
    coordinator = await setup(stores[0], adapter)
    request = request_turn(attachments=[attachment()])
    run = await coordinator.start_run(request, "test-user")
    await finish(coordinator, run)
    assert adapter.calls[0].turn.attachments == [attachment()]
    assert (await coordinator.start_run(request, "test-user")).run_id == run.run_id
    with pytest.raises(RunAdmissionConflict, match="different input"):
        await coordinator.start_run(request_turn(attachments=[attachment().model_copy(update={"size_bytes": 8})]), "test-user")


@pytest.mark.parametrize("supported", [False, True])
async def test_selected_profile_capability_override_controls_preflight_and_retained_run(
    stores: tuple[Repository, Repository], supported: bool,
) -> None:
    class ProfileAdapter(OutcomeAdapter):
        @property
        def descriptor(self) -> HarnessDescriptor:
            descriptor = super().descriptor
            descriptor.capabilities["attachments"] = CapabilityResult(level=CapabilityLevel.UNAVAILABLE if supported else CapabilityLevel.NATIVE)
            descriptor.profiles[0].capabilities["attachments"] = CapabilityResult(level=CapabilityLevel.NATIVE if supported else CapabilityLevel.UNAVAILABLE)
            return descriptor

    adapter = ProfileAdapter([ProviderTurnOutcome(status="completed")])
    coordinator = await setup(stores[0], adapter)
    if not supported:
        with pytest.raises(RunAdmissionConflict, match="attachments"):
            await coordinator.start_run(request_turn(attachments=[attachment()]), "test-user")
        assert adapter.calls == [] and await stores[1].get_latest_session("test-user", "agent-example", "conversation-example") is None
    else:
        run = await coordinator.start_run(request_turn(attachments=[attachment()]), "test-user")
        await finish(coordinator, run)
        retained = await stores[1].get_run(run.run_id)
        assert retained and retained.capabilities["attachments"].level == CapabilityLevel.NATIVE


def test_attachment_reference_rejects_urls_and_excess_input() -> None:
    with pytest.raises(ValidationError):
        AttachmentReference.model_validate({**attachment().model_dump(), "uri": "https://example.test/"})
    with pytest.raises(ValidationError):
        AttachmentReference.model_validate({**attachment().model_dump(), "id": "/etc/passwd"})
    with pytest.raises(ValidationError):
        request_turn(attachments=[attachment()] * 21)


class PausingProjector:
    def __init__(self, *, fail: bool = False) -> None:
        self.entered = asyncio.Event()
        self.resume = asyncio.Event()
        self.admissions: list[tuple[RunRecord, CreateRunRequest]] = []
        self.finals: list[RunRecord] = []
        self.fail = fail

    async def admitted(self, run: RunRecord, request: CreateRunRequest) -> None:
        self.admissions.append((run, request))
        self.entered.set()
        await self.resume.wait()
        if self.fail:
            raise ValueError("Projection registration unavailable")

    async def finalized(self, run: RunRecord) -> None:
        self.finals.append(run)


async def test_history_registration_is_shielded_and_precedes_provider_dispatch(
    stores: tuple[Repository, Repository],
) -> None:
    adapter = OutcomeAdapter([ProviderTurnOutcome(status="completed")], server_history=True)
    projector = PausingProjector()
    coordinator = await setup(stores[0], adapter, projector)
    caller = asyncio.create_task(coordinator.start_run(request_turn(visible_conversation_id="visible-example"), "test-user"))
    await asyncio.wait_for(projector.entered.wait(), 2)
    assert not caller.done() and adapter.calls == []
    caller.cancel()
    with pytest.raises(asyncio.CancelledError):
        await caller
    run = projector.admissions[0][0]
    projector.resume.set()
    await finish(coordinator, run)
    assert len(adapter.calls) == 1
    assert adapter.calls[0].turn.visible_conversation_id == "visible-example"
    assert len(projector.finals) == 1 and projector.finals[0].status == RunStatus.COMPLETED
    assert projector.finals[0].visible_conversation_id == "visible-example"


async def test_history_registration_failure_is_terminal_without_provider_effects(stores: tuple[Repository, Repository]) -> None:
    adapter = OutcomeAdapter([ProviderTurnOutcome(status="completed")], server_history=True)
    projector = PausingProjector(fail=True)
    projector.resume.set()
    coordinator = await setup(stores[0], adapter, projector)
    with pytest.raises(RunAdmissionConflict, match="history"):
        await coordinator.start_run(request_turn(visible_conversation_id="visible-example"), "test-user")
    run = projector.admissions[0][0]
    await finish(coordinator, run)
    assert adapter.calls == []
    stored = await stores[1].get_run(run.run_id)
    assert stored and stored.status == RunStatus.FAILED and stored.error_code == "history_admission_failed"
    assert len(projector.finals) == 1
