"""Real ACP JSON-RPC dispatch preserves existing native runtime behavior."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest
from acp import PROTOCOL_VERSION, RequestError, connect_to_agent
from acp.agent import AgentSideConnection
from acp.schema import ClientCapabilities, HttpMcpServer, TextContentBlock
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.models import InputFile
from dynamic_agents.services import native_acp
from dynamic_agents.services.native_acp import cancel_native_acp, native_acp_stream, native_acp_turn
from dynamic_agents.services.stream_encoders import get_encoder
from tests.test_stream_cancellation_cleanup import _runtime


class FakeRuntime:
    def __init__(self, *, interrupt: bool = False, block: bool = False) -> None:
        self.config = SimpleNamespace(id="example-agent")
        self.interrupt, self.block = interrupt, block
        self.calls: list[dict[str, Any]] = []
        self.closed = asyncio.Event()
        self.cancelled = False

    def cancel(self) -> bool:
        self.cancelled = True
        return True

    async def stream(self, message: str, session_id: str, user_email: str, trace_id: str | None, encoder: Any,
                     files: list[InputFile] | None = None, turn_id: str | None = None) -> Any:
        self.calls.append(dict(message=message, session_id=session_id, user_email=user_email,
                               trace_id=trace_id, files=files, turn_id=turn_id))
        try:
            for frame in encoder.on_run_start("example-run", session_id):
                yield frame
            if self.block:
                await asyncio.Event().wait()
            for frame in encoder.on_warning("Example warning"):
                yield frame
            chunks = [
                ((), "messages", (AIMessageChunk(content="Thinking. "), {})),
                ((), "updates", {"agent": {"messages": [AIMessage(content="", tool_calls=[{
                    "id": "example-tool", "name": "search", "args": {"query": "example"},
                }])]}}),
                ((), "tasks", {"id": "example-task", "input": [{"name": "task", "id": "example-child"}]}),
                (("tools:example-task",), "messages", (AIMessageChunk(content="Child. "), {})),
                ((), "updates", {"tools": {"messages": [ToolMessage(content="Result", tool_call_id="example-tool")]}}),
                ((), "custom", {"type": "context_usage", "used_tokens": 10, "remaining_percent": 90}),
                ((), "messages", (AIMessageChunk(content="Final."), {})),
            ]
            for chunk in chunks:
                for frame in encoder.on_chunk(chunk):
                    yield frame
            for frame in encoder.on_stream_end():
                yield frame
            if self.interrupt:
                for frame in encoder.on_input_required(
                    "example-interrupt", "form_input", "Choose a value", [{"field_name": "value", "field_type": "text"}],
                    "Example agent",
                ):
                    yield frame
            else:
                for frame in encoder.on_run_finish("example-run", session_id):
                    yield frame
        finally:
            self.closed.set()

    async def resume(self, session_id: str, user_email: str, resume_data: str, trace_id: str | None, encoder: Any) -> Any:
        self.calls.append(dict(resume_data=resume_data))
        async for frame in self.stream("resumed", session_id, user_email, trace_id, encoder):
            yield frame


@pytest.fixture
def wire_messages(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    original_send = native_acp._JsonTransport.send

    async def record(self: Any, message: dict[str, Any]) -> None:
        messages.append(json.loads(json.dumps(message)))
        await original_send(self, message)

    monkeypatch.setattr(native_acp._JsonTransport, "send", record)
    return messages


@pytest.mark.parametrize("protocol", ["agui", "custom"])
@pytest.mark.parametrize("interrupt", [False, True])
async def test_json_rpc_preserves_native_frames_and_encoder_state(
    protocol: str, interrupt: bool, monkeypatch: pytest.MonkeyPatch, wire_messages: list[dict[str, Any]],
) -> None:
    monkeypatch.setattr("dynamic_agents.services.stream_encoders.agui_sse._ts", lambda: 1.0)
    monkeypatch.setattr("dynamic_agents.services.stream_encoders.agui_sse._new_id", lambda prefix="": f"{prefix}example")
    direct, bridged = get_encoder(protocol), get_encoder(protocol)
    expected = [frame async for frame in FakeRuntime(interrupt=interrupt).stream(
        "hello", "example-session", "test-user@example.com", "example-trace", direct,
    )]
    runtime = FakeRuntime(interrupt=interrupt)
    actual = [frame async for frame in native_acp_stream(
        runtime, message="hello", session_id="example-session", user_email="test-user@example.com",
        encoder=bridged, trace_id="example-trace", turn_id="example-turn",
    )]
    assert actual == expected
    assert bridged.get_accumulated_content() == direct.get_accumulated_content()
    assert bridged.get_thinking_content() == direct.get_thinking_content()
    assert runtime.calls[0]["turn_id"] == "example-turn"
    methods = [message["method"] for message in wire_messages if "method" in message]
    assert methods[:3] == ["initialize", "session/new", "session/prompt"]
    updates = [message["params"]["update"] for message in wire_messages if message.get("method") == "session/update"]
    assert any(update["sessionUpdate"] == "agent_message_chunk" for update in updates)
    assert any(update["sessionUpdate"] == "tool_call" and update["title"] == "search" for update in updates)
    assert any(update["sessionUpdate"] == "tool_call_update" and update.get("rawOutput") == "Result" for update in updates)
    assert any(update["_meta"][native_acp.EXTENSION]["namespace"] == ["example-child"] for update in updates)
    assert all(message["params"]["sessionId"] == "example-session" for message in wire_messages
               if message.get("method") in {"session/prompt", "session/update", native_acp.FRAME_METHOD})
    capability = wire_messages[0]["params"]["clientCapabilities"]
    # The SDK omits capabilities whose values equal the disabled defaults.
    assert not capability.get("fs", {}).get("readTextFile", False)
    assert not capability.get("fs", {}).get("writeTextFile", False)
    assert not capability.get("terminal", False)
    assert not any("test-user@example.com" in json.dumps(message) for message in wire_messages)


async def test_multimodal_files_cross_standard_prompt_blocks(wire_messages: list[dict[str, Any]]) -> None:
    files = [
        InputFile(mime_type="image/png", data="aW1hZ2U=", name="example.png"),
        InputFile(mime_type="application/pdf", data="ZG9jdW1lbnQ=", name="example.pdf"),
        InputFile(mime_type="text/plain", uri="https://example.test/file", name="example.txt"),
        InputFile(mime_type="image/jpeg", data="aW1hZ2U=", uri="https://example.test/image", name="example.jpg"),
    ]
    runtime = FakeRuntime()
    _ = [frame async for frame in native_acp_stream(
        runtime, message="Review attachments", session_id="example-session", user_email="test-user@example.com",
        encoder=get_encoder("agui"), files=files,
    )]
    assert runtime.calls[0]["files"] == files
    request = next(message for message in wire_messages if message.get("method") == "session/prompt")
    assert [block["type"] for block in request["params"]["prompt"]] == ["text", "image", "resource", "resource_link", "image"]


@pytest.mark.parametrize("resume_data", [
    '{"type":"form_input","values":{"value":"example"}}',
    '{"type":"tool_approval","decisions":[{"decision":"approve"},{"decision":"edit","edited_args":{"value":1}}]}',
])
async def test_checkpointed_resume_preserves_full_payload(resume_data: str) -> None:
    runtime = FakeRuntime()
    _ = [frame async for frame in native_acp_stream(
        runtime, message=None, session_id="example-session", user_email="test-user@example.com",
        encoder=get_encoder("agui"), resume_data=resume_data,
    )]
    assert runtime.calls[0] == {"resume_data": resume_data}
    assert runtime.calls[1]["session_id"] == "example-session"


@pytest.mark.parametrize("consumer_close", [False, True], ids=["cancel-request", "disconnect"])
async def test_cancellation_closes_execution_before_releasing_guard(
    consumer_close: bool, wire_messages: list[dict[str, Any]],
) -> None:
    runtime = FakeRuntime(block=True)
    stream = native_acp_stream(runtime, message="hello", session_id="example-session",
                               user_email="test-user@example.com", encoder=get_encoder("agui"))
    async with asyncio.timeout(5):
        assert "RUN_STARTED" in await anext(stream)
        if consumer_close:
            await stream.aclose()
        else:
            assert cancel_native_acp("example-agent", "example-session")
            assert not cancel_native_acp("example-agent", "example-session")
            assert [frame async for frame in stream] == []
        assert runtime.closed.is_set()
        assert runtime.cancelled
        assert any(message.get("method") == "session/cancel" for message in wire_messages)
        assert not cancel_native_acp("example-agent", "example-session")
        async with native_acp_turn("example-agent", "example-session"):
            pass


async def test_reservation_blocks_other_tasks_and_cancels_admission() -> None:
    entered = asyncio.Event()
    cleaned = asyncio.Event()

    async def admit() -> None:
        try:
            async with native_acp_turn("example-agent", "example-session"):
                entered.set()
                await asyncio.Event().wait()
        finally:
            cleaned.set()

    task = asyncio.create_task(admit())
    await entered.wait()
    with pytest.raises(RuntimeError, match="already active"):
        async with native_acp_turn("example-agent", "example-session"):
            pass
    assert cancel_native_acp("example-agent", "example-session")
    await asyncio.gather(task, return_exceptions=True)
    assert cleaned.is_set()
    async with native_acp_turn("example-agent", "example-session"):
        async with native_acp_turn("example-agent", "example-session"):
            pass


async def test_request_owner_cancellation_awaits_runtime_cleanup() -> None:
    runtime = FakeRuntime(block=True)
    started = asyncio.Event()

    async def consume() -> None:
        async with native_acp_turn("example-agent", "example-session"):
            async for _frame in native_acp_stream(
                runtime, message="hello", session_id="example-session", user_email="test-user@example.com",
                encoder=get_encoder("agui"),
            ):
                started.set()

    task = asyncio.create_task(consume())
    await started.wait()
    task.cancel()
    results = await asyncio.gather(task, return_exceptions=True)
    assert isinstance(results[0], asyncio.CancelledError)
    assert runtime.closed.is_set()
    assert runtime.cancelled
    assert not cancel_native_acp("example-agent", "example-session")


async def test_frame_burst_finishes_after_every_notification() -> None:
    class BurstRuntime(FakeRuntime):
        async def stream(self, *args: Any, **kwargs: Any) -> Any:
            for index in range(500):
                yield f'event: warning\ndata: {{"message":"{index}"}}\n\n'

    frames = [frame async for frame in native_acp_stream(
        BurstRuntime(), message="hello", session_id="example-session", user_email="test-user@example.com",
        encoder=get_encoder("agui"),
    )]
    assert [json.loads(frame.split("data: ")[1])["message"] for frame in frames] == [str(index) for index in range(500)]


@pytest.mark.parametrize("total", [500, native_acp.BUFFER_SIZE + 1], ids=["active-producer", "completion-sentinel"])
@pytest.mark.parametrize("consumer_close", [False, True], ids=["slow-consumer", "early-close"])
async def test_bounded_delivery_and_full_buffer_cleanup(total: int, consumer_close: bool) -> None:
    class BurstRuntime(FakeRuntime):
        produced = 0

        async def stream(self, *args: Any, **kwargs: Any) -> Any:
            try:
                for index in range(total):
                    self.produced += 1
                    if self.produced == min(total, native_acp.BUFFER_SIZE + 2):
                        ready.set()
                    yield f'event: warning\ndata: {{"message":"{index}"}}\n\n'
            finally:
                self.closed.set()

    ready = asyncio.Event()
    runtime = BurstRuntime()
    stream = native_acp_stream(runtime, message="hello", session_id="example-session",
                               user_email="test-user@example.com", encoder=get_encoder("agui"))
    async with asyncio.timeout(5):
        first = await anext(stream)
        await ready.wait()
        if total <= native_acp.BUFFER_SIZE + 1:
            await runtime.closed.wait()
        assert runtime.produced <= native_acp.BUFFER_SIZE + 2
        if consumer_close:
            await stream.aclose()
        else:
            frames = [first, *[frame async for frame in stream]]
            assert len(frames) == total
            assert json.loads(frames[-1].split("data: ")[1])["message"] == str(total - 1)
        assert runtime.closed.is_set()
        assert not cancel_native_acp("example-agent", "example-session")


@asynccontextmanager
async def connected_agent(runtime: FakeRuntime) -> Any:
    first, second = native_acp._transport_pair()
    agent_connection = AgentSideConnection(native_acp._NativeAgent(
        runtime, "example-session", "trusted-user@example.com", get_encoder("agui"),
    ), second)
    client_connection = connect_to_agent(native_acp._FrameClient("example-session"), first)
    try:
        await client_connection.initialize(PROTOCOL_VERSION, client_capabilities=ClientCapabilities(field_meta={native_acp.EXTENSION: 1}))
        yield client_connection
    finally:
        await agent_connection.close()
        await client_connection.close()


@pytest.mark.parametrize("injection", [
    {"user_email": "injected@example.com"},
    {"config": {"allowed_tools": {"example": True}}},
    {native_acp.EXTENSION: {"user_email": "injected@example.com"}},
    {native_acp.EXTENSION: {"resume_data": {"type": "tool_approval"}}},
])
async def test_prompt_cannot_replace_trusted_identity_or_config(injection: dict[str, Any]) -> None:
    runtime = FakeRuntime()
    async with connected_agent(runtime) as connection:
        await connection.new_session(cwd="/", mcp_servers=[])
        with pytest.raises(RequestError):
            await connection.prompt("example-session", [TextContentBlock(type="text", text="hello")], **injection)
    assert runtime.calls == []


@pytest.mark.parametrize("parameters", [
    {"cwd": "/tmp/example", "mcp_servers": []},
    {"cwd": "/", "mcp_servers": [HttpMcpServer(type="http", name="example", url="https://example.test/mcp", headers=[])]},
    {"cwd": "/", "mcp_servers": [], "additional_directories": ["/tmp/example"]},
])
async def test_session_cannot_inject_host_path_or_mcp(parameters: dict[str, Any]) -> None:
    runtime = FakeRuntime()
    async with connected_agent(runtime) as connection:
        with pytest.raises(RequestError):
            await connection.new_session(**parameters)
    assert runtime.calls == []


async def test_wire_cancellation_before_prompt_never_executes_runtime(wire_messages):
    runtime = FakeRuntime()
    async with connected_agent(runtime) as connection:
        await connection.new_session(cwd="/", mcp_servers=[])
        await connection.cancel("example-session")
        response = await connection.prompt("example-session", [TextContentBlock(type="text", text="hello")])
    assert response.stop_reason == "cancelled"
    assert runtime.calls == []
    assert not runtime.cancelled
    assert any(message.get("method") == "session/cancel" for message in wire_messages)
    assert not any(message.get("method") == native_acp.FRAME_METHOD for message in wire_messages)


async def test_json_transport_does_not_share_request_objects() -> None:
    first, second = native_acp._transport_pair()
    message = {"jsonrpc": "2.0", "params": {"example": [1]}}
    await first.send(message)
    message["params"]["example"].append(2)
    assert await second.receive() == {"jsonrpc": "2.0", "params": {"example": [1]}}
    await first.close()
    await second.close()


async def test_each_sdk_turn_captures_current_verified_token_context() -> None:
    seen: list[str | None] = []

    class ContextRuntime(FakeRuntime):
        async def stream(self, *args: Any, **kwargs: Any) -> Any:
            seen.append(current_user_token.get())
            async for frame in super().stream(*args, **kwargs):
                yield frame

    runtime = ContextRuntime()
    for value in ("example-primary-token", "example-secondary-token"):
        token = current_user_token.set(value)
        try:
            _ = [frame async for frame in native_acp_stream(
                runtime, message="hello", session_id="example-session", user_email="test-user@example.com",
                encoder=get_encoder("agui"),
            )]
        finally:
            current_user_token.reset(token)
    assert seen == ["example-primary-token", "example-secondary-token"]


async def test_cancelled_langgraph_turn_does_not_replay_in_follow_up() -> None:
    model = FakeListChatModel(responses=["CANCELLED-CONTENT", "RECOVERY-OK"], sleep=0.01)
    runtime = _runtime(create_agent(model=model, checkpointer=InMemorySaver()))
    stream = native_acp_stream(runtime, message="first request", session_id="example-thread",
                               user_email="test-user@example.com", encoder=get_encoder("agui"))
    async with asyncio.timeout(5):
        async for frame in stream:
            if "TEXT_MESSAGE_CONTENT" in frame:
                assert cancel_native_acp(runtime.config.id, "example-thread")
                assert [remaining async for remaining in stream] == []
                break
        else:
            pytest.fail("The test model did not emit before cancellation")
        assert not runtime._is_streaming
        follow_up = get_encoder("agui")
        frames = [frame async for frame in native_acp_stream(
            runtime, message="reply only RECOVERY-OK", session_id="example-thread", user_email="test-user@example.com",
            encoder=follow_up,
        )]
    assert follow_up.get_accumulated_content() == "RECOVERY-OK"
    assert "CANCELLED-CONTENT" not in "".join(frames)
