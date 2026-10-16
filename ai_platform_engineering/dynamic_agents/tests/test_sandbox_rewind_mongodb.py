"""Native sandbox edit/reconnect keeps opaque state and canonical child history."""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import NAMESPACE_URL, uuid5

import pytest
from langchain_core.messages import HumanMessage

from dynamic_agents.models import DynamicAgentConfig
from dynamic_agents.services import sandbox_lifecycle
from dynamic_agents.services.agent_execution import AgentExecutionService
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.harness_checkpoints import CheckpointStore
from dynamic_agents.services.runtime_storage import resolve_runtime_storage
from dynamic_agents.services.sandbox_client import SandboxClient, SandboxError
from dynamic_agents.services.session_bindings import (
    get_delegated_sessions,
    get_native_binding,
    get_sandbox_binding,
    link_delegated_session,
    resolve_native_binding,
)
from dynamic_agents.services.session_runs import native_session_run
from tests.test_native_acp_mongodb import _graph, _ReconstructedRuntimeCache
from tests.test_native_acp_mongodb import native_database as native_database
from tests.test_sandbox_execution_mongodb import _collect, _service, _turn
from tests.test_sandbox_execution_mongodb import sandbox_database as sandbox_database


async def _complete(state, service, turn_id, message="Repeated request"):
    run = await service.start_run(_turn(state, turn_id, message), "custom")
    final, _ = await _collect(service, run)
    assert final.status == "completed"
    return run


async def _confirm(state, service, checkpoint_id, turn_id, occurrence):
    await service.confirm_rewind(state.agent.id, state.session_id, state.user, checkpoint_id=checkpoint_id,
        turn_id=turn_id, message_content="Repeated request", content_occurrence=occurrence)


async def test_rewind_retains_old_turn_archives_and_rehydrates_real_state_on_another_replica(sandbox_database):
    state = sandbox_database
    service = _service(state)
    runs = [await _complete(state, service, f"turn-{number}") for number in range(6)]
    assert state.portal.native_state["turns"] == 6
    assert state.db["native_acp_checkpoints"].count_documents({"status": "ready"}) == 6
    selected = state.portal.exports[0]["checkpoint_id"]
    assert await service.rewind(state.agent, state.session_id, state.user,
        turn_id="turn-1", message_content="Repeated request", content_occurrence=2) == selected
    authority = state.mongo.get_session_runs_collection().find_one({"session_id": state.session_id})
    assert authority["checkpoint_head"]["checkpoint_id"] == selected
    assert authority["checkpoint_turn_head"] == runs[0].run_id
    assert state.db["native_acp_execution_runs"].count_documents({"retired": True}) == 6
    await _confirm(state, service, selected, "turn-1", 2)
    await _complete(state, _service(state, replica=True), "edited-turn", "Edited request")
    assert state.portal.native_state["turns"] == 2
    assert state.portal.restores[-1]["checkpoint_id"] == selected
    assert [message.get("method") for message in state.portal.peers[-1].sent][:3] == ["initialize", "session/load", "session/prompt"]
    with pytest.raises(ValueError, match="Unable to match"):
        await service.rewind(state.agent, state.session_id, state.user,
            turn_id="turn-5", message_content="discarded request", content_occurrence=1)


async def test_rewind_uses_chronological_occurrence_when_ui_turn_ids_differ(sandbox_database):
    state = sandbox_database
    service = _service(state)
    for number in range(4):
        await _complete(state, service, f"turn-{number}")
    checkpoint = await service.rewind(state.agent, state.session_id, state.user,
        turn_id="frontend-only-message-id", message_content="Repeated request", content_occurrence=2)
    assert checkpoint == state.portal.exports[0]["checkpoint_id"]
    await _confirm(state, service, checkpoint, "frontend-only-message-id", 2)
    await _complete(state, service, "replacement")
    assert state.portal.native_state["turns"] == 2


async def test_first_turn_rewind_deletes_native_environment_but_keeps_agent_and_logical_files(sandbox_database, monkeypatch):
    state = sandbox_database
    service = _service(state)
    first = await _complete(state, service, "initial")
    admitted = get_native_binding(state.mongo, state.agent.id, state.session_id)
    monkeypatch.setattr(sandbox_lifecycle, "current_subject_reference", lambda: first.owner_subject)
    storage = resolve_runtime_storage(state.agent, state.session_id, state.settings)
    files = MongoDBGridFSStore(db=state.db, bucket_name=storage.gridfs_bucket_name)
    files.put(storage.fs_namespace, "/output.txt", {"content": "Canonical logical output"})

    async def delete(*_args):
        state.portal.allocation = None
        state.portal.native_state.update(turns=0, workspace="empty")

    deleted = AsyncMock(side_effect=delete)
    monkeypatch.setattr(SandboxClient, "delete", deleted)
    assert await service.rewind(state.agent, state.session_id, state.user,
        turn_id="initial", message_content="Repeated request", content_occurrence=1) == first.run_id
    deleted.assert_awaited_once()
    assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) is None
    assert get_native_binding(state.mongo, state.agent.id, state.session_id) == admitted
    assert files.get(storage.fs_namespace, "/output.txt").value["content"] == "Canonical logical output"
    assert state.db["native_acp_checkpoints"].count_documents({}) == 0
    await _confirm(state, service, first.run_id, "initial", 1)
    await _complete(state, service, "new-initial")
    assert state.portal.native_state["turns"] == 1
    assert "session/new" in [message.get("method") for message in state.portal.peers[-1].sent]


async def test_unfinished_rewind_gates_and_recovers_before_a_later_prompt(sandbox_database, monkeypatch):
    state = sandbox_database
    service = _service(state)
    await _complete(state, service, "first")
    await _complete(state, service, "second")
    original_finish = CheckpointStore._finish_rewind
    fail = True

    def lose_reply(store, intent, lease_id):
        nonlocal fail
        if fail:
            fail = False
            raise RuntimeError("Database unavailable before head selection")
        return original_finish(store, intent, lease_id)

    monkeypatch.setattr(CheckpointStore, "_finish_rewind", lose_reply)
    with pytest.raises(RuntimeError, match="head selection"):
        await service.rewind(state.agent, state.session_id, state.user,
            turn_id="second", message_content="Repeated request", content_occurrence=2)
    authority = state.mongo.get_session_runs_collection().find_one({"session_id": state.session_id})
    assert authority["checkpoint_rewind"]["boundary"]["turn_id"] == "second"
    assert state.portal.native_state["turns"] == 2
    # Identical text is insufficient: recovering a different edit would make
    # the frontend truncate one turn while native state selected another.
    with pytest.raises(SandboxError, match="Finish the pending conversation edit"):
        await service.rewind(state.agent, state.session_id, state.user,
            turn_id="first", message_content="Repeated request", content_occurrence=1)
    with pytest.raises(SandboxError, match="Finish the pending conversation edit"):
        await service.rewind(state.agent, state.session_id, state.user,
            turn_id="second", message_content="Repeated request", content_occurrence=1)
    with pytest.raises(SandboxError, match="conversation edit is unfinished"):
        await service.start_run(_turn(state, "blocked-pending-edit"), "custom")
    checkpoint = await service.rewind(state.agent, state.session_id, state.user,
        turn_id="second", message_content="Repeated request", content_occurrence=2)
    with pytest.raises(SandboxError, match="conversation edit is unfinished"):
        await service.start_run(_turn(state, "blocked-unconfirmed-edit"), "custom")
    await _confirm(state, service, checkpoint, "second", 2)
    await _complete(state, _service(state, replica=True), "after-recovery")
    assert state.portal.native_state["turns"] == 2
    assert "checkpoint_rewind" not in state.mongo.get_session_runs_collection().find_one({"session_id": state.session_id})


async def test_failed_reload_after_rewind_keeps_selected_state_without_replaying_prompt(sandbox_database):
    state = sandbox_database
    service = _service(state)
    await _complete(state, service, "first")
    await _complete(state, service, "second")
    checkpoint = await service.rewind(state.agent, state.session_id, state.user,
        turn_id="second", message_content="Repeated request", content_occurrence=2)
    await _confirm(state, service, checkpoint, "second", 2)
    state.portal.fail_restore = True
    run = await service.start_run(_turn(state, "failed-hydration"), "custom")
    assert (await _collect(service, run))[0].status == "failed"
    assert len(state.portal.peers) == 2
    state.portal.fail_restore = False
    await _complete(state, service, "recovered-hydration")
    assert state.portal.native_state["turns"] == 2


async def test_restart_reconnects_without_deleting_workspace_or_native_session(sandbox_database, monkeypatch):
    state = sandbox_database
    service = _service(state)
    first = await _complete(state, service, "first")
    monkeypatch.setattr(sandbox_lifecycle, "current_subject_reference", lambda: first.owner_subject)
    before = get_sandbox_binding(state.mongo, state.agent.id, state.session_id)
    delete = AsyncMock(side_effect=AssertionError("Restart must not delete native state"))
    monkeypatch.setattr(SandboxClient, "delete", delete)
    assert await service.restart(state.agent.id, state.session_id)
    assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) == before
    await _complete(state, _service(state, replica=True), "after-restart")
    assert state.portal.native_state["turns"] == 2
    assert "session/load" in [message.get("method") for message in state.portal.peers[-1].sent]
    delete.assert_not_awaited()


@pytest.mark.parametrize("scenario", ["lost_ack", "mixed_children", "missing_snapshot"])
async def test_parent_rewind_restores_exact_native_child_state_after_lost_copy_ack(sandbox_database, monkeypatch, scenario):
    state = sandbox_database
    service = _service(state)
    first = await _complete(state, service, "first")
    child = DynamicAgentConfig(_id="native-specialist", name="Native specialist", owner_id=state.user.email,
        system_prompt="Assist.", model={"id": "example-model", "provider": "example-provider"})
    child_session = str(uuid5(NAMESPACE_URL, f"caipe-child:{state.session_id}:{child.id}"))
    child_state = SimpleNamespace(**{**vars(state), "session_id": child_session, "agent": child})
    resolve_native_binding(state.mongo, child, child_session)
    async with native_session_run(state.mongo, state.agent.id, state.session_id):
        link_delegated_session(state.mongo, state.agent.id, state.session_id, child.id, child_session, first.owner_subject)
    graph = _graph(child_state, child)
    config = {"configurable": {"thread_id": child_session}}
    await graph.ainvoke({"messages": [HumanMessage(content="Original child request", id="original-child")]}, config)
    cache = _ReconstructedRuntimeCache(child_state)
    service = AgentExecutionService(state.mongo, settings=state.settings, cache=cache)
    await _complete(state, service, "second")
    await graph.ainvoke({"messages": [HumanMessage(content="Discarded child request", id="discarded-child")]}, config)
    assert len((await graph.aget_state(config)).values["messages"]) == 4
    if scenario == "mixed_children":
        newer = child.model_copy(update={"id": "newer-specialist", "name": "Newer specialist"})
        newer_session = str(uuid5(NAMESPACE_URL, f"caipe-child:{state.session_id}:{newer.id}"))
        newer_state = SimpleNamespace(**{**vars(state), "session_id": newer_session, "agent": newer})
        resolve_native_binding(state.mongo, newer, newer_session)
        async with native_session_run(state.mongo, state.agent.id, state.session_id):
            link_delegated_session(state.mongo, state.agent.id, state.session_id, newer.id, newer_session, first.owner_subject)
        await _graph(newer_state, newer).ainvoke({"messages": [HumanMessage(content="Newer child work")]},
            {"configurable": {"thread_id": newer_session}})
    if scenario == "missing_snapshot":
        boundary = state.db["native_acp_execution_runs"].find_one({"turn_id": "second"})["checkpoint_before"]
        storage = resolve_runtime_storage(get_native_binding(state.mongo, child.id, child_session), child_session, state.settings)
        state.db[storage.checkpoint_collection].delete_one({
            "thread_id": child_session, "checkpoint_id": boundary["delegated_states"][0]["checkpoint_id"],
        })
        with pytest.raises(SandboxError, match="checkpoint is unavailable"):
            await service.rewind(state.agent, state.session_id, state.user,
                turn_id="second", message_content="Repeated request", content_occurrence=2)
        with pytest.raises(SandboxError, match="conversation edit is unfinished"):
            await service.start_run(_turn(state, "blocked-on-missing-child-state"), "custom")
        assert len(state.portal.peers) == 2
        assert state.mongo.get_session_runs_collection().find_one({"session_id": state.session_id})["checkpoint_rewind"]
        return
    borrow = cache.borrow
    fail = True

    @asynccontextmanager
    async def lost_copy_ack(*args, **kwargs):
        nonlocal fail
        async with borrow(*args, **kwargs) as runtime:
            copy = runtime._graph.aupdate_state

            async def copy_then_fail(*copy_args, **copy_kwargs):
                nonlocal fail
                result = await copy(*copy_args, **copy_kwargs)
                if fail:
                    fail = False
                    raise RuntimeError("Child state copy acknowledgement lost")
                return result

            monkeypatch.setattr(runtime._graph, "aupdate_state", copy_then_fail)
            yield runtime

    monkeypatch.setattr(cache, "borrow", lost_copy_ack)
    with pytest.raises(RuntimeError, match="acknowledgement lost"):
        await service.rewind(state.agent, state.session_id, state.user,
            turn_id="second", message_content="Repeated request", content_occurrence=2)
    assert state.mongo.get_session_runs_collection().find_one({"session_id": state.session_id})["checkpoint_rewind"]
    assert len((await graph.aget_state(config)).values["messages"]) == 2
    if scenario == "mixed_children":
        assert get_native_binding(state.mongo, newer.id, newer_session) is None
        assert get_delegated_sessions(state.mongo, state.agent.id, state.session_id, first.owner_subject) == [
            {"agent_id": child.id, "session_id": child_session},
        ]
    with pytest.raises(SandboxError, match="conversation edit is unfinished"):
        await service.start_run(_turn(state, "blocked-partial-child-rewind"), "custom")
    checkpoint = await service.rewind(state.agent, state.session_id, state.user,
        turn_id="second", message_content="Repeated request", content_occurrence=2)
    await _confirm(state, service, checkpoint, "second", 2)
    await _complete(state, service, "after-child-recovery")
    assert len((await graph.aget_state(config)).values["messages"]) == 2
    assert state.portal.native_state["turns"] == 2
    assert "checkpoint_rewind" not in state.mongo.get_session_runs_collection().find_one({"session_id": state.session_id})


@pytest.mark.parametrize("selected", ["first", "second"])
async def test_lost_final_rewind_ack_is_recovered_without_repeating_native_state_mutation(sandbox_database, monkeypatch, selected):
    state = sandbox_database
    service = _service(state)
    first = await _complete(state, service, "first")
    await _complete(state, service, "second")
    monkeypatch.setattr(sandbox_lifecycle, "current_subject_reference", lambda: first.owner_subject)
    delete = AsyncMock()
    monkeypatch.setattr(SandboxClient, "delete", delete)
    finish = CheckpointStore._finish_rewind
    fail = True

    def lose_ack(store, intent, lease_id):
        nonlocal fail
        result = finish(store, intent, lease_id)
        if fail:
            fail = False
            raise RuntimeError("Final rewind acknowledgement lost")
        return result

    monkeypatch.setattr(CheckpointStore, "_finish_rewind", lose_ack)
    with pytest.raises(RuntimeError, match="acknowledgement lost"):
        await service.rewind(state.agent, state.session_id, state.user,
            turn_id=selected, message_content="Repeated request", content_occurrence=1 if selected == "first" else 2)
    receipt = state.mongo.get_session_runs_collection().find_one({"session_id": state.session_id})["checkpoint_rewind_receipt"]
    assert await _service(state, replica=True).rewind(state.agent, state.session_id, state.user,
        turn_id=selected, message_content="Repeated request", content_occurrence=1 if selected == "first" else 2) == receipt["checkpoint_id"]
    assert delete.await_count == (1 if selected == "first" else 0)
    with pytest.raises(SandboxError, match="conversation edit is unfinished"):
        await service.start_run(_turn(state, "blocked-on-unconfirmed-ack"), "custom")
    await _confirm(state, service, receipt["checkpoint_id"], selected, 1 if selected == "first" else 2)
    await _complete(state, service, "confirmed-new-turn")
    # A lost confirmation response can be acknowledged again after execution
    # advances, because this exact receipt already authorized the new branch.
    await _confirm(state, service, receipt["checkpoint_id"], selected, 1 if selected == "first" else 2)
