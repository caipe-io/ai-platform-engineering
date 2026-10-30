"""Structured submissions remain scoped to their graph request and encoder."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import BaseTool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.types import interrupt

from dynamic_agents.config import Settings
from dynamic_agents.models import ChatRequest, ClientContext, DynamicAgentConfig, UserContext
from dynamic_agents.routes import chat
from dynamic_agents.routes.chat import _collect_invoke_response
from dynamic_agents.services import agent_runtime
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.runtime_cache import RuntimeInitError
from dynamic_agents.services.stream_encoders import get_encoder
from dynamic_agents.services.structured_response import (
    StructuredResponseError,
    StructuredResponseFormat,
    create_submit_structured_response_tool,
)


def _runtime(graph: Any = None) -> AgentRuntime:
    runtime = AgentRuntime.__new__(AgentRuntime)
    runtime._initialized = True
    runtime._graph = graph
    runtime.config = SimpleNamespace(
        id="example-agent", name="Example", model=SimpleNamespace(id="example-model"),
        interrupt_on={}, app_context_prompt=None,
    )
    runtime.settings = SimpleNamespace(max_input_file_bytes=1024, max_input_turn_bytes=1024, max_input_files=1)
    runtime.tracing = SimpleNamespace(create_config=lambda thread: {"configurable": {"thread_id": thread}}, get_trace_id=lambda: None)
    runtime._active_stream_count = 0
    runtime._is_streaming = False
    runtime._user = None
    runtime._client_context = None
    runtime._mcp_credential_warnings = []
    runtime._failed_servers_permanent = []
    runtime._failed_servers_transient = []
    runtime._mcp_credential_failed_server_ids = set()
    runtime._failed_skills = []
    runtime._failed_workflows = []
    runtime._attachment_store_built = True
    runtime._attachment_store = None
    return runtime


def _submit(runtime: AgentRuntime, empty: bool = False) -> BaseTool:
    response_format = StructuredResponseFormat("example.response.v1", {
        "type": "object", **({} if empty else {"required": ["summary"], "properties": {"summary": {"type": "string"}}}),
    })
    return create_submit_structured_response_tool(
        response_format, lambda payload: runtime._emit_structured_response(payload, response_format.schema_id)
    )


def _events(frames: list[str]) -> list[tuple[str, dict]]:
    return [(
        next(line[7:] for line in frame.splitlines() if line.startswith("event: ")),
        json.loads(next(line[6:] for line in frame.splitlines() if line.startswith("data: "))),
    ) for frame in frames]


@pytest.mark.parametrize("protocol", ["custom", "agui"])
@pytest.mark.parametrize("submit_after_resume", [False, True])
async def test_submissions_are_delivered_before_interrupt_and_on_resume(protocol: str, submit_after_resume: bool) -> None:
    runtime = _runtime()
    submit = _submit(runtime)

    async def initial(_state: MessagesState) -> dict:
        assert (await submit.ainvoke({"payload": {"summary": "before approval"}}))["accepted"]
        return {}

    def approval(_state: MessagesState) -> dict:
        interrupt({"action_requests": [{"name": "example_tool", "args": {}}]})
        return {}

    async def finish(_state: MessagesState) -> dict:
        if submit_after_resume:
            assert (await submit.ainvoke({"payload": {"summary": "after approval"}}))["accepted"]
        return {"messages": [AIMessage(content="Completed")]}

    builder = StateGraph(MessagesState)
    builder.add_node("initial", initial)
    builder.add_node("approval", approval)
    builder.add_node("finish", finish)
    builder.add_edge(START, "initial")
    builder.add_edge("initial", "approval")
    builder.add_edge("approval", "finish")
    builder.add_edge("finish", END)
    runtime._graph = builder.compile(checkpointer=InMemorySaver())

    encoder = get_encoder(protocol)
    events = _events([frame async for frame in runtime.stream("start", "example-thread", "test-user", encoder=encoder)])
    output_index = next(i for i, (event, data) in enumerate(events) if event == "structured_output" or data.get("name") == "STRUCTURED_OUTPUT")
    interrupt_index = next(i for i, (event, data) in enumerate(events) if event == "input_required" or data.get("outcome") == "interrupt")
    assert output_index < interrupt_index
    assert encoder.get_structured_output() == {"summary": "before approval"}
    assert encoder.get_structured_output_schema_id() == "example.response.v1"
    assert not any(event == "done" or data.get("outcome") == "success" for event, data in events)

    resumed = get_encoder(protocol)
    frames = [frame async for frame in runtime.resume(
        "example-thread", "test-user", '{"type":"tool_approval","decision":"approve"}', encoder=resumed,
    )]
    assert resumed.get_structured_output() == ({"summary": "after approval"} if submit_after_resume else None)
    assert "before approval" not in "".join(frames)
    assert any(event == "done" or data.get("outcome") == "success" for event, data in _events(frames))


async def test_concurrent_invocations_on_one_runtime_keep_separate_results() -> None:
    runtime = _runtime()
    submit = _submit(runtime)
    barrier = asyncio.Barrier(2)

    async def respond(state: MessagesState) -> dict:
        assert (await submit.ainvoke({"payload": {"summary": state["messages"][-1].content}}))["accepted"]
        await barrier.wait()
        return {}

    builder = StateGraph(MessagesState)
    builder.add_node("respond", respond)
    builder.add_edge(START, "respond")
    builder.add_edge("respond", END)
    runtime._graph = builder.compile()
    runtime.has_pending_interrupt = AsyncMock(return_value=None)

    async def invoke(message: str) -> dict:
        return await _collect_invoke_response(
            runtime=runtime, request=ChatRequest(agent_id="example-agent", conversation_id="same-thread", message=message),
            user=UserContext(email="test-user@example.test"), agent=runtime.config,
        )

    async with asyncio.timeout(5):
        first, second = await asyncio.gather(invoke("first"), invoke("second"))
    assert first["structured_output"] == {"summary": "first"}
    assert second["structured_output"] == {"summary": "second"}
    assert first["structured_output_schema_id"] == second["structured_output_schema_id"] == "example.response.v1"


@pytest.mark.parametrize("submit_empty", [False, True])
async def test_invoke_retains_legacy_shape_unless_a_submission_arrives(submit_empty: bool) -> None:
    runtime = _runtime()
    submit = _submit(runtime, empty=True)

    async def respond(_state: MessagesState) -> dict:
        if submit_empty:
            assert (await submit.ainvoke({"payload": {}}))["accepted"]
        return {"messages": [AIMessage(content="Healthy")]}

    builder = StateGraph(MessagesState)
    builder.add_node("respond", respond)
    builder.add_edge(START, "respond")
    builder.add_edge("respond", END)
    runtime._graph = builder.compile()
    runtime.has_pending_interrupt = AsyncMock(return_value=None)
    response = await _collect_invoke_response(
        runtime=runtime, request=ChatRequest(agent_id="example-agent", conversation_id="example-thread", message="hello"),
        user=UserContext(email="test-user@example.test"), agent=runtime.config,
    )
    expected = {"success", "content", "thinking", "agent_id", "conversation_id", "trace_id"}
    if submit_empty:
        expected |= {"structured_output", "structured_output_schema_id"}
        assert response["structured_output"] == {}
    assert set(response) == expected
    assert response["success"] is True


async def test_initialization_resolves_structured_policy_once(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ENABLE_TRACING", "false")
    monkeypatch.setattr(agent_runtime, "get_llm", lambda *args, **kwargs: FakeMessagesListChatModel(responses=[AIMessage(content="Healthy")]))
    create_graph = Mock(return_value=Mock())
    monkeypatch.setattr(agent_runtime, "create_deep_agent", create_graph)
    runtime = AgentRuntime(
        config=DynamicAgentConfig(
            _id="example-agent", name="Example", owner_id="owner@example.test", system_prompt="Be helpful.",
            model={"id": "example-model", "provider": "example"},
            features={"middleware": [{"type": "structured_response", "enabled": True}]},
        ),
        mcp_servers=[], settings=Settings(default_runtime_backend="state", attachment_local_path=str(tmp_path)), ephemeral=True,
        client_context=ClientContext(source="webui", response_format={"type": "json_schema", "schema": {"type": "object"}}),
    )
    resolve_policy = Mock(wraps=runtime._get_allowed_structured_response_format)
    monkeypatch.setattr(runtime, "_get_allowed_structured_response_format", resolve_policy)
    await runtime.initialize()
    resolve_policy.assert_called_once()
    assert sum(tool.name == "submit_structured_response" for tool in create_graph.call_args.kwargs["tools"]) == 1
    assert all(
        tool.name != "submit_structured_response"
        for subagent in create_graph.call_args.kwargs["subagents"]
        for tool in subagent.get("tools", [])
    )
    assert "Structured response requirement:" in create_graph.call_args.kwargs["system_prompt"]


@pytest.mark.parametrize("wrapped", [False, True])
async def test_invoke_rejects_invalid_active_schema_with_422(monkeypatch: pytest.MonkeyPatch, wrapped: bool) -> None:
    error = StructuredResponseError("Invalid structured response schema")

    class FailedContext:
        async def __aenter__(self) -> None:
            raise RuntimeInitError("example-agent", error) if wrapped else error

        async def __aexit__(self, *args: object) -> None:
            pass

    monkeypatch.setattr(chat, "get_runtime_cache", lambda: SimpleNamespace(ephemeral=lambda *args, **kwargs: FailedContext(), set_mongo_service=Mock()))
    monkeypatch.setattr(chat, "get_settings", lambda: SimpleNamespace(invoke_persist_history=False))
    monkeypatch.setattr(chat, "_enforce_chat_authz", AsyncMock())
    agent = DynamicAgentConfig(
        _id="example-agent", name="Example", owner_id="owner@example.test", system_prompt="Example",
        model={"id": "example-model", "provider": "example"},
    )
    mongo = SimpleNamespace(get_agent=lambda _agent_id: agent, get_agent_mcp_servers=lambda _agent: [])
    response = await chat.chat_invoke(
        ChatRequest(agent_id=agent.id, conversation_id="example-thread", message="hello"),
        user=UserContext(email="test-user@example.test"), mongo=mongo,
    )
    assert response.status_code == 422
    assert json.loads(response.body)["error"] == str(error)


@pytest.mark.parametrize("protocol", ["custom", "agui"])
@pytest.mark.parametrize("resume", [False, True])
async def test_stream_reports_schema_initialization_errors(
    monkeypatch: pytest.MonkeyPatch, protocol: str, resume: bool,
) -> None:
    error = StructuredResponseError("Invalid structured response schema")
    cache = SimpleNamespace(get_or_create=AsyncMock(side_effect=RuntimeInitError("example-agent", error)))
    monkeypatch.setattr(chat, "get_runtime_cache", lambda: cache)
    args = dict(
        agent_config=SimpleNamespace(id="example-agent", name="Example"), mcp_servers=[], session_id="example-thread",
        user=UserContext(email="test-user@example.test"), encoder=get_encoder(protocol),
    )
    if resume:
        frames = chat._generate_resume_sse_events(resume_data="{}", **args)
    else:
        frames = chat._generate_sse_events(message="hello", **args)
    assert str(error) in "".join([frame async for frame in frames])
