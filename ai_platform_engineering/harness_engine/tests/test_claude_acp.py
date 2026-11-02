from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx2 as httpx
import pytest
from acp.schema import InitializeResponse, PromptResponse, SessionNotification
from claude_agent_sdk import AssistantMessage, TextBlock

from harness_engine.acp_events import EXTENSION
from harness_engine.adapters.base import ExecutionUnconfirmedError
from harness_engine.adapters.claude_acp import ACPEventClient, ClaudeACPAdapter
from harness_engine.adapters.claude_remote import RemoteClaudeSDKAdapter
from harness_engine.adapters.claude_sdk import ClaudeSDKAdapter
from harness_engine.claude_worker import create_worker_app
from harness_engine.config import Settings
from harness_engine.models import CanonicalEventDraft, RunContext
from harness_engine.repository import InMemoryRunRepository
from tests.conftest import auth_headers
from tests.test_claude_workers import configured_worker, context, result, rpc_response


def process_adapter(settings: Settings) -> ClaudeACPAdapter:
    return ClaudeACPAdapter(
        settings.model_copy(
            update={
                "claude_acp_command": [sys.executable, str(Path(__file__).parent / "fixtures" / "acp_agent.py")],
            }
        )
    )


async def test_process_session_reload_ignores_history_and_preserves_policy(settings: Settings) -> None:
    ctx = context()
    ctx.blueprint.tools.bindings = []
    first = [event async for event in process_adapter(settings).execute(ctx)]
    assert first[0].data == {"provider_session_id": "session-example"}
    assert first[-1].result == {"content": "new response"}
    ctx.binding.provider_session_id = "session-example"
    second = [event async for event in process_adapter(settings).execute(ctx)]
    assert [event.data["text"] for event in second if isinstance(event, CanonicalEventDraft)] == ["new response"]
    directory = hashlib.sha256(ctx.binding.binding_id.encode()).hexdigest()
    policy = json.loads((Path(settings.claude_sdk_profiles()["safe"].cwd) / directory / "session.json").read_text())
    assert policy["mcpServers"] == []
    options = policy["_meta"]["claudeCode"]["options"]
    assert options["tools"] == []
    assert options["settingSources"] == []
    assert options["allowDangerouslySkipPermissions"] is False
    assert "caller-test-token" not in json.dumps(policy)
    limits = json.loads((Path(settings.claude_sdk_profiles()["safe"].cwd) / directory / "tool-limits.json").read_text())
    assert limits == {
        "MCP_TOOL_TIMEOUT": "900000",
        "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT": "900000",
        "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS": "0",
    }


async def test_process_cancellation_sends_acp_cancel_and_exits(settings: Settings) -> None:
    ctx = context()
    ctx.blueprint.tools.bindings = []
    ctx.turn.message = "wait"
    adapter = process_adapter(settings)
    entered = asyncio.Event()

    async def consume() -> None:
        async for event in adapter.execute(ctx):
            if isinstance(event, CanonicalEventDraft) and event.event_type == "session.updated":
                entered.set()

    task = asyncio.create_task(consume())
    await asyncio.wait_for(entered.wait(), 3)
    await asyncio.sleep(0.05)
    assert await adapter.cancel_run(ctx.turn.run_id)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 3)
    directory = hashlib.sha256(ctx.binding.binding_id.encode()).hexdigest()
    assert (Path(settings.claude_sdk_profiles()["safe"].cwd) / directory / "cancelled").exists()


async def test_process_permissions_are_denied_and_mcp_configuration_is_rejected(settings: Settings) -> None:
    reply = await ACPEventClient().request_permission()
    assert reply.outcome.outcome == "cancelled"
    assert process_adapter(settings).evaluate(context().blueprint).issues[-1].severity == "error"


async def test_network_worker_frames_validate_with_official_acp_schemas(settings: Settings) -> None:
    async def query(**_: Any) -> AsyncIterator[Any]:
        yield AssistantMessage(content=[TextBlock(text="hello")], model="example")
        yield result()

    ctx = context()
    ctx.blueprint.tools.bindings = []
    worker = create_worker_app(
        settings=settings, repository=InMemoryRunRepository(), adapter=ClaudeSDKAdapter(settings, query_fn=query)
    )
    headers = {**auth_headers(), "ACP-Protocol-Version": "1"}
    metadata = {EXTENSION: {"context": ctx.model_dump(mode="json")}}
    async with worker.router.lifespan_context(worker):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=worker), base_url="http://worker.example.test", headers=headers
        ) as client:
            init = await client.post(
                "/acp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1}}
            )
            assert InitializeResponse.model_validate(init.json()["result"]).protocol_version == 1
            setup = await client.post(
                "/acp",
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "session/new",
                    "params": {"cwd": "/workspace", "mcpServers": [], "_meta": metadata},
                },
            )
            assert setup.json()["result"]["sessionId"] == ctx.binding.binding_id
            params = {
                "sessionId": ctx.binding.binding_id,
                "prompt": [{"type": "text", "text": ctx.turn.message}],
                "_meta": metadata,
            }
            prompt = {"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": params}
            response = await client.post("/acp", json=prompt)
            frames = [json.loads(line) for line in response.text.splitlines() if line]
            for frame in frames:
                if frame.get("method") == "session/update":
                    SessionNotification.model_validate(frame["params"])
            assert PromptResponse.model_validate(frames[-1]["result"]).stop_reason == "end_turn"
            assert "caller-test-token" not in response.text
            denied = await client.post("/acp", json=prompt, headers={**headers, **auth_headers("other-user")})
            assert denied.status_code == 400
            params["sessionId"] = "other-session"
            assert (await client.post("/acp", json=prompt)).status_code == 400


@pytest.mark.parametrize("params", [{"_meta": None}, {"_meta": {EXTENSION: []}}, {"_meta": {}}])
async def test_worker_rejects_invalid_acp_context_without_dispatch(settings: Settings, params: dict[str, Any]) -> None:
    worker = create_worker_app(settings=settings, repository=InMemoryRunRepository())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=worker),
        base_url="http://worker.example.test",
        headers={**auth_headers(), "ACP-Protocol-Version": "1"},
    ) as client:
        response = await client.post(
            "/acp", json={"jsonrpc": "2.0", "id": 1, "method": "session/prompt", "params": params}
        )
        assert response.status_code == 400


class InterruptedFrames(httpx.AsyncByteStream):
    def __init__(self, content: bytes) -> None:
        self.content = content

    async def __aiter__(self) -> AsyncIterator[bytes]:
        # Deliver a committed prefix, then simulate a severed worker connection.
        yield self.content.splitlines(keepends=True)[0]
        raise httpx.ReadError("Connection lost after the first committed event")


async def test_network_reconnect_resumes_cursor_without_a_second_producer(settings: Settings) -> None:
    dispatches = 0
    cursors: list[int] = []

    async def query(**_: Any) -> AsyncIterator[Any]:
        nonlocal dispatches
        dispatches += 1
        yield AssistantMessage(content=[TextBlock(text="one answer")], model="example")
        yield result()

    repo = InMemoryRunRepository()
    worker = create_worker_app(
        settings=settings.model_copy(update={"internal_token": "test-worker-secret"}),
        repository=repo,
        adapter=ClaudeSDKAdapter(settings, query_fn=query),
    )
    upstream = httpx.ASGITransport(app=worker)

    class DisconnectTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            rpc = json.loads(request.content)
            response = await upstream.handle_async_request(request)
            if rpc["method"] == "session/prompt":
                cursors.append(rpc["params"]["_meta"][EXTENSION]["after"])
                if len(cursors) == 1:
                    return httpx.Response(200, stream=InterruptedFrames(await response.aread()))
            return response

    ctx = context()
    ctx.blueprint.tools.bindings = []
    ctx.binding.profile_id = "remote"
    ctx.binding.harness_id = "claude_agent_sdk_remote"
    async with worker.router.lifespan_context(worker):
        adapter = RemoteClaudeSDKAdapter(configured_worker(settings), DisconnectTransport())
        events = [event async for event in adapter.execute(ctx)]
    assert dispatches == 1
    assert cursors == [0, 1]
    assert [
        e.data["text"] for e in events if isinstance(e, CanonicalEventDraft) and e.event_type == "content.delta"
    ] == ["one answer"]
    assert events[-1].status == "completed"


async def test_denial_after_lost_admission_does_not_release_uncertain_execution(settings: Settings) -> None:
    attempts = 0

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        rpc = json.loads(request.content)
        if rpc["method"] == "initialize":
            return rpc_response(rpc, {"protocolVersion": 1, "_meta": {EXTENSION: {"durableReplay": True}}})
        if rpc["method"] == "session/new":
            return rpc_response(rpc, {"sessionId": "example"})
        if rpc["method"] == "session/prompt":
            attempts += 1
            if attempts == 1:
                raise httpx.ReadError("Admission may have reached a producer")
            return httpx.Response(403)
        raise httpx.ConnectError("Drain confirmation unavailable")

    ctx = context()
    ctx.blueprint.tools.bindings = []
    ctx.binding.profile_id = "remote"
    with pytest.raises(ExecutionUnconfirmedError):
        _ = [
            event
            async for event in RemoteClaudeSDKAdapter(
                configured_worker(settings), httpx.MockTransport(respond)
            ).execute(ctx)
        ]


async def test_network_worker_forwards_original_tool_identity(settings: Settings) -> None:
    received: list[str] = []

    class CapturingBroker:
        url = "http://broker.example.test"

        @asynccontextmanager
        async def bind(self, ctx: RunContext) -> AsyncIterator[tuple[dict[str, Any], dict[str, str]]]:
            assert ctx.identity is not None
            assert ctx.identity.subject == ctx.binding.owner_subject
            received.append(ctx.identity.bearer.get_secret_value())
            yield {}, {}

    async def query(**_: Any) -> AsyncIterator[Any]:
        yield result()

    worker = create_worker_app(
        settings=settings.model_copy(update={"internal_token": "test-worker-secret"}),
        repository=InMemoryRunRepository(),
        adapter=ClaudeSDKAdapter(settings, query_fn=query, tool_broker=CapturingBroker()),
    )
    ctx = context()
    ctx.binding.profile_id = "remote"
    async with worker.router.lifespan_context(worker):
        remote = RemoteClaudeSDKAdapter(configured_worker(settings), httpx.ASGITransport(app=worker))
        events = [event async for event in remote.execute(ctx)]
    assert received == ["caller-test-token"]
    assert events[-1].status == "completed"
    assert "caller-test-token" not in "".join(e.model_dump_json() for e in events)


async def test_completed_turn_drains_provider_children_before_releasing_its_session(settings: Settings) -> None:
    ctx = context()
    ctx.blueprint.tools.bindings = []
    ctx.turn.message = "spawn-child"
    events = [event async for event in process_adapter(settings).execute(ctx)]
    assert events[-1].status == "completed"
    directory = (
        Path(settings.claude_sdk_profiles()["safe"].cwd) / hashlib.sha256(ctx.binding.binding_id.encode()).hexdigest()
    )
    child_pid = int((directory / "child.pid").read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(child_pid, 0)
    await asyncio.sleep(0.7)
    assert not (directory / "orphan-write").exists()
