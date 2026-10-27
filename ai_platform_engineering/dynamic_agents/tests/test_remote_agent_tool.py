"""Contract tests for the Dynamic Agents adapter against the official A2A SDK server."""

from __future__ import annotations

import asyncio
import socket
import threading
import time
from contextlib import contextmanager
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
from langchain_core.messages import AIMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from starlette.applications import Starlette

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.services.credential_exchange import CredentialExchangeClient
from dynamic_agents.services.remote_agent_tool import RemoteAgentTool, create_remote_agent_tool


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
