from __future__ import annotations

import json
from typing import Any

import httpx2 as httpx
from fastapi import FastAPI
from pydantic import SecretStr

from harness_engine.acp_events import canonical_update
from harness_engine.adapters.claude_remote import RemoteClaudeSDKAdapter
from harness_engine.claude_acp_tools import ClaudeACPToolBridge
from harness_engine.claude_tools import ClaudeToolBroker
from harness_engine.config import Settings
from tests.test_claude_workers import context


async def test_acp_mcp_capability_scope_revocation_and_caller_identity(settings: Settings) -> None:
    calls: list[dict[str, Any]] = []
    revoked = False

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer caller-test-token"
        body = json.loads(request.content)
        calls.append(body)
        if body["operation"] == "list":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "tools": [
                            {
                                "tool_id": "example.lookup",
                                "input_schema": {"type": "object"},
                                "description": "Look up an example",
                            }
                        ]
                    },
                },
            )
        return (
            httpx.Response(403)
            if revoked
            else httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {"content": [{"type": "text", "text": "authorized result"}]},
                },
            )
        )

    configured = settings.model_copy(update={"claude_tool_broker_url": "http://broker.example.test"})
    broker = ClaudeToolBroker(configured, httpx.MockTransport(respond))
    bridge = ClaudeACPToolBridge(8010)
    app = FastAPI()
    app.mount("/internal/claude-tools", bridge)
    async with bridge.bind(context(), broker) as (servers, names):
        assert names == ["mcp__caipe__tool_0"]
        server = servers[0]
        assert "caller-test-token" not in server.model_dump_json()
        assert configured.internal_token not in server.model_dump_json()
        headers = {"Authorization": server.headers[0].value, "Accept": "application/json, text/event-stream"}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
            initialized = await client.post(
                server.url,
                headers=headers,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "clientInfo": {"name": "example", "version": "1"},
                    },
                },
            )
            assert initialized.status_code == 200
            listed = await client.post(
                server.url, headers=headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
            )
            assert [tool["name"] for tool in listed.json()["result"]["tools"]] == ["tool_0"]
            request = {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "tool_0", "arguments": {}}}
            success = await client.post(server.url, headers=headers, json=request)
            assert success.json()["result"]["content"][0]["text"] == "authorized result"
            revoked = True
            denied = await client.post(server.url, headers=headers, json=request)
            assert denied.json()["result"]["isError"]
            assert len([call for call in calls if call["operation"] == "call"]) == 2
            request["params"]["name"] = "other_tool"
            rejected = await client.post(server.url, headers=headers, json=request)
            assert rejected.json()["result"]["isError"]
            assert len(calls) == 3
            assert (
                await client.post(server.url.replace("run-example", "run-other"), headers=headers, json=request)
            ).status_code == 401
            assert (await client.post(server.url, json=request)).status_code == 401
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("192.0.2.1", 1234))) as external:
            assert (await external.post(server.url, headers=headers, json=request)).status_code == 401
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
        assert (await client.post(server.url, headers=headers, json=request)).status_code == 401


def test_claude_catalog_filters_profiles_without_exposing_credentials(settings: Settings) -> None:
    configured = settings.model_copy(
        update={
            "claude_worker_profiles_json": SecretStr(
                json.dumps(
                    {
                        "primary": {
                            "url": "http://worker.example.test",
                            "token": "private-worker-token",
                            "profile_id": "safe",
                            "runtime": "claude_code_acp",
                            "tools_enabled": True,
                        },
                        "secondary": {
                            "url": "http://other.example.test",
                            "token": "other-worker-token",
                            "profile_id": "safe",
                        },
                    }
                )
            )
        }
    )
    descriptor = RemoteClaudeSDKAdapter(configured, claude_acp=True).descriptor
    assert descriptor.id == "claude_code_acp"
    assert descriptor.display_name == "Claude (ACP)"
    assert [profile.id for profile in descriptor.profiles] == ["primary"]
    assert descriptor.capabilities["tools.broker"].level == "emulated"
    assert descriptor.capabilities["session.cross_replica"].level == "unavailable"
    assert "private-worker-token" not in descriptor.model_dump_json()
    assert "worker.example.test" not in descriptor.model_dump_json()


def test_denied_acp_tool_uses_the_canonical_completion_error_contract() -> None:
    event = canonical_update(
        {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-example",
            "status": "failed",
            "rawOutput": "Access denied",
        }
    )
    assert event.event_type == "tool.completed"
    assert event.data["error"] == "Claude tool failed"
    assert event.data["result"] == "Access denied"
