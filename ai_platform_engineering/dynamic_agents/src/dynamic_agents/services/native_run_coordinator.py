"""Detached native execution and cross-replica replay subscriptions.

Adapts the Harness Engine's service-owned pump and cursor replay lifecycle,
while delegating runtime admission, ACP, credentials and state to the existing
AgentExecutionService. A subscriber never owns or cancels the producer.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable
from contextlib import aclosing, suppress
from contextvars import ContextVar

from dynamic_agents.services.native_run_repository import (
    TERMINAL_STATUSES,
    NativeExecutionRun,
    NativeRunLimitError,
    NativeRunRepository,
    NativeRunStorageError,
    RunStatus,
)

logger = logging.getLogger(__name__)
POLL_SECONDS = 0.25
KEEPALIVE_SECONDS = 10.0
_admitted_callback: ContextVar[Callable[[str], Awaitable[None]] | None] = ContextVar(
    "native_run_admitted_callback", default=None,
)
_released_callback: ContextVar[Callable[[], Awaitable[None]] | None] = ContextVar(
    "native_run_released_callback", default=None,
)


async def mark_native_run_admitted(lease_id: str) -> None:
    """Bind the durable task to the single native lease after runtime admission."""
    callback = _admitted_callback.get()
    if callback is not None:
        await callback(lease_id)


async def mark_native_run_released() -> None:
    """Mark expected cleanup immediately before the native lease is released."""
    callback = _released_callback.get()
    if callback is not None:
        await callback()


class NativeRunCoordinator:
    """Retain authorized producers in service memory and durable events in Mongo."""

    def __init__(self, repository: NativeRunRepository) -> None:
        self.repository = repository
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._scopes: dict[str, tuple[str, str, str]] = {}
        self._starters: set[asyncio.Task[NativeExecutionRun]] = set()
        self._starter_scopes: dict[asyncio.Task[NativeExecutionRun], tuple[str, str, str]] = {}
        self._cancelled_starters: set[asyncio.Task[NativeExecutionRun]] = set()
        self._closed = False

    async def start(
        self, *, owner_subject: str, agent_id: str, session_id: str, turn_id: str, fingerprint: str, protocol: str,
        producer: Callable[[], AsyncIterator[str]], outcome: Callable[[], str | None],
    ) -> NativeExecutionRun:
        if self._closed:
            raise NativeRunStorageError("Native execution is shutting down")
        # A disconnected HTTP request must not leave a fully inserted queued
        # record without its authorized producer. Admission therefore belongs
        # to the service just as execution does, including its request context.
        starter = asyncio.create_task(self._admit_and_start(
            owner_subject=owner_subject, agent_id=agent_id, session_id=session_id,
            turn_id=turn_id, fingerprint=fingerprint, protocol=protocol,
            producer=producer, outcome=outcome,
        ), name=f"native-acp-admission:{turn_id}")
        self._starters.add(starter)
        self._starter_scopes[starter] = (agent_id, session_id, turn_id)
        detached = False

        def forget_starter(done: asyncio.Task[NativeExecutionRun]) -> None:
            self._starters.discard(done)
            self._starter_scopes.pop(done, None)
            self._cancelled_starters.discard(done)
            error = done.exception() if not done.cancelled() else None
            if detached and error is not None:
                logger.error(
                    "Native admission failed after its caller disconnected",
                    exc_info=(type(error), error, error.__traceback__),
                )

        starter.add_done_callback(forget_starter)
        try:
            return await asyncio.shield(starter)
        except asyncio.CancelledError:
            detached = True
            raise

    async def _admit_and_start(
        self, *, owner_subject: str, agent_id: str, session_id: str, turn_id: str, fingerprint: str, protocol: str,
        producer: Callable[[], AsyncIterator[str]], outcome: Callable[[], str | None],
    ) -> NativeExecutionRun:
        run, created = await self.repository.create(
            owner_subject=owner_subject, agent_id=agent_id, session_id=session_id,
            turn_id=turn_id, fingerprint=fingerprint, protocol=protocol,
        )
        if not created:
            return run
        if asyncio.current_task() in self._cancelled_starters:
            return await self.repository.finish(run.run_id, "cancelled")
        if self._closed:
            return await self.repository.finish(run.run_id, "interrupted", "worker_interrupted")
        # create_task copies the authorized request context. Credentials remain
        # only in that task's memory and are never serialized into run records.
        task = asyncio.create_task(self._pump(run, producer, outcome), name=f"native-acp-run:{run.run_id}")
        self._tasks[run.run_id] = task
        self._scopes[run.run_id] = (agent_id, session_id, turn_id)

        def forget(done: asyncio.Task[None]) -> None:
            self._tasks.pop(run.run_id, None)
            self._scopes.pop(run.run_id, None)
            if not done.cancelled() and done.exception() is not None:
                error = done.exception()
                logger.error(
                    "Native detached task failed during finalization",
                    exc_info=(type(error), error, error.__traceback__),
                )

        task.add_done_callback(forget)
        return run

    async def _watch_cancel(self, run: NativeExecutionRun, owner: asyncio.Task) -> None:
        while True:
            await asyncio.sleep(POLL_SECONDS)
            try:
                current = await self.repository.get(run.run_id, owner_subject=run.owner_subject)
            except Exception:
                logger.exception("Native detached cancellation observation failed for run %s", run.run_id)
                owner.cancel()
                return
            if current is None or current.cancel_requested or current.status == "interrupted":
                owner.cancel()
                return

    async def _pump(
        self, run: NativeExecutionRun, producer: Callable[[], AsyncIterator[str]], outcome: Callable[[], str | None],
    ) -> None:
        owner = asyncio.current_task()
        if owner is None:
            raise RuntimeError("Detached native execution requires an owning task")
        token = _admitted_callback.set(lambda lease_id: self.repository.bind_lease(run.run_id, lease_id))
        released_token = _released_callback.set(lambda: self.repository.prepare_finish(run.run_id))
        watcher = asyncio.create_task(self._watch_cancel(run, owner))
        status: RunStatus = "failed"
        error_code: str | None = None
        try:
            async with aclosing(producer()) as frames:
                async for frame in frames:
                    await self.repository.append_frame(run.run_id, frame)
            final_outcome = outcome()
            status = (
                "awaiting_input" if final_outcome in {"interrupt", "awaiting_input"} else
                "failed" if final_outcome in {"error", "failed"} else
                "completed" if final_outcome in {"success", "completed"} else "interrupted"
            )
            if status == "interrupted":
                error_code = "missing_terminal_event"
        except asyncio.CancelledError:
            current = await self.repository.get(run.run_id, owner_subject=run.owner_subject, reconcile=False)
            status = "cancelled" if current is not None and current.cancel_requested else "interrupted"
            error_code = None if status == "cancelled" else "worker_interrupted"
        except Exception as exc:
            logger.exception("Native detached execution failed for run %s", run.run_id)
            error_code = "stream_storage_limit" if isinstance(exc, NativeRunLimitError) else "execution_failed"
        finally:
            watcher.cancel()
            with suppress(asyncio.CancelledError):
                await watcher
            _admitted_callback.reset(token)
            _released_callback.reset(released_token)
            # Runtime/ACP cleanup has completed before exposing a terminal run.
            await self.repository.finish(run.run_id, status, error_code)

    async def subscribe(self, run: NativeExecutionRun, after: int = 0) -> AsyncGenerator[str, None]:
        cursor = after
        heartbeat = asyncio.get_running_loop().time()
        while True:
            page = await self.repository.replay(run.run_id, cursor, owner_subject=run.owner_subject)
            if page is None:
                raise NativeRunStorageError("The native run is no longer available")
            for event in page.events:
                cursor = event.sequence
                if event.frame is not None:
                    yield f"id: {run.run_id}:{event.sequence}\n{event.frame}"
                elif event.status is not None:
                    # Native terminal frames remain unchanged. This transport
                    # lifecycle marker also closes runs whose worker vanished
                    # or failed before a native terminal frame was produced.
                    payload = json.dumps({
                        "run_id": event.run_id, "status": event.status, "failure_code": event.failure_code,
                    }, separators=(",", ":"))
                    yield f"id: {run.run_id}:{event.sequence}\nevent: CAIPE_RUN_STATUS\ndata: {payload}\n\n"
            if cursor == page.run.last_sequence and page.run.status in TERMINAL_STATUSES:
                return
            now = asyncio.get_running_loop().time()
            if now - heartbeat >= KEEPALIVE_SECONDS:
                yield ": keepalive\n\n"
                heartbeat = now
            await asyncio.sleep(POLL_SECONDS)

    async def cancel(self, agent_id: str, session_id: str, *, turn_id: str | None = None) -> bool:
        def matches(scope: tuple[str, str, str] | None) -> bool:
            return scope is not None and scope[:2] == (agent_id, session_id) and (
                turn_id is None or scope[2] == turn_id
            )

        starters = [
            starter for starter in self._starters
            if matches(self._starter_scopes.get(starter))
        ]
        self._cancelled_starters.update(starters)
        cancelled = await self.repository.request_cancel(agent_id, session_id, turn_id=turn_id)
        if starters:
            await asyncio.gather(*starters, return_exceptions=True)
            # A starter may have launched its pump immediately before the
            # cancellation marker. Signal that committed record as well.
            cancelled = await self.repository.request_cancel(agent_id, session_id, turn_id=turn_id) or cancelled
        targets = [
            (run_id, task) for run_id, task in self._tasks.items()
            if matches(self._scopes.get(run_id)) and not task.done()
        ]
        for _, task in targets:
            task.cancel()
        if targets:
            await asyncio.gather(*(task for _, task in targets), return_exceptions=True)
            # Cancellation before a newly created task's first instruction does
            # not enter its finally block. Finalize that queued record here.
            for run_id, _ in targets:
                await self.repository.finish(run_id, "cancelled")
        return cancelled or bool(targets) or bool(starters)

    async def shutdown(self) -> None:
        self._closed = True
        # Let in-flight Mongo inserts finish. Each admitted request observes
        # the closed service and persists interruption instead of launching.
        if self._starters:
            await asyncio.gather(*list(self._starters), return_exceptions=True)
        tasks = list(self._tasks.items())
        for _, task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*(task for _, task in tasks), return_exceptions=True)
            for run_id, _ in tasks:
                await self.repository.finish(run_id, "interrupted", "worker_interrupted")
