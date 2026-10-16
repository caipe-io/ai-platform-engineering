"""Concurrent cross-replica decisions use one durable idempotency identity."""

from __future__ import annotations

import asyncio
import json
from threading import Barrier
from types import SimpleNamespace
from typing import Any

import pytest

from dynamic_agents.services.harness_acp import HarnessPendingInput
from dynamic_agents.services.harness_inputs import HarnessInputs
from dynamic_agents.services.native_run_repository import NativeRunConflictError, NativeRunRepository
from dynamic_agents.services.session_runs import native_session_run
from dynamic_agents.services.stream_encoders.events import InputRequired
from tests.test_native_acp_mongodb import native_database as native_database

OWNER = "user:example-owner"


async def test_simultaneous_identical_human_decision_is_idempotent(native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    state = native_database
    repository = NativeRunRepository(state.mongo)
    await repository.initialize()
    run, _ = await repository.create(owner_subject=OWNER, agent_id=state.agent.id, session_id=state.session_id,
                                     turn_id="original", fingerprint="original", protocol="custom")
    pending = HarnessPendingInput(interrupt_id="current-input", session_id="provider-session",
        method="session/request_permission", request={"options": [{"optionId": "allow-once"}]},
        event=InputRequired(interrupt_id="current-input", interrupt_type="form_input", agent="Example", prompt="Choose", fields=[]))
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        await repository.bind_lease(run.run_id, lease)
        inputs = HarnessInputs(repository)
        await inputs.persist(run.run_id, pending)
        await inputs.publish_waiting(run.run_id)
        barrier = Barrier(2, timeout=5)
        original = repository.runs.find_one_and_update

        def simultaneous(query: dict, update: dict, **kwargs: Any) -> dict | None:
            if "harness_pending.decision" in query:
                barrier.wait()
            return original(query, update, **kwargs)

        monkeypatch.setattr(repository.runs, "find_one_and_update", simultaneous)
        args = {"agent_id": state.agent.id, "session_id": state.session_id, "owner": OWNER, "turn_id": "decision-turn",
                "protocol": "custom", "resume_data": json.dumps({"type": "form_input", "interrupt_id": pending.interrupt_id, "values": {"option_id": "allow-once"}})}
        results = await asyncio.gather(inputs.submit(**args), inputs.submit(**args), return_exceptions=True)
        assert all(not isinstance(result, Exception) for result in results), results
        assert results[0].run_id == results[1].run_id == run.run_id
        record = repository.runs.find_one({"run_id": run.run_id})
        assert len(record["harness_decisions"]) == 1


async def test_cancellation_before_human_decision_never_reopens_run(native_database: SimpleNamespace) -> None:
    state = native_database
    repository = NativeRunRepository(state.mongo)
    await repository.initialize()
    run, _ = await repository.create(owner_subject=OWNER, agent_id=state.agent.id, session_id=state.session_id,
                                     turn_id="original", fingerprint="original", protocol="custom")
    pending = HarnessPendingInput(interrupt_id="current-input", session_id="provider-session",
        method="session/request_permission", request={"options": [{"optionId": "allow-once"}]},
        event=InputRequired(interrupt_id="current-input", interrupt_type="form_input", agent="Example", prompt="Choose", fields=[]))
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        await repository.bind_lease(run.run_id, lease)
        inputs = HarnessInputs(repository)
        await inputs.persist(run.run_id, pending)
        await inputs.publish_waiting(run.run_id)
        assert await repository.request_cancel(state.agent.id, state.session_id, turn_id="original")
        with pytest.raises(NativeRunConflictError):
            await inputs.submit(agent_id=state.agent.id, session_id=state.session_id, owner=OWNER, turn_id="decision-turn", protocol="custom",
                                resume_data=json.dumps({"type": "form_input", "interrupt_id": pending.interrupt_id, "values": {"option_id": "allow-once"}}))
        assert "decision" not in repository.runs.find_one({"run_id": run.run_id})["harness_pending"]
