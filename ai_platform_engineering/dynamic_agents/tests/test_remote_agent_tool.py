"""Contract tests for the Dynamic Agents adapter against the official A2A SDK server."""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
import uvicorn
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes, create_rest_routes
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    Message,
    Part,
    Role,
    Task,
    TaskState,
    TaskStatus,
)
from deepagents import create_deep_agent
from deepagents.backends.state import StateBackend
from deepagents.middleware.subagents import SubAgentMiddleware
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from langgraph.types import Command
from starlette.applications import Starlette

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.models import FeaturesConfig
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.credential_exchange import CredentialExchangeClient
from dynamic_agents.services.remote_agent_subagent import create_remote_agent_subagent
from dynamic_agents.services.remote_agent_tool import RemoteAgentTool, create_remote_agent_tool
from dynamic_agents.services.stream_encoders.agui_sse import AGUIStreamEncoder
from dynamic_agents.services.stream_encoders.custom_sse import CustomStreamEncoder


class _CaptureAuthorization:
    authorization: str | None = None
    requests: list[dict[str, str]] = []

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            self.__class__.requests.append({key.decode(): value.decode() for key, value in scope.get("headers", [])})
        if scope["type"] == "http" and scope.get("path") == "/":
            headers = dict(scope.get("headers", []))
            self.__class__.authorization = headers.get(b"authorization", b"").decode() or None
        await self.app(scope, receive, send)


class _EchoExecutor(AgentExecutor):
    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        await event_queue.enqueue_event(
            Message(
                message_id="response-1",
                role=Role.ROLE_AGENT,
                parts=[Part(text=f"echo: {context.get_user_input()}")],
            )
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        return None


@contextmanager
def _sdk_agent_server(
    protocol_binding: str = "JSONRPC", executor: AgentExecutor | None = None, streaming: bool = False, advertised_url: str | None = None
):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    endpoint = f"http://127.0.0.1:{port}/"
    card = AgentCard(
        name="Example Echo Agent",
        description="Echoes a message.",
        version="1.0.0",
        capabilities=AgentCapabilities(streaming=streaming),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        supported_interfaces=[AgentInterface(url=advertised_url or endpoint, protocol_binding=protocol_binding, protocol_version="1.0")],
    )
    handler = DefaultRequestHandler(
        agent_executor=executor or _EchoExecutor(),
        task_store=InMemoryTaskStore(),
        agent_card=card,
    )
    app = _CaptureAuthorization(
        Starlette(
            routes=[
                *create_agent_card_routes(card),
                *(
                    create_jsonrpc_routes(handler, rpc_url="/")
                    if protocol_binding == "JSONRPC"
                    else create_rest_routes(handler)
                ),
            ]
        )
    )
    _CaptureAuthorization.authorization = None
    _CaptureAuthorization.requests = []
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="critical"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 5
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    if not server.started:
        server.should_exit = True
        thread.join(timeout=5)
        raise RuntimeError("A2A SDK test server did not start")
    try:
        yield endpoint
    finally:
        server.should_exit = True
        thread.join(timeout=5)


async def test_remote_tool_uses_sdk_contract_and_forwards_request_token():
    with _sdk_agent_server() as endpoint:
        tool = await create_remote_agent_tool(
            a2a_url=endpoint, allowed_http_origins=[endpoint],
            name="Example Echo Agent",
            description="Echoes a message.",
            bearer_token="stale-token",
            timeout=15,
        )
        token = current_user_token.set("request-token")
        try:
            result = await tool.ainvoke({"message": "hello"})
        finally:
            current_user_token.reset(token)

    assert result == "echo: hello"
    assert _CaptureAuthorization.authorization == "Bearer request-token"
    assert tool.name == "example_echo_agent"
    assert tool.timeout == 15


def test_sync_run_is_not_supported():
    tool = RemoteAgentTool(name="remote", description="d", a2a_url="http://example.test/")

    with pytest.raises(NotImplementedError):
        tool.invoke({"message": "ping"})


@pytest.mark.parametrize("protocol_binding", ["JSONRPC", "HTTP+JSON"])
@pytest.mark.parametrize("kind", ["caller_token", "secret_ref", "provider_connection"])
@pytest.mark.parametrize("streaming", [False, True])
async def test_selected_auth_reaches_card_and_agent_and_resolves_each_caller(
    monkeypatch: pytest.MonkeyPatch,
    protocol_binding: str,
    kind: str,
    streaming: bool,
) -> None:
    exchanges: list[tuple[str, dict[str, Any], str]] = []

    async def exchange(client: CredentialExchangeClient, path: str, json_body: dict[str, Any]) -> dict[str, Any]:
        caller = client._headers()["Authorization"].removeprefix("Bearer ")
        exchanges.append((path, json_body, caller))
        if path == "/retrieve":
            return {"credential": f"saved-{caller}"}
        return {"access_token": f"connected-{caller}"}

    monkeypatch.setattr(CredentialExchangeClient, "_post", exchange)
    source = {"kind": kind, "target": "header", "name": "Authorization"}
    if kind == "caller_token":
        source["name"] = "X-User-JWT"
    elif kind == "secret_ref":
        source.update(name="X-API-Key", secret_ref="example-secret")
    else:
        source["provider"] = "example"

    with _sdk_agent_server(
        protocol_binding, executor=_StreamingExecutor() if streaming else None, streaming=streaming
    ) as endpoint:
        tool = await create_remote_agent_tool(
            a2a_url=endpoint, allowed_http_origins=[endpoint],
            name="Example Agent",
            credential_source=source,
            credential_api_url="http://credentials.example.test/api/credentials",
            bearer_token="old-caller",
            streaming=streaming,
        )
        for caller in ("first-caller", "second-caller"):
            _CaptureAuthorization.requests = []
            token = current_user_token.set(caller)
            try:
                expected_text = "first second" if streaming else "echo: hello"
                assert await tool.ainvoke({"message": "hello"}) == expected_text
            finally:
                current_user_token.reset(token)
            expected = {
                "caller_token": caller,
                "secret_ref": f"saved-{caller}",
                "provider_connection": f"Bearer connected-{caller}",
            }[kind]
            assert len(_CaptureAuthorization.requests) >= 2  # Card discovery and A2A message.
            for headers in _CaptureAuthorization.requests:
                assert headers[source["name"].lower()] == expected
                if kind != "provider_connection":
                    assert "authorization" not in headers

    if kind == "caller_token":
        assert exchanges == []
    else:
        assert [caller for _, _, caller in exchanges] == ["first-caller", "second-caller"]
        for path, body, _ in exchanges:
            assert body["intended_use"] == "a2a_agent"
            if kind == "secret_ref":
                assert path == "/retrieve" and body["secret_ref"] == "example-secret"
            else:
                assert path == "/exchange" and body["provider"] == "example"


async def test_secret_permission_denial_stops_a2a_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    async def deny(client: CredentialExchangeClient, path: str, json_body: dict[str, Any]) -> dict[str, Any]:
        response = httpx.Response(403, request=httpx.Request("POST", "http://credentials.example.test/retrieve"))
        response.raise_for_status()
        return {}

    monkeypatch.setattr(CredentialExchangeClient, "_post", deny)
    with _sdk_agent_server() as endpoint:
        tool = await create_remote_agent_tool(
            a2a_url=endpoint, allowed_http_origins=[endpoint],
            name="Example Agent",
            bearer_token="caller",
            credential_source={
                "kind": "secret_ref",
                "target": "header",
                "name": "X-API-Key",
                "secret_ref": "example-secret",
            },
            credential_api_url="http://credentials.example.test/api/credentials",
        )
        with pytest.raises(httpx.HTTPStatusError):
            await tool.ainvoke({"message": "hello"})
        assert _CaptureAuthorization.requests == []


class _StreamingExecutor(AgentExecutor):
    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        await event_queue.enqueue_event(
            Task(
                id=context.task_id,
                context_id=context.context_id,
                status=TaskStatus(state=TaskState.TASK_STATE_SUBMITTED),
            )
        )
        await updater.start_work()
        await updater.add_artifact([Part(text="first ")], artifact_id="answer", append=False)
        await asyncio.sleep(0.15)
        await updater.add_artifact([Part(text="second")], artifact_id="answer", append=True, last_chunk=True)
        await updater.complete()

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        return None


@pytest.mark.parametrize("binding", ["JSONRPC", "HTTP+JSON"])
async def test_streamed_sdk_artifacts_reach_graph_before_tool_completion(binding: str) -> None:
    with _sdk_agent_server(binding, executor=_StreamingExecutor(), streaming=True) as endpoint:
        tool = await create_remote_agent_tool(a2a_url=endpoint, allowed_http_origins=[endpoint], name="remote", streaming=True, bearer_token="caller")
        builder = StateGraph(MessagesState)
        builder.add_node("tools", ToolNode([tool]))
        builder.add_edge(START, "tools")
        builder.add_edge("tools", END)
        graph = builder.compile()
        events = []
        async for mode, data in graph.astream(
            {
                "messages": [
                    AIMessage(
                        content="",
                        tool_calls=[
                            {"name": "remote", "args": {"message": "hello"}, "id": "call-stream", "type": "tool_call"},
                        ],
                    )
                ]
            },
            stream_mode=["custom", "updates"],
        ):
            events.append((mode, data))
        assert [data["result"] for mode, data in events if mode == "custom"] == ["first ", "first second"]
        assert events[0][0] == "custom"
        assert events[-1][0] == "updates"
        assert events[-1][1]["tools"]["messages"][0].content == "first second"
        assert _CaptureAuthorization.requests
        assert all(headers.get("authorization") == "Bearer caller" for headers in _CaptureAuthorization.requests)
        assert tool.tool_call_schema.model_json_schema()["properties"].keys() == {"message"}


async def test_streaming_opt_in_falls_back_for_non_streaming_card() -> None:
    with _sdk_agent_server() as endpoint:
        tool = await create_remote_agent_tool(a2a_url=endpoint, allowed_http_origins=[endpoint], streaming=True, bearer_token="caller")
        assert await tool.ainvoke({"message": "hello"}) == "echo: hello"


@pytest.mark.parametrize("kind", ["caller_token", "secret_ref", "provider_connection"])
async def test_plaintext_endpoint_rejected_before_credentials_or_network(kind: str, monkeypatch: pytest.MonkeyPatch) -> None:
    resolver = AsyncMock()
    monkeypatch.setattr(RemoteAgentTool, "_resolve_auth_headers", resolver)
    tool = RemoteAgentTool(name="example", description="example", a2a_url="http://agent.example.test/",
                           credential_source={"kind": kind})
    with pytest.raises(ValueError, match="HTTPS"):
        await tool.ainvoke({"message": "hello"})
    resolver.assert_not_awaited()


@pytest.mark.parametrize("binding", ["JSONRPC", "HTTP+JSON"])
async def test_card_cannot_send_credentials_to_another_origin(binding: str) -> None:
    with _sdk_agent_server(binding) as untrusted:
        with _sdk_agent_server(binding, advertised_url=untrusted) as endpoint:
            tool = await create_remote_agent_tool(a2a_url=endpoint, allowed_http_origins=[endpoint],
                                                  name="example", bearer_token="test-caller")
            with pytest.raises(Exception, match="untrusted origin"):
                await tool.ainvoke({"message": "hello"})
            # Only the configured origin's card was requested, no transport call reached the other server.
            assert len(_CaptureAuthorization.requests) == 1


@pytest.mark.parametrize("binding", ["JSONRPC", "HTTP+JSON"])
@pytest.mark.parametrize("limit", ["response", "output"])
async def test_complete_sdk_result_obeys_size_limits(binding: str, limit: str) -> None:
    with _sdk_agent_server(binding) as endpoint:
        tool = await create_remote_agent_tool(
            a2a_url=endpoint, allowed_http_origins=[endpoint], bearer_token="caller",
            max_response_bytes=1024 if limit == "response" else 8192,
            max_output_bytes=4 if limit == "output" else 8192,
        )
        with pytest.raises(RuntimeError, match="exceeded"):
            await tool.ainvoke({"message": "x" * 2048})


async def test_oversized_card_is_rejected_before_transport_selection() -> None:
    with _sdk_agent_server() as endpoint:
        tool = await create_remote_agent_tool(
            a2a_url=endpoint, allowed_http_origins=[endpoint], bearer_token="caller", max_response_bytes=10,
        )
        with pytest.raises(RuntimeError, match="responses exceeded 10 bytes"):
            await tool.ainvoke({"message": "hello"})
        assert not any(headers.get("content-type", "").startswith("application/json") for headers in _CaptureAuthorization.requests)


class _ToolCallingFakeModel(FakeMessagesListChatModel):
    def bind_tools(self, tools: Any, **kwargs: Any) -> "_ToolCallingFakeModel":
        return self


@pytest.mark.parametrize("encoder_type", [CustomStreamEncoder, AGUIStreamEncoder])
def test_subagent_content_and_tools_do_not_change_the_supervisor_answer(encoder_type) -> None:
    encoder = encoder_type()
    encoder._handle_messages((AIMessage(content="Plan"), {}), ())
    tool_message = AIMessage(content="", tool_calls=[{"name": "task", "args": {}, "id": "parent-call"}])
    encoder._handle_updates({"model": {"messages": [tool_message]}}, ())
    encoder._handle_messages((AIMessage(content="Answer"), {}), ())
    assert encoder._handle_messages((AIMessage(content="Child output"), {}), ("parent-call",))
    encoder._handle_updates({"model": {"messages": [tool_message]}}, ("parent-call",))
    encoder._handle_messages((AIMessage(content=" complete"), {}), ())
    assert encoder.get_accumulated_content() == "Answer complete"
    assert encoder.get_thinking_content() == "Plan"


@pytest.mark.parametrize("binding", ["JSONRPC", "HTTP+JSON"])
@pytest.mark.parametrize("nested", [False, True])
async def test_native_task_delegates_and_streams_without_an_extra_model(binding: str, nested: bool) -> None:
    with _sdk_agent_server(binding, executor=_StreamingExecutor(), streaming=True) as endpoint:
        transport = await create_remote_agent_tool(a2a_url=endpoint, allowed_http_origins=[endpoint],
            name="remote_example", description="Example remote agent", streaming=True, bearer_token="stale")
        spec = create_remote_agent_subagent(transport)
        model = _ToolCallingFakeModel(responses=[
            AIMessage(content="", tool_calls=[{"name": "task", "args": {
                "description": "hello", "subagent_type": spec["name"]}, "id": "remote-call"}]),
            AIMessage(content="Remote work complete."),
        ])
        if nested:
            child = {"name": "local-child", "description": "Example child", "system_prompt": "Delegate the task", "model": model,
                "tools": [], "middleware": [SubAgentMiddleware(backend=StateBackend, subagents=[spec])]}
            parent = _ToolCallingFakeModel(responses=[AIMessage(content="", tool_calls=[{"name": "task", "args": {
                "description": "Delegate the example", "subagent_type": "local-child"}, "id": "local-call"}]),
                AIMessage(content="Parent complete.")])
            graph = create_deep_agent(model=parent, tools=[], subagents=[child])
        else:
            graph = create_deep_agent(model=model, tools=[], subagents=[spec])
        encoders = [CustomStreamEncoder(), AGUIStreamEncoder()]
        frames = [[], []]
        messages = []
        token = current_user_token.set("active-caller")
        try:
            async for chunk in graph.astream({"messages": [HumanMessage(content="Delegate the example task")]},
                stream_mode=["messages", "custom", "updates", "tasks"], subgraphs=True):
                if chunk[1] == "updates" and isinstance(chunk[2], dict):
                    for update in chunk[2].values():
                        if isinstance(update, dict):
                            messages.extend(update.get("messages", []))
                for encoder, output in zip(encoders, frames, strict=True):
                    output.extend(encoder.on_chunk(chunk))
        finally:
            current_user_token.reset(token)
        for output in frames:
            events = [json.loads(line[6:]) for frame in output for line in frame.splitlines() if line.startswith("data: ")]
            snapshots = [event.get("value", event) for event in events
                if event.get("name") == "TOOL_OUTPUT" or event.get("type") == "tool_output"]
            assert [item["result"] for item in snapshots] == ["first ", "first second"]
            assert all(item["tool_call_id"] == "remote-call" and item["namespace"] == (["local-call"] if nested else []) for item in snapshots)
        assert _CaptureAuthorization.requests
        assert all(item.get("authorization") == "Bearer active-caller" for item in _CaptureAuthorization.requests)
        assert any(isinstance(msg, ToolMessage) and msg.tool_call_id == "remote-call" and msg.content == "first second" for msg in messages)
        assert any(isinstance(msg, AIMessage) and msg.content == "Remote work complete." for msg in messages)
        assert all(encoder.get_accumulated_content() == ("Parent complete." if nested else "Remote work complete.") for encoder in encoders)


async def test_shared_subagent_resolves_each_caller_without_persisting_credentials() -> None:
    with _sdk_agent_server() as endpoint:
        transport = await create_remote_agent_tool(a2a_url=endpoint, allowed_http_origins=[endpoint], bearer_token="stale")
        graph = create_remote_agent_subagent(transport)["runnable"]
        for caller in ["first-caller", "second-caller"]:
            token = current_user_token.set(caller)
            try:
                state = await graph.ainvoke({"messages": [HumanMessage(content="hello")]})
            finally:
                current_user_token.reset(token)
            assert state["messages"][-1].content == "echo: hello"
            assert _CaptureAuthorization.authorization == f"Bearer {caller}"
            assert set(state) == {"messages"}
            assert caller not in repr(state) and "stale" not in repr(state)


async def test_failed_delegation_does_not_trigger_parent_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    transport = await create_remote_agent_tool(a2a_url="https://agent.example.test", bearer_token="caller")
    invoke = AsyncMock(side_effect=TimeoutError("uncertain remote outcome"))
    monkeypatch.setattr(type(transport), "invoke_agent", invoke)
    state = await create_remote_agent_subagent(transport)["runnable"].ainvoke({"messages": [HumanMessage(content="hello")]})
    assert "do not automatically retry" in state["messages"][-1].content
    invoke.assert_awaited_once()


async def test_native_cancellation_closes_the_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    started, closed = asyncio.Event(), asyncio.Event()
    async def invoke(self, message, on_update, **kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            closed.set()
    transport = await create_remote_agent_tool(a2a_url="https://agent.example.test", bearer_token="caller")
    monkeypatch.setattr(type(transport), "invoke_agent", invoke)
    task = asyncio.create_task(create_remote_agent_subagent(transport)["runnable"].ainvoke({"messages": [HumanMessage(content="hello")]}))
    await asyncio.wait_for(started.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed.is_set()


def test_native_delegation_requires_explicit_opt_in() -> None:
    assert AgentRuntime._uses_remote_subagents(SimpleNamespace(features=None)) is False
    assert AgentRuntime._uses_remote_subagents(SimpleNamespace(features=FeaturesConfig())) is False
    assert AgentRuntime._uses_remote_subagents(SimpleNamespace(features=FeaturesConfig(remote_agents_as_subagents=True))) is True


async def test_native_task_approval_precedes_remote_network_requests() -> None:
    with _sdk_agent_server() as endpoint:
        transport = await create_remote_agent_tool(a2a_url=endpoint, allowed_http_origins=[endpoint], bearer_token="caller")
        spec = create_remote_agent_subagent(transport)
        model = _ToolCallingFakeModel(responses=[AIMessage(content="", tool_calls=[{"name": "task", "args": {
            "description": "hello", "subagent_type": spec["name"]}, "id": "approved-call"}]), AIMessage(content="Done")])
        graph = create_deep_agent(model=model, tools=[], subagents=[spec], checkpointer=MemorySaver(), interrupt_on={"task": True})
        config = {"configurable": {"thread_id": "approval-example"}}
        result = await graph.ainvoke({"messages": [HumanMessage(content="Delegate")]}, config)
        assert result["__interrupt__"]
        assert _CaptureAuthorization.requests == []
        result = await graph.ainvoke(Command(resume={"decisions": [{"type": "approve"}]}), config)
        assert _CaptureAuthorization.requests
        assert any(isinstance(msg, ToolMessage) and msg.content == "echo: hello" for msg in result["messages"])


@pytest.mark.parametrize("state", [TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED])
async def test_native_subagent_does_not_report_a_remote_pause_as_completion(state, monkeypatch: pytest.MonkeyPatch) -> None:
    async def responses(*args, **kwargs):
        yield SimpleNamespace(task=Task(id="remote-task", context_id="remote-context", status=TaskStatus(state=state)))
    client = SimpleNamespace(send_message=responses, close=AsyncMock())
    factory = SimpleNamespace(create_from_url=AsyncMock(return_value=client))
    monkeypatch.setattr("dynamic_agents.services.remote_agent_tool.ClientFactory", lambda config: factory)
    transport = await create_remote_agent_tool(a2a_url="https://agent.example.test", bearer_token="caller")
    # Legacy callers retain their response contract; native mode rejects the unsupported continuation.
    assert await transport.ainvoke({"message": "hello"}) == "Remote agent returned no text response."
    result = await create_remote_agent_subagent(transport)["runnable"].ainvoke({"messages": [HumanMessage(content="hello")]})
    assert "RemoteAgentContinuationRequired" in result["messages"][-1].content
    assert client.close.await_count == 2
