"""End-to-end A2A contract between Dynamic Agents and the netutils server."""

from __future__ import annotations

import socket
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
import uvicorn

from dynamic_agents.netutils_agent.server import create_app
from dynamic_agents.services.remote_agent_tool import create_remote_agent_tool


class _FakeNetutilsAgent:
    def __init__(self) -> None:
        self.messages: list[str] = []

    async def ainvoke(self, input: dict[str, object]) -> dict[str, object]:
        messages = input["messages"]
        assert isinstance(messages, list)
        content = str(messages[-1]["content"])
        self.messages.append(content)
        return {"messages": [SimpleNamespace(content=f"netutils result for {content}")]}


async def test_health_endpoint_needs_no_query_parameters() -> None:
    transport = httpx.ASGITransport(app=create_app(agent=_FakeNetutilsAgent()))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


@pytest.mark.asyncio
async def test_dynamic_agent_can_call_netutils_a2a_server() -> None:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    endpoint = f"http://127.0.0.1:{port}/"
    netutils_agent = _FakeNetutilsAgent()
    server = uvicorn.Server(
        uvicorn.Config(create_app(agent=netutils_agent, agent_url=endpoint), host="127.0.0.1", port=port, log_level="critical")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 5
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    if not server.started:
        server.should_exit = True
        thread.join(timeout=5)
        raise RuntimeError("Netutils A2A test server did not start")

    try:
        tool = await create_remote_agent_tool(
            a2a_url=endpoint,
            name="netutils_agent",
            description="Network utilities",
            timeout=10,
        )
        result = await tool.ainvoke({"message": "Resolve example.com"})
        assert result == "netutils result for Resolve example.com"
        assert netutils_agent.messages == ["Resolve example.com"]
    finally:
        server.should_exit = True
        thread.join(timeout=5)
