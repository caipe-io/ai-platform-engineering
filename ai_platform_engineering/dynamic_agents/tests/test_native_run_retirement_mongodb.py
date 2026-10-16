"""Checkpoint edits retire stale replay without deleting the audit journal."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from dynamic_agents.routes import conversations
from dynamic_agents.services.agent_execution import ExecutionTurn
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.native_run_repository import (
    EXECUTION_EVENTS_COLLECTION,
    EXECUTION_RUNS_COLLECTION,
    NativeRunBusyError,
    NativeRunConflictError,
    NativeRunRepository,
    NativeRunStorageError,
)
from dynamic_agents.services.session_bindings import SESSION_BINDINGS_COLLECTION
from dynamic_agents.services.session_runs import native_session_run
from tests.test_native_acp_mongodb import _checkpoint_config, _graph, _service
from tests.test_native_acp_mongodb import native_database as native_database
from tests.test_native_execution_runs_mongodb import AGENT, SESSION, _frame, _request, _scope
from tests.test_native_run_continuity_mongodb import _finished


async def test_retirement_hides_terminal_replay_preserves_journal_and_rejects_old_turn_retries(native_database: SimpleNamespace) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    original, _ = await repository.create(**_request())
    await repository.append_frame(original.run_id, _frame("RUN_FINISHED", outcome="success"))
    await repository.finish(original.run_id, "completed")
    event_count = native_database.db[EXECUTION_EVENTS_COLLECTION].count_documents({})
    async with native_session_run(native_database.mongo, AGENT, SESSION):
        assert await repository.retire_session(AGENT, SESSION) == 1
    assert await repository.get(original.run_id, **_scope()) is None
    assert await repository.latest(**_scope()) is None
    assert await repository.replay(original.run_id, 0, **_scope()) is None
    assert native_database.db[EXECUTION_RUNS_COLLECTION].count_documents({}) == 1
    assert native_database.db[EXECUTION_EVENTS_COLLECTION].count_documents({}) == event_count
    with pytest.raises(NativeRunConflictError):
        await repository.create(**_request())
    following, created = await repository.create(**_request(turn_id="next-turn"))
    assert created and following.run_id != original.run_id
    assert (await repository.finish(original.run_id, "completed")).status == "completed"
    assert native_database.db[EXECUTION_EVENTS_COLLECTION].count_documents({}) == event_count
    assert (await repository.get(following.run_id, **_scope())).status == "queued"


async def test_state_reset_cannot_retire_an_admitted_queued_request(native_database: SimpleNamespace) -> None:
    repository = NativeRunRepository(native_database.mongo)
    await repository.initialize()
    original, _ = await repository.create(**_request())
    before = native_database.db[EXECUTION_RUNS_COLLECTION].find_one({"run_id": original.run_id})
    async with native_session_run(native_database.mongo, AGENT, SESSION):
        with pytest.raises(NativeRunBusyError):
            await repository.retire_session(AGENT, SESSION)
    after = native_database.db[EXECUTION_RUNS_COLLECTION].find_one({"run_id": original.run_id})
    assert before == after and (await repository.get(original.run_id, **_scope())).status == "queued"


@pytest.mark.parametrize("mutation", ["clear", "rewind"])
async def test_native_checkpoint_mutation_retires_pre_edit_replay_and_allows_a_fresh_turn(
    native_database: SimpleNamespace, mutation: str,
) -> None:
    state = native_database
    service = _service(state)
    requests, runs = [], []
    try:
        for number in (1, 2):
            turn = ExecutionTurn(
                agent=state.agent, session_id=state.session_id, user=state.user,
                message=f"Request {number}", turn_id=f"original-turn-{number}",
            )
            requests.append(turn)
            run = await service.start_run(turn, "agui")
            assert (await _finished(service, state, run.run_id)).status == "completed"
            runs.append(run)
        if mutation == "clear":
            counts = await service.clear(state.agent.id, state.session_id)
            assert counts.checkpoints_deleted > 0
            assert state.db["example_checkpoints"].count_documents({"thread_id": state.session_id}) == 0
        else:
            await service.rewind(
                state.agent, state.session_id, state.user,
                turn_id="original-turn-2", message_content="Request 2", content_occurrence=1,
            )
            checkpoint = await _graph(state, state.agent).aget_state(_checkpoint_config(state))
            assert len(checkpoint.values["messages"]) == 2
            assert checkpoint.values["messages"][0].id == "original-turn-1"
        fresh = _service(state)
        for run in runs:
            assert await fresh.get_run_status(state.agent.id, state.session_id, state.user, run_id=run.run_id) is None
        assert await fresh.get_run_status(state.agent.id, state.session_id, state.user) is None
        assert state.db[EXECUTION_RUNS_COLLECTION].count_documents({"retired": True}) == 2
        with pytest.raises(NativeRunConflictError):
            await fresh.start_run(requests[-1], "agui")
        following = await fresh.start_run(ExecutionTurn(
            agent=state.agent, session_id=state.session_id, user=state.user,
            message="Fresh request", turn_id="fresh-turn",
        ), "agui")
        assert (await _finished(fresh, state, following.run_id)).status == "completed"
        checkpoint = await _graph(state, state.agent).aget_state(_checkpoint_config(state))
        assert checkpoint.values["messages"][-2].id == "fresh-turn"
        assert len(checkpoint.values["messages"]) == (2 if mutation == "clear" else 4)
        assert state.db[SESSION_BINDINGS_COLLECTION].count_documents({}) == 1
    finally:
        await service.coordinator.shutdown()


async def test_admin_clear_canonical_participant_binding_retires_interrupt_and_clears_admitted_state(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = native_database
    service = _service(state, "tool_approval")
    run = await service.start_run(ExecutionTurn(
        agent=state.agent, session_id=state.session_id, user=state.user,
        message="Request approval", turn_id="original-turn",
    ), "agui")
    try:
        assert (await _finished(service, state, run.run_id)).status == "awaiting_input"
        assert (await service.interrupt_state(state.agent, state.session_id, state.user))["type"] == "tool_approval"
        store = MongoDBGridFSStore(db=state.db, bucket_name=state.settings.gridfs_bucket_name)
        namespace = tuple(state.agent.backend.config.fs_namespace)
        other_namespace = (state.agent.id, "other-thread", "filesystem")
        store.put(namespace, "/approval.txt", {"content": "clear this logical file"})
        store.put(other_namespace, "/approval.txt", {"content": "preserve this other session"})
        state.db["conversations"].insert_one({
            "_id": state.session_id, "owner_id": state.user.email,
            "participants": [{"type": "agent", "id": state.agent.id}],
        })
        monkeypatch.setattr(conversations, "AgentExecutionService", lambda _: service)
        result = await conversations.clear_conversation_checkpoints(
            state.session_id, state.user.model_copy(update={"is_admin": True}), state.mongo,
        )
        assert result.data["files_deleted"] == 1 and result.data["checkpoints_deleted"] > 0
        assert store.get(namespace, "/approval.txt") is None
        assert store.get(other_namespace, "/approval.txt").value == {"content": "preserve this other session"}
        fresh = _service(state, "tool_approval")
        assert await fresh.get_run_status(state.agent.id, state.session_id, state.user, run_id=run.run_id) is None
        assert await fresh.interrupt_state(state.agent, state.session_id, state.user) is None
        assert state.db["example_checkpoints"].count_documents({"thread_id": state.session_id}) == 0
        assert state.db["example_checkpoints_writes"].count_documents({"thread_id": state.session_id}) == 0
        assert state.db[EXECUTION_RUNS_COLLECTION].count_documents({"run_id": run.run_id, "retired": True}) == 1
        assert state.db[EXECUTION_EVENTS_COLLECTION].count_documents({"run_id": run.run_id}) > 0
    finally:
        await service.coordinator.shutdown()


async def test_rewind_pending_approval_cannot_replay_or_restore_the_edited_away_interrupt(native_database: SimpleNamespace) -> None:
    state = native_database
    service = _service(state)
    first = await service.start_run(ExecutionTurn(
        agent=state.agent, session_id=state.session_id, user=state.user,
        message="Completed request", turn_id="first-turn",
    ), "agui")
    try:
        assert (await _finished(service, state, first.run_id)).status == "completed"
        pending_service = _service(state, "tool_approval")
        pending = await pending_service.start_run(ExecutionTurn(
            agent=state.agent, session_id=state.session_id, user=state.user,
            message="Edited-away request", turn_id="pending-turn",
        ), "agui")
        assert (await _finished(pending_service, state, pending.run_id)).status == "awaiting_input"
        await pending_service.rewind(
            state.agent, state.session_id, state.user,
            turn_id="pending-turn", message_content="Edited-away request", content_occurrence=1,
        )
        fresh = _service(state, "tool_approval")
        assert await fresh.get_run_status(state.agent.id, state.session_id, state.user, run_id=pending.run_id) is None
        assert await fresh.interrupt_state(state.agent, state.session_id, state.user) is None
        checkpoint = await _graph(state, state.agent, "tool_approval").aget_state(_checkpoint_config(state))
        assert len(checkpoint.values["messages"]) == 2 and not checkpoint.interrupts
        assert checkpoint.values["messages"][0].id == "first-turn"
        assert state.db[EXECUTION_EVENTS_COLLECTION].count_documents({"run_id": pending.run_id}) > 0
    finally:
        await service.coordinator.shutdown()


@pytest.mark.parametrize("pending", ["form_input", "tool_approval"])
async def test_invalid_rewind_preserves_pending_native_input_and_its_replay_journal(
    native_database: SimpleNamespace, pending: str,
) -> None:
    state = native_database
    service = _service(state, pending)
    run = await service.start_run(ExecutionTurn(
        agent=state.agent, session_id=state.session_id, user=state.user,
        message="Request approval", turn_id="original-turn",
    ), "agui")
    try:
        awaiting = await _finished(service, state, run.run_id)
        assert awaiting.status == "awaiting_input"
        before = await _graph(state, state.agent, pending).aget_state(_checkpoint_config(state))
        journal = state.db[EXECUTION_RUNS_COLLECTION].find_one({"run_id": run.run_id})
        replay = [frame async for frame in service.run_events(awaiting)]
        with pytest.raises(ValueError, match="Unable to match"):
            await service.rewind(
                state.agent, state.session_id, state.user,
                turn_id="missing-turn", message_content="Missing request", content_occurrence=1,
            )
        after = await _graph(state, state.agent, pending).aget_state(_checkpoint_config(state))
        assert after.config == before.config and after.interrupts == before.interrupts
        assert [(message.id, message.content) for message in after.values["messages"]] == [
            (message.id, message.content) for message in before.values["messages"]
        ]
        assert state.db[EXECUTION_RUNS_COLLECTION].find_one({"run_id": run.run_id}) == journal
        restored = await service.get_run_status(state.agent.id, state.session_id, state.user, run_id=run.run_id)
        assert restored.status == "awaiting_input"
        assert [frame async for frame in service.run_events(restored)] == replay
        assert (await service.interrupt_state(state.agent, state.session_id, state.user))["type"] == pending
    finally:
        await service.coordinator.shutdown()


async def test_rewind_retirement_storage_failure_returns_503_before_checkpoint_mutation(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = native_database
    service = _service(state, "tool_approval")
    run = await service.start_run(ExecutionTurn(
        agent=state.agent, session_id=state.session_id, user=state.user,
        message="Request approval", turn_id="original-turn",
    ), "agui")
    try:
        awaiting = await _finished(service, state, run.run_id)
        checkpoint = await _graph(state, state.agent, "tool_approval").aget_state(_checkpoint_config(state))
        journal = state.db[EXECUTION_RUNS_COLLECTION].find_one({"run_id": run.run_id})
        state.db["conversations"].insert_one({
            "_id": state.session_id, "owner_id": state.user.email, "agent_id": state.agent.id,
        })
        monkeypatch.setattr(state.mongo, "get_agent", lambda _: state.agent)
        monkeypatch.setattr(conversations, "AgentExecutionService", lambda _: service)
        retirement = AsyncMock(side_effect=NativeRunStorageError("Canonical retirement storage unavailable"))
        monkeypatch.setattr(service.coordinator.repository, "retire_session", retirement)
        with pytest.raises(HTTPException) as failure:
            await conversations.rewind_conversation(
                state.session_id, conversations.RewindConversationRequest(
                    agent_id=state.agent.id, turn_id="original-turn", message_content="Request approval", content_occurrence=1,
                ), state.user, state.mongo,
            )
        assert failure.value.status_code == 503
        retirement.assert_awaited_once_with(state.agent.id, state.session_id)
        after = await _graph(state, state.agent, "tool_approval").aget_state(_checkpoint_config(state))
        assert after.config == checkpoint.config and after.interrupts == checkpoint.interrupts
        assert state.db[EXECUTION_RUNS_COLLECTION].find_one({"run_id": run.run_id}) == journal
        assert (await service.get_run_status(state.agent.id, state.session_id, state.user, run_id=run.run_id)).status == awaiting.status
    finally:
        await service.coordinator.shutdown()
