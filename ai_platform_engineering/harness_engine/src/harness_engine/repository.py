"""Agent, session, run, and canonical event persistence."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections import defaultdict
from copy import deepcopy
from datetime import datetime, timedelta
from typing import Any, Protocol
from uuid import uuid4

from pymongo import ASCENDING, DESCENDING, MongoClient, ReturnDocument
from pymongo.errors import DuplicateKeyError

from harness_engine.models import (
    TERMINAL_RUN_STATUSES,
    AgentBlueprint,
    AgentRecord,
    AgentVersion,
    CreateRunRequest,
    ProviderResource,
    RegisteredAgentCoreProfile,
    RunEvent,
    RunRecord,
    RunStatus,
    SessionBinding,
    utc_now,
)


class RevisionConflictError(Exception):
    """An optimistic agent update or unique insert failed."""


class RunAdmissionConflict(Exception):
    """A request changed or another producer already owns the conversation."""


class RunFencedError(Exception):
    """A producer no longer owns its durable run claim."""


class ReplayUnavailableError(Exception):
    """The requested committed event range has expired or is incomplete."""


_RUN_INTERNAL = {
    "_request_fingerprint",
    "_producer_id",
    "_owner_token",
    "_producer_stopped",
    "_provider_started",
    "_provider_drained",
    "_producer_expires_at",
    "_admission_deadline",
    "_pending_event",
    "_cancel_requested",
}
_SESSION_INTERNAL = {"_active_run_id", "_producer_id", "_lease_expires_at", "active_run", "dispatch_started"}
_EVENT_MAX_BYTES = 1_048_576
_PAGE_MAX_BYTES = 8_388_608


def _event_bytes(document: dict[str, Any]) -> int:
    return len(json.dumps(document, default=str, ensure_ascii=False, separators=(",", ":")).encode())


def _provider_drained(document: dict[str, Any]) -> bool:
    # Before explicit drain acknowledgments, only successful completion after
    # adapter iteration proves a stopped producer finished its provider work.
    return bool(document.get("_provider_drained", document.get("_producer_stopped") and document["status"] == "completed"))


def _run_record(document: dict[str, Any]) -> RunRecord:
    if "_cancel_requested" in document:
        document = {**document, "cancellation_requested": bool(document.get("cancellation_requested") or document["_cancel_requested"])}
    return RunRecord.model_validate(
        {key: value for key, value in document.items() if key not in _RUN_INTERNAL | {"_id"}}
    )


def _session_record(document: dict[str, Any]) -> SessionBinding:
    if document.get("active_run") is not None or document.get("dispatch_started", False) is not False:
        raise RunAdmissionConflict("Legacy execution owner requires drained-session migration")
    return SessionBinding.model_validate(
        {key: value for key, value in document.items() if key not in _SESSION_INTERNAL | {"_id"}}
    )


def _matches(document: dict[str, Any], expected: dict[str, Any]) -> bool:
    for field, wanted in expected.items():
        current: Any = document
        for part in field.split("."):
            current = current.get(part) if isinstance(current, dict) else None
        if isinstance(wanted, dict) and "$exists" in wanted:
            if (current is not None) != wanted["$exists"]:
                return False
        elif isinstance(wanted, dict) and "$in" in wanted:
            if current not in wanted["$in"]:
                return False
        elif isinstance(wanted, dict) and "$ne" in wanted:
            if current == wanted["$ne"]:
                return False
        elif current != wanted:
            return False
    return True


class RunLifecycle:
    """One admission/journal policy over atomic single-document storage operations.

    A pending event is a recoverable append intent, not a published cursor. The
    event is inserted idempotently before its head/status is published. No Mongo
    transaction or provider replay is required to finish that storage operation.
    """

    async def _insert_run(self, document: dict[str, Any]) -> bool:
        raise NotImplementedError

    async def _read_run(self, run_id: str) -> dict[str, Any] | None:
        raise NotImplementedError

    async def _change_run(
        self, run_id: str, expected: dict[str, Any], values: dict[str, Any], unset: tuple[str, ...] = ()
    ) -> dict[str, Any] | None:
        raise NotImplementedError

    async def _find_run(
        self,
        owner_subject: str,
        agent_id: str,
        conversation_id: str,
        active: bool,
        client_request_id: str | None = None,
    ) -> dict[str, Any] | None:
        raise NotImplementedError

    async def _store_event(self, document: dict[str, Any]) -> None:
        raise NotImplementedError

    async def _read_events(self, run_id: str, after: int, through: int) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def _read_binding(self, binding_id: str) -> dict[str, Any] | None:
        raise NotImplementedError

    async def _claim_binding(self, binding_id: str, run_id: str, producer_id: str, deadline: datetime) -> bool:
        raise NotImplementedError

    async def _renew_binding(
        self, binding_id: str, run_id: str, producer_id: str, now: datetime, deadline: datetime
    ) -> bool:
        raise NotImplementedError

    async def _release_binding(self, binding_id: str, run_id: str, producer_id: str, degraded: bool = False) -> None:
        raise NotImplementedError

    async def is_context_deleted(self, conversation_id: str) -> bool:
        raise NotImplementedError

    async def gateway_harness(self, agent_id: str, conversation_id: str) -> str | None:
        raise NotImplementedError

    async def context_sessions(self, owner_subject: str, agent_id: str, conversation_id: str) -> list[SessionBinding]:
        raise NotImplementedError

    async def _context_runs(self, owner_subject: str, agent_id: str, conversation_id: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def purge_context(self, owner_subject: str, agent_id: str, conversation_id: str) -> None:
        raise NotImplementedError

    async def create_run(self, run: RunRecord) -> RunRecord:
        if not await self._insert_run(run.model_dump(mode="python")):
            raise RevisionConflictError(run.run_id)
        return run

    async def lookup_request(
        self,
        run_id: str,
        fingerprint: str,
        *,
        owner_subject: str | None = None,
        request: CreateRunRequest | None = None,
    ) -> RunRecord | None:
        existing = await self._read_run(run_id)
        if existing is None and request and request.client_request_id and owner_subject:
            # Earlier Engine releases assigned UUID run IDs. The accepted request
            # tuple remains authoritative across an upgrade, before any session
            # resolution or provider preparation can repeat its side effects.
            existing = await self._find_run(
                owner_subject, request.agent_id, request.conversation_id, False, request.client_request_id
            )
        if existing is None:
            return None
        if "request_fingerprint" in existing:
            if not request or not owner_subject or not existing.get("request_fingerprint"):
                raise RunAdmissionConflict("Legacy accepted request requires explicit migration")
            legacy_input = request.model_dump(
                mode="json", include={"agent_id", "conversation_id", "message", "context", "client_request_id"}
            )
            legacy_fingerprint = hashlib.sha256(
                json.dumps(legacy_input, ensure_ascii=False, separators=(",", ":")).encode()
            ).hexdigest()
            if (
                existing.get("request_fingerprint") != legacy_fingerprint
                or request.protocol != "agui"
                or request.expected_harness_id not in (None, existing["harness_id"])
            ):
                raise RunAdmissionConflict("client_request_id was already used with different input")
            if existing["status"] not in TERMINAL_RUN_STATUSES:
                raise RunAdmissionConflict("Legacy accepted request requires drained-session migration")
            await self._normalize_legacy_terminal(existing)
            await self._change_run(
                existing["run_id"], {"request_fingerprint": legacy_fingerprint},
                {"_request_fingerprint": fingerprint}, ("request_fingerprint",),
            )
        elif existing.get("_request_fingerprint") != fingerprint:
            if not existing.get("_request_fingerprint"):
                raise RunAdmissionConflict("Accepted request has no input proof; explicit migration required")
            raise RunAdmissionConflict("client_request_id was already used with different input")
        return await self.get_run(existing["run_id"])

    async def _normalize_legacy_terminal(self, document: dict[str, Any]) -> None:
        if document["status"] not in TERMINAL_RUN_STATUSES:
            raise RunAdmissionConflict("Legacy execution owner requires drained-session migration")
        pending = document.get("pending_event")
        if pending:
            event = RunEvent.model_validate(pending)
            if event.run_id != document["run_id"] or event.sequence != document["last_sequence"]:
                raise ReplayUnavailableError("Legacy pending event does not match its committed head")
            await self._store_event(event.model_dump(mode="python"))
            await self._change_run(document["run_id"], {"pending_event": pending}, {}, ("pending_event",))

    async def admit_run(
        self, run: RunRecord, fingerprint: str, producer_id: str, lease_seconds: float
    ) -> tuple[RunRecord, bool]:
        if await self.is_context_deleted(run.conversation_id):
            raise RunAdmissionConflict("Execution context was permanently deleted")
        gateway_owner = await self.gateway_harness(run.agent_id, run.conversation_id)
        if gateway_owner is not None and gateway_owner != run.harness_id:
            raise RunAdmissionConflict("Execution context is bound to a different harness")
        binding = await self._read_binding(run.binding_id)
        if binding and (binding.get("active_run") is not None or binding.get("dispatch_started", False) is not False):
            raise RunAdmissionConflict("Legacy execution owner requires drained-session migration")
        deadline = utc_now() + timedelta(seconds=lease_seconds)
        inserted = await self._insert_run(
            {
                **run.model_dump(mode="python"),
                "_request_fingerprint": fingerprint,
                "_producer_id": producer_id,
                "_owner_token": producer_id,
                "_producer_stopped": False,
                "_provider_started": False,
                "_provider_drained": False,
                "_producer_expires_at": deadline,
                "_admission_deadline": deadline,

            }
        )
        if not inserted:
            existing = await self.lookup_request(run.run_id, fingerprint)
            if existing is None:
                raise RunFencedError(run.run_id)
            return existing, False
        # Reconcile an abandoned claim before deciding whether this binding is busy.
        binding = await self._read_binding(run.binding_id)
        if binding and binding.get("_active_run_id"):
            await self.get_run(binding["_active_run_id"])
        if not await self._claim_binding(run.binding_id, run.run_id, producer_id, deadline):
            await self.append_event(
                run.run_id,
                "run.failed",
                {
                    "code": "session_conflict",
                    "message": "Conversation is busy or was cleared; no provider request was sent",
                },
                RunStatus.FAILED,
                producer_id=producer_id,
            )
            await self.release_run(run.run_id, producer_id)
            raise RunAdmissionConflict("Conversation has another active run or was cleared")
        if await self.is_context_deleted(run.conversation_id):
            await self.release_run(run.run_id, producer_id)
            raise RunAdmissionConflict("Execution context was permanently deleted")
        return run, True

    async def _publish_pending(self, run_id: str) -> dict[str, Any] | None:
        document = await self._read_run(run_id)
        for _ in range(4):
            if not document or not document.get("_pending_event"):
                return document
            pending = document["_pending_event"]
            await self._store_event(pending["event"])
            updates = {"last_sequence": pending["event"]["sequence"], "updated_at": utc_now()}
            if pending["status"] is not None:
                updates["status"] = pending["status"]
                updates["error_code"] = pending["event"]["data"].get("code")
            await self._change_run(run_id, {"_pending_event.id": pending["id"]}, updates, ("_pending_event",))
            document = await self._read_run(run_id)
        return document

    async def get_run(self, run_id: str) -> RunRecord | None:
        initial = await self._read_run(run_id)
        if initial is None or await self.is_context_deleted(initial["conversation_id"]):
            return None
        if "_cancel_requested" in initial:
            # Rewrite the earlier private flag once; all new state uses the
            # public Engine cancellation contract, without losing a pending Stop.
            await self._change_run(
                run_id, {"_cancel_requested": initial["_cancel_requested"]},
                {"cancellation_requested": bool(initial.get("cancellation_requested") or initial["_cancel_requested"])},
                ("_cancel_requested",),
            )
        if "request_fingerprint" in initial or "pending_event" in initial:
            await self._normalize_legacy_terminal(initial)
        document = await self._publish_pending(run_id)
        if not document:
            return None
        # The legacy public fingerprint is compatibility input only, not a
        # second authority for newly admitted runs.
        document.pop("request_fingerprint", None)
        run = _run_record(document)
        producer = document.get("_producer_id")
        if run.status in TERMINAL_RUN_STATUSES:
            if producer and document.get("_producer_stopped") and (not document.get("_provider_started") or _provider_drained(document)):
                await self._release_binding(run.binding_id, run_id, producer)
            elif producer:
                binding = await self._read_binding(run.binding_id)
                if (
                    binding
                    and binding.get("_active_run_id") == run_id
                    and binding.get("_lease_expires_at", utc_now()) <= utc_now()
                ):
                    # The committed answer survives owner loss, but an unknown
                    # cleanup cannot silently reuse its provider session.
                    await self._release_binding(run.binding_id, run_id, producer, degraded=True)
            return run
        if not producer:
            return run
        binding = await self._read_binding(run.binding_id)
        now = utc_now()
        owns = bool(binding and binding.get("_active_run_id") == run_id and binding.get("_producer_id") == producer)
        closed = bool(binding and binding.get("status") == "closed")
        deadline = binding.get("_lease_expires_at") if owns else document.get("_admission_deadline")
        if closed or (binding and binding.get("status") == "degraded") or (deadline and deadline <= now):
            return await self.interrupt_run(run_id, producer, closed=closed)
        return run

    async def interrupt_run(self, run_id: str, producer_id: str, *, closed: bool = False) -> RunRecord | None:
        document = await self._publish_pending(run_id)
        if not document:
            return None
        run = _run_record(document)
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        # Revoke the old producer before recording interruption. It may still
        # be alive, but cannot renew or publish another event with its old token.
        await self._release_binding(run.binding_id, run_id, producer_id, degraded=not closed)
        for _ in range(4):
            document = await self._publish_pending(run_id)
            if not document or document["status"] in TERMINAL_RUN_STATUSES:
                break
            fence = uuid4().hex
            fenced = await self._change_run(
                run_id,
                {"_producer_id": producer_id, "status": document["status"], "_pending_event": {"$exists": False}},
                {"_producer_id": fence, "cancellation_requested": True},
            )
            if fenced:
                await self.append_event(
                    run_id,
                    "run.cancelled" if closed else "run.failed",
                    {
                        "code": "session_closed" if closed else "execution_interrupted",
                        "message": "Session was cleared"
                        if closed
                        else "Execution owner was lost; work was not replayed. Clear the session before continuing.",
                    },
                    RunStatus.CANCELLED if closed else RunStatus.FAILED,
                    producer_id=fence,
                )
                break
        current = await self._publish_pending(run_id)
        return _run_record(current) if current else None

    async def get_active_run(
        self, owner_subject: str, agent_id: str, conversation_id: str, client_request_id: str | None = None
    ) -> RunRecord | None:
        document = await self._find_run(owner_subject, agent_id, conversation_id, True, client_request_id)
        run = await self.get_run(document["run_id"]) if document else None
        return run if run and run.status not in TERMINAL_RUN_STATUSES else None

    async def get_latest_run(self, owner_subject: str, agent_id: str, conversation_id: str) -> RunRecord | None:
        active = await self.get_active_run(owner_subject, agent_id, conversation_id)
        if active:
            return active
        document = await self._find_run(owner_subject, agent_id, conversation_id, False)
        return await self.get_run(document["run_id"]) if document else None

    async def renew_run(self, run_id: str, producer_id: str, lease_seconds: float) -> bool:
        document = await self._read_run(run_id)
        if (
            not document
            or document.get("_producer_id") != producer_id
            or ((document.get("cancellation_requested") or document.get("_cancel_requested")) and not document.get("_provider_started"))
            or document["status"] in TERMINAL_RUN_STATUSES
        ):
            return False
        if await self.is_context_deleted(document["conversation_id"]):
            return False
        now = utc_now()
        deadline = now + timedelta(seconds=lease_seconds)
        await self._change_run(run_id, {"_producer_id": producer_id}, {"_producer_expires_at": deadline})
        renewed = await self._renew_binding(document["binding_id"], run_id, producer_id, now, deadline)
        return renewed and not await self.is_context_deleted(document["conversation_id"])

    async def request_cancellation(self, run_id: str) -> RunRecord | None:
        await self._change_run(
            run_id, {"status": {"$in": ["queued", "running"]}}, {"cancellation_requested": True}, ("_cancel_requested",)
        )
        return await self.get_run(run_id)

    async def begin_provider(self, run_id: str, producer_id: str, lease_seconds: float) -> bool:
        document = await self._read_run(run_id)
        if not document or await self.is_context_deleted(document["conversation_id"]):
            return False
        marked = await self._change_run(
            run_id,
            {"_producer_id": producer_id, "status": "running", "cancellation_requested": {"$ne": True}, "_cancel_requested": {"$ne": True}, "_provider_started": False},
            {"_provider_started": True},
        )
        # This atomic binding renewal is provider admission's linearization
        # point against clear, which closes the same binding document.
        return bool(marked and await self.renew_run(run_id, producer_id, lease_seconds))

    async def cancellation_requested(self, run_id: str) -> bool:
        document = await self._read_run(run_id)
        return bool(document and (document.get("cancellation_requested") or document.get("_cancel_requested")))

    async def provider_has_started(self, run_id: str) -> bool:
        document = await self._read_run(run_id)
        return bool(document and document.get("_provider_started"))

    async def release_run(self, run_id: str, producer_id: str, *, provider_drained: bool = False) -> None:
        document = await self._read_run(run_id)
        if document:
            acknowledged = await self._change_run(
                run_id, {"_owner_token": producer_id},
                {"_producer_stopped": True, "_provider_drained": provider_drained or _provider_drained(document)},
            )
            if acknowledged and document["status"] in TERMINAL_RUN_STATUSES and (
                not document.get("_provider_started") or _provider_drained(acknowledged)
            ):
                await self._release_binding(document["binding_id"], run_id, producer_id)

    async def context_run_binding_ids(self, owner_subject: str, agent_id: str, conversation_id: str) -> set[str]:
        return {run["binding_id"] for run in await self._context_runs(owner_subject, agent_id, conversation_id)}

    async def context_is_drained(self, owner_subject: str, agent_id: str, conversation_id: str) -> bool:
        for run in await self._context_runs(owner_subject, agent_id, conversation_id):
            if (
                run.get("_producer_stopped") and (not run.get("_provider_started") or _provider_drained(run))
            ) or (run.get("_owner_token") and not run.get("_provider_started")):
                continue
            if run.get("_owner_token") or run.get("status") not in TERMINAL_RUN_STATUSES:
                return False
        return True

    async def update_run_provider_id(self, run_id: str, provider_session_id: str) -> None:
        await self._change_run(
            run_id,
            {"status": {"$in": ["queued", "running"]}},
            {"provider_session_id": provider_session_id, "updated_at": utc_now()},
        )

    async def append_event(
        self,
        run_id: str,
        event_type: str,
        data: dict[str, object],
        status: RunStatus | None = None,
        *,
        producer_id: str | None = None,
    ) -> RunEvent:
        for _ in range(64):
            document = await self._publish_pending(run_id)
            if not document:
                raise KeyError(run_id)
            if document["status"] in TERMINAL_RUN_STATUSES or (
                producer_id is not None and document.get("_producer_id") != producer_id
            ):
                raise RunFencedError(run_id)
            if await self.is_context_deleted(document["conversation_id"]):
                raise RunFencedError(run_id)
            event = RunEvent(run_id=run_id, sequence=document["last_sequence"] + 1, event_type=event_type, data=data)
            if _event_bytes(event.model_dump(mode="json")) > _EVENT_MAX_BYTES:
                raise ValueError("Canonical event exceeds the journal size limit")
            pending = {
                "id": uuid4().hex,
                "event": event.model_dump(mode="python"),
                "status": status.value if status else None,
            }
            expected: dict[str, Any] = {
                "last_sequence": document["last_sequence"],
                "status": document["status"],
                "_pending_event": {"$exists": False},
            }
            if producer_id is not None:
                expected["_producer_id"] = producer_id
            if await self._change_run(run_id, expected, {"_pending_event": pending}):
                await self._publish_pending(run_id)
                return event
        raise RunFencedError(run_id)

    async def list_events(self, run_id: str, after: int) -> list[RunEvent]:
        run = await self.get_run(run_id)
        if not run:
            raise KeyError(run_id)
        if after > run.last_sequence:
            raise ReplayUnavailableError("Cursor exceeds the committed event head")
        documents = await self._read_events(run_id, after, run.last_sequence)
        events = [RunEvent.model_validate(doc) for doc in documents]
        if (
            (events and events[0].sequence != after + 1)
            or any(right.sequence != left.sequence + 1 for left, right in zip(events, events[1:]))
            or (not events and after < run.last_sequence)
            or (
                events and events[-1].sequence < run.last_sequence
                and len(events) < 256
                and sum(_event_bytes(document) for document in documents) + _EVENT_MAX_BYTES <= _PAGE_MAX_BYTES
            )
        ):
            raise ReplayUnavailableError("Committed event history has expired or is incomplete")
        return events

    async def wait_for_events(self, run_id: str, after: int, timeout: float) -> list[RunEvent]:
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            events = await self.list_events(run_id, after)
            run = await self.get_run(run_id)
            if events or (run and run.status in TERMINAL_RUN_STATUSES) or asyncio.get_running_loop().time() >= deadline:
                return events
            await asyncio.sleep(min(0.1, max(0.0, deadline - asyncio.get_running_loop().time())))


class RunRepository(Protocol):
    async def is_context_deleted(self, conversation_id: str) -> bool: ...

    async def context_sessions(
        self, owner_subject: str, agent_id: str, conversation_id: str
    ) -> list[SessionBinding]: ...

    async def context_run_binding_ids(self, owner_subject: str, agent_id: str, conversation_id: str) -> set[str]: ...

    async def context_is_drained(self, owner_subject: str, agent_id: str, conversation_id: str) -> bool: ...

    async def purge_context(self, owner_subject: str, agent_id: str, conversation_id: str) -> None: ...

    async def initialize(self) -> None: ...

    async def close(self) -> None: ...

    async def list_agentcore_profiles(self) -> list[RegisteredAgentCoreProfile]: ...

    async def create_agentcore_profile(self, profile: RegisteredAgentCoreProfile) -> None: ...

    async def get_agent(self, agent_id: str) -> AgentRecord | None: ...

    async def get_agent_version(self, agent_id: str, version: int | None = None) -> AgentVersion | None: ...

    async def save_agent(
        self,
        blueprint: AgentBlueprint,
        config_fingerprint: str,
        catalog_revision: str,
        expected_revision: int | None,
    ) -> tuple[AgentRecord, AgentVersion]: ...

    async def delete_agent(self, agent_id: str) -> bool: ...

    async def get_provider_resource(self, agent_id: str) -> ProviderResource | None: ...

    async def save_provider_resource(self, resource: ProviderResource) -> ProviderResource: ...

    async def delete_provider_resource(self, agent_id: str) -> bool: ...

    async def get_session(self, binding_id: str) -> SessionBinding | None: ...

    async def get_latest_session(
        self, owner_subject: str, agent_id: str, conversation_id: str
    ) -> SessionBinding | None: ...

    async def create_session(self, binding: SessionBinding) -> SessionBinding: ...

    async def update_session_provider_id(self, binding_id: str, provider_session_id: str) -> SessionBinding: ...

    async def close_session(self, binding_id: str) -> SessionBinding: ...

    async def create_run(self, run: RunRecord) -> RunRecord: ...

    async def lookup_request(
        self, run_id: str, fingerprint: str, *, owner_subject: str | None = None,
        request: CreateRunRequest | None = None,
    ) -> RunRecord | None: ...

    async def admit_run(
        self, run: RunRecord, fingerprint: str, producer_id: str, lease_seconds: float
    ) -> tuple[RunRecord, bool]: ...

    async def renew_run(self, run_id: str, producer_id: str, lease_seconds: float) -> bool: ...

    async def request_cancellation(self, run_id: str) -> RunRecord | None: ...

    async def begin_provider(self, run_id: str, producer_id: str, lease_seconds: float) -> bool: ...

    async def cancellation_requested(self, run_id: str) -> bool: ...

    async def provider_has_started(self, run_id: str) -> bool: ...

    async def release_run(self, run_id: str, producer_id: str, *, provider_drained: bool = False) -> None: ...

    async def interrupt_run(self, run_id: str, producer_id: str, *, closed: bool = False) -> RunRecord | None: ...

    async def get_run(self, run_id: str) -> RunRecord | None: ...

    async def get_active_run(
        self,
        owner_subject: str,
        agent_id: str,
        conversation_id: str,
        client_request_id: str | None = None,
    ) -> RunRecord | None: ...

    async def get_latest_run(self, owner_subject: str, agent_id: str, conversation_id: str) -> RunRecord | None: ...

    async def update_run_provider_id(self, run_id: str, provider_session_id: str) -> None: ...

    async def append_event(
        self,
        run_id: str,
        event_type: str,
        data: dict[str, object],
        status: RunStatus | None = None,
        *,
        producer_id: str | None = None,
    ) -> RunEvent: ...

    async def list_events(self, run_id: str, after: int) -> list[RunEvent]: ...

    async def wait_for_events(self, run_id: str, after: int, timeout: float) -> list[RunEvent]: ...


class InMemoryRunRepository(RunLifecycle):
    """Deterministic repository for local development and tests."""

    def __init__(self) -> None:
        self._agents: dict[str, AgentRecord] = {}
        self._versions: dict[tuple[str, int], AgentVersion] = {}
        self._sessions: dict[str, SessionBinding] = {}
        self._provider_resources: dict[str, ProviderResource] = {}
        self._agentcore_profiles: dict[str, RegisteredAgentCoreProfile] = {}
        self._runs: dict[str, dict[str, Any]] = {}
        self._session_claims: dict[str, dict[str, Any]] = {}
        self._deleted_contexts: set[str] = set()
        self._gateway_owners: dict[tuple[str, str], str] = {}
        self._events: dict[str, list[RunEvent]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def list_agentcore_profiles(self) -> list[RegisteredAgentCoreProfile]:
        return [profile.model_copy(deep=True) for profile in self._agentcore_profiles.values()]

    async def create_agentcore_profile(self, profile: RegisteredAgentCoreProfile) -> None:
        async with self._lock:
            if profile.profile_id in self._agentcore_profiles:
                raise RevisionConflictError(profile.profile_id)
            self._agentcore_profiles[profile.profile_id] = profile.model_copy(deep=True)

    async def get_agent(self, agent_id: str) -> AgentRecord | None:
        record = self._agents.get(agent_id)
        return record.model_copy(deep=True) if record else None

    async def get_agent_version(self, agent_id: str, version: int | None = None) -> AgentVersion | None:
        if version is None:
            record = self._agents.get(agent_id)
            version = record.current_version if record else None
        stored = self._versions.get((agent_id, version)) if version else None
        return stored.model_copy(deep=True) if stored else None

    async def save_agent(
        self,
        blueprint: AgentBlueprint,
        config_fingerprint: str,
        catalog_revision: str,
        expected_revision: int | None,
    ) -> tuple[AgentRecord, AgentVersion]:
        async with self._lock:
            current = self._agents.get(blueprint.id)
            if expected_revision is not None and (current is None or current.revision != expected_revision):
                raise RevisionConflictError(blueprint.id)
            now = utc_now()
            version_number = current.current_version + 1 if current else 1
            version = AgentVersion(
                agent_id=blueprint.id,
                version=version_number,
                blueprint=blueprint,
                config_fingerprint=config_fingerprint,
                catalog_revision=catalog_revision,
                created_at=now,
            )
            record = AgentRecord(
                agent_id=blueprint.id,
                current_version=version_number,
                revision=(current.revision + 1) if current else 1,
                enabled=current.enabled if current else True,
                created_at=current.created_at if current else now,
                updated_at=now,
            )
            self._versions[(record.agent_id, version_number)] = version
            self._agents[record.agent_id] = record
            return record.model_copy(deep=True), version.model_copy(deep=True)

    async def delete_agent(self, agent_id: str) -> bool:
        async with self._lock:
            existed = self._agents.pop(agent_id, None) is not None
            for key in [key for key in self._versions if key[0] == agent_id]:
                del self._versions[key]
            return existed

    async def get_provider_resource(self, agent_id: str) -> ProviderResource | None:
        resource = self._provider_resources.get(agent_id)
        return resource.model_copy(deep=True) if resource else None

    async def save_provider_resource(self, resource: ProviderResource) -> ProviderResource:
        async with self._lock:
            self._provider_resources[resource.agent_id] = resource
            return resource.model_copy(deep=True)

    async def delete_provider_resource(self, agent_id: str) -> bool:
        async with self._lock:
            return self._provider_resources.pop(agent_id, None) is not None

    async def get_session(self, binding_id: str) -> SessionBinding | None:
        session = self._sessions.get(binding_id)
        return session.model_copy(deep=True) if session else None

    async def get_latest_session(
        self, owner_subject: str, agent_id: str, conversation_id: str
    ) -> SessionBinding | None:
        matches = [
            session
            for session in self._sessions.values()
            if session.owner_subject == owner_subject
            and session.agent_id == agent_id
            and session.conversation_id == conversation_id
        ]
        latest = max(matches, key=lambda session: session.epoch) if matches else None
        return latest.model_copy(deep=True) if latest else None

    async def create_session(self, binding: SessionBinding) -> SessionBinding:
        async with self._lock:
            if binding.conversation_id in self._deleted_contexts:
                raise RunAdmissionConflict("Execution context was permanently deleted")
            current = self._sessions.get(binding.binding_id)
            if current:
                return current.model_copy(deep=True)
            self._sessions[binding.binding_id] = binding
            return binding.model_copy(deep=True)

    async def update_session_provider_id(self, binding_id: str, provider_session_id: str) -> SessionBinding:
        async with self._lock:
            session = self._sessions[binding_id]
            if session.status != "active":
                raise RevisionConflictError(binding_id)
            stored = session.model_copy(
                update={
                    "provider_session_id": provider_session_id,
                    "revision": session.revision + 1,
                    "updated_at": utc_now(),
                }
            )
            self._sessions[binding_id] = stored
            return stored.model_copy(deep=True)

    async def close_session(self, binding_id: str) -> SessionBinding:
        async with self._lock:
            session = self._sessions[binding_id]
            if session.status == "closed":
                return session.model_copy(deep=True)
            stored = session.model_copy(
                update={
                    "status": "closed",
                    "revision": session.revision + 1,
                    "updated_at": utc_now(),
                }
            )
            self._sessions[binding_id] = stored
            return stored.model_copy(deep=True)

    async def _insert_run(self, document: dict[str, Any]) -> bool:
        async with self._lock:
            if document["run_id"] in self._runs:
                return False
            self._runs[document["run_id"]] = deepcopy(document)
            return True

    async def _read_run(self, run_id: str) -> dict[str, Any] | None:
        document = self._runs.get(run_id)
        return deepcopy(document) if document else None

    async def _change_run(
        self, run_id: str, expected: dict[str, Any], values: dict[str, Any], unset: tuple[str, ...] = ()
    ) -> dict[str, Any] | None:
        async with self._lock:
            document = self._runs.get(run_id)
            if document is None or not _matches(document, expected):
                return None
            document.update(deepcopy(values))
            for field in unset:
                document.pop(field, None)
            return deepcopy(document)

    async def _find_run(
        self,
        owner_subject: str,
        agent_id: str,
        conversation_id: str,
        active: bool,
        client_request_id: str | None = None,
    ) -> dict[str, Any] | None:
        matches = [
            run
            for run in self._runs.values()
            if run["owner_subject"] == owner_subject
            and run["agent_id"] == agent_id
            and run["conversation_id"] == conversation_id
            and (not active or run["status"] not in TERMINAL_RUN_STATUSES)
            and (client_request_id is None or run.get("client_request_id") == client_request_id)
        ]
        return deepcopy(max(matches, key=lambda run: run["created_at"])) if matches else None

    async def _store_event(self, document: dict[str, Any]) -> None:
        async with self._lock:
            events = self._events[document["run_id"]]
            existing = next((event for event in events if event.sequence == document["sequence"]), None)
            if existing:
                if existing.model_dump(mode="python") != document:
                    raise ReplayUnavailableError("Conflicting event append")
            else:
                events.append(RunEvent.model_validate(document))

    async def _read_events(self, run_id: str, after: int, through: int) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        size = 0
        for event in sorted(self._events[run_id], key=lambda event: event.sequence):
            if not after < event.sequence <= through:
                continue
            document = event.model_dump(mode="python")
            size += _event_bytes(document)
            if result and size > _PAGE_MAX_BYTES:
                break
            result.append(document)
            if len(result) == 256:
                break
        return result

    async def _read_binding(self, binding_id: str) -> dict[str, Any] | None:
        binding = self._sessions.get(binding_id)
        return (
            {**binding.model_dump(mode="python"), **deepcopy(self._session_claims.get(binding_id, {}))}
            if binding
            else None
        )

    async def _claim_binding(self, binding_id: str, run_id: str, producer_id: str, deadline: datetime) -> bool:
        async with self._lock:
            binding = self._sessions.get(binding_id)
            if not binding or binding.status != "active" or self._session_claims.get(binding_id):
                return False
            self._session_claims[binding_id] = {
                "_active_run_id": run_id,
                "_producer_id": producer_id,
                "_lease_expires_at": deadline,
            }
            return True

    async def _renew_binding(
        self, binding_id: str, run_id: str, producer_id: str, now: datetime, deadline: datetime
    ) -> bool:
        async with self._lock:
            binding = self._sessions.get(binding_id)
            claim = self._session_claims.get(binding_id, {})
            if (
                not binding
                or binding.status != "active"
                or claim.get("_active_run_id") != run_id
                or claim.get("_producer_id") != producer_id
                or claim.get("_lease_expires_at", now) <= now
            ):
                return False
            claim["_lease_expires_at"] = deadline
            return True

    async def _release_binding(self, binding_id: str, run_id: str, producer_id: str, degraded: bool = False) -> None:
        async with self._lock:
            claim = self._session_claims.get(binding_id, {})
            if claim.get("_active_run_id") == run_id and claim.get("_producer_id") == producer_id:
                self._session_claims.pop(binding_id, None)
                binding = self._sessions.get(binding_id)
                if degraded and binding and binding.status == "active":
                    self._sessions[binding_id] = binding.model_copy(
                        update={"status": "degraded", "updated_at": utc_now()}
                    )

    async def is_context_deleted(self, conversation_id: str) -> bool:
        return conversation_id in self._deleted_contexts

    async def gateway_harness(self, agent_id: str, conversation_id: str) -> str | None:
        return self._gateway_owners.get((agent_id, conversation_id))

    async def context_sessions(self, owner_subject: str, agent_id: str, conversation_id: str) -> list[SessionBinding]:
        return [
            binding.model_copy(deep=True)
            for binding in self._sessions.values()
            if (binding.owner_subject, binding.agent_id, binding.conversation_id)
            == (owner_subject, agent_id, conversation_id)
        ]

    async def _context_runs(self, owner_subject: str, agent_id: str, conversation_id: str) -> list[dict[str, Any]]:
        return [
            deepcopy(run)
            for run in self._runs.values()
            if (run["owner_subject"], run["agent_id"], run["conversation_id"])
            == (owner_subject, agent_id, conversation_id)
        ]

    async def purge_context(self, owner_subject: str, agent_id: str, conversation_id: str) -> None:
        if not await self.is_context_deleted(conversation_id) or not await self.context_is_drained(
            owner_subject, agent_id, conversation_id
        ):
            raise RunAdmissionConflict("Deletion requires a fenced, drained execution context")
        async with self._lock:
            for run_id, run in list(self._runs.items()):
                if (run["owner_subject"], run["agent_id"], run["conversation_id"]) == (
                    owner_subject,
                    agent_id,
                    conversation_id,
                ):
                    self._runs.pop(run_id, None)
                    self._events.pop(run_id, None)
            for binding_id, binding in list(self._sessions.items()):
                if (binding.owner_subject, binding.agent_id, binding.conversation_id) == (
                    owner_subject,
                    agent_id,
                    conversation_id,
                ):
                    self._sessions.pop(binding_id, None)
                    self._session_claims.pop(binding_id, None)


class MongoRunRepository(RunLifecycle):
    """Mongo-backed repository supporting replay and cross-replica sessions."""

    def __init__(self, uri: str, database: str, retention_seconds: int) -> None:
        self._client = MongoClient(
            uri, tz_aware=True, serverSelectionTimeoutMS=5000, connectTimeoutMS=5000, socketTimeoutMS=5000
        )
        self._db = self._client[database]
        self._retention_seconds = retention_seconds

    async def initialize(self) -> None:
        def ensure_indexes() -> None:
            self._db.harness_agents.create_index("agent_id", unique=True)
            self._db.harness_agent_versions.create_index([("agent_id", ASCENDING), ("version", ASCENDING)], unique=True)
            self._db.harness_provider_resources.create_index("agent_id", unique=True)
            self._db.harness_agentcore_profiles.create_index("profile_id", unique=True)
            self._db.harness_sessions.create_index("binding_id", unique=True)
            self._db.harness_sessions.create_index(
                [
                    ("owner_subject", ASCENDING),
                    ("agent_id", ASCENDING),
                    ("conversation_id", ASCENDING),
                    ("epoch", ASCENDING),
                ],
                unique=True,
            )
            self._db.harness_runs.create_index("run_id", unique=True)
            self._db.harness_runs.create_index([("owner_subject", ASCENDING), ("created_at", ASCENDING)])
            self._db.harness_events.create_index([("run_id", ASCENDING), ("sequence", ASCENDING)], unique=True)
            self._db.harness_events.create_index("created_at", expireAfterSeconds=self._retention_seconds)

        await asyncio.to_thread(ensure_indexes)

    async def close(self) -> None:
        await asyncio.to_thread(self._client.close)

    async def list_agentcore_profiles(self) -> list[RegisteredAgentCoreProfile]:
        docs = await asyncio.to_thread(lambda: list(self._db.harness_agentcore_profiles.find({}, {"_id": 0})))
        return [RegisteredAgentCoreProfile.model_validate(doc) for doc in docs]

    async def create_agentcore_profile(self, profile: RegisteredAgentCoreProfile) -> None:
        try:
            await asyncio.to_thread(self._db.harness_agentcore_profiles.insert_one, profile.model_dump(mode="python"))
        except DuplicateKeyError as exc:
            raise RevisionConflictError(profile.profile_id) from exc

    async def get_agent(self, agent_id: str) -> AgentRecord | None:
        doc = await asyncio.to_thread(self._db.harness_agents.find_one, {"agent_id": agent_id}, {"_id": 0})
        return AgentRecord.model_validate(doc) if doc else None

    async def get_agent_version(self, agent_id: str, version: int | None = None) -> AgentVersion | None:
        if version is None:
            record = await self.get_agent(agent_id)
            version = record.current_version if record else None
        if version is None:
            return None
        doc = await asyncio.to_thread(
            self._db.harness_agent_versions.find_one,
            {"agent_id": agent_id, "version": version},
            {"_id": 0},
        )
        return AgentVersion.model_validate(doc) if doc else None

    async def delete_agent(self, agent_id: str) -> bool:
        def delete() -> bool:
            result = self._db.harness_agents.delete_one({"agent_id": agent_id})
            self._db.harness_agent_versions.delete_many({"agent_id": agent_id})
            return result.deleted_count > 0

        return await asyncio.to_thread(delete)

    async def get_provider_resource(self, agent_id: str) -> ProviderResource | None:
        doc = await asyncio.to_thread(
            self._db.harness_provider_resources.find_one,
            {"agent_id": agent_id},
            {"_id": 0},
        )
        return ProviderResource.model_validate(doc) if doc else None

    async def save_provider_resource(self, resource: ProviderResource) -> ProviderResource:
        await asyncio.to_thread(
            self._db.harness_provider_resources.replace_one,
            {"agent_id": resource.agent_id},
            resource.model_dump(mode="python"),
            upsert=True,
        )
        return resource

    async def delete_provider_resource(self, agent_id: str) -> bool:
        result = await asyncio.to_thread(self._db.harness_provider_resources.delete_one, {"agent_id": agent_id})
        return result.deleted_count > 0

    async def save_agent(
        self,
        blueprint: AgentBlueprint,
        config_fingerprint: str,
        catalog_revision: str,
        expected_revision: int | None,
    ) -> tuple[AgentRecord, AgentVersion]:
        def write() -> tuple[dict[str, object], dict[str, object]]:
            current_doc = self._db.harness_agents.find_one({"agent_id": blueprint.id}, {"_id": 0})
            current = AgentRecord.model_validate(current_doc) if current_doc else None
            if expected_revision is not None and (current is None or current.revision != expected_revision):
                raise RevisionConflictError(blueprint.id)
            now = utc_now()
            number = current.current_version + 1 if current else 1
            version = AgentVersion(
                agent_id=blueprint.id,
                version=number,
                blueprint=blueprint,
                config_fingerprint=config_fingerprint,
                catalog_revision=catalog_revision,
                created_at=now,
            )
            record = AgentRecord(
                agent_id=blueprint.id,
                current_version=number,
                revision=(current.revision + 1) if current else 1,
                enabled=current.enabled if current else True,
                created_at=current.created_at if current else now,
                updated_at=now,
            )
            try:
                self._db.harness_agent_versions.insert_one(version.model_dump(mode="python"))
                self._db.harness_agents.replace_one(
                    {"agent_id": blueprint.id}, record.model_dump(mode="python"), upsert=True
                )
            except DuplicateKeyError as exc:
                raise RevisionConflictError(blueprint.id) from exc
            return record.model_dump(mode="python"), version.model_dump(mode="python")

        record_doc, version_doc = await asyncio.to_thread(write)
        return AgentRecord.model_validate(record_doc), AgentVersion.model_validate(version_doc)

    async def get_session(self, binding_id: str) -> SessionBinding | None:
        doc = await asyncio.to_thread(self._db.harness_sessions.find_one, {"binding_id": binding_id}, {"_id": 0})
        return _session_record(doc) if doc else None

    async def get_latest_session(
        self, owner_subject: str, agent_id: str, conversation_id: str
    ) -> SessionBinding | None:
        doc = await asyncio.to_thread(
            self._db.harness_sessions.find_one,
            {
                "owner_subject": owner_subject,
                "agent_id": agent_id,
                "conversation_id": conversation_id,
            },
            {"_id": 0},
            sort=[("epoch", DESCENDING)],
        )
        return _session_record(doc) if doc else None

    async def create_session(self, binding: SessionBinding) -> SessionBinding:
        if await self.is_context_deleted(binding.conversation_id):
            raise RunAdmissionConflict("Execution context was permanently deleted")
        try:
            await asyncio.to_thread(self._db.harness_sessions.insert_one, binding.model_dump(mode="python"))
            if await self.is_context_deleted(binding.conversation_id):
                await asyncio.to_thread(self._db.harness_sessions.delete_one, {"binding_id": binding.binding_id})
                raise RunAdmissionConflict("Execution context was permanently deleted")
            return binding
        except DuplicateKeyError:
            current = await self.get_session(binding.binding_id)
            if current is None:
                raise
            return current

    async def update_session_provider_id(self, binding_id: str, provider_session_id: str) -> SessionBinding:
        doc = await asyncio.to_thread(
            self._db.harness_sessions.find_one_and_update,
            {"binding_id": binding_id, "status": "active"},
            {
                "$set": {"provider_session_id": provider_session_id, "updated_at": utc_now()},
                "$inc": {"revision": 1},
            },
            return_document=ReturnDocument.AFTER,
        )
        if not doc:
            raise RevisionConflictError(binding_id)
        return _session_record(doc)

    async def close_session(self, binding_id: str) -> SessionBinding:
        doc = await asyncio.to_thread(
            self._db.harness_sessions.find_one_and_update,
            {"binding_id": binding_id, "status": {"$ne": "closed"}},
            {"$set": {"status": "closed", "updated_at": utc_now()}, "$inc": {"revision": 1}},
            return_document=ReturnDocument.AFTER,
        )
        if doc:
            return _session_record(doc)
        current = await self.get_session(binding_id)
        if current is None:
            raise KeyError(binding_id)
        return current

    async def _insert_run(self, document: dict[str, Any]) -> bool:
        try:
            await asyncio.to_thread(self._db.harness_runs.insert_one, document)
            return True
        except DuplicateKeyError:
            return False

    async def _read_run(self, run_id: str) -> dict[str, Any] | None:
        return await asyncio.to_thread(self._db.harness_runs.find_one, {"run_id": run_id}, {"_id": 0})

    async def _change_run(
        self, run_id: str, expected: dict[str, Any], values: dict[str, Any], unset: tuple[str, ...] = ()
    ) -> dict[str, Any] | None:
        update: dict[str, Any] = {"$set": values}
        if unset:
            update["$unset"] = dict.fromkeys(unset, "")
        return await asyncio.to_thread(
            self._db.harness_runs.find_one_and_update,
            {"run_id": run_id, **expected},
            update,
            return_document=ReturnDocument.AFTER,
        )

    async def _find_run(
        self,
        owner_subject: str,
        agent_id: str,
        conversation_id: str,
        active: bool,
        client_request_id: str | None = None,
    ) -> dict[str, Any] | None:
        query: dict[str, Any] = {
            "owner_subject": owner_subject,
            "agent_id": agent_id,
            "conversation_id": conversation_id,
        }
        if active:
            query["status"] = {"$in": ["queued", "running"]}
        if client_request_id is not None:
            query["client_request_id"] = client_request_id
        return await asyncio.to_thread(
            self._db.harness_runs.find_one, query, {"_id": 0}, sort=[("created_at", DESCENDING)]
        )

    async def _store_event(self, document: dict[str, Any]) -> None:
        def store() -> None:
            query = {"run_id": document["run_id"], "sequence": document["sequence"]}
            try:
                self._db.harness_events.update_one(query, {"$setOnInsert": document}, upsert=True)
            except DuplicateKeyError:
                pass
            stored = self._db.harness_events.find_one(query, {"_id": 0})
            if stored != document:
                raise ReplayUnavailableError("Conflicting event append")

        await asyncio.to_thread(store)

    async def _read_events(self, run_id: str, after: int, through: int) -> list[dict[str, Any]]:
        def read() -> list[dict[str, Any]]:
            result: list[dict[str, Any]] = []
            size = 0
            cursor = (
                self._db.harness_events.find(
                    {"run_id": run_id, "sequence": {"$gt": after, "$lte": through}}, {"_id": 0}
                )
                .sort("sequence", ASCENDING)
                .limit(256)
                .batch_size(16)
            )
            for document in cursor:
                size += _event_bytes(document)
                if result and size > _PAGE_MAX_BYTES:
                    break
                result.append(document)
            return result

        return await asyncio.to_thread(read)

    async def _read_binding(self, binding_id: str) -> dict[str, Any] | None:
        return await asyncio.to_thread(self._db.harness_sessions.find_one, {"binding_id": binding_id}, {"_id": 0})

    async def _claim_binding(self, binding_id: str, run_id: str, producer_id: str, deadline: datetime) -> bool:
        result = await asyncio.to_thread(
            self._db.harness_sessions.update_one,
            {"binding_id": binding_id, "status": "active", "_active_run_id": None, "active_run": None, "dispatch_started": {"$ne": True}},
            {"$set": {"_active_run_id": run_id, "_producer_id": producer_id, "_lease_expires_at": deadline}},
        )
        return result.modified_count == 1

    async def _renew_binding(
        self, binding_id: str, run_id: str, producer_id: str, now: datetime, deadline: datetime
    ) -> bool:
        result = await asyncio.to_thread(
            self._db.harness_sessions.update_one,
            {
                "binding_id": binding_id,
                "status": "active",
                "_active_run_id": run_id,
                "_producer_id": producer_id,
                "_lease_expires_at": {"$gt": now},
            },
            {"$set": {"_lease_expires_at": deadline}},
        )
        return result.matched_count == 1

    async def _release_binding(self, binding_id: str, run_id: str, producer_id: str, degraded: bool = False) -> None:
        query = {"binding_id": binding_id, "_active_run_id": run_id, "_producer_id": producer_id}
        if degraded:
            await asyncio.to_thread(
                self._db.harness_sessions.update_one,
                {**query, "status": "active"},
                {"$set": {"status": "degraded", "updated_at": utc_now()}},
            )
        await asyncio.to_thread(
            self._db.harness_sessions.update_one, query, {"$unset": dict.fromkeys(_SESSION_INTERNAL, "")}
        )

    async def is_context_deleted(self, conversation_id: str) -> bool:
        return bool(
            await asyncio.to_thread(self._db.native_acp_deleted_sessions.find_one, {"_id": conversation_id}, {"_id": 1})
        )

    async def context_sessions(self, owner_subject: str, agent_id: str, conversation_id: str) -> list[SessionBinding]:
        def read() -> list[SessionBinding]:
            return [
                _session_record(document)
                for document in self._db.harness_sessions.find(
                    {"owner_subject": owner_subject, "agent_id": agent_id, "conversation_id": conversation_id},
                    {"_id": 0},
                )
            ]

        return await asyncio.to_thread(read)

    async def _context_runs(self, owner_subject: str, agent_id: str, conversation_id: str) -> list[dict[str, Any]]:
        return await asyncio.to_thread(
            lambda: list(
                self._db.harness_runs.find(
                    {"owner_subject": owner_subject, "agent_id": agent_id, "conversation_id": conversation_id},
                    {"run_id": 1, "binding_id": 1, "status": 1, "_owner_token": 1, "_producer_stopped": 1, "_provider_started": 1, "_provider_drained": 1},
                )
            )
        )

    async def purge_context(self, owner_subject: str, agent_id: str, conversation_id: str) -> None:
        if not await self.is_context_deleted(conversation_id) or not await self.context_is_drained(
            owner_subject, agent_id, conversation_id
        ):
            raise RunAdmissionConflict("Deletion requires a fenced, drained execution context")
        query = {"owner_subject": owner_subject, "agent_id": agent_id, "conversation_id": conversation_id}

        def purge() -> None:
            run_ids: list[str] = []
            for document in self._db.harness_runs.find(query, {"run_id": 1}).batch_size(128):
                run_ids.append(document["run_id"])
                if len(run_ids) == 128:
                    self._db.harness_events.delete_many({"run_id": {"$in": run_ids}})
                    run_ids.clear()
            if run_ids:
                self._db.harness_events.delete_many({"run_id": {"$in": run_ids}})
            self._db.harness_runs.delete_many(query)
            self._db.harness_sessions.delete_many(query)

        await asyncio.to_thread(purge)

    async def gateway_harness(self, agent_id: str, conversation_id: str) -> str | None:
        conversation = await asyncio.to_thread(
            self._db.conversations.find_one, {"_id": conversation_id}, {"app_binding": 1},
        )
        if conversation is not None and "app_binding" in conversation:
            raise RunAdmissionConflict("Execution context belongs to an installed app; use its admitted gateway")
        key = hashlib.sha256(f"{agent_id}\0{conversation_id}".encode()).hexdigest()
        claim = await asyncio.to_thread(self._db.harness_gateway_bindings.find_one, {"_id": key}, {"harness_id": 1})
        return claim["harness_id"] if claim else None
