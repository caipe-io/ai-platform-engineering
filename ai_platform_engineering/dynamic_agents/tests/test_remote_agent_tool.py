"""Verify the remote A2A agent tool speaks JSON-RPC ``tasks/send``.

Issue #2013 — remote agents are invoked as LangChain tool calls. These
tests use an in-process HTTP server so we never touch the network.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.services.remote_agent_tool import (
    RemoteAgentTool,
    _extract_result_text,
    clear_agent_card_cache,
    create_remote_agent_tool,
)


@pytest.fixture(autouse=True)
def _no_card_cache_between_tests():
    """The card cache is module-level and deliberately outlives a runtime, so it
    would otherwise leak resolutions from one test into the next."""
    clear_agent_card_cache()
    yield
    clear_agent_card_cache()

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
    # Which well-known path this server answers on. 0.2.x servers serve the
    # legacy path only; 0.3.0+ serve the current one.
    card_path: str = "/.well-known/agent-card.json"
    card_paths_requested: list[str] = []

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
        self.__class__.card_paths_requested.append(self.path)
        if self.path == self.__class__.card_path and self.__class__.card is not None:
            self._respond(200, self.__class__.card)
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        self.__class__.captured_payload = json.loads(self.rfile.read(length) or b"{}")
        self.__class__.captured_headers = {k.lower(): v for k, v in self.headers.items()}
        self._respond(200, _artifact_response("pong"))


@contextmanager
def _a2a_server(
    card: dict | None = AGENT_CARD,
    card_path: str = "/.well-known/agent-card.json",
):
    _A2AHandler.card = card
    _A2AHandler.card_path = card_path
    _A2AHandler.card_paths_requested = []
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


# -- agent card path (A2A 0.3.0 renamed it) -----------------------------------


@pytest.mark.asyncio
async def test_card_is_read_from_the_current_well_known_path():
    """A2A publishes the card at ``/.well-known/agent-card.json`` since 0.3.0.
    Asking for the pre-0.3.0 ``agent.json`` 404s against a conforming server,
    and the tool then silently falls back to a URL-derived name and a generic
    description the LLM cannot route on."""
    with _a2a_server(card_path="/.well-known/agent-card.json") as url:
        tool = await create_remote_agent_tool(a2a_url=url)

    assert tool.name == "net_utils_agent"
    assert tool.description == "Runs network diagnostics."
    assert "/.well-known/agent-card.json" in _A2AHandler.card_paths_requested


@pytest.mark.asyncio
async def test_a_pre_030_server_is_still_discovered_via_the_legacy_path():
    """0.2.x servers only serve ``agent.json``. The SDK kept that value as
    ``PREV_AGENT_CARD_WELL_KNOWN_PATH`` for exactly this transition, so a 404 on
    the current path is retried against the old one rather than giving up."""
    with _a2a_server(card_path="/.well-known/agent.json") as url:
        tool = await create_remote_agent_tool(a2a_url=url)

    assert tool.description == "Runs network diagnostics.", "legacy card was not used"
    assert _A2AHandler.card_paths_requested == [
        "/.well-known/agent-card.json",
        "/.well-known/agent.json",
    ], "current path must be tried first"


@pytest.mark.asyncio
async def test_a_server_with_no_card_anywhere_is_asked_only_twice():
    """Two paths, then stop. A missing card is normal during startup and must
    not turn into a retry loop."""
    with _a2a_server(card=None) as url:
        tool = await create_remote_agent_tool(a2a_url=url)

    assert len(_A2AHandler.card_paths_requested) == 2
    assert tool.description.startswith("Remote agent at ")


@pytest.mark.asyncio
async def test_a_non_404_response_is_not_retried_on_the_legacy_path():
    """A 500 means the server answered and is unwell; asking a second time on a
    different path is noise, not resilience."""

    class _Failing(_A2AHandler):
        def do_GET(self):  # noqa: N802
            self.__class__.card_paths_requested.append(self.path)
            self._respond(500, {"error": "boom"})

    _Failing.card_paths_requested = []
    server = HTTPServer(("127.0.0.1", 0), _Failing)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        tool = await create_remote_agent_tool(a2a_url=f"http://127.0.0.1:{server.server_port}/")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert _Failing.card_paths_requested == ["/.well-known/agent-card.json"]
    assert tool.description.startswith("Remote agent at ")


# -- card resolution is cached and concurrent (P2) -----------------------------


@pytest.mark.asyncio
async def test_a_resolved_card_is_not_fetched_again():
    """Runtimes are rebuilt whenever the 600s idle TTL expires or config changes.
    Refetching every card on every rebuild is latency for data that rarely
    changes."""
    with _a2a_server() as url:
        first = await create_remote_agent_tool(a2a_url=url)
        after_first = list(_A2AHandler.card_paths_requested)
        second = await create_remote_agent_tool(a2a_url=url)

    assert first.description == second.description
    assert _A2AHandler.card_paths_requested == after_first, "second build refetched the card"


@pytest.mark.asyncio
async def test_a_failed_card_is_retried_on_the_next_build():
    """The opposite of caching successes: an agent that was still starting up
    must not be written off with a generic description for the life of the
    process. Not caching the failure is what lets it self-heal."""
    with _a2a_server(card=None) as url:
        degraded = await create_remote_agent_tool(a2a_url=url)
        assert degraded.description.startswith("Remote agent at ")
        # Same URL, but the agent has finished starting up now.
        _A2AHandler.card = AGENT_CARD
        _A2AHandler.card_paths_requested = []
        recovered = await create_remote_agent_tool(a2a_url=url)

    assert recovered.description == "Runs network diagnostics."
    assert _A2AHandler.card_paths_requested, "a failure was cached, so no retry happened"


@pytest.mark.asyncio
async def test_cards_for_several_agents_resolve_concurrently():
    """Card resolution must be safe to run in parallel.

    Scope: this covers the primitive, not the caller. `_build_remote_agent_tools`
    is where the serial `await` in a list comprehension lived, and it cannot be
    imported here because `agent_runtime` pulls in `cnoe_agent_utils`, which is
    neither vendored nor on PyPI. That wiring is verified by reading the diff and
    by the project's own suite, not by this test.
    """
    from dynamic_agents.services import remote_agent_tool as rat

    delay = 0.3
    calls = 0

    async def _slow_fetch(a2a_url: str):
        nonlocal calls
        calls += 1
        await asyncio.sleep(delay)
        return {"name": f"agent {calls}", "description": "slow but real"}

    original = rat._fetch_agent_card
    rat._fetch_agent_card = _slow_fetch
    try:
        urls = [f"http://agent-{i}:8000/" for i in range(5)]
        started = time.monotonic()
        tools = await asyncio.gather(*(create_remote_agent_tool(a2a_url=u) for u in urls))
        elapsed = time.monotonic() - started
    finally:
        rat._fetch_agent_card = original

    assert len(tools) == 5
    assert calls == 5
    # Serially this would be 5 * 0.3 = 1.5s. Allow generous headroom for CI.
    assert elapsed < delay * 3, f"resolution looks serial: {elapsed:.2f}s for 5 agents"
