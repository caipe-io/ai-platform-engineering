"""Durable human decisions for an ACP prompt still owned by its worker.

The pending request and idempotent reply live in the existing run document.
Any authorized replica may submit a decision, but only the admitted producer
answers the actual ACP callback. A decision never starts another prompt.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any

from pymongo import ReturnDocument

from dynamic_agents.services.harness_acp import HarnessPendingInput, validate_harness_decision
from dynamic_agents.services.native_run_repository import (
    NativeExecutionRun,
    NativeRunConflictError,
    NativeRunRepository,
    NativeRunStorageError,
    _now,
    _repository_operation,
)

MAX_INPUT_BYTES = 256 * 1024
MAX_DECISIONS = 100


class HarnessInputs:
    def __init__(self, repository: NativeRunRepository) -> None:
        self.repository = repository

    async def persist(self, run_id: str, pending: Any) -> None:
        payload = {**pending.model_dump(mode="json"), "id": pending.interrupt_id}
        if len(json.dumps(payload).encode()) > MAX_INPUT_BYTES:
            raise NativeRunStorageError("The harness input request exceeds the supported size")
        result = await _repository_operation(
            self.repository.runs.update_one,
            {"run_id": run_id, "active": True, "status": "running", "cancel_requested": False},
            {"$set": {"harness_pending": payload, "updated_at": _now()}},
        )
        if not result.matched_count:
            raise NativeRunConflictError("The harness request is no longer active")

    async def publish_waiting(self, run_id: str) -> None:
        """Called by the sole journal producer after persisting InputRequired."""
        def pause() -> None:
            doc = self.repository.runs.find_one({"run_id": run_id, "active": True, "status": "running"})
            if doc and doc.get("harness_pending") and not doc["harness_pending"].get("decision"):
                self.repository._append(run_id, None, "awaiting_input", None, continue_execution=True)

        await _repository_operation(pause)

    async def wait(self, run_id: str, pending: Any) -> dict:
        while True:
            doc = await _repository_operation(self.repository.runs.find_one, {"run_id": run_id})
            if not doc or not doc.get("active") or doc.get("cancel_requested") or doc.get("retired"):
                raise asyncio.CancelledError
            state = doc.get("harness_pending")
            if not state or state["id"] != pending.interrupt_id:
                raise NativeRunConflictError("The pending harness request changed")
            if state.get("decision") is not None:
                return state["decision"]
            await asyncio.sleep(0.25)

    async def current(self, agent_id: str, session_id: str) -> dict | None:
        doc = await _repository_operation(self.repository.runs.find_one, {
            "agent_id": agent_id, "session_id": session_id, "active": True, "status": "awaiting_input",
        })
        if not doc:
            return None
        run = await self.repository.get(doc["run_id"], owner_subject=None)
        return doc["harness_pending"]["event"] if run and run.active and doc.get("harness_pending") else None

    async def submit(self, *, agent_id: str, session_id: str, owner: str, turn_id: str,
                     resume_data: str, protocol: str) -> NativeExecutionRun:
        if len(resume_data.encode()) > MAX_INPUT_BYTES:
            raise NativeRunConflictError("The harness decision exceeds the supported size")
        try:
            submitted = json.loads(resume_data)
        except (json.JSONDecodeError, TypeError):
            raise NativeRunConflictError("The harness decision is invalid") from None
        if not isinstance(submitted, dict) or not isinstance(submitted.get("interrupt_id"), str):
            raise NativeRunConflictError("The decision must identify the pending harness request")
        digest = hashlib.sha256(json.dumps(submitted, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

        def commit() -> NativeExecutionRun:
            scope = {"agent_id": agent_id, "session_id": session_id, "owner_subject": owner}
            # Retried submissions attach even when the original prompt finished
            # before its HTTP response reached this replica.
            def previous_submission() -> NativeExecutionRun | None:
                previous = self.repository.runs.find_one({**scope, "harness_decisions.turn_id": turn_id})
                if previous is None:
                    return None
                record = next(item for item in previous["harness_decisions"] if item["turn_id"] == turn_id)
                if record["fingerprint"] != digest or previous["protocol"] != protocol:
                    raise NativeRunConflictError("This turn ID belongs to a different harness decision")
                retained = self.repository._get({"run_id": previous["run_id"]})
                if retained is None or retained.retired:
                    raise NativeRunConflictError("The execution context is no longer available")
                return retained.model_copy(update={"current_turn_id": turn_id, "first_sequence": record["after"]})

            previous = previous_submission()
            if previous is not None:
                return previous
            doc = self.repository.runs.find_one({**scope, "active": True, "status": "awaiting_input"})
            if not doc or doc.get("cancel_requested") or doc.get("retired"):
                previous = previous_submission()
                if previous is not None:
                    return previous
                raise NativeRunConflictError("There is no active harness request waiting for this decision")
            run = self.repository._get({"run_id": doc["run_id"]})
            if run is None or not run.active or run.protocol != protocol:
                raise NativeRunConflictError("The original harness worker is unavailable or uses a different protocol")
            pending = doc.get("harness_pending", {})
            if pending.get("id") != submitted["interrupt_id"]:
                raise NativeRunConflictError("This decision belongs to a different harness request")
            if len(doc.get("harness_decisions", [])) >= MAX_DECISIONS:
                raise NativeRunConflictError("This prompt reached its human-decision limit")
            try:
                retained = {key: value for key, value in pending.items() if key not in {"id", "decision"}}
                decision = validate_harness_decision(HarnessPendingInput.model_validate(retained), submitted)
            except ValueError:
                raise NativeRunConflictError("Select a valid answer to the harness's displayed request") from None
            after = run.last_sequence
            updated = self.repository.runs.find_one_and_update(
                {**scope, "run_id": run.run_id, "active": True, "status": "awaiting_input",
                 "cancel_requested": False, "harness_pending.id": pending["id"],
                 "harness_pending.decision": {"$exists": False}},
                {"$set": {"harness_pending.decision": decision, "status": "running", "updated_at": _now(),
                          "current_turn_id": turn_id, "first_sequence": after},
                 "$push": {"harness_decisions": {"turn_id": turn_id, "fingerprint": digest, "after": after}}},
                return_document=ReturnDocument.AFTER,
            )
            if updated is None:
                previous = previous_submission()
                if previous is not None:
                    return previous
                raise NativeRunConflictError("This harness request was already answered; attach to its retained run")
            return NativeExecutionRun.model_validate(updated)

        return await _repository_operation(commit)
