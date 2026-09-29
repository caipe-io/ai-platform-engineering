"""Durable, attempt-scoped cleanup for unpublished private follow-up copies."""

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from dynamic_agents.config import get_settings
from dynamic_agents.services.mongo import MongoDBService

logger = logging.getLogger(__name__)
ATTEMPTS_COLLECTION = "autonomous_follow_up_copy_attempts"
COPY_LEASE = timedelta(minutes=5)
SWEEP_SECONDS = 60


class FollowUpContextUnavailable(HTTPException):
    """The ready mapping is stale; an explicit user request may create a new copy."""


class FollowUpArchived(HTTPException):
    """Keep the archived conversation and its mapping until the user restores it."""


def _invalidate_ready_copy(db: Any, record: dict) -> None:
    db["autonomous_follow_up_chats"].update_one(
        {"_id": record["_id"], "token": record["token"], "state": "ready",
         "conversation._id": record["conversation"]["_id"]},
        {"$set": {"state": "failed"}, "$unset": {"conversation": ""}},
    )
    raise FollowUpContextUnavailable(409, "This follow-up was removed or its saved context expired.")


def publish_follow_up_chat(db: Any, record: dict, *, checkpoint_collection: str | None = None) -> dict:
    """Idempotently publish a completed copy, including after a restart."""
    conversation = record["conversation"]
    existing = db["conversations"].find_one({"_id": conversation["_id"]})
    if existing and existing.get("deleted_at"):
        raise FollowUpArchived(409, "This follow-up chat is in the archive. Restore it before continuing.")
    collection = record.get("checkpoint_collection") or checkpoint_collection or get_settings().checkpoint_collection
    if not db[collection].find_one({"thread_id": conversation["_id"], "checkpoint_ns": ""}, {"_id": 1}):
        _invalidate_ready_copy(db, record)
    result = {"conversation_id": conversation["_id"], "run_id": record["run_id"]}
    if existing:
        # Do not upsert a chat another request could be permanently deleting.
        return result
    # Only a journaled, unfinished publication may recreate a missing row.
    # Once published, a missing conversation means it was permanently removed.
    if not db[ATTEMPTS_COLLECTION].find_one({"_id": conversation["_id"]}, {"_id": 1}):
        _invalidate_ready_copy(db, record)
    if not db["autonomous_follow_up_chats"].find_one({
        "_id": record["_id"], "token": record["token"], "state": "ready",
        "conversation._id": conversation["_id"],
    }, {"_id": 1}):
        raise HTTPException(409, "This follow-up changed during publication. Please try again.")
    db["conversations"].update_one(
        {"_id": conversation["_id"]}, {"$setOnInsert": conversation}, upsert=True,
    )
    return result


def renew_copy_lease(db: Any, attempt: dict) -> None:
    """A revoked or expired writer cannot start another copy step or publish."""
    now = datetime.now(timezone.utc)
    result = db["autonomous_follow_up_chats"].update_one(
        {"_id": attempt["registry_id"], "token": attempt["_id"], "state": "creating",
         "lease_until": {"$gt": now}},
        {"$set": {"lease_until": now + COPY_LEASE}},
    )
    if not result.matched_count:
        raise HTTPException(409, "This copy attempt expired. Please try again.")


def cleanup_copy_attempt(db: Any, attempt: dict) -> None:
    """Revoke expired writers before deleting only this attempt's destination.

    Tombstones remain until the writer acknowledges it has stopped. A process
    may resume an in-flight database write after its lease expires; repeated
    cleanup removes those late writes even if it subsequently crashes. Never
    TTL these records independently of their copied artifacts.
    """
    # Validate all deletion coordinates before removing any artifact.
    for field in ("_id", "registry_id", "checkpoint_collection", "writes_collection", "gridfs_bucket"):
        if not isinstance(attempt.get(field), str) or not attempt[field]:
            raise ValueError(f"Invalid follow-up copy journal field: {field}")
    destination = attempt["_id"]
    registry = db["autonomous_follow_up_chats"]
    journal = db[ATTEMPTS_COLLECTION]
    current = registry.find_one({"_id": attempt["registry_id"]})
    if current and current.get("token") == destination and current.get("state") == "creating":
        revoked = registry.update_one(
            {"_id": attempt["registry_id"], "token": destination, "state": "creating",
             "lease_until": {"$lte": datetime.now(timezone.utc)}},
            {"$set": {"state": "failed"}},
        )
        if not revoked.matched_count:
            # The writer renewed or published between our read and revocation.
            journal.update_one({"_id": destination}, {"$set": {
                "cleanup_after": datetime.now(timezone.utc) + timedelta(seconds=SWEEP_SECONDS),
            }})
            return
    elif current and current.get("state") == "ready" and current["conversation"]["_id"] == destination:
        # A committed copy must become visible even if the original request
        # died before publication and the user never retries. Preserve archives.
        try:
            publish_follow_up_chat(db, current, checkpoint_collection=attempt["checkpoint_collection"])
        except FollowUpContextUnavailable:
            # No saved context: revoke the stale mapping and clean the attempt,
            # never publish an empty chat or re-create a permanently deleted one.
            pass
        except FollowUpArchived:
            journal.delete_one({"_id": destination})
            return
        else:
            journal.delete_one({"_id": destination})
            return
    # Also preserve published chats if their task/registry was later removed.
    if db["conversations"].find_one({"_id": destination}, {"_id": 1}):
        journal.delete_one({"_id": destination})
        return

    db[attempt["checkpoint_collection"]].delete_many({"thread_id": destination})
    db[attempt["writes_collection"]].delete_many({"thread_id": destination})
    db["messages"].delete_many({"conversation_id": destination})
    # Copy uploads use destination-prefixed IDs. Delete chunks too, including
    # interrupted uploads that never created a GridFS files/metadata document.
    file_ids = {"$regex": f"^{re.escape(destination)}:"}
    db[f"{attempt['gridfs_bucket']}.files"].delete_many({"_id": file_ids})
    db[f"{attempt['gridfs_bucket']}.chunks"].delete_many({"files_id": file_ids})
    if attempt.get("writer_stopped"):
        journal.delete_one({"_id": destination, "writer_stopped": True})
    else:
        journal.update_one({"_id": destination}, {"$set": {
            "cleanup_after": datetime.now(timezone.utc) + timedelta(seconds=SWEEP_SECONDS),
        }})


def finish_copy_attempt(db: Any, attempt: dict, *, writer_stopped: bool) -> None:
    """Finish local writes; retire recovery only when no server writes are pending."""
    try:
        db["autonomous_follow_up_chats"].update_one(
            {"_id": attempt["registry_id"], "token": attempt["_id"], "state": "creating"},
            {"$set": {"state": "failed"}},
        )
        journal = db[ATTEMPTS_COLLECTION]
        journal.update_one({"_id": attempt["_id"]}, {"$set": {"writer_stopped": writer_stopped}})
        cleanup_copy_attempt(db, {**attempt, "writer_stopped": writer_stopped})
    except Exception:  # noqa: BLE001 — cleanup must not replace the request's result/error
        # The pre-write journal survives database outages and process restarts.
        logger.exception("Follow-up copy cleanup deferred for attempt %s", attempt["_id"])


def reap_copy_attempts(mongo: MongoDBService) -> None:
    if mongo._db is None:
        return
    db = mongo._db
    for attempt in db[ATTEMPTS_COLLECTION].find({
        "cleanup_after": {"$lte": datetime.now(timezone.utc)},
    }).sort("cleanup_after", 1).limit(100):
        try:
            cleanup_copy_attempt(db, attempt)
        except Exception:  # noqa: BLE001 — isolate corrupt records and unexpected storage failures
            logger.exception("Could not clean follow-up copy attempt %s; will retry", attempt.get("_id"))
            try:
                db[ATTEMPTS_COLLECTION].update_one({"_id": {"$eq": attempt["_id"]}}, {"$set": {
                    "cleanup_after": datetime.now(timezone.utc) + timedelta(seconds=SWEEP_SECONDS),
                }})
            except Exception:  # noqa: BLE001 — a retry-bookkeeping failure must not stop this batch
                logger.exception("Could not defer follow-up copy attempt %s", attempt.get("_id"))


async def run_copy_cleanup(mongo: MongoDBService) -> None:
    """Recover abandoned copies at startup and periodically, without a request."""
    while True:
        try:
            await asyncio.to_thread(reap_copy_attempts, mongo)
        except Exception:  # noqa: BLE001 — supervise the long-lived worker; cancellation still propagates
            logger.exception("Follow-up copy recovery unavailable; will retry")
        await asyncio.sleep(SWEEP_SECONDS)
