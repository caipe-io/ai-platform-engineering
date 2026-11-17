"""Run-scoped loopback MCP bridge; user credentials remain in the worker broker."""

from __future__ import annotations

import hmac
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from acp.schema import HttpHeader, HttpMcpServer
from mcp import types
from mcp.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.responses import Response
from starlette.types import Receive, Scope, Send

from harness_engine.claude_tools import ClaudeToolBroker
from harness_engine.models import RunContext


@dataclass
class ToolSession:
    token: str
    manager: StreamableHTTPSessionManager


class ClaudeACPToolBridge:
    """Only the selected tools are exposed, with a capability revoked at turn end."""

    def __init__(self, port: int) -> None:
        self._port = port
        self._sessions: dict[str, ToolSession] = {}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        headers = dict(scope.get("headers", []))
        run_id = scope["path"].rsplit("/", 1)[-1]
        session = self._sessions.get(run_id)
        peer = scope.get("client")
        authorization = headers.get(b"authorization", b"")
        if (
            scope["type"] != "http"
            or not peer
            or peer[0] not in {"127.0.0.1", "::1"}
            or session is None
            or not hmac.compare_digest(authorization, f"Bearer {session.token}".encode())
        ):
            await Response(status_code=401)(scope, receive, send)
            return
        await session.manager.handle_request(scope, receive, send)

    @asynccontextmanager
    async def bind(
        self,
        context: RunContext,
        broker: ClaudeToolBroker,
        max_calls: int | None = None,
    ) -> AsyncIterator[tuple[list[HttpMcpServer], dict[str, str]]]:
        if not context.blueprint.tools.bindings:
            yield [], {}
            return
        async with broker.bind_tools(context) as (tools, names):
            server = Server("caipe")
            by_name = {tool.name: tool for tool in tools}
            calls = 0

            @server.list_tools()
            async def list_tools() -> list[types.Tool]:
                return [
                    types.Tool(name=tool.name, description=tool.description, inputSchema=tool.input_schema)
                    for tool in tools
                ]

            @server.call_tool()
            async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
                nonlocal calls
                tool = by_name.get(name)
                if tool is None:
                    raise PermissionError("Tool is not in this run's allowlist")
                if max_calls is not None and calls >= max_calls:
                    raise PermissionError("Research MCP call budget exhausted")
                calls += 1
                # The shared broker rechecks the caller, agent and tool through
                # CAS/AgentGateway on every call, and never retries a tool call.
                return types.CallToolResult.model_validate(await tool.handler(arguments))

            run_id = context.turn.run_id
            if run_id in self._sessions:
                raise RuntimeError("An MCP capability is already active for this run")
            token = secrets.token_urlsafe(32)
            manager = StreamableHTTPSessionManager(server, stateless=True, json_response=True)
            async with manager.run():
                self._sessions[run_id] = ToolSession(token, manager)
                try:
                    yield (
                        [
                            HttpMcpServer(
                                type="http",
                                name="caipe",
                                url=f"http://127.0.0.1:{self._port}/internal/claude-tools/{quote(run_id, safe='')}",
                                headers=[HttpHeader(name="Authorization", value=f"Bearer {token}")],
                            )
                        ],
                        names,
                    )
                finally:
                    self._sessions.pop(run_id, None)
