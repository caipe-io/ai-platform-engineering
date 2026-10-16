"""Detached ACP execution preserves native checkpoints and human-input resume."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from deepagents.graph import DeepAgentState
from fastapi import FastAPI, HTTPException
from langchain_core.messages import AIMessage
from langgraph.checkpoint.mongodb.saver import MongoDBSaver
from langgraph.graph import END, START, StateGraph

from dynamic_agents.models import UserContext
from dynamic_agents.routes import chat
from dynamic_agents.services import agent_execution
from dynamic_agents.services.agent_execution import AgentExecutionService, ExecutionTurn
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.native_run_repository import EXECUTION_EVENTS_COLLECTION, EXECUTION_RUNS_COLLECTION
from dynamic_agents.services.runtime_storage import resolve_runtime_storage
from dynamic_agents.services.session_bindings import SESSION_BINDINGS_COLLECTION
from dynamic_agents.services.session_runs import SESSION_RUNS_COLLECTION
from tests.test_native_acp_mongodb import (
    _checkpoint_config,
    _graph,
    _ReconstructedRuntimeCache,
    _service,
)
from tests.test_native_acp_mongodb import (
    native_database as native_database,
)
from tests.test_native_execution_runs_mongodb import _wait_for
from tests.test_stream_cancellation_cleanup import _runtime


async def _finished(service: AgentExecutionService, state: SimpleNamespace, run_id: str) -> Any:
    async def read() -> Any:
        run = await service.get_run_status(state.agent.id, state.session_id, state.user, run_id=run_id)
        return run if run is not None and run.status not in {"queued", "running"} else None

    return await _wait_for(read)


class _DelayedNativeCache(_ReconstructedRuntimeCache):
    """A real checkpoint graph with a deterministic, controllable provider wait."""

    @asynccontextmanager
    async def borrow(self, agent: Any, servers: list[Any], session_id: str, **context: Any) -> AsyncGenerator[AgentRuntime, None]:
        assert not servers and session_id == self.state.session_id
        self.configurations.append(agent.model_copy(deep=True))
        storage = resolve_runtime_storage(agent, session_id, self.state.settings)
        saver = MongoDBSaver(
            self.state.client, db_name=storage.database,
            checkpoint_collection_name=storage.checkpoint_collection,
            writes_collection_name=storage.checkpoint_writes_collection,
        )

        async def answer(graph_state: DeepAgentState) -> dict[str, Any]:
            self.state.provider_calls += 1
            self.state.provider_entered.set()
            await self.state.provider_release.wait()
            return {"messages": [AIMessage(content=f"Remembered {len(graph_state['messages'])} messages")]}

        builder = StateGraph(DeepAgentState)
        builder.add_node("agent", answer)
        builder.add_edge(START, "agent")
        builder.add_edge("agent", END)
        runtime = _runtime(builder.compile(checkpointer=saver))
        runtime.config = agent
        self.runtimes.append(runtime)
        yield runtime


async def test_native_graph_finishes_after_disconnect_and_reload_replays_without_new_prompt(native_database: SimpleNamespace) -> None:
    state = native_database
    state.provider_calls = 0
    state.provider_entered, state.provider_release = asyncio.Event(), asyncio.Event()
    cache = _DelayedNativeCache(state)
    service = AgentExecutionService(state.mongo, settings=state.settings, cache=cache)
    turn = ExecutionTurn(
        agent=state.agent, session_id=state.session_id, user=state.user,
        message="Original request", turn_id="original-turn",
    )
    run = await service.start_run(turn, "agui")
    try:
        await asyncio.wait_for(state.provider_entered.wait(), 5)
        consumer = service.run_events(run)
        first = await asyncio.wait_for(anext(consumer), 5)
        assert "RUN_STARTED" in first
        await consumer.aclose()
        assert state.provider_calls == 1
        assert state.db[SESSION_RUNS_COLLECTION].count_documents({}) == 1
        assert await service.coordinator.repository.get(run.run_id, owner_subject="other-owner") is None
        state.provider_release.set()
        completed = await _finished(service, state, run.run_id)
        assert completed.status == "completed"
        assert state.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
        saved = await _graph(state, state.agent).aget_state(_checkpoint_config(state))
        assert [(message.id, message.content) for message in saved.values["messages"]][0] == ("original-turn", "Original request")
        assert len(saved.values["messages"]) == 2
        assert saved.values["messages"][-1].content == "Remembered 1 messages"
        binding = state.db[SESSION_BINDINGS_COLLECTION].find_one()
        assert binding["native_session_id"] == binding["session_id"] == state.session_id

        fresh_service = _service(state)
        restored = await fresh_service.get_run_status(state.agent.id, state.session_id, state.user)
        assert restored.run_id == run.run_id and restored.status == "completed"
        replay = [frame async for frame in fresh_service.run_events(restored)]
        assert replay[0] == first and any("RUN_FINISHED" in frame for frame in replay)
        assert [frame async for frame in fresh_service.run_events(restored, after=1)] == replay[1:]
        assert fresh_service.cache.runtimes == []
        retried = await fresh_service.start_run(turn, "agui")
        assert retried.run_id == run.run_id and fresh_service.cache.runtimes == []
        assert state.provider_calls == 1
        assert len((await _graph(state, state.agent).aget_state(_checkpoint_config(state))).values["messages"]) == 2
        assert state.db[EXECUTION_RUNS_COLLECTION].count_documents({}) == 1
        assert state.db[EXECUTION_EVENTS_COLLECTION].count_documents({"run_id": run.run_id}) > 1
    finally:
        state.provider_release.set()
        await service.coordinator.shutdown()


@pytest.mark.parametrize("pending", ["form_input", "tool_approval"])
@pytest.mark.parametrize("protocol", ["agui", "custom"])
async def test_detached_pending_input_replays_and_resumes_once_after_runtime_reconstruction(
    native_database: SimpleNamespace, pending: str, protocol: str,
) -> None:
    state = native_database
    service = _service(state, pending)
    original = ExecutionTurn(
        agent=state.agent, session_id=state.session_id, user=state.user,
        message="Request approval", turn_id="original-turn",
    )
    run = await service.start_run(original, protocol)
    try:
        awaiting = await _finished(service, state, run.run_id)
        assert awaiting.status == "awaiting_input"
        replay = [frame async for frame in service.run_events(awaiting)]
        if protocol == "agui":
            interrupted = next(json.loads(frame.split("data: ", 1)[1]) for frame in replay if '"outcome": "interrupt"' in frame)
            assert interrupted["outcome"] == "interrupt"
        else:
            interrupted = next(json.loads(frame.split("data: ", 1)[1]) for frame in replay if "event: input_required\n" in frame)
            assert interrupted["type"] == pending
        fresh = _service(state, pending)
        saved_interrupt = await fresh.interrupt_state(state.agent, state.session_id, state.user)
        assert saved_interrupt["type"] == pending
        if pending == "tool_approval":
            assert len(saved_interrupt["tool_approvals"]) == 2
        response = {"type": "form_input", "values": {"value": "accepted"}} if pending == "form_input" else {
            "type": "tool_approval", "decisions": [
                {"decision": "edit", "tool_name": "example_write", "edited_args": {"value": "accepted"}},
                {"decision": "reject"},
            ],
        }
        resume = ExecutionTurn(
            agent=state.agent, session_id=state.session_id, user=state.user,
            resume_data=json.dumps(response), turn_id="resume-turn",
        )
        resumed = await fresh.start_run(resume, protocol)
        assert resumed.run_id != run.run_id
        assert (await _finished(fresh, state, resumed.run_id)).status == "completed"
        latest = await _graph(state, state.agent, pending).aget_state(_checkpoint_config(state))
        assert not latest.interrupts and len(latest.values["messages"]) == 2
        decisions = json.loads(latest.values["messages"][-1].content)["decisions"]
        if pending == "form_input":
            assert decisions[0]["edited_action"]["args"]["fields"][0]["value"] == "accepted"
        else:
            assert decisions == [
                {"type": "edit", "edited_action": {"name": "example_write", "args": {"value": "accepted"}}},
                {"type": "reject"},
            ]
        third_worker = _service(state, pending)
        retried = await third_worker.start_run(resume, protocol)
        assert retried.run_id == resumed.run_id and third_worker.cache.runtimes == []
        assert state.db[EXECUTION_RUNS_COLLECTION].count_documents({}) == 2
        assert state.db[SESSION_BINDINGS_COLLECTION].count_documents({}) == 1
        assert state.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
    finally:
        await service.coordinator.shutdown()


@pytest.mark.parametrize("protocol", ["agui", "custom"])
async def test_http_start_retry_and_scoped_replay_use_one_actual_native_execution(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, protocol: str,
) -> None:
    state = native_database
    service = _service(state)
    monkeypatch.setattr(chat, "AgentExecutionService", lambda _: service)
    monkeypatch.setattr(chat, "require_agent_use_permission", AsyncMock())
    monkeypatch.setattr(state.mongo, "get_agent", lambda _: state.agent)
    app = FastAPI()
    app.include_router(chat.router)
    app.dependency_overrides[chat.get_user_context] = lambda: state.user
    app.dependency_overrides[chat.get_mongo_service] = lambda: state.mongo
    payload = {
        "agent_id": state.agent.id, "conversation_id": state.session_id,
        "message": "Original request", "turn_id": "original-turn", "protocol": protocol,
    }
    scope = {"agent_id": state.agent.id, "conversation_id": state.session_id}
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://example.test") as client:
            original = await client.post("/chat/stream/start", json=payload)
            assert original.status_code == 200
            run_id = original.headers["x-caipe-run-id"]
            assert original.headers["x-caipe-turn-id"] == "original-turn"
            assert original.headers["x-caipe-protocol"] == protocol
            assert "CAIPE_RUN_STATUS" in original.text and '"status":"completed"' in original.text
            retried = await client.post("/chat/stream/start", json=payload)
            assert retried.status_code == 200 and retried.headers["x-caipe-run-id"] == run_id
            assert retried.text == original.text
            status = await client.get(f"/chat/runs/{run_id}", params=scope)
            assert status.status_code == 200 and status.json()["run"]["status"] == "completed"
            replay = await client.get(f"/chat/runs/{run_id}/stream", params={**scope, "after": 0})
            assert replay.status_code == 200 and replay.text == original.text
            wrong_scope = await client.get(f"/chat/runs/{run_id}/stream", params={**scope, "agent_id": "other-agent", "after": 0})
            assert wrong_scope.status_code == 404
        assert len(service.cache.runtimes) == 1
        assert state.db[EXECUTION_RUNS_COLLECTION].count_documents({}) == 1
        assert state.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
        saved = await _graph(state, state.agent).aget_state(_checkpoint_config(state))
        assert len(saved.values["messages"]) == 2 and saved.values["messages"][0].id == "original-turn"
    finally:
        await service.coordinator.shutdown()


async def test_worker_shutdown_drains_actual_acp_execution_and_fresh_worker_only_replays_interrupted_run(
    native_database: SimpleNamespace,
) -> None:
    state = native_database
    state.provider_calls = 0
    state.provider_entered, state.provider_release = asyncio.Event(), asyncio.Event()
    cache = _DelayedNativeCache(state)
    service = AgentExecutionService(state.mongo, settings=state.settings, cache=cache)
    run = await service.start_run(ExecutionTurn(
        agent=state.agent, session_id=state.session_id, user=state.user,
        message="Interrupted request", turn_id="original-turn",
    ), "agui")
    fresh = None
    try:
        await asyncio.wait_for(state.provider_entered.wait(), 5)
        await service.coordinator.shutdown()
        assert state.provider_calls == 1
        assert all(not runtime._is_streaming for runtime in cache.runtimes)
        assert state.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
        replacement_mongo = MongoDBService(state.settings)
        replacement_mongo._client, replacement_mongo._db = state.client, state.db
        replacement = SimpleNamespace(**{**vars(state), "mongo": replacement_mongo})
        fresh = _service(replacement)
        interrupted = await fresh.get_run_status(state.agent.id, state.session_id, state.user, run_id=run.run_id)
        assert interrupted.status == "interrupted"
        replay = [frame async for frame in fresh.run_events(interrupted)]
        assert json.loads(replay[-1].split("data: ", 1)[1])["status"] == "interrupted"
        assert fresh.cache.runtimes == [] and state.provider_calls == 1
        original = await _graph(state, state.agent).aget_state(_checkpoint_config(state))
        assert original.values["messages"][0].id == "original-turn"
        continued = await fresh.start_run(ExecutionTurn(
            agent=state.agent, session_id=state.session_id, user=state.user,
            message="Continue explicitly", turn_id="next-turn",
        ), "agui")
        assert (await _finished(fresh, replacement, continued.run_id)).status == "completed"
        assert continued.session_id == run.session_id
        assert (await fresh.get_run_status(state.agent.id, state.session_id, state.user, run_id=run.run_id)).status == "interrupted"
        restored = await _graph(state, state.agent).aget_state(_checkpoint_config(state))
        assert any(message.id == "original-turn" for message in restored.values["messages"])
        assert any(message.id == "next-turn" for message in restored.values["messages"])
        assert state.db[SESSION_BINDINGS_COLLECTION].count_documents({}) == 1
    finally:
        state.provider_release.set()
        if fresh is not None:
            await fresh.coordinator.shutdown()
        await service.coordinator.shutdown()


async def test_shared_reader_replay_requires_conversation_permission_and_never_starts_a_turn(
    native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = native_database
    service = _service(state)
    run = await service.start_run(ExecutionTurn(
        agent=state.agent, session_id=state.session_id, user=state.user,
        message="Private request", turn_id="original-turn",
    ), "agui")
    try:
        await _finished(service, state, run.run_id)
        reader = UserContext(email="reader@example.com")
        calls = []

        async def deny(session_id: str) -> None:
            calls.append(session_id)
            raise HTTPException(status_code=403, detail="conversation#read denied")

        monkeypatch.setattr(agent_execution, "require_conversation_read_permission", deny)
        fresh = _service(state)
        with pytest.raises(HTTPException) as error:
            await fresh.get_run_status(state.agent.id, state.session_id, reader, run_id=run.run_id)
        assert error.value.status_code == 403 and calls == [state.session_id]
        assert fresh.cache.runtimes == []

        async def allow(session_id: str) -> None:
            calls.append(session_id)

        monkeypatch.setattr(agent_execution, "require_conversation_read_permission", allow)
        permitted = await fresh.get_run_status(state.agent.id, state.session_id, reader, run_id=run.run_id)
        assert permitted.run_id == run.run_id and calls == [state.session_id, state.session_id]
        assert [frame async for frame in fresh.run_events(permitted)]
        assert fresh.cache.runtimes == []
        assert len((await _graph(state, state.agent).aget_state(_checkpoint_config(state))).values["messages"]) == 2
    finally:
        await service.coordinator.shutdown()
