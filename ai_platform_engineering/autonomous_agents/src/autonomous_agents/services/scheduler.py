"""APScheduler runtime for cron and interval tasks.

Also exposes single-task ``register_scheduler_task`` /
``unregister_scheduler_task`` helpers so the CRUD endpoints can hot-reload the
scheduler without bouncing the service.
"""

import logging

from apscheduler.jobstores.base import JobLookupError
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger as APSCronTrigger
from apscheduler.triggers.interval import IntervalTrigger as APSIntervalTrigger

from autonomous_agents.config import get_settings
from autonomous_agents.models import (
    CronTrigger,
    IntervalTrigger,
    TaskDefinition,
    TriggerType,
)
from autonomous_agents.services.schedule_validation import validate_trigger_frequency

# ``execute_task`` is the APScheduler job target wired up below. The
# default ``MemoryJobStore`` stores callables by reference, so moving the
# function across modules is transparent at runtime. A persistent
# job store (none in use today) would serialise the target as
# "module:qualname" -- switching would require this import path to
# stay stable, hence this comment to deter casual refactors of the
# import line.
from autonomous_agents.services.task_runner import execute_task

logger = logging.getLogger("autonomous_agents")

_scheduler: AsyncIOScheduler | None = None


def get_scheduler() -> AsyncIOScheduler:
    """Initialize and return the global APScheduler instance"""
    global _scheduler
    if _scheduler is None:
        _scheduler = AsyncIOScheduler(timezone="UTC")
    return _scheduler


def register_scheduler_task(task: TaskDefinition) -> None:
    """Register a single cron / interval task with APScheduler.

    Idempotent: ``replace_existing=True`` means re-registering the same
    ``task.id`` (e.g. on update via the CRUD API) atomically replaces
    the prior job and any in-flight run completes against the new
    definition only on its *next* trigger fire.

    Webhook-only tasks are no-ops here -- webhooks have their own
    router-side runtime registry. Disabled tasks are *actively
    unscheduled* here so flipping ``enabled=false`` from the UI on an
    existing cron/interval task immediately stops it firing instead of
    leaving a zombie job until the next service restart (PR #5 review,
    Copilot+Codex P1).
    """
    if not task.enabled:
        # ``unregister_scheduler_task`` is a no-op when no job exists,
        # so this is safe for tasks that were never scheduled in the
        # first place (newly-created disabled tasks, webhook tasks, etc.).
        unregister_scheduler_task(task.id)
        logger.info(f"[{task.id}] Disabled -- not scheduling (any prior job removed)")
        return

    trigger = task.trigger

    if trigger.type == TriggerType.WEBHOOK:
        # Trigger-type swap from cron/interval -> webhook: detach the
        # old APScheduler job. Same idempotent contract as the
        # disabled-task branch above.
        unregister_scheduler_task(task.id)
        logger.info(
            f"[{task.id}] Webhook task -- handled by /hooks router, "
            "not APScheduler"
        )
        return

    if trigger.type == TriggerType.CRON:
        if not isinstance(trigger, CronTrigger):
            logger.warning(
                f"[{task.id}] Expected CronTrigger, got "
                f"{type(trigger).__name__} -- skipping"
            )
            return
        validate_trigger_frequency(
            trigger,
            get_settings().minimum_schedule_interval_seconds,
        )
        aps_trigger = APSCronTrigger.from_crontab(trigger.schedule, timezone="UTC")
        logger.info(f"[{task.id}] Scheduling cron: {trigger.schedule}")

    elif trigger.type == TriggerType.INTERVAL:
        if not isinstance(trigger, IntervalTrigger):
            logger.warning(
                f"[{task.id}] Expected IntervalTrigger, got "
                f"{type(trigger).__name__} -- skipping"
            )
            return
        validate_trigger_frequency(
            trigger,
            get_settings().minimum_schedule_interval_seconds,
        )
        aps_trigger = APSIntervalTrigger(
            seconds=trigger.seconds or 0,
            minutes=trigger.minutes or 0,
            hours=trigger.hours or 0,
        )
        logger.info(f"[{task.id}] Scheduling interval: {trigger.seconds}s / {trigger.minutes}m / {trigger.hours}h")

    else:
        logger.warning(f"[{task.id}] Unknown trigger type '{trigger.type}' -- skipping")
        return

    get_scheduler().add_job(
        execute_task,
        trigger=aps_trigger,
        args=[task],
        id=task.id,
        name=task.name,
        replace_existing=True,
        misfire_grace_time=60,
    )


def unregister_scheduler_task(task_id: str) -> bool:
    """Remove ``task_id`` from APScheduler if present.

    Returns ``True`` if a job was removed, ``False`` if no such job
    existed.
    """
    scheduler = get_scheduler()
    try:
        scheduler.remove_job(task_id)
        logger.info(f"[{task_id}] Removed from scheduler")
        return True
    except JobLookupError:
        # Not an error: webhook tasks and disabled tasks are never
        # added, so a "missing" job on delete is the common case.
        return False


def register_scheduler_tasks(tasks: list[TaskDefinition]) -> None:
    """Bulk-register all cron and interval tasks, then start the scheduler.

    Called once from the FastAPI lifespan with the task list loaded from MongoDB.
    Subsequent CRUD-driven changes go through
    :func:`register_scheduler_task` / :func:`unregister_scheduler_task`
    directly so the scheduler is never restarted at runtime.
    """
    for task in tasks:
        try:
            register_scheduler_task(task)
        except ValueError as exc:
            # Existing tasks may pre-date the configured frequency floor. Keep
            # the service available so an operator can edit them, but never
            # register the unsafe schedule.
            logger.error("[%s] Schedule rejected during startup: %s", task.id, exc)

    scheduler = get_scheduler()
    if not scheduler.running:
        scheduler.start()
    logger.info(f"Scheduler started with {len(scheduler.get_jobs())} job(s)")
