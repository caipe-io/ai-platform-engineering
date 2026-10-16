"""External delegation rechecks current native child and inline admission."""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import NAMESPACE_URL, uuid5

import jwt
import pytest
from deepagents.graph import DeepAgentState
from fastapi import HTTPException
from langchain_core.messages import AIMessage
from langgraph.checkpoint.mongodb.saver import MongoDBSaver
from langgraph.graph import END, START, StateGraph

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.models import (
    AgentBackend,
    AgentBackendConfig,
    AgentExecutionConfig,
    DynamicAgentConfig,
    SubAgentRef,
)
from dynamic_agents.services import agent_execution
from dynamic_agents.services.agent_execution import AgentExecutionService, ExecutionTurn, InvocationResult
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.harness_admission import inline_harness_admission
from dynamic_agents.services.runtime_storage import resolve_runtime_storage
from dynamic_agents.services.sandbox_client import SandboxError
from dynamic_agents.services.session_bindings import resolve_native_binding, save_sandbox_binding
from dynamic_agents.services.session_runs import native_session_run
from tests.test_native_acp_mongodb import native_database as native_database
from tests.test_stream_cancellation_cleanup import _runtime

CHILD_CONTENT = "completed-native-child-result"


def _agent(identifier, *, refs=None, **updates):
    return DynamicAgentConfig(_id=identifier, name=identifier, owner_id="owner@example.com", system_prompt="Assist.",
        model={"id": "qualified-model", "provider": "qualified-provider"}, subagents=refs or [], **updates)


def _ref(identifier):
    return SubAgentRef(agent_id=identifier, name=identifier, description="Configured native specialist")


def _save(state, agent):
    state.mongo._get_agents_collection().replace_one({"_id": agent.id}, agent.model_dump(by_alias=True), upsert=True)




class NativeChildCache:
    """Use the real native ACP path and Mongo checkpoint, without an LLM."""

    def __init__(self, state):
        self.state, self.entered, self.calls = state, 0, 0

    def set_mongo_service(self, mongo):
        assert mongo is self.state.mongo

    @asynccontextmanager
    async def persistent(self, agent, _servers, session_id, **_context):
        self.entered += 1
        storage = resolve_runtime_storage(agent, session_id, self.state.settings)
        saver = MongoDBSaver(self.state.client, db_name=storage.database,
            checkpoint_collection_name=storage.checkpoint_collection,
            writes_collection_name=storage.checkpoint_writes_collection)

        def execute(_state: DeepAgentState):
            self.calls += 1
            return {"messages": [AIMessage(content="Public native result")]}

        graph = StateGraph(DeepAgentState)
        graph.add_node("agent", execute)
        graph.add_edge(START, "agent")
        graph.add_edge("agent", END)
        runtime = _runtime(graph.compile(checkpointer=saver))
        runtime.config = agent
        yield runtime


@pytest.fixture
async def child_state(native_database, monkeypatch):
    state = native_database
    state.session_id = str(uuid5(NAMESPACE_URL, "caipe-child:parent-conversation:native-child"))
    state.agent = _agent("native-child")
    _save(state, state.agent)
    state.cache = NativeChildCache(state)
    state.service = AgentExecutionService(state.mongo, settings=state.settings, cache=state.cache)
    state.parent = ExecutionTurn(agent=_agent("external-parent", execution=AgentExecutionConfig(
        kind="sandbox", profile_id="qualified")), session_id="parent-conversation", user=state.user)
    resolve_native_binding(state.mongo, state.parent.agent, state.parent.session_id)
    monkeypatch.setattr(agent_execution, "require_agent_use_permission", AsyncMock())
    token = current_user_token.set(jwt.encode({"sub": "fixture-owner", "email": state.user.email}, "fixture-signing-key-with-at-least-32-bytes", algorithm="HS256"))
    try:
        save_sandbox_binding(state.mongo, state.parent.agent.id, state.parent.session_id,
            {"owner_subject": state.service._owner(state.user)})
        async with native_session_run(state.mongo, state.parent.agent.id, state.parent.session_id):
            yield state
    finally:
        current_user_token.reset(token)


async def _invoke(state):
    return await state.service._invoke_harness_child(state.parent, state.agent, state.session_id, "Inspect the resource", None)










async def test_ordinary_public_native_child_still_returns_with_persistent_state(child_state):
    state = child_state
    result = await _invoke(state)
    assert result.content == "Public native result"
    assert state.cache.calls == 1
    assert inline_harness_admission.get() is None


@pytest.mark.parametrize("problem", ["missing", "disabled", "denied", "sandbox", "foreign-namespace", "nested", "cycle"])
async def test_inline_children_fail_closed_instead_of_native_skip_or_backend_fallback(child_state, monkeypatch, problem):
    state = child_state
    state.agent = _agent("native-child", refs=[_ref("inline-child")])
    _save(state, state.agent)
    inline = _agent("inline-child")
    if problem == "disabled":
        inline = inline.model_copy(update={"enabled": False})
    elif problem == "sandbox":
        inline = inline.model_copy(update={"execution": AgentExecutionConfig(kind="sandbox", profile_id="unqualified")})
    elif problem == "foreign-namespace":
        inline = inline.model_copy(update={"backend": AgentBackend(type="store", config=AgentBackendConfig(
            fs_namespace=["another-agent", "private-conversation", "filesystem"]))})
    elif problem == "nested":
        inline = inline.model_copy(update={"subagents": [_ref("deeper-child")]})
    elif problem == "cycle":
        inline = state.agent
        state.agent = state.agent.model_copy(update={"subagents": [_ref(state.agent.id)]})
        _save(state, state.agent)
    if problem != "missing":
        _save(state, inline)
    if problem == "denied":
        async def deny(identifier):
            if identifier == "inline-child":
                raise HTTPException(403, "Agent use denied")
        monkeypatch.setattr(agent_execution, "require_agent_use_permission", deny)
    with pytest.raises((SandboxError, HTTPException)):
        await _invoke(state)
    assert state.cache.calls == 0
    assert inline_harness_admission.get() is None


@pytest.mark.parametrize("change", ["missing", "sandbox"])
async def test_exact_inline_definition_is_rechecked_after_native_builder_fetch(child_state, monkeypatch, change):
    state = child_state
    state.agent = _agent("native-child", refs=[_ref("inline-child")])
    _save(state, state.agent)
    _save(state, _agent("inline-child"))
    tools = AsyncMock()

    async def build_after_admission(turn, **_kwargs):
        if change == "missing":
            state.mongo._get_agents_collection().delete_one({"_id": "inline-child"})
        else:
            _save(state, _agent("inline-child", execution=AgentExecutionConfig(kind="sandbox", profile_id="unqualified")))
        runtime = AgentRuntime.__new__(AgentRuntime)
        runtime.config, runtime._mongo_service = turn.agent, state.mongo
        runtime._build_subagent_tools = tools
        await runtime._resolve_subagents(turn.agent.subagents)
        return InvocationResult(content=CHILD_CONTENT, thinking=None, interrupt=None)

    monkeypatch.setattr(state.service, "invoke", build_after_admission)
    with pytest.raises(SandboxError):
        await _invoke(state)
    tools.assert_not_awaited()
    assert inline_harness_admission.get() is None




async def test_inline_hook_has_no_effect_on_ordinary_native_skip_missing_behavior():
    assert inline_harness_admission.get() is None
    runtime = AgentRuntime.__new__(AgentRuntime)
    runtime.config = _agent("ordinary-native")
    runtime._mongo_service = SimpleNamespace(get_agent=lambda _identifier: None)
    assert await runtime._resolve_subagents([_ref("missing-child")]) == []


@pytest.mark.parametrize("retained_model", [True, False])
async def test_ordinary_native_parent_never_inlines_sandbox_child_or_constructs_its_model(retained_model):
    assert inline_harness_admission.get() is None
    child = _agent("external-child", execution=AgentExecutionConfig(kind="sandbox", profile_id="qualified"))
    if not retained_model:
        child = child.model_copy(update={"model": None})
    runtime = AgentRuntime.__new__(AgentRuntime)
    runtime.config = _agent("native-parent")
    runtime._mongo_service = SimpleNamespace(get_agent=lambda _identifier: child)
    runtime._build_subagent_tools = AsyncMock()
    with pytest.raises(SandboxError, match="cannot inline a sandbox subagent"):
        await runtime._resolve_subagents([_ref(child.id)])
    runtime._build_subagent_tools.assert_not_awaited()
