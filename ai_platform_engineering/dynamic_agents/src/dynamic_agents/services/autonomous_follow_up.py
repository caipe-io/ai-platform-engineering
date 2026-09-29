"""Create independent, reusable manual chats from completed autonomous runs."""

import logging
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from deepagents.graph import DeepAgentState
from deepagents.middleware.filesystem import FilesystemState
from fastapi import HTTPException
from langgraph.channels.delta import DeltaChannel
from langgraph.checkpoint.base import BaseCheckpointSaver, CheckpointTuple, empty_checkpoint
from langgraph.checkpoint.mongodb.saver import MongoDBSaver
from langgraph.checkpoint.serde.types import _DeltaSnapshot
from langgraph.graph import StateGraph
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

from dynamic_agents.config import Settings
from dynamic_agents.models import DynamicAgentConfig, UserContext
from dynamic_agents.services.autonomous_follow_up_cleanup import (
    ATTEMPTS_COLLECTION,
    COPY_LEASE,
    FollowUpContextUnavailable,
    finish_copy_attempt,
    publish_follow_up_chat,
    renew_copy_lease,
)
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.mongo import MongoDBService

logger = logging.getLogger(__name__)

# Read the runtime's channel definitions without initializing a model or MCP
# clients. Their reducers handle message removal, overwrites, and file deletion.
_RUN_DELTA_CHANNELS = {
    name: channel
    for schema in (FilesystemState, DeepAgentState)
    for name, channel in StateGraph(schema).channels.items()
    if isinstance(channel, DeltaChannel)
}


def _materialize_run_state(saver: BaseCheckpointSaver, entry: CheckpointTuple) -> dict[str, Any]:
    """Produce standalone values, not deltas that depend on the source thread."""
    values = deepcopy(entry.checkpoint.get("channel_values", {}))
    channels = {
        name: channel for name, channel in _RUN_DELTA_CHANNELS.items()
        if name in values or name in entry.checkpoint.get("channel_versions", {})
    }
    missing = [name for name in channels if name not in values]
    histories = saver.get_delta_channel_history(config=entry.config, channels=missing) if missing else {}
    for name, spec in channels.items():
        if name in values:
            # Handles both periodic delta snapshots and legacy inline values.
            channel = spec.from_checkpoint(values[name])
        else:
            history = histories[name]
            channel = spec.from_checkpoint(deepcopy(history.get("seed", spec.typ())))
            # The saver follows this checkpoint's parents only and excludes
            # its own pending writes, which belong to subsequent execution.
            channel.replay_writes(deepcopy(history["writes"]))
        values[name] = channel.get()
    return values


def _utc(value: datetime | str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def copy_run_checkpoint(
    saver: BaseCheckpointSaver,
    source_id: str,
    destination_id: str,
    finished_at: datetime | str,
) -> str:
    """Copy the root snapshot as it was when this run finished, never its later replies.

    Pending writes belong to subsequent execution and are deliberately not
    copied. A checkpoint that still requests tools cannot be used as a finished
    conversational turn: starting it could replay side effects.
    """
    cutoff = _utc(finished_at)
    # BSON dates lose sub-millisecond precision, unlike checkpoint timestamps.
    if cutoff.microsecond % 1000 == 0:
        cutoff += timedelta(microseconds=999)
    for entry in saver.list({"configurable": {"thread_id": source_id, "checkpoint_ns": ""}}):
        if _utc(entry.checkpoint["ts"]) <= cutoff:
            checkpoint = deepcopy(entry.checkpoint)
            checkpoint["channel_values"] = _materialize_run_state(saver, entry)
            messages = checkpoint.get("channel_values", {}).get("messages", [])
            if not messages:
                raise HTTPException(409, "This run has no saved conversation context.")
            if checkpoint.get("pending_sends") or getattr(messages[-1], "tool_calls", None):
                raise HTTPException(409, "This run stopped during tool execution and cannot be continued safely.")
            # Snapshot envelopes mark these as current delta-channel state,
            # not legacy values that may already subsume the next step's writes.
            # The destination must not depend on any source-thread ancestors.
            for name in _RUN_DELTA_CHANNELS:
                if name in checkpoint["channel_values"]:
                    checkpoint["channel_values"][name] = _DeltaSnapshot(checkpoint["channel_values"][name])
            # LangGraph sorts checkpoint IDs chronologically; use its generator.
            fresh = empty_checkpoint()
            checkpoint["id"] = fresh["id"]
            checkpoint["ts"] = fresh["ts"]
            saver.put(
                {"configurable": {"thread_id": destination_id, "checkpoint_ns": ""}},
                checkpoint,
                {"source": "fork", "step": entry.metadata.get("step", 0), "parents": {}},
                checkpoint["channel_versions"],
            )
            return entry.checkpoint["id"]
    raise HTTPException(409, "The saved context for this run is no longer available.")


def create_follow_up_chat(
    mongo: MongoDBService,
    settings: Settings,
    task: dict,
    run: dict,
    agent: DynamicAgentConfig,
    user: UserContext,
) -> dict:
    """Claim one branch per caller/run; retries never overwrite a live chat.

    Every initialization attempt uses a new destination ID. A Mongo lease and
    compare-and-swap publication prevent concurrent/retried clicks from resetting
    an already-used context. A failed or expired attempt can be retried.
    """
    db = mongo._db
    if db is None or mongo._client is None:
        raise HTTPException(503, "Database not connected")
    identity = user.email.strip().lower()
    key = str(uuid5(NAMESPACE_URL, f"autonomous-follow-up:{run['task_id']}:{run['run_id']}:{identity}"))
    registry = db["autonomous_follow_up_chats"]
    now = datetime.now(timezone.utc)
    destination_id = str(uuid4())
    token = destination_id
    backend = agent.backend.config if agent.backend else None
    checkpoint_collection = (
        backend.checkpoint_collection if backend and backend.checkpoint_collection
        else settings.checkpoint_collection
    )
    writes_collection = (
        f"{backend.checkpoint_collection}_writes" if backend and backend.checkpoint_collection
        else settings.checkpoint_writes_collection
    )
    existing = registry.find_one({"_id": key})
    if existing and existing.get("state") == "ready":
        try:
            return publish_follow_up_chat(db, existing, checkpoint_collection=checkpoint_collection)
        except FollowUpContextUnavailable:
            # Never reuse a deleted/expired destination. Re-copy from the run
            # into a fresh ID, or fail if the source is no longer available.
            pass
    if backend and backend.fs_namespace:
        raise HTTPException(409, "This agent uses a shared file namespace; an isolated follow-up is not supported.")
    attempt = {
        "_id": destination_id, "registry_id": key,
        "checkpoint_collection": checkpoint_collection, "writes_collection": writes_collection,
        "gridfs_bucket": settings.gridfs_bucket_name,
        "cleanup_after": now + COPY_LEASE, "writer_stopped": False,
    }
    try:
        claimed = registry.find_one_and_update(
            {"_id": key, "$or": [{"state": "failed"}, {"state": "creating", "lease_until": {"$lte": now}}]},
            {"$set": {
                "state": "creating", "token": token, "destination_id": destination_id, "lease_until": now + COPY_LEASE,
                "owner_id": identity, "task_id": run["task_id"], "run_id": run["run_id"],
                "checkpoint_collection": checkpoint_collection,
            }},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        existing = registry.find_one({"_id": key})
        if existing and existing.get("state") == "ready":
            return publish_follow_up_chat(db, existing, checkpoint_collection=checkpoint_collection)
        raise HTTPException(409, "This follow-up chat is being prepared. Please try again shortly.") from None
    if not claimed:
        raise HTTPException(409, "This follow-up chat is being prepared. Please try again shortly.")

    writes_settled = False
    try:
        # Persist cleanup coordinates before any checkpoint, file, or message.
        db[ATTEMPTS_COLLECTION].insert_one(attempt)
        renew_copy_lease(db, attempt)
        saver = MongoDBSaver(
            mongo._client, db_name=settings.mongodb_database,
            checkpoint_collection_name=checkpoint_collection,
            writes_collection_name=writes_collection,
            ttl=backend.checkpoint_ttl if backend else None,
        )
        snapshot_id = copy_run_checkpoint(saver, run["execution_context_id"], destination_id, run["finished_at"])
        renew_copy_lease(db, attempt)

        file_ttl = backend.fs_ttl_seconds if backend and backend.fs_ttl_seconds is not None else settings.default_fs_ttl_seconds
        if settings.max_fs_ttl_seconds and (file_ttl == 0 or file_ttl > settings.max_fs_ttl_seconds):
            file_ttl = settings.max_fs_ttl_seconds
        store = MongoDBGridFSStore(db=db, bucket_name=settings.gridfs_bucket_name, ttl_seconds=file_ttl)
        source_namespace = (agent.id, run["execution_context_id"], "filesystem")
        offset = 0
        while files := store.search(source_namespace, limit=100, offset=offset):
            for file in files:
                renew_copy_lease(db, attempt)
                store.put_with_id(
                    (agent.id, destination_id, "filesystem"), file.key, deepcopy(file.value),
                    f"{destination_id}:{uuid4()}",
                )
                renew_copy_lease(db, attempt)
            offset += len(files)

        source_url = (
            f"/chat/{run['conversation_id']}" if run.get("conversation_id")
            else f"/chat/webhooks/{run['task_id']}" if task.get("trigger", {}).get("type") == "webhook"
            else f"/autonomous?task={run['task_id']}"
        )
        # Only this run is seeded in the visible chat. All model/tool history is
        # in the independently copied checkpoint, not in the grouped task log.
        for role, content in (
            ("user", run.get("request_prompt") or task.get("prompt") or "Autonomous task"),
            ("assistant", run.get("response_full") or run.get("response_preview") or run.get("error") or "Run finished."),
        ):
            renew_copy_lease(db, attempt)
            db["messages"].insert_one({
                "conversation_id": destination_id, "message_id": f"{destination_id}:{role}",
                "owner_id": identity, "role": role, "content": content,
                "created_at": now if role == "user" else now + timedelta(milliseconds=1),
                "metadata": {"turn_id": run["run_id"], "is_final": True},
            })
        conversation = {
            "_id": destination_id,
            "title": f"[Manual Follow-up] {run['task_name']} · {_utc(run['started_at']).strftime('%Y-%m-%d %H:%M UTC')}",
            "client_type": "webui", "source": "web", "owner_id": identity,
            "agent_id": agent.id,
            "participants": [{"type": "agent", "id": agent.id}, {"type": "user", "id": identity}],
            "created_at": now, "updated_at": now,
            "metadata": {"total_messages": 2},
            "manual_follow_up": {
                "task_id": run["task_id"], "run_id": run["run_id"], "source_url": source_url,
                "source_checkpoint_id": snapshot_id,
            },
            "sharing": {"is_public": False, "shared_with": [], "shared_with_teams": [], "share_link_enabled": False},
            "tags": ["manual-follow-up"], "is_archived": False, "is_pinned": False,
        }
        completed = registry.find_one_and_update(
            {"_id": key, "token": token, "state": "creating", "lease_until": {"$gt": datetime.now(timezone.utc)}},
            {"$set": {"state": "ready", "conversation": conversation}, "$unset": {"lease_until": ""}},
            return_document=ReturnDocument.AFTER,
        )
        if not completed:
            raise HTTPException(409, "Another request prepared this follow-up. Please try again.")
        result = publish_follow_up_chat(db, completed)
        writes_settled = True
        return result
    except (HTTPException, PyMongoError, ValueError, TypeError, RuntimeError, OSError) as exc:
        # A disconnected/timed-out Mongo command may still commit on the server
        # after local cleanup. Keep its tombstone for repeated recovery sweeps.
        writes_settled = not isinstance(exc, (PyMongoError, OSError))
        if not isinstance(exc, HTTPException):
            logger.exception("Failed to prepare manual chat for task %s run %s", run["task_id"], run["run_id"])
        raise
    finally:
        # A ready record is recoverable even if publication lost its response.
        # Failed/expired attempts clean only their unique destination.
        finish_copy_attempt(db, attempt, writer_stopped=writes_settled)
