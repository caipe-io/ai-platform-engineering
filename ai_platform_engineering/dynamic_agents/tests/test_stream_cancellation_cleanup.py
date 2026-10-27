"""Cancelled generators close their graph tasks before a follow-up starts."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langgraph.checkpoint.memory import InMemorySaver

from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.stream_encoders.agui_sse import AGUIStreamEncoder


def _runtime(graph: Any) -> AgentRuntime:
    runtime = AgentRuntime.__new__(AgentRuntime)
    runtime._initialized = True
    runtime._graph = graph
    runtime.config = SimpleNamespace(id="example-agent", name="example-agent", model=SimpleNamespace(id="example-model"))
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


@pytest.mark.asyncio
@pytest.mark.parametrize("consumer_close", [False, True], ids=["cancel-request", "disconnect"])
async def test_cancelled_model_does_not_replay_in_follow_up(consumer_close: bool) -> None:
    model = FakeListChatModel(responses=["CANCELLED-CONTENT", "RECOVERY-OK"], sleep=0.01)
    graph = create_agent(model=model, checkpointer=InMemorySaver())
    runtime = _runtime(graph)
    encoder = AGUIStreamEncoder()
    stream = runtime.stream("first request", "example-thread", "test-user", encoder=encoder)
    async with asyncio.timeout(5):
        async for frame in stream:
            if "TEXT_MESSAGE_CONTENT" in frame:
                if consumer_close:
                    await stream.aclose()
                else:
                    assert runtime.cancel()
                    assert [remaining async for remaining in stream] == []
                break
        else:
            pytest.fail("The test model did not emit content before cancellation")
        assert not runtime._is_streaming
        follow_up = AGUIStreamEncoder()
        frames = [frame async for frame in runtime.stream(
            "reply only RECOVERY-OK", "example-thread", "test-user", encoder=follow_up
        )]
        assert follow_up.get_accumulated_content() == "RECOVERY-OK"
        assert "CANCELLED-CONTENT" not in "".join(frames)
        assert any("RUN_FINISHED" in frame for frame in frames)
