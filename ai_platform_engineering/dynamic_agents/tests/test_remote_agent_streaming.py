"""Streaming accumulation and transport-neutral encoder contracts."""

import asyncio
import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from a2a.types import (
    Artifact,
    Message,
    Part,
    Role,
    StreamResponse,
    Task,
    TaskArtifactUpdateEvent,
    TaskState,
    TaskStatus,
    TaskStatusUpdateEvent,
)

from dynamic_agents.services.remote_agent_tool import _RemoteOutput, create_remote_agent_tool
from dynamic_agents.services.stream_encoders.agui_sse import AGUIStreamEncoder
from dynamic_agents.services.stream_encoders.custom_sse import CustomStreamEncoder


def test_artifact_replacement_and_append_do_not_duplicate_text() -> None:
    output = _RemoteOutput()
    for text, append in [("initial", False), ("replacement", False), (" tail", True)]:
        output.update(
            StreamResponse(
                artifact_update=TaskArtifactUpdateEvent(
                    task_id="test-task",
                    context_id="test-context",
                    artifact=Artifact(artifact_id="answer", parts=[Part(text=text)]),
                    append=append,
                )
            )
        )
    assert output.text == "replacement tail"
    assert output.stream_seen and not output.finished
    output.update(
        StreamResponse(
            status_update=TaskStatusUpdateEvent(
                task_id="test-task",
                context_id="test-context",
                status=TaskStatus(state=TaskState.TASK_STATE_COMPLETED),
            )
        )
    )
    assert output.finished
    assert output.text == "replacement tail"


@pytest.mark.parametrize(
    "state", [TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED]
)
def test_stream_failure_is_not_a_successful_partial_answer(state: TaskState) -> None:
    with pytest.raises(RuntimeError, match="failed or was canceled"):
        _RemoteOutput().update(
            StreamResponse(
                status_update=TaskStatusUpdateEvent(
                    task_id="test-task",
                    context_id="test-context",
                    status=TaskStatus(state=state),
                )
            )
        )


@pytest.mark.parametrize("encoder", [AGUIStreamEncoder, CustomStreamEncoder])
def test_encoder_preserves_tool_output_snapshot_and_namespace(encoder: type) -> None:
    frames = encoder()._handle_custom(
        {"type": "tool_output", "tool_call_id": "call-1", "result": "partial"}, ("test-child",)
    )
    assert len(frames) == 1
    data = json.loads(next(line[6:] for line in frames[0].splitlines() if line.startswith("data: ")))
    if encoder is AGUIStreamEncoder:
        assert data["name"] == "TOOL_OUTPUT"
        data = data["value"]
    assert data["tool_call_id"] == "call-1"
    assert data["result"] == "partial"
    assert data["namespace"] == ["test-child"]


@pytest.mark.parametrize("ending", ["eof", "timeout", "cancel"])
async def test_stream_cleanup_on_disconnect_timeout_and_cancellation(
    ending: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = asyncio.Event()

    async def stream(*args: Any, **kwargs: Any) -> AsyncIterator[StreamResponse]:
        yield StreamResponse(
            artifact_update=TaskArtifactUpdateEvent(
                task_id="task",
                context_id="context",
                artifact=Artifact(artifact_id="answer", parts=[Part(text="partial")]),
            )
        )
        started.set()
        if ending == "timeout":
            raise httpx.ReadTimeout("test timeout")
        if ending == "cancel":
            await asyncio.Event().wait()

    client = SimpleNamespace(send_message=stream, close=AsyncMock())
    factory = SimpleNamespace(create_from_url=AsyncMock(return_value=client))
    monkeypatch.setattr("dynamic_agents.services.remote_agent_tool.ClientFactory", lambda config: factory)
    tool = await create_remote_agent_tool(a2a_url="https://agent.example.test", streaming=True, bearer_token="caller")
    if ending == "cancel":
        task = asyncio.create_task(tool.ainvoke({"message": "test"}))
        await asyncio.wait_for(started.wait(), timeout=2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        error = RuntimeError if ending == "eof" else httpx.ReadTimeout
        with pytest.raises(error):
            await tool.ainvoke({"message": "test"})
    client.close.assert_awaited_once()


@pytest.mark.parametrize("kind", ["append", "replace", "message", "task", "status"])
def test_utf8_output_limit_covers_all_response_forms(kind: str) -> None:
    output = _RemoteOutput(max_output_bytes=4)
    part = Part(text="ééé")  # Three characters, six UTF-8 bytes.
    if kind in {"append", "replace"}:
        event = StreamResponse(artifact_update=TaskArtifactUpdateEvent(
            task_id="task", context_id="context", append=kind == "append",
            artifact=Artifact(artifact_id="answer", parts=[part]),
        ))
    elif kind == "message":
        event = StreamResponse(message=Message(message_id="reply", role=Role.ROLE_AGENT, parts=[part]))
    elif kind == "task":
        event = StreamResponse(task=Task(id="task", context_id="context",
            status=TaskStatus(state=TaskState.TASK_STATE_COMPLETED),
            artifacts=[Artifact(artifact_id="answer", parts=[part])]))
    else:
        event = StreamResponse(status_update=TaskStatusUpdateEvent(task_id="task", context_id="context",
            status=TaskStatus(state=TaskState.TASK_STATE_WORKING,
                message=Message(message_id="status", role=Role.ROLE_AGENT, parts=[part]))))
    with pytest.raises(RuntimeError, match="output exceeded 4 bytes"):
        output.update(event)


def test_output_budget_counts_append_and_multiple_artifacts() -> None:
    output = _RemoteOutput(max_output_bytes=5)
    def update(artifact_id: str, text: str, append: bool = False) -> StreamResponse:
        return StreamResponse(artifact_update=TaskArtifactUpdateEvent(task_id="task", context_id="context",
            artifact=Artifact(artifact_id=artifact_id, parts=[Part(text=text)]), append=append))
    output.update(update("answer", "123"))
    output.update(update("answer", "45", True))
    assert output.text == "12345"  # Exact boundary.
    with pytest.raises(RuntimeError, match="output exceeded"):
        output.update(update("secondary", "6"))


@pytest.mark.parametrize("phase", ["credential", "discovery", "stream"])
async def test_overall_deadline_includes_setup_and_trickling_stream(
    phase: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    closed = asyncio.Event()
    snapshots: list[dict] = []
    async def stream(*args: Any, **kwargs: Any) -> AsyncIterator[StreamResponse]:
        try:
            while True:
                yield StreamResponse(artifact_update=TaskArtifactUpdateEvent(task_id="task", context_id="context",
                    artifact=Artifact(artifact_id="answer", parts=[Part(text="x")]), append=True))
                await asyncio.sleep(0.05)
        finally:
            closed.set()
    client = SimpleNamespace(send_message=stream, close=AsyncMock())
    async def discover(*args: Any, **kwargs: Any) -> Any:
        if phase == "discovery":
            await asyncio.Event().wait()
        return client
    factory = SimpleNamespace(create_from_url=discover)
    monkeypatch.setattr("dynamic_agents.services.remote_agent_tool.ClientFactory", lambda config: factory)
    tool = await create_remote_agent_tool(a2a_url="https://agent.example.test", bearer_token="caller", timeout=1, streaming=True)
    if phase == "credential":
        async def resolve(*args: Any) -> dict[str, str]:
            await asyncio.Event().wait()
            return {}
        monkeypatch.setattr(type(tool), "_resolve_auth_headers", resolve)
    runtime = SimpleNamespace(tool_call_id="call", stream_writer=snapshots.append)
    started = asyncio.get_running_loop().time()
    with pytest.raises(TimeoutError, match="1 second deadline"):
        await asyncio.wait_for(tool._arun("test", runtime), timeout=2)
    assert asyncio.get_running_loop().time() - started < 1.5
    if phase == "stream":
        assert len(snapshots) > 3  # Continuing activity does not reset the deadline.
        assert closed.is_set()
        client.close.assert_awaited_once()
    else:
        client.close.assert_not_awaited()


async def test_output_limit_closes_sdk_client_without_emitting_oversized_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    closed = asyncio.Event()
    async def stream(*args: Any, **kwargs: Any) -> AsyncIterator[StreamResponse]:
        try:
            yield StreamResponse(artifact_update=TaskArtifactUpdateEvent(task_id="task", context_id="context",
                artifact=Artifact(artifact_id="answer", parts=[Part(text="oversized")]), append=False))
        finally:
            closed.set()
    client = SimpleNamespace(send_message=stream, close=AsyncMock())
    factory = SimpleNamespace(create_from_url=AsyncMock(return_value=client))
    monkeypatch.setattr("dynamic_agents.services.remote_agent_tool.ClientFactory", lambda config: factory)
    tool = await create_remote_agent_tool(a2a_url="https://agent.example.test", bearer_token="caller", streaming=True, max_output_bytes=4)
    snapshots: list[dict] = []
    with pytest.raises(RuntimeError, match="output exceeded"):
        await tool._arun("test", SimpleNamespace(tool_call_id="call", stream_writer=snapshots.append))
    assert snapshots == []
    client.close.assert_awaited_once()
    assert closed.is_set()
