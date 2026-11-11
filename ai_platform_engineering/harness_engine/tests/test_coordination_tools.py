from __future__ import annotations

import json

import httpx2 as httpx
import pytest

from harness_engine.claude_tools import ClaudeToolBroker
from harness_engine.config import Settings
from harness_engine.coordination_tools import coordination_tools
from harness_engine.models import CreateRunRequest
from tests.test_claude_workers import context


async def test_coordination_is_absent_without_server_admission_hint() -> None:
    def forbidden(request: httpx.Request) -> httpx.Response:
        pytest.fail("Non-coordinated runs must not contact the coordination service")

    assert await coordination_tools(context(), "http://broker.example.test", httpx.MockTransport(forbidden)) == []


async def test_handoff_is_available_without_external_mcp_grants(settings: Settings) -> None:
    calls = []

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/harness-engine/runs/run-example/coordination"
        assert request.headers["authorization"] == "Bearer caller-test-token"
        body = json.loads(request.content)
        calls.append(body)
        if body["operation"] == "list":
            return httpx.Response(200, json={"data": {"tools": [{"tool_id": "handoff_to_agent", "description": "Assign to @helper", "input_schema": {"type": "object"}}]}})
        return httpx.Response(200, json={"data": {"content": [{"type": "text", "text": "queued"}]}})

    run = context()
    run.turn.coordination_enabled = True
    run.blueprint.tools.bindings = []
    broker = ClaudeToolBroker(settings.model_copy(update={"claude_tool_broker_url": "http://broker.example.test"}), httpx.MockTransport(respond))
    async with broker.bind_tools(run) as (tools, names):
        assert names == {"mcp__caipe__handoff_to_agent": "handoff_to_agent"}
        result = await tools[0].handler({"handle": "helper", "message": "Read the sample"})
        assert result["content"][0]["text"] == "queued"
    assert len(calls) == 2


async def test_revoked_coordination_fails_closed() -> None:
    run = context()
    run.turn.coordination_enabled = True
    with pytest.raises(httpx.HTTPStatusError):
        await coordination_tools(run, "http://broker.example.test", httpx.MockTransport(lambda _: httpx.Response(403)))


def test_default_hint_preserves_existing_request_fingerprints() -> None:
    request = CreateRunRequest(agent_id="example-agent", conversation_id="example-chat", message="hello")
    assert "coordination_enabled" not in request.model_dump()
    request.coordination_enabled = True
    assert request.model_dump()["coordination_enabled"] is True
