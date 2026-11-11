"""One producer per native checkpoint across legacy and Engine entry points."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from pymongo import ReturnDocument
from pymongo.collection import Collection
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError, PyMongoError

from dynamic_agents.config import get_settings
from dynamic_agents.models import DynamicAgentConfig

logger = logging.getLogger(__name__)


async def _drain[T](task: asyncio.Task[T]) -> T:
    """A cancelled subscriber must not abandon an in-flight ownership write."""
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    result = task.result()
    if cancelled:
        raise asyncio.CancelledError
    return result


async def _release(leases: Collection, key: str, run_id: str, owner: str) -> None:
    # No producer remains when this function is called. Keep the run fence if
    # storage is unavailable; an operator must verify quiescence before recovery.
    for attempt in range(3):
        try:
            await asyncio.to_thread(leases.update_one, {"_id": key, "active_run": run_id}, {
                "$set": {"active_run": None, "execution_owner": owner},
            })
            return
        except PyMongoError:
            if attempt == 2:
                logger.exception("Native lease release failed; recover stopped producer key=%s run=%s", key, run_id)
                raise
            await asyncio.sleep(0.05 * 2 ** attempt)


class NativeThreadBusyError(RuntimeError):
    """Another authorized producer currently owns the native thread."""


@asynccontextmanager
async def reserve_native_thread(
    db: Database | None,
    config: DynamicAgentConfig,
    thread_id: str,
    run_id: str,
    *,
    owner: str = "dynamic_agents",
    adopt: bool = False,
    handoff_to: str | None = None,
) -> AsyncIterator[None]:
    if db is None:
        yield
        return
    backend = config.backend.config if config.backend else None
    collection = (
        backend.checkpoint_collection
        if backend and backend.checkpoint_collection
        else get_settings().checkpoint_collection
    )
    key = hashlib.sha256(f"{collection}\0{thread_id}".encode()).hexdigest()
    leases = db["execution_thread_leases"]
    claim = asyncio.create_task(asyncio.to_thread(
        leases.find_one_and_update,
        {"_id": key, "active_run": None, **({} if adopt else {"execution_owner": {"$in": [owner, None]}})},
        {"$set": {"active_run": run_id, "execution_owner": owner}},
        upsert=True, return_document=ReturnDocument.BEFORE,
    ))
    try:
        previous = await asyncio.shield(claim)
    except asyncio.CancelledError:
        # Cancelling the await cannot stop a Mongo write already running in its
        # worker thread. Drain that claim and release it before returning.
        try:
            while not claim.done():
                try:
                    await asyncio.shield(claim)
                except asyncio.CancelledError:
                    continue
            previous = claim.result()
        except DuplicateKeyError:
            pass
        else:
            await _drain(asyncio.create_task(_release(
                leases, key, run_id, (previous or {}).get("execution_owner", owner),
            )))
        raise
    except DuplicateKeyError as exc:
        raise NativeThreadBusyError("Native conversation is active or belongs to another execution owner") from exc
    completed = False
    try:
        yield
        completed = True
    finally:
        # A handoff inspects state without executing a model/tool. Failed
        # reconciliation retains the previous owner; normal runs retain theirs.
        next_owner = (
            (handoff_to if completed else (previous or {}).get("execution_owner", owner)) if handoff_to else owner
        )
        await _drain(asyncio.create_task(_release(leases, key, run_id, next_owner)))
