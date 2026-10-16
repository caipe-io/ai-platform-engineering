"""Real ACP decisions and cross-replica continuation in canonical MongoDB."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from dynamic_agents.services.harness_acp import HarnessACPDriver
from dynamic_agents.services.harness_inputs import HarnessInputs
from dynamic_agents.services.native_run_coordinator import (
    NativeRunCoordinator,
    current_native_execution_run,
    mark_native_run_admitted,
    mark_native_run_released,
)
from dynamic_agents.services.native_run_repository import NativeRunConflictError, NativeRunRepository
from dynamic_agents.services.session_runs import native_session_run
from dynamic_agents.services.stream_encoders import get_encoder
from tests.test_harness_acp import HarnessPeer
from tests.test_native_acp_mongodb import native_database as native_database

OWNER = "user:example-owner"


async def _start(state: SimpleNamespace, protocol: str = "custom"):
    repository = NativeRunRepository(state.mongo)
    await repository.initialize()
    coordinator = NativeRunCoordinator(repository)
    inputs = HarnessInputs(repository)
    peer = HarnessPeer(interaction="permission")
    encoder = get_encoder(protocol)

    async def producer():
        run = current_native_execution_run.get()
        assert run is not None
        async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease_id:
            await mark_native_run_admitted(lease_id)
            driver = HarnessACPDriver(
                peer, agent_name=state.agent.name, canonical_session_id=state.session_id,
                persist_session=lambda _session: asyncio.sleep(0),
                persist_input=lambda pending: inputs.persist(run.run_id, pending),
                wait_for_decision=lambda pending: inputs.wait(run.run_id, pending),
            )
            try:
                await driver.open("/workspace")
                async for frame in driver.stream("Use the selected source", encoder, run_id=run.run_id):
                    yield frame
            finally:
                await driver.close()
                await mark_native_run_released()

    run = await coordinator.start(
        owner_subject=OWNER, agent_id=state.agent.id, session_id=state.session_id,
        turn_id="original-turn", fingerprint="original-input", protocol=protocol,
        producer=producer, outcome=encoder.get_outcome,
    )
    async with asyncio.timeout(10):
        initial = [frame async for frame in coordinator.subscribe(run)]
    return coordinator, repository, peer, run, initial


def _reply(state, pending, **updates):
    return {
        "agent_id": state.agent.id, "session_id": state.session_id, "owner": OWNER,
        "turn_id": "decision-turn", "protocol": "custom", "resume_data": json.dumps({
            "type": "form_input", "interrupt_id": pending["interrupt_id"], "values": {"option_id": "allow-once"},
        }), **updates,
    }


@pytest.mark.parametrize("protocol", ["custom", "agui"])
async def test_permission_survives_subscriber_loss_and_other_replica_resumes_one_prompt(native_database, protocol):
    state = native_database
    coordinator, repository, peer, run, initial = await _start(state, protocol)
    try:
        assert any("awaiting_input" in frame for frame in initial)
        paused = await repository.get(run.run_id, owner_subject=OWNER)
        assert paused.active and paused.status == "awaiting_input"
        assert state.mongo.get_session_runs_collection().find_one({"session_id": state.session_id})
        pending = await HarnessInputs(repository).current(state.agent.id, state.session_id)
        other_replica = HarnessInputs(NativeRunRepository(state.mongo))
        response = await other_replica.submit(**_reply(state, pending, protocol=protocol))
        assert response.first_sequence == paused.last_sequence
        async with asyncio.timeout(10):
            continued = [frame async for frame in coordinator.subscribe(response, response.first_sequence)]
        assert not any("input_required" in frame or "awaiting_input" in frame for frame in continued)
        assert any("Result" in frame for frame in continued)
        completed = await repository.get(run.run_id, owner_subject=OWNER)
        assert completed.status == "completed" and not completed.active
        assert completed.public()["turn_id"] == "decision-turn"
        retry = await other_replica.submit(**_reply(state, pending, protocol=protocol))
        assert retry.run_id == run.run_id and retry.first_sequence == paused.last_sequence
        assert len([message for message in peer.sent if message.get("method") == "session/prompt"]) == 1
    finally:
        await coordinator.shutdown()


async def test_decision_is_bound_to_owner_request_choices_and_idempotent_input(native_database):
    state = native_database
    coordinator, repository, _, run, _ = await _start(state)
    try:
        inputs = HarnessInputs(repository)
        pending = await inputs.current(state.agent.id, state.session_id)
        with pytest.raises(NativeRunConflictError):
            await inputs.submit(**_reply(state, pending, owner="user:another-owner"))
        wrong = json.dumps({"type": "form_input", "interrupt_id": "stale-request", "values": {"option_id": "allow-once"}})
        with pytest.raises(NativeRunConflictError):
            await inputs.submit(**_reply(state, pending, resume_data=wrong))
        wrong = json.dumps({"type": "form_input", "interrupt_id": pending["interrupt_id"], "values": {"option_id": "invented"}})
        with pytest.raises(NativeRunConflictError):
            await inputs.submit(**_reply(state, pending, resume_data=wrong))
        await inputs.submit(**_reply(state, pending))
        changed = json.dumps({"type": "form_input", "interrupt_id": pending["interrupt_id"], "values": {"option_id": "reject-once"}})
        with pytest.raises(NativeRunConflictError):
            await inputs.submit(**_reply(state, pending, resume_data=changed))
        assert not await repository.request_cancel(state.agent.id, state.session_id, turn_id="original-turn")
    finally:
        await coordinator.shutdown()


async def test_lost_owner_while_awaiting_input_is_interrupted_without_restarting_tools(native_database):
    state = native_database
    coordinator, repository, peer, run, _ = await _start(state)
    try:
        pending = await HarnessInputs(repository).current(state.agent.id, state.session_id)
        state.mongo.get_session_runs_collection().update_one(
            {"session_id": state.session_id}, {"$set": {"lease_expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)}},
        )
        interrupted = await repository.get(run.run_id, owner_subject=OWNER)
        assert interrupted.status == "interrupted" and not interrupted.active
        with pytest.raises(NativeRunConflictError):
            await HarnessInputs(repository).submit(**_reply(state, pending))
        assert len([message for message in peer.sent if message.get("method") == "session/prompt"]) == 1
    finally:
        await coordinator.shutdown()
