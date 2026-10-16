"""Existing remote delegation output survives native ACP and both UI protocols."""

import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from a2a.types import (
    Artifact,
    Part,
    StreamResponse,
    TaskArtifactUpdateEvent,
    TaskState,
    TaskStatus,
    TaskStatusUpdateEvent,
)
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver

from dynamic_agents.services import native_acp
from dynamic_agents.services.native_acp import native_acp_stream
from dynamic_agents.services.remote_agent_tool import create_remote_agent_tool
from dynamic_agents.services.stream_encoders import get_encoder
from dynamic_agents.services.stream_encoders.events import STREAM_EVENT_ADAPTER, ToolOutput
from dynamic_agents.services.stream_encoders.semantic import SemanticStreamEncoder
from tests.test_stream_cancellation_cleanup import _runtime


class _ToolModel(FakeMessagesListChatModel):
    def bind_tools(self, tools: Any, **kwargs: Any) -> "_ToolModel":
        return self


def test_tool_output_is_typed_and_correlates_the_subagent_namespace() -> None:
    encoder = SemanticStreamEncoder()
    encoder.on_chunk(((), "tasks", {
        "id": "example-task", "input": [{"name": "task", "id": "example-child"}],
    }))
    events = encoder.on_chunk((("tools:example-task",), "custom", {
        "type": "tool_output", "tool_call_id": "example-call", "result": "partial",
    }))
    assert events == [ToolOutput(
        tool_call_id="example-call", result="partial", namespace=("example-child",),
    )]
    assert STREAM_EVENT_ADAPTER.validate_json(events[0].model_dump_json()) == events[0]
    assert encoder.get_accumulated_content() == ""
    assert encoder.get_thinking_content() == ""


@pytest.mark.parametrize("protocol", ["agui", "custom"])
async def test_remote_sdk_tool_snapshots_cross_real_graph_and_serialized_acp(
    protocol: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    snapshots = ["initial", "replacement", "replacement tail"]

    async def responses(*args: Any, **kwargs: Any) -> AsyncIterator[StreamResponse]:
        for text, append in [("initial", False), ("replacement", False), (" tail", True)]:
            yield StreamResponse(artifact_update=TaskArtifactUpdateEvent(
                task_id="example-task", context_id="example-context",
                artifact=Artifact(artifact_id="example-answer", parts=[Part(text=text)]), append=append,
            ))
        yield StreamResponse(status_update=TaskStatusUpdateEvent(
            task_id="example-task", context_id="example-context",
            status=TaskStatus(state=TaskState.TASK_STATE_COMPLETED),
        ))

    sdk_client = SimpleNamespace(send_message=responses, close=AsyncMock())
    factory = SimpleNamespace(create_from_url=AsyncMock(return_value=sdk_client))
    monkeypatch.setattr("dynamic_agents.services.remote_agent_tool.ClientFactory", lambda config: factory)
    wire: list[dict[str, Any]] = []
    send = native_acp._JsonTransport.send

    async def record(transport: Any, message: dict[str, Any]) -> None:
        wire.append(json.loads(json.dumps(message)))
        await send(transport, message)

    monkeypatch.setattr(native_acp._JsonTransport, "send", record)
    tool = await create_remote_agent_tool(
        a2a_url="https://agent.example.test", name="delegate", streaming=True, bearer_token="example-token",
    )
    graph = create_agent(
        model=_ToolModel(responses=[
            AIMessage(content="", tool_calls=[{
                "id": "example-call", "name": tool.name, "args": {"message": "example request"},
            }]),
            AIMessage(content="Done."),
        ]),
        tools=[tool], checkpointer=InMemorySaver(),
    )
    runtime, encoder = _runtime(graph), get_encoder(protocol)
    frames = [frame async for frame in native_acp_stream(
        runtime, message="delegate this request", session_id="example-session",
        user_email="test-user@example.com", encoder=encoder,
    )]

    native_events = [message["params"]["event"] for message in wire
                     if message.get("method") == f"_{native_acp.EVENT_METHOD}"]
    outputs = [event for event in native_events if event["kind"] == "tool_output"]
    assert outputs == [
        {"kind": "tool_output", "tool_call_id": "example-call", "result": result, "namespace": []}
        for result in snapshots
    ]
    standard_updates = [message["params"]["update"] for message in wire
                        if message.get("method") == "session/update"]
    standard_outputs = [update for update in standard_updates
                        if update.get("status") == "in_progress" and "rawOutput" in update]
    assert [update["rawOutput"] for update in standard_outputs] == snapshots
    assert all(update["toolCallId"] == "example-call" for update in standard_outputs)
    assert all(update["_meta"][native_acp.EXTENSION]["namespace"] == [] for update in standard_outputs)
    assert [update["rawOutput"] for update in standard_updates
            if update.get("status") == "completed"] == [snapshots[-1]]
    payloads = [json.loads(frame.split("data: ", 1)[1]) for frame in frames]
    ui_outputs = [
        payload["value"] if protocol == "agui" else payload
        for payload in payloads
        if payload.get("name") == "TOOL_OUTPUT" or payload.get("type") == "tool_output"
    ]
    assert ui_outputs == [
        {"type": "tool_output", "tool_call_id": "example-call", "result": result, "namespace": []}
        for result in snapshots
    ]
    assert encoder.get_accumulated_content() == "Done."
    assert [event["content"] for event in native_events if event["kind"] == "tool_completed"] == [snapshots[-1]]
    sdk_client.close.assert_awaited_once()
    assert not runtime._is_streaming
    assert not any(message.get("method", "").startswith(("fs/", "terminal/")) for message in wire)
