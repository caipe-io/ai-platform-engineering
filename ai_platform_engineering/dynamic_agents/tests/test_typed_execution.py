from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from deepagents import create_deep_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.memory import InMemoryStore

from dynamic_agents.models import DynamicAgentConfig
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.execution import RuntimeEvent, TurnOutcome, execute_turn
from dynamic_agents.services.skills import build_skills_files
from dynamic_agents.services.stream_encoders.custom_sse import CustomStreamEncoder


class ToolModel(FakeMessagesListChatModel):
    def bind_tools(self, tools: Any, **kwargs: Any) -> ToolModel:
        return self


def runtime_for(graph: Any) -> AgentRuntime:
    runtime = object.__new__(AgentRuntime)
    runtime.config = DynamicAgentConfig(
        _id="agent-example",
        name="Example",
        owner_id="user@example.com",
        system_prompt="Help",
        model={"id": "test-model", "provider": "openai"},
    )
    runtime._graph = graph
    runtime._initialized = True
    runtime._active_stream_count = 0
    runtime._user = None
    runtime._client_context = None
    runtime._mcp_credential_warnings = []
    runtime._failed_servers_permanent = []
    runtime._failed_servers_transient = []
    runtime._mcp_credential_failed_server_ids = []
    runtime._failed_skills = []
    runtime._failed_workflows = []
    runtime.settings = SimpleNamespace(
        max_input_file_bytes=5_242_880, max_input_turn_bytes=20_971_520, max_input_files=20
    )
    runtime._get_attachment_store = lambda: None
    runtime._build_stream_config = lambda session_id, *_: {"configurable": {"thread_id": session_id}}
    runtime._record_turn = MagicMock()
    return runtime


def test_payload_projection_preserves_custom_wire_without_sse_parsing() -> None:
    chunk = ((), "messages", (AIMessageChunk(content="Example response"), {"langgraph_node": "model"}))
    wire = CustomStreamEncoder()
    typed = CustomStreamEncoder(lambda name, data: RuntimeEvent("custom", name, data))
    frames = wire.on_chunk(chunk)
    payloads = typed.on_chunk(chunk)
    assert frames
    assert frames == [f"event: {item.name}\ndata: {json.dumps(item.data)}\n\n" for item in payloads]


@pytest.mark.asyncio
async def test_real_deep_agent_pauses_then_resumes_from_native_checkpoint() -> None:
    @tool
    def request_user_input(prompt: str, fields: list[dict[str, Any]]) -> str:
        """Ask for input before continuing."""
        return str(fields)

    saver = MemorySaver()
    model = ToolModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "request_user_input",
                        "args": {
                            "prompt": "Choose",
                            "fields": [{"field_name": "value", "field_type": "text"}],
                        },
                        "id": "call-example",
                    }
                ],
            ),
            AIMessage(content="Selected value received"),
        ]
    )
    graph = create_deep_agent(
        model, tools=[request_user_input], interrupt_on={"request_user_input": True}, checkpointer=saver
    )
    first = [
        event
        async for event in execute_turn(
            runtime_for(graph), session_id="native-thread", user_id="user@example.com", message="Ask me"
        )
    ]
    assert isinstance(first[-1], TurnOutcome)
    assert first[-1].status == "paused"
    assert first[-1].interrupt["interrupt_id"]
    # Reconstruct the graph and runtime while retaining the native checkpoint.
    graph = create_deep_agent(
        model, tools=[request_user_input], interrupt_on={"request_user_input": True}, checkpointer=saver
    )
    resumed = [
        event
        async for event in execute_turn(
            runtime_for(graph),
            session_id="native-thread",
            user_id="user@example.com",
            resume_data=json.dumps({"type": "form_input", "values": {"value": "example"}}),
        )
    ]
    assert resumed[-1].status == "completed"
    assert "Selected value received" in resumed[-1].result["content"]
    assert not (await graph.aget_state({"configurable": {"thread_id": "native-thread"}})).interrupts


@pytest.mark.asyncio
@pytest.mark.parametrize("resume_data", [None, '{"type":"form_input","values":{}}'])
async def test_cancellation_before_stream_initialization_never_starts_graph(resume_data: str | None) -> None:
    graph = MagicMock()
    runtime = runtime_for(graph)
    cancellation = asyncio.Event()
    cancellation.set()
    events = [event async for event in execute_turn(runtime, session_id="example", user_id="user@example.test", message="example", resume_data=resume_data, cancellation_event=cancellation)]
    assert events == [TurnOutcome("cancelled")]
    graph.astream.assert_not_called()


def test_skill_snapshots_do_not_replace_shared_files_or_another_runtime_skills() -> None:
    runtime = runtime_for(MagicMock())
    runtime._session_id = "example-session"
    runtime._store = InMemoryStore()
    files, _ = build_skills_files([{"name": "example", "content": "---\nname: example\ndescription: Example\n---\nOriginal instructions"}])
    original = runtime._build_skill_store_backend(files)
    assert "Original instructions" in original.read("/default/example/SKILL.md").file_data["content"]
    other = runtime_for(MagicMock())
    other._session_id = "other-session"
    other._store = runtime._store
    assert other._build_skill_store_backend({}).read("/default/example/SKILL.md").error
    revised, _ = build_skills_files([{"name": "example", "content": "---\nname: example\ndescription: Example\n---\nUpdated instructions"}])
    latest = runtime._build_skill_store_backend(revised)
    assert "Updated instructions" in latest.read("/default/example/SKILL.md").file_data["content"]
    assert "Original instructions" in original.read("/default/example/SKILL.md").file_data["content"]
