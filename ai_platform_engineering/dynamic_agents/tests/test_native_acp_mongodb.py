"""Native ACP migration and restart against real MongoDB checkpoints.

Set NATIVE_ACP_TEST_MONGODB_URI to an isolated test server. Each test owns a
random database and removes it afterward; no application database is used.
The deterministic graph replaces model/provider calls, not ACP, session
admission, checkpoint persistence, or the native runtime's state operations.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncGenerator, Iterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from deepagents.graph import DeepAgentState
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.mongodb.saver import MongoDBSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt
from pymongo import MongoClient

from dynamic_agents.config import Settings
from dynamic_agents.models import AgentBackend, AgentBackendConfig, DynamicAgentConfig, UserContext
from dynamic_agents.services.agent_execution import AgentExecutionService, ExecutionTurn
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.runtime_storage import resolve_runtime_storage
from dynamic_agents.services.session_bindings import SESSION_BINDINGS_COLLECTION
from dynamic_agents.services.session_runs import SESSION_RUNS_COLLECTION
from dynamic_agents.services.stream_encoders import get_encoder
from tests.test_stream_cancellation_cleanup import _runtime


@pytest.fixture
def native_database() -> Iterator[SimpleNamespace]:
    uri = os.environ.get("NATIVE_ACP_TEST_MONGODB_URI")
    if not uri:
        pytest.skip("Set NATIVE_ACP_TEST_MONGODB_URI for isolated real-MongoDB tests")
    client = MongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=5000)
    client.admin.command("ping")
    database = client[f"native_acp_test_{uuid4().hex}"]
    settings = Settings(mongodb_database=database.name)
    mongo = MongoDBService(settings)
    mongo._client, mongo._db = client, database
    mongo._ensure_indexes()
    agent = DynamicAgentConfig(
        _id="example-agent", name="Example agent", owner_id="owner@example.com",
        system_prompt="Original instructions", model={"id": "example-model", "provider": "example-provider"},
        backend=AgentBackend(type="store", config=AgentBackendConfig(
            checkpoint_collection="example_checkpoints", fs_namespace=["example", "original-thread", "filesystem"],
        )),
    )
    state = SimpleNamespace(
        client=client, db=database, settings=settings, mongo=mongo, agent=agent,
        user=UserContext(email="owner@example.com"), session_id="original-thread",
    )
    try:
        yield state
    finally:
        client.drop_database(database.name)
        client.close()


def _graph(state: SimpleNamespace, agent: DynamicAgentConfig, pending: str | None = None) -> Any:
    storage = resolve_runtime_storage(agent, state.session_id, state.settings)
    saver = MongoDBSaver(
        state.client, db_name=storage.database, checkpoint_collection_name=storage.checkpoint_collection,
        writes_collection_name=storage.checkpoint_writes_collection,
    )

    def answer(graph_state: DeepAgentState) -> dict[str, Any]:
        if pending is None:
            answer = f"Remembered {len(graph_state['messages'])} messages"
        else:
            actions = [{
                "name": "request_user_input", "id": "example-form", "args": {
                    "prompt": "Choose a value", "fields": [{"field_name": "value", "field_type": "text"}],
                },
            }] if pending == "form_input" else [
                {"name": "example_write", "id": "example-write", "args": {"value": "original"}},
                {"name": "example_read", "id": "example-read", "args": {"path": "/example.txt"}},
            ]
            answer = json.dumps(interrupt({"action_requests": actions}), sort_keys=True)
        return {"messages": [AIMessage(content=answer)]}

    builder = StateGraph(DeepAgentState)
    builder.add_node("agent", answer)
    builder.add_edge(START, "agent")
    builder.add_edge("agent", END)
    return builder.compile(checkpointer=saver)


class _ReconstructedRuntimeCache:
    """Create a fresh graph/saver on every borrow, as after worker eviction."""

    def __init__(self, state: SimpleNamespace, pending: str | None = None) -> None:
        self.state, self.pending = state, pending
        self.configurations: list[DynamicAgentConfig] = []
        self.runtimes: list[AgentRuntime] = []

    def set_mongo_service(self, mongo: MongoDBService) -> None:
        assert mongo is self.state.mongo

    @asynccontextmanager
    async def borrow(
        self, agent: DynamicAgentConfig, servers: list[Any], session_id: str,
        **context: Any,
    ) -> AsyncGenerator[AgentRuntime, None]:
        assert not servers and session_id == self.state.session_id
        self.configurations.append(agent.model_copy(deep=True))
        runtime = _runtime(_graph(self.state, agent, self.pending))
        runtime.config = agent
        self.runtimes.append(runtime)
        yield runtime

    async def invalidate(self, agent_id: str, session_id: str) -> bool:
        assert agent_id == self.state.agent.id and session_id == self.state.session_id
        return True


def _service(state: SimpleNamespace, pending: str | None = None) -> AgentExecutionService:
    return AgentExecutionService(
        state.mongo, settings=state.settings, cache=_ReconstructedRuntimeCache(state, pending),
    )


def _checkpoint_config(state: SimpleNamespace) -> dict[str, Any]:
    return {"configurable": {"thread_id": state.session_id}}


async def test_pre_acp_checkpoint_and_ui_history_survive_first_acp_turn_and_restart(native_database: SimpleNamespace) -> None:
    state = native_database
    graph = _graph(state, state.agent)
    await graph.ainvoke({"messages": [HumanMessage(content="Original request", id="original-turn")]}, _checkpoint_config(state))
    original_checkpoint = await graph.aget_state(_checkpoint_config(state))
    original_messages = [(message.id, message.content) for message in original_checkpoint.values["messages"]]
    state.db["conversations"].insert_one({"_id": state.session_id, "owner_id": state.user.email, "agent_id": state.agent.id})
    state.db["messages"].insert_many([
        {"_id": "original-turn", "conversation_id": state.session_id, "role": "user", "content": "Original request"},
        {"_id": "original-answer", "conversation_id": state.session_id, "role": "assistant", "content": "Remembered 1 messages"},
    ])
    ui_history = list(state.db["messages"].find({}))
    store = MongoDBGridFSStore(db=state.db, bucket_name=state.settings.gridfs_bucket_name)
    namespace = tuple(state.agent.backend.config.fs_namespace)
    store.put(namespace, "/example.txt", {"content": "preserved logical file"})
    assert state.db[SESSION_BINDINGS_COLLECTION].count_documents({}) == 0

    for number in (1, 2):
        service = _service(state)
        turn = ExecutionTurn(
            agent=state.agent, session_id=state.session_id, user=state.user,
            message=f"Follow-up {number}", turn_id=f"follow-up-{number}",
        )
        frames = [frame async for frame in service.stream(turn, get_encoder("agui"))]
        assert any("RUN_FINISHED" in frame for frame in frames)
        restored = await _graph(state, state.agent).aget_state(_checkpoint_config(state))
        assert [(message.id, message.content) for message in restored.values["messages"][:2]] == original_messages
        assert len(restored.values["messages"]) == 2 + number * 2
        assert restored.values["messages"][-2].id == f"follow-up-{number}"
        assert restored.values["messages"][-1].content == f"Remembered {1 + number * 2} messages"
        binding = state.db[SESSION_BINDINGS_COLLECTION].find_one()
        assert binding["session_id"] == binding["native_session_id"] == state.session_id
        assert binding["persistence"]["checkpoint_collection"] == "example_checkpoints"
        assert state.db[SESSION_BINDINGS_COLLECTION].count_documents({}) == 1
        assert state.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
    assert store.get(namespace, "/example.txt").value == {"content": "preserved logical file"}
    assert list(state.db["messages"].find({})) == ui_history
    assert state.db["conversations"].find_one()["_id"] == state.session_id
    assert set(state.db["example_checkpoints"].distinct("thread_id")) == {state.session_id}


@pytest.mark.parametrize("pending", ["form_input", "tool_approval"])
@pytest.mark.parametrize("legacy_checkpoint", [False, True], ids=["acp-checkpoint", "pre-acp-checkpoint"])
async def test_pending_human_input_survives_worker_restart_and_acp_resume(
    native_database: SimpleNamespace, pending: str, legacy_checkpoint: bool,
) -> None:
    state = native_database
    if legacy_checkpoint:
        await _graph(state, state.agent, pending).ainvoke(
            {"messages": [HumanMessage(content="Request approval", id="original-turn")]}, _checkpoint_config(state),
        )
    else:
        turn = ExecutionTurn(
            agent=state.agent, session_id=state.session_id, user=state.user,
            message="Request approval", turn_id="original-turn",
        )
        frames = [frame async for frame in _service(state, pending).stream(turn, get_encoder("agui"))]
        assert any(json.loads(frame.split("data: ", 1)[1]).get("outcome") == "interrupt" for frame in frames)
    original = await _graph(state, state.agent, pending).aget_state(_checkpoint_config(state))
    assert len(original.interrupts) == 1
    service = _service(state, pending)
    replacement = state.agent if legacy_checkpoint else state.agent.model_copy(update={
        "system_prompt": "Replacement instructions", "backend": AgentBackend(type="state"),
    })
    restored_interrupt = await service.interrupt_state(replacement, state.session_id, state.user)
    assert restored_interrupt["type"] == pending
    assert len(restored_interrupt.get("tool_approvals", [])) == (2 if pending == "tool_approval" else 0)
    response = {"type": "form_input", "values": {"value": "accepted"}} if pending == "form_input" else {
        "type": "tool_approval", "decisions": [
            {"decision": "edit", "tool_name": "example_write", "edited_args": {"value": "accepted"}},
            {"decision": "reject"},
        ],
    }
    turn = ExecutionTurn(
        agent=replacement, session_id=state.session_id, user=state.user, resume_data=json.dumps(response),
    )
    frames = [frame async for frame in service.stream(turn, get_encoder("agui"))]
    assert any("RUN_FINISHED" in frame for frame in frames)
    restored = await _graph(state, state.agent, pending).aget_state(_checkpoint_config(state))
    assert not restored.interrupts and len(restored.values["messages"]) == 2
    assert restored.values["messages"][0].id == "original-turn"
    decisions = json.loads(restored.values["messages"][-1].content)["decisions"]
    if pending == "form_input":
        assert decisions[0]["edited_action"]["args"]["fields"][0]["value"] == "accepted"
    else:
        assert decisions == [
            {"type": "edit", "edited_action": {"name": "example_write", "args": {"value": "accepted"}}},
            {"type": "reject"},
        ]
    assert service.cache.configurations[-1].system_prompt == "Original instructions"
    assert await _service(state, pending).interrupt_state(state.agent, state.session_id, state.user) is None
    assert state.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0


async def test_rewind_and_clear_after_restart_use_admitted_checkpoint_and_file_namespace(native_database: SimpleNamespace) -> None:
    state = native_database
    for number in (1, 2):
        turn = ExecutionTurn(
            agent=state.agent, session_id=state.session_id, user=state.user,
            message=f"Request {number}", turn_id=f"original-turn-{number}",
        )
        _ = [frame async for frame in _service(state).stream(turn, get_encoder("agui"))]
    replacement = state.agent.model_copy(update={"backend": AgentBackend(type="state")})
    service = _service(state)
    checkpoint_id = await service.rewind(
        replacement, state.session_id, state.user, turn_id="original-turn-2", message_content="Request 2", content_occurrence=1,
    )
    restored = await _graph(state, state.agent).aget_state(_checkpoint_config(state))
    assert restored.config["configurable"]["checkpoint_id"] == checkpoint_id
    assert len(restored.values["messages"]) == 2
    assert restored.values["messages"][0].id == "original-turn-1"
    store = MongoDBGridFSStore(db=state.db, bucket_name=state.settings.gridfs_bucket_name)
    admitted_namespace = tuple(state.agent.backend.config.fs_namespace)
    store.put(admitted_namespace, "/example.txt", {"content": "clear this logical file"})
    store.put(("example", "other-thread", "filesystem"), "/example.txt", {"content": "keep another session"})
    state.db[state.settings.checkpoint_collection].insert_one({"thread_id": "other-thread"})
    assert await service.restart(state.agent.id, state.session_id)
    counts = await _service(state).clear(state.agent.id, state.session_id)
    assert counts.checkpoints_deleted > 0 and counts.files_deleted == 1
    assert state.db["example_checkpoints"].count_documents({"thread_id": state.session_id}) == 0
    assert state.db["example_checkpoints_writes"].count_documents({"thread_id": state.session_id}) == 0
    assert state.db[state.settings.checkpoint_collection].count_documents({"thread_id": "other-thread"}) == 1
    assert store.get(admitted_namespace, "/example.txt") is None
    assert store.get(("example", "other-thread", "filesystem"), "/example.txt").value == {"content": "keep another session"}
    assert state.db[SESSION_BINDINGS_COLLECTION].count_documents({}) == 1
    assert state.db[SESSION_RUNS_COLLECTION].count_documents({}) == 0
