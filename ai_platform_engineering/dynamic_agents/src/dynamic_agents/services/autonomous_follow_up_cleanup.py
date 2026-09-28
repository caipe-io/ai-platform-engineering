"""Durable, attempt-scoped cleanup for unpublished private follow-up copies."""

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from pymongo.errors import PyMongoError

from dynamic_agents.services.mongo import MongoDBService

logger = logging.getLogger(__name__)
ATTEMPTS_COLLECTION = "autonomous_follow_up_copy_attempts"
COPY_LEASE = timedelta(minutes=5)
SWEEP_SECONDS = 60


def publish_follow_up_chat(db: Any, record: dict) -> dict:
    """Idempotently publish a completed copy, including after a restart."""
    conversation = record["conversation"]
    existing = db["conversations"].find_one({"_id": conversation["_id"]})
    if existing and existing.get("deleted_at"):
        raise HTTPException(409, "This follow-up chat is in the archive. Restore it before continuing.")
    db["conversations"].update_one(
        {"_id": conversation["_id"]}, {"$setOnInsert": conversation}, upsert=True,
    )
    return {"conversation_id": conversation["_id"], "run_id": record["run_id"]}


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
        if not db["conversations"].find_one({"_id": destination}, {"_id": 1}):
            try:
                publish_follow_up_chat(db, current)
            except HTTPException as exc:
                # A concurrent request may publish and archive it after our read.
                if exc.status_code != 409:
                    raise
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
    except PyMongoError:
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
        except PyMongoError:
            logger.exception("Could not clean follow-up copy attempt %s; will retry", attempt["_id"])


async def run_copy_cleanup(mongo: MongoDBService) -> None:
    """Recover abandoned copies at startup and periodically, without a request."""
    while True:
        try:
            await asyncio.to_thread(reap_copy_attempts, mongo)
        except PyMongoError:
            logger.exception("Follow-up copy recovery unavailable; will retry")
        await asyncio.sleep(SWEEP_SECONDS)
