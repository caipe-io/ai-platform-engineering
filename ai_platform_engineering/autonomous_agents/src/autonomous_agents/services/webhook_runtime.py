"""Webhook runtime registry and shared dispatch pipeline.

This module owns the live in-memory index of enabled webhook-triggered
tasks and the shared "claim -> run id -> background fire -> outcome"
tail used by the webhook routes. MongoDB remains the durable task
definition store; this module is the runtime view used by request
handlers.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any

from fastapi import BackgroundTasks, HTTPException

from autonomous_agents.models import FollowUpContext, TaskDefinition, TriggerType
from autonomous_agents.services.mongo import get_mongo_service
from autonomous_agents.services.task_runner import fire_webhook_task
from autonomous_agents.services.trigger_instances import (
    DedupKey,
    TriggerClaim,
    claim_trigger_instance,
)

logger = logging.getLogger("autonomous_agents")

# Tests and compatibility shims intentionally mutate this same object.
# Do not reassign ``_webhook_tasks = {}``.
_webhook_tasks: dict[str, TaskDefinition] = {}

# Per-task FIFO queues are process-local. They serialize each webhook task while
# allowing unrelated tasks to run concurrently. These queues are intentionally
# bounded; a durable/multi-replica deployment should replace this runtime with a
# broker (for example SQS FIFO) rather than pretending process memory is durable.
_dispatch_lock = threading.Lock()
_dispatch_pending = 0
_dispatch_pending_payload_bytes = 0
_dispatch_pending_by_task: dict[str, int] = {}
_dispatch_pending_by_owner: dict[str, int] = {}


@dataclass
class _DispatchLease:
    task_id: str
    owner_key: str
    payload_bytes: int
    released: bool = False


@dataclass(frozen=True)
class _QueuedWebhookRun:
    task: TaskDefinition
    context: dict[str, Any]
    follow_up: FollowUpContext | None
    run_id: str
    trigger_instance_id: str | None
    dispatch_lease: _DispatchLease
    max_concurrent_per_owner: int
    max_concurrent_global: int


_task_queues: dict[str, deque[_QueuedWebhookRun]] = {}
_task_drainers: set[str] = set()
_execution_loop: asyncio.AbstractEventLoop | None = None
_global_execution_semaphore: asyncio.Semaphore | None = None
_global_execution_limit = 0
_owner_execution_semaphores: dict[str, tuple[int, asyncio.Semaphore]] = {}


def _owner_capacity_key(task: TaskDefinition) -> str:
    if task.owner_sub:
        return f"sub:{task.owner_sub}"
    if task.owner_id:
        return f"id:{task.owner_id.casefold()}"
    # Legacy/unowned tasks cannot safely be grouped by a fabricated shared
    # owner. Isolate each under its own task id; the global cap still applies.
    return f"unowned-task:{task.id}"


def _try_reserve_queue_slot(
    task: TaskDefinition,
    *,
    payload_bytes: int,
    max_pending_per_task: int,
    max_pending_per_owner: int,
    max_pending_global: int,
    max_pending_payload_bytes_global: int,
) -> tuple[_DispatchLease | None, str | None]:
    global _dispatch_pending, _dispatch_pending_payload_bytes
    owner_key = _owner_capacity_key(task)
    with _dispatch_lock:
        if _dispatch_pending_by_task.get(task.id, 0) >= max_pending_per_task:
            return None, "task"
        if _dispatch_pending_by_owner.get(owner_key, 0) >= max_pending_per_owner:
            return None, "owner"
        if _dispatch_pending >= max_pending_global:
            return None, "global"
        if (
            _dispatch_pending_payload_bytes + payload_bytes
            > max_pending_payload_bytes_global
        ):
            return None, "global-payload-bytes"

        _dispatch_pending += 1
        _dispatch_pending_payload_bytes += payload_bytes
        _dispatch_pending_by_task[task.id] = (
            _dispatch_pending_by_task.get(task.id, 0) + 1
        )
        _dispatch_pending_by_owner[owner_key] = (
            _dispatch_pending_by_owner.get(owner_key, 0) + 1
        )
        return _DispatchLease(
            task_id=task.id,
            owner_key=owner_key,
            payload_bytes=payload_bytes,
        ), None


def _decrement_counter(counter: dict[str, int], key: str) -> None:
    remaining = counter.get(key, 0) - 1
    if remaining > 0:
        counter[key] = remaining
    else:
        counter.pop(key, None)


def _release_queue_slot(lease: _DispatchLease) -> None:
    global _dispatch_pending, _dispatch_pending_payload_bytes
    with _dispatch_lock:
        if lease.released:
            return
        lease.released = True
        _dispatch_pending = max(0, _dispatch_pending - 1)
        _dispatch_pending_payload_bytes = max(
            0, _dispatch_pending_payload_bytes - lease.payload_bytes
        )
        _decrement_counter(_dispatch_pending_by_task, lease.task_id)
        _decrement_counter(_dispatch_pending_by_owner, lease.owner_key)


def webhook_dispatch_pending(*, task_id: str | None = None) -> int:
    """Return pending (queued + running) work globally or for one task."""
    with _dispatch_lock:
        if task_id is not None:
            return _dispatch_pending_by_task.get(task_id, 0)
        return _dispatch_pending


def _reset_dispatch_limiter_for_tests() -> None:
    global _dispatch_pending, _dispatch_pending_payload_bytes
    global _execution_loop, _global_execution_semaphore
    global _global_execution_limit
    with _dispatch_lock:
        _dispatch_pending = 0
        _dispatch_pending_payload_bytes = 0
        _dispatch_pending_by_task.clear()
        _dispatch_pending_by_owner.clear()
        _task_queues.clear()
        _task_drainers.clear()
    _execution_loop = None
    _global_execution_semaphore = None
    _global_execution_limit = 0
    _owner_execution_semaphores.clear()


def get_webhook_task(task_id: str) -> TaskDefinition | None:
    """Look up a webhook task by id; returns ``None`` if not registered."""
    return _webhook_tasks.get(task_id)


def register_webhook_task(task: TaskDefinition) -> None:
    """Index a single webhook task for fast lookup at request time.

    Idempotent: re-registering the same id replaces the prior entry.
    Non-webhook (and disabled) tasks are silently skipped so the CRUD
    endpoints can call this unconditionally without first checking the
    trigger type.
    """
    if task.trigger.type != TriggerType.WEBHOOK:
        return

    if not task.enabled:
        # Ensure disabled webhook tasks cannot still be triggered.
        _webhook_tasks.pop(task.id, None)
        return

    _webhook_tasks[task.id] = task
    logger.info("Webhook task '%s' registered at POST /hooks/%s", task.id, task.id)


def unregister_webhook_task(task_id: str) -> bool:
    """Remove ``task_id`` from the webhook runtime registry if present.

    Returns ``True`` if an entry was removed, ``False`` otherwise. Same
    no-raise contract as :func:`services.scheduler.unregister_scheduler_task` so
    the CRUD layer can call both unconditionally.
    """
    return _webhook_tasks.pop(task_id, None) is not None


def register_webhook_tasks(tasks: list[TaskDefinition]) -> None:
    """Bulk-register webhook tasks (used by the FastAPI lifespan)."""
    for task in tasks:
        register_webhook_task(task)


@dataclass(frozen=True)
class DispatchOutcome:
    """Result of dispatching a webhook-triggered run.

    Callers translate this into their own JSON response shape because
    the exact envelope differs across endpoints (follow-up routes add
    ``parent_run_id``, initial fires don't). The helper deliberately
    does NOT build a dict, so adding a new field at one call site
    never has to thread through every other site.

    Fields:
        status_code: HTTP status the caller should set on the response.
            ``202`` when a fresh task was queued (claimed or no-dedup
            mode); ``200`` when the delivery was deduped to an existing
            run.
        run_id: The run id to surface to the sender. New UUID on
            ``claimed=True``; the prior run's id on ``claimed=False``.
        claimed: ``True`` when a new run was spawned. ``False`` when
            the delivery deduped to an existing run.
        trigger_instance_id: The ``trigger_instances`` row id (the
            dedup key). ``None`` only when the caller opted out of
            dedup by passing ``DedupKey(key=None, ...)``.
        dedup_strategy: Strategy label carried through from the
            :class:`DedupKey` for log/observability purposes.
    """

    status_code: int
    run_id: str
    claimed: bool
    trigger_instance_id: str | None
    dedup_strategy: str


async def _fire_and_log(
    *,
    task: TaskDefinition,
    context: dict[str, Any],
    follow_up: FollowUpContext | None,
    run_id: str,
    trigger_instance_id: str | None,
) -> None:
    """Background-task wrapper that runs the task and never re-raises.

    The webhook handler has already returned 202 to the sender by the
    time this runs (FastAPI's ``BackgroundTasks`` schedules this after
    the response has been sent). Any exception here is therefore
    invisible to the caller; we log loudly and let
    :func:`fire_webhook_task`'s own persistence path record the failed
    run.

    Note for tests: this is the call-time seam. Monkey-patch
    ``webhook_runtime._fire_and_log`` to observe what would have been
    fired without actually running the task, or replace
    ``webhook_runtime.fire_webhook_task`` to stub the firing primitive
    one frame deeper.
    """
    try:
        await fire_webhook_task(
            task,
            context=context,
            follow_up=follow_up,
            run_id=run_id,
            trigger_instance_id=trigger_instance_id,
        )
    except Exception as exc:  # noqa: BLE001 -- background task must not raise
        logger.exception(
            "[%s] Background webhook task crashed (run_id=%s): %s",
            task.id,
            run_id,
            exc,
        )


def _execution_semaphores(
    job: _QueuedWebhookRun,
) -> tuple[asyncio.Semaphore, asyncio.Semaphore]:
    """Return loop-local owner/global worker semaphores for ``job``."""
    global _execution_loop, _global_execution_semaphore
    global _global_execution_limit

    loop = asyncio.get_running_loop()
    if _execution_loop is not loop:
        # Production runs one uvicorn event loop. Reinitialising here keeps
        # isolated tests (which use a fresh loop per case) from sharing
        # asyncio primitives across loops.
        _execution_loop = loop
        _global_execution_semaphore = None
        _global_execution_limit = 0
        _owner_execution_semaphores.clear()

    if _global_execution_semaphore is None:
        _global_execution_limit = job.max_concurrent_global
        _global_execution_semaphore = asyncio.Semaphore(_global_execution_limit)
    elif _global_execution_limit != job.max_concurrent_global:
        raise RuntimeError("Webhook global concurrency changed while the queue is active")

    owner_entry = _owner_execution_semaphores.get(job.dispatch_lease.owner_key)
    if owner_entry is None:
        owner_entry = (
            job.max_concurrent_per_owner,
            asyncio.Semaphore(job.max_concurrent_per_owner),
        )
        _owner_execution_semaphores[job.dispatch_lease.owner_key] = owner_entry
    elif owner_entry[0] != job.max_concurrent_per_owner:
        raise RuntimeError("Webhook owner concurrency changed while the queue is active")

    return owner_entry[1], _global_execution_semaphore


async def _drain_task_queue(task_id: str) -> None:
    """Drain one task's FIFO, never running two deliveries concurrently."""
    try:
        while True:
            with _dispatch_lock:
                queue = _task_queues.get(task_id)
                if not queue:
                    _task_queues.pop(task_id, None)
                    _task_drainers.discard(task_id)
                    return
                job = queue[0]

            try:
                owner_semaphore, global_semaphore = _execution_semaphores(job)
                # Acquire the owner limit first so a noisy owner waiting for its
                # own quota does not occupy global worker capacity.
                async with owner_semaphore:
                    async with global_semaphore:
                        await _fire_and_log(
                            task=job.task,
                            context=job.context,
                            follow_up=job.follow_up,
                            run_id=job.run_id,
                            trigger_instance_id=job.trigger_instance_id,
                        )
            finally:
                with _dispatch_lock:
                    queue = _task_queues.get(task_id)
                    if queue:
                        if queue[0] is job:
                            queue.popleft()
                        else:  # pragma: no cover - defensive invariant repair
                            queue.remove(job)
                _release_queue_slot(job.dispatch_lease)
    finally:
        # Cancellation normally means process shutdown. Clearing the marker
        # ensures a surviving loop can schedule a drainer on the next delivery.
        with _dispatch_lock:
            _task_drainers.discard(task_id)
            if not _task_queues.get(task_id):
                _task_queues.pop(task_id, None)


def _enqueue_webhook_run(
    job: _QueuedWebhookRun,
    background_tasks: BackgroundTasks,
) -> None:
    """Append ``job`` to its task FIFO and schedule its single drainer."""
    with _dispatch_lock:
        queue = _task_queues.setdefault(job.task.id, deque())
        queue.append(job)
        schedule_drainer = job.task.id not in _task_drainers
        if schedule_drainer:
            _task_drainers.add(job.task.id)

    if not schedule_drainer:
        return

    try:
        background_tasks.add_task(_drain_task_queue, job.task.id)
    except Exception:
        with _dispatch_lock:
            queue = _task_queues.get(job.task.id)
            if queue is not None:
                queue.remove(job)
                if not queue:
                    _task_queues.pop(job.task.id, None)
            _task_drainers.discard(job.task.id)
        _release_queue_slot(job.dispatch_lease)
        raise


async def _claim_or_log(
    *,
    task_id: str,
    dedup_key: DedupKey,
    body: bytes,
) -> TriggerClaim:
    """Wrap :func:`claim_trigger_instance` so a Mongo error becomes a 503.

    The dedup table is the source of truth for "have we seen this
    delivery?". If Mongo is unreachable we cannot safely answer that
    question, so we surface a 503 to the sender rather than firing the
    task and risking duplicate execution. Senders that retry on 5xx
    will then re-deliver once Mongo recovers, at which point dedup
    works again -- which is the failure mode we want.
    """
    try:
        return await claim_trigger_instance(
            get_mongo_service(),
            task_id=task_id,
            dedup_key=dedup_key,
            body=body,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 -- translated to 503
        logger.error(
            "[%s] trigger_instances claim failed (key=%s): %s",
            task_id,
            dedup_key.key,
            exc,
        )
        raise HTTPException(
            status_code=503,
            detail="Webhook deduplication store unavailable; retry later.",
        ) from exc


async def dispatch_webhook_run(
    *,
    task: TaskDefinition,
    dedup_key: DedupKey,
    body: bytes,
    context: dict[str, Any],
    follow_up: FollowUpContext | None,
    background_tasks: BackgroundTasks,
    max_pending_per_task: int,
    max_pending_per_owner: int,
    max_pending_global: int,
    max_pending_payload_bytes_global: int,
    max_concurrent_per_owner: int,
    max_concurrent_global: int,
) -> DispatchOutcome:
    """Run the shared tail of the webhook pipeline.

    Three call sites share this sequence: claim the dedup row (or
    recognise that no dedup is possible), pre-allocate a ``run_id``,
    attach it to the dedup row, append it to the task's FIFO, and return
    the outcome. Exactly one drainer exists per task, so deliveries for the
    same webhook never execute concurrently.

    Scope note: dedup-key *derivation* is intentionally not done here
    -- each caller has its own rules (signature precedence on the
    initial fire, ``:followup:{parent}`` suffix on follow-ups, Webex
    builds its own directly). The helper consumes a pre-built key.

    Failure modes:
        * A task/owner/global queue item limit or the global queued-payload byte
          limit is reached -> 429; no dedup row or run is created.
        * Mongo unreachable during ``_claim_or_log`` -> propagates as
          a 503 :class:`HTTPException`. The sender retries.
        * ``attach_run_to_trigger_instance`` failure after a successful
          claim -> swallowed and logged. The dedup row is observability
          (audit trail "delivery X -> run Y"), not the source of truth
          for whether the task ran; the task still fires.
    """
    dispatch_lease, rejected_scope = _try_reserve_queue_slot(
        task,
        payload_bytes=len(body),
        max_pending_per_task=max_pending_per_task,
        max_pending_per_owner=max_pending_per_owner,
        max_pending_global=max_pending_global,
        max_pending_payload_bytes_global=max_pending_payload_bytes_global,
    )
    if dispatch_lease is None:
        # Do not emit a warning per rejection: an attacker could turn that into
        # log amplification. Operators can still enable debug logs temporarily.
        logger.debug(
            "[%s] Dropping webhook delivery: %s queue limit reached",
            task.id,
            rejected_scope,
        )
        raise HTTPException(
            status_code=429,
            detail="Webhook queue capacity reached; retry later.",
            headers={"Retry-After": "1"},
        )

    if dedup_key.key is None:
        # No dedup is possible (no header configured/present, no
        # signature, or caller opted out). Queue directly without
        # claiming a row; the response shape still matches the
        # dedup'd path so senders see one envelope.
        run_id = str(uuid.uuid4())
        try:
            _enqueue_webhook_run(
                _QueuedWebhookRun(
                    task=task,
                    context=context,
                    follow_up=follow_up,
                    run_id=run_id,
                    trigger_instance_id=None,
                    dispatch_lease=dispatch_lease,
                    max_concurrent_per_owner=max_concurrent_per_owner,
                    max_concurrent_global=max_concurrent_global,
                ),
                background_tasks,
            )
        except Exception:
            _release_queue_slot(dispatch_lease)
            raise
        return DispatchOutcome(
            status_code=202,
            run_id=run_id,
            claimed=True,
            trigger_instance_id=None,
            dedup_strategy=dedup_key.strategy,
        )

    try:
        claim = await _claim_or_log(task_id=task.id, dedup_key=dedup_key, body=body)
    except Exception:
        _release_queue_slot(dispatch_lease)
        raise

    if not claim.claimed:
        # Duplicate delivery -- sender retried. Report the original
        # run id so the sender (or anyone watching their logs) can
        # correlate. Status 200 distinguishes "we accepted it
        # already" from a fresh 202.
        _release_queue_slot(dispatch_lease)
        return DispatchOutcome(
            status_code=200,
            run_id=claim.existing_run_id or "",
            claimed=False,
            trigger_instance_id=claim.dedup_key,
            dedup_strategy=claim.strategy,
        )

    # New delivery: pre-allocate a run id (so we can return it in the
    # 202 without waiting for the task to start) and back-link it onto
    # the just-claimed row before appending to the task FIFO.
    run_id = str(uuid.uuid4())
    try:
        await get_mongo_service().attach_run_to_trigger_instance(
            claim.dedup_key, run_id
        )
    except Exception as exc:  # noqa: BLE001 -- audit-only, never block
        logger.warning(
            "[%s] Failed to pre-attach run_id=%s to trigger_instance=%s: %s",
            task.id,
            run_id,
            claim.dedup_key,
            exc,
        )

    try:
        _enqueue_webhook_run(
            _QueuedWebhookRun(
                task=task,
                context=context,
                follow_up=follow_up,
                run_id=run_id,
                trigger_instance_id=claim.dedup_key,
                dispatch_lease=dispatch_lease,
                max_concurrent_per_owner=max_concurrent_per_owner,
                max_concurrent_global=max_concurrent_global,
            ),
            background_tasks,
        )
    except Exception:
        _release_queue_slot(dispatch_lease)
        raise

    return DispatchOutcome(
        status_code=202,
        run_id=run_id,
        claimed=True,
        trigger_instance_id=claim.dedup_key,
        dedup_strategy=claim.strategy,
    )
