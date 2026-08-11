"""Verify the remote A2A agent tool speaks JSON-RPC ``tasks/send``.

Issue #2013 — remote agents are invoked as LangChain tool calls. These
tests use an in-process HTTP server so we never touch the network.
"""

from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.services.remote_agent_tool import (
    RemoteAgentTool,
    _extract_result_text,
    create_remote_agent_tool,
)

AGENT_CARD = {"name": "Net Utils Agent", "description": "Runs network diagnostics."}


def _artifact_response(text: str) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": "1",
        "result": {"artifacts": [{"parts": [{"type": "text", "text": text}]}]},
    }


class _A2AHandler(BaseHTTPRequestHandler):
    """Minimal A2A server: serves an agent card and answers ``tasks/send``."""

    captured_headers: dict[str, str] = {}
    captured_payload: dict = {}
    card: dict | None = AGENT_CARD

    def log_message(self, *args):  # noqa: A002 - silence test server logging
        pass

    def _respond(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802
        if self.path == "/.well-known/agent.json" and self.__class__.card is not None:
            self._respond(200, self.__class__.card)
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        self.__class__.captured_payload = json.loads(self.rfile.read(length) or b"{}")
        self.__class__.captured_headers = {k.lower(): v for k, v in self.headers.items()}
        self._respond(200, _artifact_response("pong"))


@contextmanager
def _a2a_server(card: dict | None = AGENT_CARD):
    _A2AHandler.card = card
    _A2AHandler.captured_headers = {}
    _A2AHandler.captured_payload = {}
    server = HTTPServer(("127.0.0.1", 0), _A2AHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


async def test_agent_card_supplies_tool_name_and_description():
    with _a2a_server() as url:
        tool = await create_remote_agent_tool(a2a_url=url)

    assert tool.name == "net_utils_agent"
    assert tool.description == "Runs network diagnostics."
    assert tool.a2a_url == url


async def test_explicit_name_and_description_win_over_card():
    with _a2a_server() as url:
        tool = await create_remote_agent_tool(a2a_url=url, name="netutils", description="custom")

    assert (tool.name, tool.description) == ("netutils", "custom")


async def test_unreachable_agent_card_falls_back_to_host_derived_name():
    # ".invalid" never resolves (RFC 6761). The tool must still be built, so
    # one cold remote agent cannot fail the whole agent initialization, and
    # the name comes from the host so two cold agents do not collide.
    url = "http://netutils-agent.example.invalid:8000/"
    tool = await create_remote_agent_tool(a2a_url=url)

    assert tool.name == "netutils-agent_example_invalid"
    assert url in tool.description


async def test_sends_jsonrpc_tasks_send_and_returns_artifact_text():
    with _a2a_server() as url:
        tool = await create_remote_agent_tool(a2a_url=url)
        result = await tool.ainvoke({"message": "ping"})

    assert result == "pong"
    payload = _A2AHandler.captured_payload
    assert payload["jsonrpc"] == "2.0"
    assert payload["method"] == "tasks/send"
    assert payload["params"]["message"] == {
        "role": "user",
        "parts": [{"type": "text", "text": "ping"}],
    }


async def test_forwards_per_request_bearer_token():
    with _a2a_server() as url:
        tool = await create_remote_agent_tool(a2a_url=url, bearer_token="build-time-token")

        token = current_user_token.set("per-request-token")
        try:
            await tool.ainvoke({"message": "ping"})
        finally:
            current_user_token.reset(token)

    # The request-scoped token wins: runtimes are cached and reused across
    # requests, so the token captured at build time goes stale.
    assert _A2AHandler.captured_headers["authorization"] == "Bearer per-request-token"


async def test_falls_back_to_build_time_token_when_no_request_token():
    with _a2a_server() as url:
        tool = await create_remote_agent_tool(a2a_url=url, bearer_token="build-time-token")
        await tool.ainvoke({"message": "ping"})

    assert _A2AHandler.captured_headers["authorization"] == "Bearer build-time-token"


async def test_no_authorization_header_when_no_token_available():
    with _a2a_server() as url:
        tool = await create_remote_agent_tool(a2a_url=url)
        await tool.ainvoke({"message": "ping"})

    assert "authorization" not in _A2AHandler.captured_headers


def test_extract_text_reads_status_message_when_no_artifacts():
    data = {
        "result": {
            "status": {"message": {"parts": [{"kind": "text", "text": "from status"}]}},
        }
    }

    assert _extract_result_text(data) == "from status"


def test_extract_text_joins_multiple_text_parts_and_skips_non_text():
    data = {
        "result": {
            "artifacts": [
                {"parts": [{"type": "text", "text": "line one"}, {"type": "file", "file": {}}]},
                {"parts": [{"type": "text", "text": "line two"}]},
            ]
        }
    }

    assert _extract_result_text(data) == "line one\nline two"


def test_extract_text_raises_on_jsonrpc_error():
    data = {"error": {"code": -32603, "message": "internal error"}}

    with pytest.raises(RuntimeError, match="internal error"):
        _extract_result_text(data)


def test_sync_run_is_not_supported():
    tool = RemoteAgentTool(name="remote", description="d", a2a_url="http://example.test/")

    with pytest.raises(NotImplementedError):
        tool.invoke({"message": "ping"})
