"""One producer per native checkpoint across legacy and Engine entry points."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from pymongo import ReturnDocument
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError

from dynamic_agents.config import get_settings
from dynamic_agents.models import DynamicAgentConfig


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
            previous = await claim
        except DuplicateKeyError:
            pass
        else:
            await asyncio.to_thread(leases.update_one, {"_id": key, "active_run": run_id}, {
                "$set": {"active_run": None, "execution_owner": (previous or {}).get("execution_owner", owner)},
            })
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
        await asyncio.to_thread(
            leases.update_one,
            {"_id": key, "active_run": run_id},
            {"$set": {"active_run": None, "execution_owner": next_owner}},
        )
