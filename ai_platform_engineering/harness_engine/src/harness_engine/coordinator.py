"""Disconnect-independent execution with durable admission and producer fencing."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import AsyncIterator
from contextlib import suppress
from typing import Protocol
from uuid import uuid4

from harness_engine.brokers import PromptCompiler
from harness_engine.models import (
    TERMINAL_RUN_STATUSES,
    AgentVersion,
    CancelActiveRunResult,
    CanonicalEventDraft,
    CapabilityLevel,
    ClearAgentSessionResult,
    CreateRunRequest,
    ExecutionMode,
    ProviderTurnOutcome,
    RunContext,
    RunRecord,
    RunStatus,
    TurnInput,
)
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import RunAdmissionConflict, RunFencedError, RunRepository
from harness_engine.sessions import (
    AgentSessionClosedError,
    AgentSessionNotRunnableError,
    CAIPEAgentSessionManager,
)

logger = logging.getLogger(__name__)


class AgentNotRunnableError(Exception):
    """The requested agent or pinned version cannot be executed."""


class ProviderContractError(Exception):
    """An adapter failed the Engine's explicit turn outcome contract."""


class RunHistoryAdmissionError(Exception):
    """Visible history could not be durably registered before dispatch."""


class RunHistoryProjector(Protocol):
    async def admitted(self, run: RunRecord, request: CreateRunRequest) -> None: ...

    async def finalized(self, run: RunRecord) -> None: ...


class RunCoordinator:
    """Own provider tasks independently from subscribers, never replay lost work."""

    def __init__(
        self,
        repository: RunRepository,
        registry: HarnessRegistry,
        session_manager: CAIPEAgentSessionManager,
        prompt_compiler: PromptCompiler,
        *,
        lease_seconds: float = 30.0,
        history_projector: RunHistoryProjector | None = None,
    ) -> None:
        self._repository = repository
        self._registry = registry
        self._session_manager = session_manager
        self._prompt_compiler = prompt_compiler
        self._lease_seconds = lease_seconds
        self._history_projector = history_projector
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._run_bindings: dict[str, str] = {}
        self._producers: dict[str, str] = {}
        self._contexts: dict[str, RunContext] = {}
        self._cancel_tasks: dict[str, asyncio.Task[None]] = {}
        self._history_registrations: set[asyncio.Task[None]] = set()

    async def start_run(
        self,
        request: CreateRunRequest,
        owner_subject: str,
        traceparent: str | None = None,
    ) -> RunRecord:
        if await self._repository.is_context_deleted(request.conversation_id):
            raise RunAdmissionConflict("Execution context was permanently deleted")
        request_data = request.model_dump(mode="json", exclude={"client_request_id"})
        # Preserve accepted request identities from before these optional inputs.
        if not request.attachments:
            request_data.pop("attachments")
        if request.visible_conversation_id is None:
            request_data.pop("visible_conversation_id")
        fingerprint = hashlib.sha256(
            json.dumps(request_data, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        request_identity = json.dumps(
            [owner_subject, request.agent_id, request.conversation_id, request.client_request_id or uuid4().hex],
            separators=(",", ":"),
        )
        run_id = "run-" + hashlib.sha256(request_identity.encode()).hexdigest()
        existing = await self._repository.lookup_request(run_id, fingerprint, owner_subject=owner_subject, request=request)
        if existing:
            await self._wait_for_history_registration(existing, request)
            return existing
        try:
            binding, version = await self._session_manager.resolve(
                owner_subject,
                request.agent_id,
                request.conversation_id,
                expected_harness_id=request.expected_harness_id,
                required_capabilities=("attachments",) if request.attachments else (),
            )
        except AgentSessionNotRunnableError as exc:
            raise AgentNotRunnableError(request.agent_id) from exc
        producer_id = uuid4().hex
        descriptor = self._registry.adapter(binding.harness_id).descriptor
        profile = next((item for item in descriptor.profiles if item.id == binding.profile_id), None)
        run = RunRecord(
            run_id=run_id,
            owner_subject=owner_subject,
            agent_id=request.agent_id,
            agent_version=version.version,
            conversation_id=request.conversation_id,
            visible_conversation_id=request.visible_conversation_id,
            binding_id=binding.binding_id,
            harness_id=binding.harness_id,
            profile_id=binding.profile_id,
            contract_version=descriptor.contract_version,
            capabilities={**descriptor.capabilities, **(profile.capabilities if profile else {})},
            provider_session_id=binding.provider_session_id,
            client_request_id=request.client_request_id,
            protocol=request.protocol,
            traceparent=traceparent,
        )
        admitted, created = await self._repository.admit_run(run, fingerprint, producer_id, self._lease_seconds)
        if not created:
            await self._wait_for_history_registration(admitted, request)
            return admitted
        admission_ready: asyncio.Future[None] | None = None
        if self._projects_history(admitted):
            admission_ready = asyncio.get_running_loop().create_future()
            # A disconnected caller may stop awaiting admission, while the owner
            # still records its outcome. Retrieve any eventual exception.
            admission_ready.add_done_callback(lambda future: future.exception() if not future.cancelled() else None)
        task = asyncio.create_task(
            self._pump(admitted, version, request, producer_id, admission_ready), name=f"harness-run:{run_id}"
        )
        self._tasks[run_id] = task
        self._run_bindings[run_id] = run.binding_id
        self._producers[run_id] = producer_id

        def forget(_: asyncio.Task[None]) -> None:
            self._tasks.pop(run_id, None)
            self._run_bindings.pop(run_id, None)
            self._producers.pop(run_id, None)
            self._contexts.pop(run_id, None)
            self._cancel_tasks.pop(run_id, None)
            if not task.cancelled() and (error := task.exception()):
                logger.error(
                    "Run owner ended without a clean terminal result for %s (%s)", run_id, type(error).__name__
                )

        task.add_done_callback(forget)
        if admission_ready is not None:
            await asyncio.shield(admission_ready)
        return admitted

    async def _wait_for_history_registration(self, run: RunRecord, request: CreateRunRequest) -> None:
        if not self._projects_history(run):
            return
        assert self._history_projector is not None
        task = asyncio.create_task(self._history_projector.admitted(run, request))
        self._history_registrations.add(task)

        def forget(completed: asyncio.Task[None]) -> None:
            self._history_registrations.discard(completed)
            if not completed.cancelled():
                completed.exception()

        task.add_done_callback(forget)
        try:
            await asyncio.shield(task)
        except Exception as exc:
            raise RunAdmissionConflict("Visible history could not be registered") from exc

    def _projects_history(self, run: RunRecord) -> bool:
        capability = run.capabilities.get("history.server_owned")
        return self._history_projector is not None and run.visible_conversation_id is not None and (run.harness_id == "claude_code_acp" or (
            capability is not None and capability.level in {CapabilityLevel.NATIVE, CapabilityLevel.EMULATED}
        ))

    def _request_provider_stop(self, run_id: str) -> None:
        context = self._contexts.get(run_id)
        if context is None or run_id in self._cancel_tasks:
            return
        cancel = getattr(self._registry.adapter(context.binding.harness_id), "cancel", None)
        if not callable(cancel):
            return

        async def stop() -> None:
            try:
                await cancel(context)
            except Exception as exc:
                logger.error("Provider cancellation failed for %s (%s)", run_id, type(exc).__name__)

        self._cancel_tasks[run_id] = asyncio.create_task(stop(), name=f"harness-stop:{run_id}")

    async def _watch_claim(self, run_id: str, producer_id: str, task: asyncio.Task[None]) -> None:
        next_renewal = asyncio.get_running_loop().time() + self._lease_seconds / 4
        try:
            while True:
                await asyncio.sleep(min(0.1, self._lease_seconds / 4))
                # Observe Stop promptly during potentially slow prompt compilation,
                # without running a second execution owner or renewing every poll.
                if await self._repository.cancellation_requested(run_id):
                    if not await self._repository.provider_has_started(run_id):
                        task.cancel()
                        return
                    self._request_provider_stop(run_id)
                if asyncio.get_running_loop().time() < next_renewal:
                    continue
                if not await self._repository.renew_run(run_id, producer_id, self._lease_seconds):
                    self._request_provider_stop(run_id)
                    # A dispatched remote provider drains without further writes;
                    # loss of transport authority is not proof external work stopped.
                    if not await self._repository.provider_has_started(run_id):
                        task.cancel()
                    return
                next_renewal = asyncio.get_running_loop().time() + self._lease_seconds / 4
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("Run claim renewal failed for %s (%s)", run_id, type(exc).__name__)
            task.cancel()

    async def _require_claim(self, run_id: str, producer_id: str) -> None:
        if not await self._repository.renew_run(run_id, producer_id, self._lease_seconds):
            raise RunFencedError(run_id)

    async def _terminal(
        self, run_id: str, producer_id: str, event: str, status: RunStatus, data: dict[str, object] | None = None
    ) -> None:
        try:
            await self._repository.append_event(run_id, event, data or {}, status, producer_id=producer_id)
        except RunFencedError:
            # Reconciliation or clear already published a terminal result.
            return

    async def _pump(
        self, run: RunRecord, version: AgentVersion, request: CreateRunRequest, producer_id: str,
        admission_ready: asyncio.Future[None] | None = None,
    ) -> None:
        task = asyncio.current_task()
        assert task is not None
        heartbeat = asyncio.create_task(self._watch_claim(run.run_id, producer_id, task))
        provider_stream: AsyncIterator[CanonicalEventDraft | ProviderTurnOutcome] | None = None
        provider_drained = False
        adapter = None
        drain_only = False
        outcome: ProviderTurnOutcome | None = None
        try:
            await self._require_claim(run.run_id, producer_id)
            if self._projects_history(run):
                assert self._history_projector is not None
                try:
                    await self._history_projector.admitted(run, request)
                except Exception as exc:
                    raise RunHistoryAdmissionError(run.run_id) from exc
                await self._require_claim(run.run_id, producer_id)
            if admission_ready is not None and not admission_ready.done():
                admission_ready.set_result(None)
            rendered_prompt = await self._prompt_compiler.compile(version.blueprint)
            if request.context:
                rendered_prompt = rendered_prompt.model_copy(
                    update={
                        "system": (
                            f"{rendered_prompt.system}\n\n<client-system-context>\n{request.context}\n</client-system-context>"
                        )
                    }
                )
            # Compilation may yield while another replica clears the session.
            # Fence again before invoking any provider code or tools.
            await self._require_claim(run.run_id, producer_id)
            binding = await self._session_manager.current(run.owner_subject, run.agent_id, run.conversation_id)
            if binding is None or binding.binding_id != run.binding_id:
                raise RunFencedError(run.run_id)
            context = RunContext(
                blueprint=version.blueprint,
                binding=binding,
                prompt=rendered_prompt,
                turn=TurnInput(
                    run_id=run.run_id, message=request.message, traceparent=run.traceparent,
                    context=request.context,
                    attachments=request.attachments, visible_conversation_id=request.visible_conversation_id,
                ),
                producer_token=producer_id,
            )
            await self._repository.append_event(
                run.run_id,
                "run.started",
                {
                    "harness_id": run.harness_id,
                    "agent_version": run.agent_version,
                    "binding_id": run.binding_id,
                },
                RunStatus.RUNNING,
                producer_id=producer_id,
            )
            await self._require_claim(run.run_id, producer_id)
            if not await self._repository.begin_provider(run.run_id, producer_id, self._lease_seconds):
                raise RunFencedError(run.run_id)
            adapter = self._registry.adapter(run.harness_id)
            self._contexts[run.run_id] = context
            provider_stream = adapter.stream(context)
            async for event in provider_stream:
                if not drain_only:
                    drain_only = not await self._repository.renew_run(run.run_id, producer_id, self._lease_seconds)
                if drain_only:
                    continue
                if outcome is not None:
                    raise ProviderContractError("Provider emitted data after its turn outcome")
                if isinstance(event, ProviderTurnOutcome):
                    outcome = event
                    continue
                if event.event_type in {"run.completed", "run.cancelled", "run.failed", "run.interrupted"}:
                    raise ProviderContractError("Only the Engine may commit a terminal run event")
                updated_binding = await self._session_manager.observe_provider_event(context.binding, event)
                if updated_binding.provider_session_id != context.binding.provider_session_id:
                    context = context.model_copy(update={"binding": updated_binding})
                    self._contexts[run.run_id] = context
                    if updated_binding.provider_session_id:
                        await self._repository.update_run_provider_id(run.run_id, updated_binding.provider_session_id)
                if not await self._repository.cancellation_requested(run.run_id):
                    await self._repository.append_event(run.run_id, event.event_type, event.data, producer_id=producer_id)
            provider_drained = True
            await self._require_claim(run.run_id, producer_id)
            if await self._repository.cancellation_requested(run.run_id):
                raise asyncio.CancelledError
            await self._session_manager.ensure_active(context.binding)
            if adapter.descriptor.contract_version >= 2 and outcome is None:
                raise ProviderContractError("Provider stream ended without an explicit turn outcome")
            status = RunStatus(outcome.status) if outcome else RunStatus.COMPLETED
            data = {"checkpoint": outcome.checkpoint} if outcome and outcome.checkpoint is not None else {}
            await self._terminal(run.run_id, producer_id, f"run.{status.value}", status, data)
        except asyncio.CancelledError:
            current = await self._repository.get_run(run.run_id)
            if current and current.status not in TERMINAL_RUN_STATUSES:
                if await self._repository.cancellation_requested(run.run_id):
                    await self._terminal(run.run_id, producer_id, "run.cancelled", RunStatus.CANCELLED)
                else:
                    await self._repository.interrupt_run(run.run_id, producer_id)
            raise
        except (AgentSessionClosedError, RunFencedError):
            current = await self._repository.get_run(run.run_id)
            if current and current.status not in TERMINAL_RUN_STATUSES:
                await self._terminal(run.run_id, producer_id, "run.cancelled", RunStatus.CANCELLED)
        except (ProviderContractError, RunHistoryAdmissionError) as exc:
            code = "provider_contract_error" if isinstance(exc, ProviderContractError) else "history_admission_failed"
            await self._terminal(
                run.run_id, producer_id, "run.failed", RunStatus.FAILED,
                {"code": code, "message": "Harness execution could not satisfy its durable turn contract"},
            )
            if admission_ready is not None and not admission_ready.done():
                admission_ready.set_exception(RunAdmissionConflict("Visible history could not be registered"))
        except Exception as exc:
            logger.error("Harness execution failed for %s (%s)", run.run_id, type(exc).__name__)
            await self._terminal(
                run.run_id,
                producer_id,
                "run.failed",
                RunStatus.FAILED,
                {
                    "code": "provider_error",
                    "message": "Harness execution failed; inspect the correlated server trace",
                },
            )
        finally:
            if admission_ready is not None and not admission_ready.done():
                admission_ready.set_exception(RunAdmissionConflict("Run admission was interrupted before dispatch"))
            heartbeat.cancel()
            with suppress(asyncio.CancelledError):
                await heartbeat
            if provider_stream is not None and (close_stream := getattr(provider_stream, "aclose", None)):
                await close_stream()
                # In-process adapters await their local process/callback cleanup.
                # A closed remote transport alone is not external stop proof.
                if adapter is not None and adapter.descriptor.execution_mode == ExecutionMode.IN_PROCESS:
                    provider_drained = True
            # A failed terminal append keeps its lease until bounded read-side
            # reconciliation reports interruption; it must not admit overlap.
            await self._repository.release_run(run.run_id, producer_id, provider_drained=provider_drained)
            if cancel_task := self._cancel_tasks.get(run.run_id):
                if not cancel_task.done():
                    cancel_task.cancel()
                with suppress(asyncio.CancelledError):
                    await cancel_task
            if self._projects_history(run):
                assert self._history_projector is not None
                try:
                    current = await self._repository.get_run(run.run_id)
                    if current and current.status in TERMINAL_RUN_STATUSES:
                        await self._history_projector.finalized(current)
                except Exception as exc:
                    logger.error("Run history projection pending for %s (%s)", run.run_id, type(exc).__name__)

    async def cancel(self, run_id: str) -> RunRecord | None:
        run = await self._repository.request_cancellation(run_id)
        if run is None or run.status in TERMINAL_RUN_STATUSES:
            return run
        self._request_provider_stop(run_id)
        task = self._tasks.get(run_id)
        producer_id = self._producers.get(run_id)
        if task:
            if not task.done() and not task.cancelling() and not await self._repository.provider_has_started(run_id):
                task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=0.5)
            except TimeoutError:
                return await self._repository.get_run(run_id)
            except asyncio.CancelledError:
                if not task.done():
                    raise
            # A task cancelled before its first await never enters its finally.
            current = await self._repository.get_run(run_id)
            if producer_id and current and current.status not in TERMINAL_RUN_STATUSES:
                await self._terminal(run_id, producer_id, "run.cancelled", RunStatus.CANCELLED)
            if producer_id and not await self._repository.provider_has_started(run_id):
                await self._repository.release_run(run_id, producer_id)
        else:
            for _ in range(20):
                current = await self._repository.get_run(run_id)
                if current is None or current.status in TERMINAL_RUN_STATUSES:
                    return current
                await asyncio.sleep(0.025)
        return await self._repository.get_run(run_id)

    async def cancel_active(
        self, owner_subject: str, agent_id: str, conversation_id: str, client_request_id: str | None = None
    ) -> CancelActiveRunResult:
        run = await self._repository.get_active_run(owner_subject, agent_id, conversation_id, client_request_id)
        if run is None:
            return CancelActiveRunResult(cancelled=False)
        cancelled = await self.cancel(run.run_id)
        return CancelActiveRunResult(
            cancelled=cancelled is not None and cancelled.status == RunStatus.CANCELLED,
            cancellation_requested=cancelled is not None and cancelled.cancellation_requested,
            run_id=run.run_id,
        )

    async def clear_session(self, owner_subject: str, agent_id: str, conversation_id: str) -> ClearAgentSessionResult:
        binding = await self._session_manager.current(owner_subject, agent_id, conversation_id)
        if binding is None or binding.status == "closed":
            return ClearAgentSessionResult(
                cleared=False,
                closed_binding_id=binding.binding_id if binding else None,
                next_epoch=binding.epoch + 1 if binding else 0,
            )
        # Closing the durable binding is the linearization point. Remote pumps
        # lose renewal authority before local cancellation or provider cleanup.
        closed = await self._repository.close_session(binding.binding_id)
        for run_id, binding_id in list(self._run_bindings.items()):
            if binding_id == binding.binding_id:
                await self.cancel(run_id)
        # A remote producer observes the closed binding via its renewable claim.
        await self._registry.adapter(binding.harness_id).session_manager.close(binding)
        return ClearAgentSessionResult(cleared=True, closed_binding_id=closed.binding_id, next_epoch=closed.epoch + 1)

    async def delete_session(self, owner_subject: str, agent_id: str, conversation_id: str) -> None:
        if not await self._repository.is_context_deleted(conversation_id):
            raise RunAdmissionConflict("Permanent deletion must first fence the canonical conversation")
        bindings = await self._repository.context_sessions(owner_subject, agent_id, conversation_id)
        run_bindings = await self._repository.context_run_binding_ids(owner_subject, agent_id, conversation_id)
        if run_bindings - {binding.binding_id for binding in bindings}:
            raise RunAdmissionConflict("Retained execution has no binding; provider cleanup requires reconciliation")
        for binding in bindings:
            if binding.status != "closed":
                await self._repository.close_session(binding.binding_id)
        ids = {binding.binding_id for binding in bindings}
        for run_id, binding_id in list(self._run_bindings.items()):
            if binding_id in ids:
                await self.cancel(run_id)
        if not await self._repository.context_is_drained(owner_subject, agent_id, conversation_id):
            raise RunAdmissionConflict(
                "Deletion is waiting for the execution owner to stop; an unknown owner requires reconciliation"
            )
        for binding in bindings:
            adapter = self._registry.adapter(binding.harness_id)
            await adapter.session_manager.close(binding)
            if delete_provider_state := getattr(adapter, "delete_session", None):
                await delete_provider_state(binding)
        await self._repository.purge_context(owner_subject, agent_id, conversation_id)

    async def shutdown(self) -> None:
        tasks = [*self._tasks.values(), *self._history_registrations]
        for task in tasks:
            if not task.cancelling():
                task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task
