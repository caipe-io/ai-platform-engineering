"""Distributed native-turn admission and cancellation in the canonical database.

Leases coordinate workers, not external tool side effects. An expired worker
can lose admission and another worker can proceed; this does not provide
exactly-once execution or restore a crashed turn. Worker clocks must be synced.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING
from uuid import uuid4

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

if TYPE_CHECKING:
    from dynamic_agents.services.mongo import MongoDBService

logger = logging.getLogger(__name__)

SESSION_RUNS_COLLECTION = "native_acp_runs"
LEASE_SECONDS = 120
HEARTBEAT_SECONDS = 1


class SessionRunBusyError(RuntimeError):
    """Another worker owns the active turn for this native agent session."""


class SessionRunError(RuntimeError):
    """The canonical database could not safely coordinate native execution."""


async def await_session_operation[**P, T](operation: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    """Finish a synchronous state mutation before cancellation releases admission.

    Cancelling ``to_thread`` only stops waiting; it does not stop the thread.
    Shield and drain the operation even through repeated cancellation so this
    worker does not release its admission while the mutation is still running.
    """
    pending = asyncio.create_task(asyncio.to_thread(operation, *args, **kwargs))
    try:
        return await asyncio.shield(pending)
    except asyncio.CancelledError:
        while not pending.done():
            try:
                await asyncio.shield(pending)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not pending.cancelled():
            error = pending.exception()
            if error is not None:
                logger.error(
                    "Native session database operation failed while caller was cancelled",
                    exc_info=(type(error), error, error.__traceback__),
                )
        raise


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _reserve(mongo: MongoDBService, agent_id: str, session_id: str, lease_id: str) -> None:
    now = _now()
    try:
        record = mongo.get_session_runs_collection().find_one_and_update(
            {
                "agent_id": agent_id,
                "session_id": session_id,
                "$or": [{"lease_expires_at": {"$lte": now}}, {"lease_id": {"$exists": False}}],
            },
            {"$set": {
                "agent_id": agent_id,
                "session_id": session_id,
                "lease_id": lease_id,
                "lease_expires_at": now + timedelta(seconds=LEASE_SECONDS),
                "heartbeat_at": now,
                "cancel_requested": False,
            }},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        raise SessionRunBusyError("This agent session already has an active turn") from None
    except PyMongoError as exc:
        raise SessionRunError("Native turn admission is unavailable") from exc
    if record is None or record.get("lease_id") != lease_id:
        raise SessionRunError("Native turn admission did not return the owned lease")


def _heartbeat(mongo: MongoDBService, agent_id: str, session_id: str, lease_id: str) -> bool:
    now = _now()
    record = mongo.get_session_runs_collection().find_one_and_update(
        {
            "agent_id": agent_id,
            "session_id": session_id,
            "lease_id": lease_id,
            "lease_expires_at": {"$gt": now},
        },
        {"$set": {"heartbeat_at": now, "lease_expires_at": now + timedelta(seconds=LEASE_SECONDS)}},
        return_document=ReturnDocument.AFTER,
    )
    return record is not None and not record.get("cancel_requested", False)


async def _watch_owner(
    mongo: MongoDBService, agent_id: str, session_id: str, lease_id: str, owner: asyncio.Task,
) -> None:
    while True:
        await asyncio.sleep(HEARTBEAT_SECONDS)
        try:
            keep_running = await await_session_operation(_heartbeat, mongo, agent_id, session_id, lease_id)
        except (PyMongoError, RuntimeError):
            logger.exception("Native turn lease heartbeat failed for agent %s", agent_id)
            keep_running = False
        if not keep_running:
            owner.cancel()
            return


async def _release_owned_lease(mongo: MongoDBService, agent_id: str, session_id: str, lease_id: str) -> None:
    try:
        await await_session_operation(
            mongo.get_session_runs_collection().delete_one,
            {"agent_id": agent_id, "session_id": session_id, "lease_id": lease_id},
        )
    except (PyMongoError, RuntimeError):
        # An unavailable database leaves the bounded lease to expire. Never
        # mask turn failure/cancellation or delete another worker's admission.
        logger.exception("Native turn lease cleanup failed for agent %s", agent_id)


@asynccontextmanager
async def native_session_run(
    mongo: MongoDBService, agent_id: str, session_id: str,
) -> AsyncGenerator[None, None]:
    """Reserve before binding/config admission and release only this worker's lease."""
    owner = asyncio.current_task()
    if owner is None:
        raise SessionRunError("Native turn admission requires an owning task")
    lease_id = str(uuid4())
    try:
        await await_session_operation(_reserve, mongo, agent_id, session_id, lease_id)
    except asyncio.CancelledError:
        # Reserve has finished before this deletion; it cannot later create an
        # orphan admission after the caller is gone.
        await _release_owned_lease(mongo, agent_id, session_id, lease_id)
        raise
    watcher = asyncio.create_task(_watch_owner(mongo, agent_id, session_id, lease_id, owner))
    try:
        yield
    finally:
        watcher.cancel()
        with suppress(asyncio.CancelledError):
            await watcher
        await _release_owned_lease(mongo, agent_id, session_id, lease_id)


def request_native_session_cancel(mongo: MongoDBService, agent_id: str, session_id: str) -> bool:
    """Signal the active worker without assuming it runs in the requesting pod."""
    try:
        record = mongo.get_session_runs_collection().find_one_and_update(
            {"agent_id": agent_id, "session_id": session_id, "lease_expires_at": {"$gt": _now()}},
            {"$set": {"cancel_requested": True}},
            return_document=ReturnDocument.AFTER,
        )
    except PyMongoError as exc:
        raise SessionRunError("Native turn cancellation is unavailable") from exc
    return record is not None
