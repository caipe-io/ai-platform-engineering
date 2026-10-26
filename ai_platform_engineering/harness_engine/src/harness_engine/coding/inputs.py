"""Durable human answers for one ACP prompt, using its existing Engine run."""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from pymongo import ReturnDocument

from harness_engine.coding.acp_client import HarnessPendingInput, validate_harness_decision
from harness_engine.coding.admission import CodingAdmissionError, RunFence
from harness_engine.models import RunRecord

MAX_INPUT_BYTES = 256 * 1024
MAX_DECISIONS = 100


class SubmitCodingInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_request_id: str = Field(min_length=1, max_length=128)
    decision: dict[str, Any]


def _fingerprint(value: Any) -> str:
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode()
    except (ValueError, TypeError):
        raise CodingAdmissionError("The human decision is invalid") from None
    if len(encoded) > MAX_INPUT_BYTES:
        raise CodingAdmissionError("The human decision exceeds its supported size")
    return hashlib.sha256(encoded).hexdigest()


class CodingInputs:
    def __init__(self, fence: RunFence) -> None:
        self.fence, self.runs = fence, fence.db.harness_runs

    async def persist(self, pending: HarnessPendingInput) -> None:
        await self.fence.require()
        data = pending.model_dump(mode="json")
        _fingerprint(data)
        context = self.fence.context
        query = {
            "run_id": context.turn.run_id,
            "_producer_id": context.producer_token,
            "status": "running",
            "cancellation_requested": False,
            "$or": [{"_coding_pending": {"$exists": False}}, {"_coding_pending.decision": {"$exists": True}}],
        }
        result = await asyncio.to_thread(self.runs.update_one, query, {"$set": {"_coding_pending": data}})
        if result.modified_count != 1:
            raise CodingAdmissionError("The harness human request is no longer admitted")
        # The owning Engine producer publishes interrupt.requested immediately
        # afterward, transitioning the one run to awaiting_input.

    async def wait(self, pending: HarnessPendingInput) -> dict[str, Any]:
        while True:
            run, _ = await self.fence.require()
            stored = run.get("_coding_pending")
            if not stored or stored.get("interrupt_id") != pending.interrupt_id:
                raise CodingAdmissionError("The harness human request changed")
            if "decision" in stored:
                return validate_harness_decision(pending, stored["decision"])
            await asyncio.sleep(0.2)

    async def submit(self, request: SubmitCodingInput) -> tuple[RunRecord, int]:
        digest = _fingerprint(request.decision)
        context = self.fence.context

        def previous(doc: dict[str, Any]) -> tuple[RunRecord, int] | None:
            for item in doc.get("_coding_decisions", []):
                if item["client_request_id"] == request.client_request_id:
                    if item["fingerprint"] != digest:
                        raise CodingAdmissionError("This decision identity belongs to different input")
                    public = {key: value for key, value in doc.items() if key in RunRecord.model_fields}
                    return RunRecord.model_validate(public), item["after_cursor"]
            return None

        # Exact retries can attach even if the original worker already committed
        # completion. They never start another provider prompt.
        document = await asyncio.to_thread(
            self.runs.find_one, {"run_id": context.turn.run_id, "owner_subject": context.binding.owner_subject}
        )
        if not document:
            raise CodingAdmissionError("The harness run is unavailable")
        retained = previous(document)
        if retained is not None:
            return retained
        run, _ = await self.fence.require()
        pending_data = run.get("_coding_pending")
        if run.get("status") != "awaiting_input" or not pending_data or pending_data.get("decision") is not None:
            raise CodingAdmissionError("This harness is not waiting for a human decision")
        pending = HarnessPendingInput.model_validate(pending_data)
        if request.decision.get("interrupt_id") != pending.interrupt_id:
            raise CodingAdmissionError("The decision belongs to a different human request")
        decision = validate_harness_decision(pending, request.decision)
        if len(run.get("_coding_decisions", [])) >= MAX_DECISIONS:
            raise CodingAdmissionError("The harness prompt reached its human-decision limit")
        after = run["last_sequence"]
        changed = await asyncio.to_thread(
            self.runs.find_one_and_update,
            {
                "run_id": context.turn.run_id,
                "_producer_id": context.producer_token,
                "status": "awaiting_input",
                "cancellation_requested": False,
                "_coding_pending.interrupt_id": pending.interrupt_id,
                "_coding_pending.decision": {"$exists": False},
            },
            {
                "$set": {"_coding_pending.decision": decision},
                "$push": {
                    "_coding_decisions": {
                        "client_request_id": request.client_request_id,
                        "fingerprint": digest,
                        "after_cursor": after,
                    }
                },
            },
            return_document=ReturnDocument.AFTER,
        )
        if changed is None:
            current = await asyncio.to_thread(self.runs.find_one, {"run_id": context.turn.run_id})
            retained = previous(current or {})
            if retained is not None:
                return retained
            raise CodingAdmissionError("The human request was already answered")
        # The provider callback consumes this answer and emits resolved; API
        # replicas do not mutate canonical run lifecycle or append events.
        public = {key: value for key, value in changed.items() if key in RunRecord.model_fields}
        return RunRecord.model_validate(public), after
