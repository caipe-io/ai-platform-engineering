"""Server-owned projection of canonical Engine turns into visible chat messages."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from pymongo import ASCENDING
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError

from harness_engine.canonical_context import CanonicalContextError, resolve_canonical_conversation
from harness_engine.models import (
    TERMINAL_RUN_STATUSES,
    CapabilityLevel,
    CreateRunRequest,
    RunEvent,
    RunRecord,
    RunStatus,
    utc_now,
)
from harness_engine.repository import RunAdmissionConflict, RunRepository

_CONTENT_MAX_BYTES = 4_194_304
_EVENTS_MAX_BYTES = 2_097_152
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class HistoryMessageIds:
    user_message_id: str
    assistant_message_id: str


def history_message_ids(run_id: str) -> HistoryMessageIds:
    return HistoryMessageIds(user_message_id=f"user-{run_id}", assistant_message_id=f"message-{run_id}")


def history_headers(identity: dict[str, str] | None) -> dict[str, str]:
    if identity is None:
        return {}
    return {
        "X-Harness-History-Owner": "server", "X-Harness-User-Message-ID": identity["user_message_id"],
        "X-Harness-Assistant-Message-ID": identity["assistant_message_id"],
    }


async def registered_history(repository: RunRepository, run: RunRecord | None) -> dict[str, str] | None:
    """Describe only durable registered ownership, independent of the catalog."""
    database = repository.provider_database
    if database is None or run is None:
        return None
    ids = history_message_ids(run.run_id)
    projection = await asyncio.to_thread(database.harness_history_projections.find_one, {
        "_id": run.run_id, "owner_subject": run.owner_subject, "agent_id": run.agent_id,
        "conversation_id": run.conversation_id, "visible_conversation_id": run.visible_conversation_id,
        "harness_id": run.harness_id, "user_message_id": ids.user_message_id,
        "assistant_message_id": ids.assistant_message_id, "admission_complete": True,
        "state": {"$in": ["pending", "complete"]},
    }, {"_id": 1})
    return {"owner": "server", **vars(ids)} if projection else None


def _text(data: dict[str, Any]) -> str:
    value = data.get("text", data.get("delta", ""))
    return value if isinstance(value, str) else ""


def _namespace(data: dict[str, Any]) -> list[str]:
    value = data.get("namespace", [])
    return value if isinstance(value, list) and all(isinstance(item, str) for item in value) else []


def _display_event(event: RunEvent) -> dict[str, Any] | None:
    data = event.data
    result: dict[str, Any] = {
        "id": f"event-{event.run_id}-{event.sequence}", "timestamp": event.created_at,
        "namespace": _namespace(data), "raw": {"event_type": event.event_type, "data": data},
    }
    if event.event_type == "content.delta":
        result.update(type="content", content=_text(data))
    elif event.event_type == "tool.started":
        result.update(type="tool_start", toolData={
            "tool_call_id": data.get("tool_call_id", data.get("id", "")),
            "tool_name": data.get("tool_name", data.get("name", "")),
            "args": data.get("arguments", {}),
        })
    elif event.event_type == "tool.completed":
        result.update(type="tool_end", toolData={
            "tool_call_id": data.get("tool_call_id", data.get("id", "")),
            "result": data.get("result", data.get("content", "")),
        })
    elif event.event_type == "interrupt.requested":
        result.update(type="input_required", inputRequiredData={
            "interrupt_id": data.get("interrupt_id", data.get("id", "")),
            "prompt": data.get("prompt", "Input requested"), "fields": data.get("fields", []),
            "agent": data.get("agent", ""),
        })
    elif event.event_type == "run.failed":
        result.update(type="error", displayContent=data.get("message", "Harness execution failed"))
    else:
        return None
    return result


class MongoRunHistoryProjector:
    """Idempotent message projection; the Engine journal remains run authority.

    The outbox records only projection identity and the accepted user input. It
    contains no provider event stream, credentials, lease, or execution owner.
    Terminal output is always read from committed canonical events.
    """

    def __init__(self, repository: RunRepository) -> None:
        database = repository.provider_database
        if database is None:
            raise ValueError("Server-owned run history requires canonical MongoDB")
        self._repository = repository
        self._db: Database[Any] = database

    async def initialize(self) -> None:
        await asyncio.to_thread(
            self._db.harness_history_projections.create_index,
            [("state", ASCENDING), ("next_attempt_at", ASCENDING), ("created_at", ASCENDING)],
        )

    @staticmethod
    def applies(run: RunRecord) -> bool:
        capability = run.capabilities.get("history.server_owned")
        return run.visible_conversation_id is not None and (run.harness_id == "claude_code_acp" or (
            capability is not None and capability.level in {CapabilityLevel.NATIVE, CapabilityLevel.EMULATED}
        ))

    async def _conversation(self, run: RunRecord) -> dict[str, Any]:
        visible_id = run.visible_conversation_id
        if not visible_id:
            raise RunAdmissionConflict("A visible conversation is required for server-owned history")
        if await self._repository.is_context_deleted(visible_id) or await self._repository.is_context_deleted(run.conversation_id):
            raise RunAdmissionConflict("The visible execution context was deleted")
        try:
            conversation = await asyncio.to_thread(
                resolve_canonical_conversation, self._db, owner_subject=run.owner_subject, agent_id=run.agent_id,
                conversation_id=run.conversation_id, visible_conversation_id=visible_id,
            )
        except CanonicalContextError as exc:
            raise RunAdmissionConflict(str(exc)) from exc
        if conversation is None:
            raise RunAdmissionConflict("The visible conversation is unavailable for this run")
        if not isinstance(conversation.get("owner_id"), str) or not conversation["owner_id"]:
            raise RunAdmissionConflict("Visible conversation has no canonical owner")
        binding = await asyncio.to_thread(self._db.harness_gateway_bindings.find_one, {
            "owner_subject": run.owner_subject, "agent_id": run.agent_id,
            "conversation_id": run.conversation_id, "harness_id": run.harness_id,
        })
        session = await self._repository.get_session(run.binding_id)
        if binding is None or session is None or (
            session.owner_subject, session.agent_id, session.conversation_id, session.harness_id
        ) != (run.owner_subject, run.agent_id, run.conversation_id, run.harness_id):
            raise RunAdmissionConflict("Visible history has no matching admitted runtime identity")
        return conversation

    async def admitted(self, run: RunRecord, request: CreateRunRequest) -> None:
        if not self.applies(run):
            return
        if (request.agent_id, request.conversation_id, request.visible_conversation_id) != (
            run.agent_id, run.conversation_id, run.visible_conversation_id,
        ):
            raise RunAdmissionConflict("History admission differs from the accepted run")
        conversation = await self._conversation(run)
        ids = history_message_ids(run.run_id)
        input_data = {"message": request.message, "attachments": [item.model_dump(mode="json") for item in request.attachments]}
        fingerprint = hashlib.sha256(json.dumps(input_data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        document = {
            "_id": run.run_id, "run_id": run.run_id, "owner_subject": run.owner_subject,
            "agent_id": run.agent_id, "conversation_id": run.conversation_id,
            "visible_conversation_id": run.visible_conversation_id, "harness_id": run.harness_id,
            "input_fingerprint": fingerprint, "input": input_data, "state": "pending", "created_at": run.created_at,
            "user_message_id": ids.user_message_id, "assistant_message_id": ids.assistant_message_id,
        }
        try:
            await asyncio.to_thread(
                self._db.harness_history_projections.update_one,
                {"_id": run.run_id}, {"$setOnInsert": document}, upsert=True,
            )
        except DuplicateKeyError:
            # Another replica registered the same idempotent projection.
            pass
        existing = await asyncio.to_thread(self._db.harness_history_projections.find_one, {"_id": run.run_id})
        if existing is None or any(existing.get(key) != document[key] for key in (
            "input_fingerprint", "owner_subject", "agent_id", "conversation_id", "visible_conversation_id", "harness_id",
        )):
            raise RunAdmissionConflict("History registration conflicts with an accepted turn")
        if existing["state"] == "pending":
            await self._ensure_messages(run, conversation, existing)

    async def _ensure_messages(self, run: RunRecord, conversation: dict[str, Any], projection: dict[str, Any]) -> None:
        await self._reject_deleted_target(run, projection)
        version = await self._repository.get_agent_version(run.agent_id, run.agent_version)
        agent_name = version.blueprint.name if version else run.agent_id
        metadata = {
            "turn_id": run.run_id, "source": conversation.get("source", "web"), "agent_id": run.agent_id,
            "agent_name": agent_name, "run_id": run.run_id, "execution_context_id": run.conversation_id,
            "harness_id": run.harness_id, "history_owner": "harness_engine",
            "client_request_id": run.client_request_id,
        }
        for role, message_id in (("user", projection["user_message_id"]), ("assistant", projection["assistant_message_id"])):
            # Browser persistence must adopt these IDs and treat these rows as
            # server-owned. Reject an earlier foreign row instead of overwriting it.
            foreign = await asyncio.to_thread(self._db.messages.find_one, {
                "message_id": message_id, "conversation_id": run.visible_conversation_id, "_id": {"$ne": message_id},
            }, {"_id": 1})
            if foreign:
                raise RunAdmissionConflict("A visible message identity belongs to another writer")
            document = {
                "_id": message_id, "message_id": message_id, "conversation_id": run.visible_conversation_id,
                "owner_id": conversation["owner_id"], "role": role,
                "content": projection["input"]["message"] if role == "user" else "",
                "created_at": run.created_at + timedelta(milliseconds=1 if role == "assistant" else 0),
                "updated_at": utc_now(), "metadata": {
                    **metadata, "is_final": role == "user", "turn_status": "completed" if role == "user" else "running",
                },
            }
            if role == "user" and projection["input"]["attachments"]:
                document["artifacts"] = [{"type": "attachment", "name": item["name"], "data": {
                    "artifact_id": item["id"], "mime_type": item["media_type"], "size": item["size_bytes"],
                }} for item in projection["input"]["attachments"]]
            try:
                await asyncio.to_thread(self._db.messages.update_one, {"_id": message_id}, {"$setOnInsert": document}, upsert=True)
            except DuplicateKeyError:
                pass
            stored = await asyncio.to_thread(self._db.messages.find_one, {"_id": message_id})
            if stored is None or any(stored.get(key) != document[key] for key in ("message_id", "conversation_id", "role")) or (
                stored.get("metadata", {}).get("history_owner") != "harness_engine"
                or stored.get("metadata", {}).get("run_id") != run.run_id
            ):
                raise RunAdmissionConflict("A canonical message identity has conflicting ownership")
        await self._update_conversation(run.visible_conversation_id)
        await self._reject_deleted_target(run, projection)
        await asyncio.to_thread(self._db.harness_history_projections.update_one, {"_id": run.run_id, "state": "pending"}, {
            "$set": {"admission_complete": True},
        })

    async def _abandon(self, projection: dict[str, Any]) -> None:
        await asyncio.to_thread(self._db.messages.delete_many, {
            "_id": {"$in": [projection["user_message_id"], projection["assistant_message_id"]]},
            "metadata.history_owner": "harness_engine", "metadata.run_id": projection["run_id"],
        })
        await asyncio.to_thread(self._db.harness_history_projections.update_one, {"_id": projection["_id"]}, {
            "$set": {"state": "abandoned"}, "$unset": {"input": ""},
        })

    async def _reject_deleted_target(self, run: RunRecord, projection: dict[str, Any]) -> None:
        conversation = await asyncio.to_thread(self._db.conversations.find_one, {"_id": run.visible_conversation_id}, {"_id": 1})
        if conversation is None or await self._repository.is_context_deleted(run.conversation_id):
            await self._abandon(projection)
            raise RunAdmissionConflict("Visible history was permanently deleted during registration")

    async def _update_conversation(self, visible_id: str) -> None:
        count = await asyncio.to_thread(self._db.messages.count_documents, {"conversation_id": visible_id})
        await asyncio.to_thread(self._db.conversations.update_one, {"_id": visible_id, "deleted_at": None}, {
            "$set": {"updated_at": utc_now()}, "$max": {"metadata.total_messages": count},
        })

    async def finalized(self, run: RunRecord) -> None:
        if not self.applies(run) or run.status not in TERMINAL_RUN_STATUSES:
            return
        projection = await asyncio.to_thread(self._db.harness_history_projections.find_one, {"_id": run.run_id})
        if projection is None or projection["state"] != "pending":
            return
        conversation = await self._conversation(run)
        await self._ensure_messages(run, conversation, projection)
        cursor = 0
        content = bytearray()
        display_events: list[dict[str, Any]] = []
        event_bytes = 0
        truncated = False
        while cursor < run.last_sequence:
            events = await self._repository.list_events(run.run_id, cursor)
            if not events:
                raise RunAdmissionConflict("Canonical history did not reach its committed terminal event")
            for event in events:
                cursor = event.sequence
                if event.event_type == "content.delta" and not _namespace(event.data):
                    encoded = _text(event.data).encode()
                    room = _CONTENT_MAX_BYTES - len(content)
                    content.extend(encoded[:room])
                    truncated = truncated or len(encoded) > room
                display = _display_event(event)
                if display:
                    size = len(json.dumps(display, default=str, ensure_ascii=False).encode())
                    if event_bytes + size <= _EVENTS_MAX_BYTES:
                        display_events.append(display)
                        event_bytes += size
                    else:
                        truncated = True
        metadata = {
            "is_final": True, "turn_status": run.status.value,
            "is_interrupted": run.status in {RunStatus.CANCELLED, RunStatus.INTERRUPTED},
            "history_last_sequence": run.last_sequence, "history_truncated": truncated,
        }
        result = await asyncio.to_thread(self._db.messages.update_one, {
            "_id": projection["assistant_message_id"], "conversation_id": run.visible_conversation_id,
            "metadata.history_owner": "harness_engine", "metadata.run_id": run.run_id,
        }, {"$set": {
            "content": content.decode(errors="ignore"), "stream_events": display_events, "updated_at": utc_now(),
            **{f"metadata.{key}": value for key, value in metadata.items()},
        }})
        if result.matched_count != 1:
            raise RunAdmissionConflict("The server-owned assistant message is unavailable")
        await self._update_conversation(run.visible_conversation_id)
        await asyncio.to_thread(self._db.harness_history_projections.update_one, {"_id": run.run_id, "state": "pending"}, {
            "$set": {"state": "complete", "completed_at": utc_now(), "last_sequence": run.last_sequence},
            "$unset": {"input": ""},
        })

    async def reconcile_once(self, limit: int = 100) -> None:
        projections = await asyncio.to_thread(lambda: list(
            self._db.harness_history_projections.find({"state": "pending", "$or": [
                {"next_attempt_at": {"$exists": False}}, {"next_attempt_at": {"$lte": utc_now()}},
            ]}).sort([("next_attempt_at", ASCENDING), ("created_at", ASCENDING)]).limit(limit)
        ))
        for projection in projections:
            try:
                run = await self._repository.get_run(projection["run_id"])
                if run is None:
                    # Never restore messages after canonical deletion fencing.
                    await self._abandon(projection)
                    continue
                if run.status in TERMINAL_RUN_STATUSES:
                    await self.finalized(run)
                else:
                    conversation = await self._conversation(run)
                    await self._ensure_messages(run, conversation, projection)
                delay = 5
            except Exception as exc:
                logger.error("Visible history remains pending for %s (%s)", projection["run_id"], type(exc).__name__)
                delay = 30
            await asyncio.to_thread(self._db.harness_history_projections.update_one, {"_id": projection["_id"], "state": "pending"}, {
                "$set": {"next_attempt_at": utc_now() + timedelta(seconds=delay)},
            })
