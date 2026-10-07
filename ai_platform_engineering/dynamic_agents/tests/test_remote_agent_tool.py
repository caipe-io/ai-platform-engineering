"""Contract tests for the Dynamic Agents adapter against the official A2A SDK server."""

from __future__ import annotations

import socket
import threading
import time
from contextlib import contextmanager

import pytest
import uvicorn
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    Message,
    Part,
    Role,
)
from starlette.applications import Starlette

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.services.remote_agent_tool import RemoteAgentTool, create_remote_agent_tool


class _CaptureAuthorization:
    authorization: str | None = None

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
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
def _sdk_agent_server():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    endpoint = f"http://127.0.0.1:{port}/"
    card = AgentCard(
        name="Example Echo Agent",
        description="Echoes a message.",
        version="1.0.0",
        capabilities=AgentCapabilities(),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        supported_interfaces=[
            AgentInterface(url=endpoint, protocol_binding="JSONRPC", protocol_version="1.0")
        ],
    )
    handler = DefaultRequestHandler(
        agent_executor=_EchoExecutor(),
        task_store=InMemoryTaskStore(),
        agent_card=card,
    )
    app = _CaptureAuthorization(Starlette(
        routes=[
            *create_agent_card_routes(card),
            *create_jsonrpc_routes(handler, rpc_url="/"),
        ]
    ))
    _CaptureAuthorization.authorization = None
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
            a2a_url=endpoint,
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
