from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import signal
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any

import httpx2 as httpx
import pytest
from pydantic import SecretStr, ValidationError
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from harness_engine.adapters.base import ExecutionRejectedError, ExecutionUnconfirmedError
from harness_engine.adapters.claude_acp import ACPEventClient, ClaudeACPAdapter
from harness_engine.adapters.claude_remote import RemoteClaudeSDKAdapter
from harness_engine.claude_acp_tools import ClaudeACPToolBridge
from harness_engine.claude_sandbox import MAX_BODY, SandboxTransport, managed_sandbox_process
from harness_engine.claude_tools import ClaudeToolBroker
from harness_engine.claude_worker import create_worker_app
from harness_engine.config import SandboxConnection, Settings
from harness_engine.main import create_app
from harness_engine.models import AgentBlueprint, CanonicalEventDraft, RunRecord
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import InMemoryRunRepository
from harness_engine.sessions import AgentSessionNotRunnableError, CAIPEAgentSessionManager
from tests.conftest import auth_headers, blueprint
from tests.test_claude_workers import context


def policy(root: Path) -> dict[str, Any]:
    return {
        "instance_id": "sandbox-example", "display_name": "Private coding environment",
        "owner_subject": "test-user", "portal_url": "https://portal.example.test/sandboxes/example",
        "policy_revision": "revision-example", "policy_summary": "Private workspace; approved destinations",
        "workspace_root": str(root),
    }


def connection(url: str, root: Path) -> SandboxConnection:
    return SandboxConnection(**policy(root), url=url, token="test-sandbox-service-token-long-enough")


def configured_parent(settings: Settings, root: Path, **changes: Any) -> Settings:
    remote = {
        "url": "https://worker.example.test", "token": "test-worker-service-token",
        "profile_id": "safe", "runtime": "claude_code_acp", "tools_enabled": True,
        "sandbox": {**policy(root), **changes},
    }
    return settings.model_copy(update={
        "claude_worker_profiles_json": SecretStr(json.dumps({"primary": remote})),
        "sandbox_portal_url": "https://portal.example.test/",
    })


def ready(opened: dict[str, Any], root: Path, **changes: Any) -> dict[str, Any]:
    cwd = root / hashlib.sha256(opened["binding_id"].encode()).hexdigest()
    return {
        **opened, "type": "ready", "process_id": "process-example-token-123456",
        "workspace": str(root), "cwd": str(cwd), "config_dir": str(cwd / ".claude"),
        "mcp_url": "http://127.0.0.1:12345/mcp", **changes,
    }


async def exit_frame(websocket: ServerConnection, opened: dict[str, Any], **changes: Any) -> None:
    await websocket.send(json.dumps({
        "type": "exit", "run_id": opened["run_id"], "process_id": "process-example-token-123456",
        "returncode": 0, "drained": True, **changes,
    }))


@asynccontextmanager
async def peer(handler: Any) -> AsyncIterator[str]:
    async with serve(handler, "127.0.0.1", 0, max_size=1024 * 1024) as server:
        yield f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/api/acp/connections/primary/stdio"


@pytest.mark.parametrize("url", ["ws://remote.example.test/acp", "wss://user:secret@example.test/acp", "wss://example.test/acp?token=secret"])
def test_sandbox_connections_require_private_admitted_tls_urls(tmp_path: Path, url: str) -> None:
    with pytest.raises(ValidationError):
        connection(url, tmp_path)


async def test_personal_catalog_save_admission_and_pinned_management_snapshot(settings: Settings, tmp_path: Path) -> None:
    configured = configured_parent(settings, tmp_path)
    adapter = RemoteClaudeSDKAdapter(configured, claude_acp=True)
    repository = InMemoryRunRepository()
    app = create_app(settings=configured, repository=repository, adapters=[adapter])
    draft = blueprint(harness_id="claude_code_acp", profile_id="primary")
    draft["workspace"] = {"persistence": "thread"}
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://engine.example.test") as client:
            own = (await client.get("/api/v1/harnesses", headers=auth_headers())).json()["data"]["harnesses"][0]
            assert own["profiles"][0]["sandbox"]["instance_id"] == "sandbox-example"
            assert own["ui_schema"]["sandbox_portal_url"] == "https://portal.example.test/"
            assert "test-user" not in json.dumps(own)
            assert "worker.example.test" not in json.dumps(own)
            other = (await client.get("/api/v1/harnesses", headers=auth_headers("other-user"))).json()["data"]["harnesses"][0]
            assert other["profiles"] == []
            assert other["availability"] == "misconfigured"
            denied = await client.put("/api/v1/agents/agent-example", headers=auth_headers("other-user"), json={"blueprint": draft})
            assert denied.status_code == 422
            assert (await client.put("/api/v1/agents/agent-example", headers=auth_headers(), json={"blueprint": draft})).status_code == 200
            binding, _ = await app.state.session_manager.resolve("test-user", "agent-example", "conversation-example")
            assert binding.sandbox.portal_url == policy(tmp_path)["portal_url"]
            snapshot = await client.post("/api/v1/sessions/lookup", headers=auth_headers(), json={"agent_id": "agent-example", "conversation_id": "conversation-example"})
            assert snapshot.json()["data"]["sandbox"]["policy_revision"] == "revision-example"
            clear = await client.post("/api/v1/sessions/clear", headers=auth_headers(), json={"agent_id": "agent-example", "conversation_id": "conversation-example"})
            assert clear.status_code == 409 and "Reset is unavailable" in clear.text
            assert (await repository.get_session(binding.binding_id)).status == "active"
            await repository.admit_run(RunRecord(
                run_id="run-example", owner_subject="test-user", agent_id="agent-example", agent_version=1,
                conversation_id="conversation-example", binding_id=binding.binding_id,
                harness_id="claude_code_acp", profile_id="primary",
            ))
            await repository.release_run(binding.binding_id, "run-example")
            read_headers = {**auth_headers(), "x-harness-read-agent": "agent-example", "x-harness-read-conversation": "conversation-example"}
            owner_read = await client.post("/api/v1/sessions/lookup", headers=read_headers, json={"agent_id": "agent-example", "conversation_id": "conversation-example"})
            assert owner_read.json()["data"]["sandbox"]["instance_id"] == "sandbox-example"
            shared = await client.post("/api/v1/sessions/lookup", headers={**auth_headers("other-user"), "x-harness-read-agent": "agent-example", "x-harness-read-conversation": "conversation-example"}, json={"agent_id": "agent-example", "conversation_id": "conversation-example"})
            assert "sandbox" not in shared.json()["data"]


async def test_retained_target_rejects_profile_repoint_and_other_owner_before_dispatch(settings: Settings, tmp_path: Path) -> None:
    adapter = RemoteClaudeSDKAdapter(configured_parent(settings, tmp_path), claude_acp=True)
    registry = HarnessRegistry([adapter])
    repository = InMemoryRunRepository()
    draft = AgentBlueprint.model_validate(blueprint(harness_id="claude_code_acp", profile_id="primary"))
    validated = registry.validate(draft, owner_subject="test-user")
    await repository.save_agent(draft, validated.config_fingerprint, registry.catalog_revision, None)
    sessions = CAIPEAgentSessionManager(repository, registry, b"test-session-key")
    binding, _ = await sessions.resolve("test-user", draft.id, "conversation-example")
    assert binding.execution_target and binding.sandbox.instance_id == "sandbox-example"
    adapter._profiles["primary"].token = SecretStr("rotated-worker-service-token")
    assert (await sessions.resolve("test-user", draft.id, "conversation-example"))[0].binding_id == binding.binding_id
    with pytest.raises(AgentSessionNotRunnableError):
        await sessions.resolve("other-user", draft.id, "conversation-other")
    adapter._profiles["primary"].sandbox.instance_id = "replacement-sandbox"
    with pytest.raises(AgentSessionNotRunnableError):
        await sessions.resolve("test-user", draft.id, "conversation-example")
    assert (await repository.get_session(binding.binding_id)).sandbox.instance_id == "sandbox-example"


async def test_real_websocket_acp_new_load_and_remote_paths_preserve_session(settings: Settings, tmp_path: Path) -> None:
    requests: list[dict[str, Any]] = []
    subprocesses = []

    async def handler(websocket: ServerConnection) -> None:
        assert websocket.request.headers["Authorization"] == "Bearer test-sandbox-service-token-long-enough"
        assert websocket.request.headers["X-Harness-Engine-Subject"] == "test-user"
        opened = json.loads(await websocket.recv())
        requests.append(opened)
        state = ready(opened, tmp_path)
        cwd = Path(state["cwd"])
        cwd.mkdir(parents=True, exist_ok=True)
        process = await asyncio.create_subprocess_exec(
            sys.executable, str(Path(__file__).parent / "fixtures/acp_agent.py"),
            cwd=cwd, env={"PATH": os.environ["PATH"], "CLAUDE_CONFIG_DIR": state["config_dir"]},
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
        )
        subprocesses.append(process)
        await websocket.send(json.dumps(state))

        async def output() -> None:
            while data := await process.stdout.readline():
                # Split across frames to exercise byte rather than message boundaries.
                for chunk in [data[:5], data[5:]]:
                    await websocket.send(json.dumps({"type": "stdout", "data": base64.b64encode(chunk).decode()}))

        output_task = asyncio.create_task(output())
        try:
            async for raw in websocket:
                frame = json.loads(raw)
                if frame["type"] == "stdin":
                    process.stdin.write(base64.b64decode(frame["data"]))
                    await process.stdin.drain()
                elif frame["type"] == "cancel":
                    break
        finally:
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            await process.wait()
            with suppress(ConnectionClosed):
                await output_task
                await exit_frame(websocket, opened)

    async with peer(handler) as url:
        remote = connection(url, tmp_path)
        configured = settings.model_copy(update={"claude_sdk_profiles_json": json.dumps({"safe": {"model": "claude-example", "cwd": str(tmp_path / "never-created-local"), "sandbox": remote.model_dump(mode="json", exclude={"token"}) | {"token": remote.token.get_secret_value()}}})})
        ctx = context()
        ctx.blueprint.tools.bindings = []
        first = [event async for event in ClaudeACPAdapter(configured).execute(ctx)]
        assert first[0].data["provider_session_id"] == "session-example"
        ctx.binding.provider_session_id = "session-example"
        second = [event async for event in ClaudeACPAdapter(configured).execute(ctx)]
        assert [event.data["text"] for event in second if isinstance(event, CanonicalEventDraft)] == ["new response"]
        assert not (tmp_path / "never-created-local").exists()
    assert len(requests) == 2
    assert all(process.returncode is not None for process in subprocesses)
    assert "caller-test-token" not in json.dumps(requests)
    assert "test-internal-token-value" not in json.dumps(requests)
    cwd = tmp_path / hashlib.sha256(ctx.binding.binding_id.encode()).hexdigest()
    recorded = json.loads((cwd / "session.json").read_text())
    assert recorded["cwd"] == str(cwd)
    assert recorded["_meta"]["systemPrompt"] == ctx.prompt.system


@pytest.mark.parametrize("fault", ["eof", "wrong_run", "wrong_process", "unconfirmed"])
async def test_missing_or_wrong_remote_drain_never_becomes_success(tmp_path: Path, fault: str) -> None:
    async def handler(websocket: ServerConnection) -> None:
        opened = json.loads(await websocket.recv())
        await websocket.send(json.dumps(ready(opened, tmp_path)))
        if fault == "eof":
            return
        await websocket.recv()
        changes = {"run_id": "other-run"} if fault == "wrong_run" else {"process_id": "other-process-token"} if fault == "wrong_process" else {"drained": False}
        await exit_frame(websocket, opened, **changes)

    async with peer(handler) as url:
        with pytest.raises(ExecutionUnconfirmedError):
            async with managed_sandbox_process(ACPEventClient(), connection(url, tmp_path), context(), bridge=None, mcp_servers=[]):
                pass


async def test_misbinding_is_denied_before_any_acp_message(tmp_path: Path) -> None:
    frames = []

    async def handler(websocket: ServerConnection) -> None:
        opened = json.loads(await websocket.recv())
        await websocket.send(json.dumps(ready(opened, tmp_path, cwd=str(tmp_path / "other-binding"))))
        frames.append(json.loads(await websocket.recv()))

    async with peer(handler) as url:
        with pytest.raises(ExecutionUnconfirmedError):
            async with managed_sandbox_process(ACPEventClient(), connection(url, tmp_path), context(), bridge=None, mcp_servers=[]):
                pytest.fail("A mismatched workspace must not expose an ACP connection")
    assert frames == [{"type": "cancel"}]


async def test_explicit_authenticated_prelaunch_rejection_is_actionable(tmp_path: Path) -> None:
    async def handler(websocket: ServerConnection) -> None:
        opened = json.loads(await websocket.recv())
        await websocket.send(json.dumps({**opened, "type": "error", "code": "sandbox_bound", "admitted": False}))

    async with peer(handler) as url:
        with pytest.raises(ExecutionRejectedError, match="another conversation"):
            async with managed_sandbox_process(ACPEventClient(), connection(url, tmp_path), context(), bridge=None, mcp_servers=[]):
                pytest.fail("Rejected admission cannot expose a connection")


async def test_real_mcp_request_uses_current_run_capability_and_never_forwards_identity(settings: Settings, tmp_path: Path) -> None:
    calls = []

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer caller-test-token"
        body = json.loads(request.content)
        calls.append(body)
        if body["operation"] == "list":
            return httpx.Response(200, json={"success": True, "data": {"tools": [{"tool_id": "example.lookup", "input_schema": {"type": "object"}}]}})
        return httpx.Response(200, json={"success": True, "data": {"content": [{"type": "text", "text": "authorized result"}]}})

    broker = ClaudeToolBroker(settings.model_copy(update={"claude_tool_broker_url": "https://broker.example.test"}), httpx.MockTransport(respond))
    bridge = ClaudeACPToolBridge(8010)
    ctx = context()
    received = []
    async with bridge.bind(ctx, broker) as (servers, _):
        headers = {"Authorization": servers[0].headers[0].value, "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}

        async def handler(websocket: ServerConnection) -> None:
            opened = json.loads(await websocket.recv())
            await websocket.send(json.dumps(ready(opened, tmp_path)))
            for index, rpc in enumerate([
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "example", "version": "1"}}},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "tool_0", "arguments": {}}},
            ]):
                await websocket.send(json.dumps({"type": "mcp_request", "id": f"request-{index}", "method": "POST", "headers": headers, "body": base64.b64encode(json.dumps(rpc).encode()).decode()}))
                result = json.loads(await websocket.recv())
                received.append(result)
            await websocket.recv()
            await exit_frame(websocket, opened)

        async with peer(handler) as url:
            async with managed_sandbox_process(ACPEventClient(), connection(url, tmp_path), ctx, bridge=bridge, mcp_servers=servers) as process:
                assert process.mcp_servers[0].url == "http://127.0.0.1:12345/mcp"
                assert "caller-test-token" not in process.mcp_servers[0].model_dump_json()
                for _ in range(100):
                    if len(received) == 2:
                        break
                    await asyncio.sleep(0.01)
                assert len(received) == 2
    answer = json.loads(base64.b64decode(received[1]["body"]))
    assert answer["result"]["content"][0]["text"] == "authorized result"
    assert len([call for call in calls if call["operation"] == "call"]) == 1
    assert "caller-test-token" not in json.dumps(received)
    assert (await bridge.forward(ctx.turn.run_id, headers, b"{}", max_body=MAX_BODY))[0] == 401


async def test_remote_worker_requires_no_local_agent_executable(settings: Settings, tmp_path: Path) -> None:
    remote = connection("wss://portal.example.test/api/acp/connections/primary/stdio", tmp_path)
    configured = settings.model_copy(update={"claude_sdk_profiles_json": json.dumps({"safe": {"model": "claude-example", "sandbox": {**remote.model_dump(mode="json", exclude={"token"}), "token": remote.token.get_secret_value()}}})})
    worker = create_worker_app(settings=configured, repository=InMemoryRunRepository())
    async with worker.router.lifespan_context(worker):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=worker), base_url="https://worker.example.test") as client:
            result = await client.post("/acp", headers=auth_headers(), json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1}})
            assert result.json()["result"]["_meta"]["caipe.io/harness"]["runtime"] == "claude_code_acp"
            assert result.json()["result"]["_meta"]["caipe.io/harness"]["sandboxTransportVersion"] == 1


async def test_ordinary_remote_profiles_preserve_older_strict_worker_context(settings: Settings) -> None:
    calls = []
    configured = settings.model_copy(update={"claude_worker_profiles_json": SecretStr(json.dumps({"primary": {
        "url": "https://worker.example.test", "token": "test-worker-service-token", "profile_id": "safe",
    }}))})
    ctx = context()
    ctx.blueprint.tools.bindings = []
    ctx.blueprint.harness.profile_id = ctx.binding.profile_id = "primary"

    def respond(request: httpx.Request) -> httpx.Response:
        rpc = json.loads(request.content)
        calls.append(rpc["method"])
        if rpc["method"] == "initialize":
            result = {"protocolVersion": 1, "agentCapabilities": {}, "_meta": {"caipe.io/harness": {"runtime": "sdk", "durableReplay": True}}}
        elif rpc["method"] == "session/new":
            binding = rpc["params"]["_meta"]["caipe.io/harness"]["context"]["binding"]
            assert "sandbox" not in binding and "execution_target" not in binding
            result = {"sessionId": ctx.binding.binding_id}
        else:
            assert rpc["method"] == "session/prompt"
            result = {"stopReason": "end_turn", "_meta": {"caipe.io/harness": {"run": {"run_id": ctx.turn.run_id, "last_sequence": 0, "status": "completed"}, "drained": True}}}
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": rpc["id"], "result": result})

    result = [event async for event in RemoteClaudeSDKAdapter(configured, httpx.MockTransport(respond)).execute(ctx)]
    assert result[-1].status == "completed"
    assert calls == ["initialize", "session/new", "session/prompt"]


async def test_sandbox_profiles_reject_older_worker_before_session_admission(settings: Settings, tmp_path: Path) -> None:
    calls = []

    def respond(request: httpx.Request) -> httpx.Response:
        rpc = json.loads(request.content)
        calls.append(rpc["method"])
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": rpc["id"], "result": {"protocolVersion": 1, "agentCapabilities": {}, "_meta": {"caipe.io/harness": {"runtime": "claude_code_acp", "durableReplay": True}}}})

    ctx = context()
    ctx.blueprint.tools.bindings = []
    ctx.blueprint.harness.profile_id = ctx.binding.profile_id = "primary"
    with pytest.raises(ValueError, match="sandbox data plane"):
        async for _ in RemoteClaudeSDKAdapter(configured_parent(settings, tmp_path), httpx.MockTransport(respond), claude_acp=True).execute(ctx):
            pass
    assert calls == ["initialize"]


async def test_second_cancel_during_remote_teardown_never_confirms_stop(tmp_path: Path) -> None:
    entered = asyncio.Event()
    cancellation_received = asyncio.Event()

    async def handler(websocket: ServerConnection) -> None:
        opened = json.loads(await websocket.recv())
        await websocket.send(json.dumps(ready(opened, tmp_path)))
        async for message in websocket:
            if json.loads(message)["type"] == "cancel":
                cancellation_received.set()

    async with peer(handler) as url:
        async def turn() -> None:
            async with managed_sandbox_process(ACPEventClient(), connection(url, tmp_path), context(), bridge=None, mcp_servers=[]):
                entered.set()
                await asyncio.Future()

        task = asyncio.create_task(turn())
        await asyncio.wait_for(entered.wait(), 2)
        task.cancel()
        await asyncio.wait_for(cancellation_received.wait(), 2)
        task.cancel()
        with pytest.raises(ExecutionUnconfirmedError):
            await asyncio.wait_for(task, 2)


async def test_confirmed_remote_cancel_preserves_normal_stopped_outcome(settings: Settings, tmp_path: Path) -> None:
    prompting = asyncio.Event()
    control_cancelled = asyncio.Event()

    async def handler(websocket: ServerConnection) -> None:
        opened = json.loads(await websocket.recv())
        await websocket.send(json.dumps(ready(opened, tmp_path)))
        prompt_id = None
        async for raw in websocket:
            frame = json.loads(raw)
            if frame["type"] == "cancel":
                control_cancelled.set()
                await exit_frame(websocket, opened)
                return
            rpc = json.loads(base64.b64decode(frame["data"]))
            method = rpc["method"]
            if method == "session/prompt":
                prompt_id = rpc["id"]
                prompting.set()
                continue
            if method == "session/cancel":
                response = {"jsonrpc": "2.0", "id": prompt_id, "result": {"stopReason": "cancelled"}}
            else:
                result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}, "authMethods": []} if method == "initialize" else {"sessionId": "session-example"}
                response = {"jsonrpc": "2.0", "id": rpc["id"], "result": result}
            await websocket.send(json.dumps({"type": "stdout", "data": base64.b64encode((json.dumps(response) + "\n").encode()).decode()}))

    async with peer(handler) as url:
        remote = connection(url, tmp_path)
        configured = settings.model_copy(update={"claude_sdk_profiles_json": json.dumps({"safe": {"model": "claude-example", "sandbox": {**remote.model_dump(mode="json", exclude={"token"}), "token": remote.token.get_secret_value()}}})})
        adapter = ClaudeACPAdapter(configured)
        ctx = context()
        ctx.blueprint.tools.bindings = []

        async def consume() -> None:
            async for _ in adapter.execute(ctx):
                pass

        task = asyncio.create_task(consume())
        await asyncio.wait_for(prompting.wait(), 2)
        assert await adapter.cancel_run(ctx.turn.run_id)
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        assert control_cancelled.is_set()
        assert adapter._remote_drained == set()


async def test_worker_rejects_changed_parent_sandbox_before_process_admission(settings: Settings, tmp_path: Path) -> None:
    remote = connection("wss://portal.example.test/api/acp/connections/primary/stdio", tmp_path)
    configured = settings.model_copy(update={"claude_sdk_profiles_json": json.dumps({"safe": {"model": "claude-example", "sandbox": {**remote.model_dump(mode="json", exclude={"token"}), "token": remote.token.get_secret_value()}}})})
    repository = InMemoryRunRepository()
    worker = create_worker_app(settings=configured, repository=repository)
    ctx = context()
    ctx.blueprint.tools.bindings = []
    ctx.binding.sandbox = remote.public().model_copy(update={"instance_id": "changed-instance"})
    async with worker.router.lifespan_context(worker):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=worker), base_url="https://worker.example.test") as client:
            result = await client.post("/acp", headers={**auth_headers(), "ACP-Protocol-Version": "1"}, json={"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": {"cwd": "/workspace", "mcpServers": [], "_meta": {"caipe.io/harness": {"context": ctx.model_dump(mode="json")}}}})
            assert result.status_code == 409
            assert await repository.get_run(ctx.turn.run_id) is None


async def test_lost_sandbox_transport_retains_worker_reservation_and_does_not_redispatch(settings: Settings, tmp_path: Path) -> None:
    opened_count = 0

    async def handler(websocket: ServerConnection) -> None:
        nonlocal opened_count
        opened = json.loads(await websocket.recv())
        opened_count += 1
        await websocket.send(json.dumps(ready(opened, tmp_path)))
        await websocket.recv()
        # The peer may have started a native process. Deliberately lose the
        # transport without any process-tree drain receipt.

    async with peer(handler) as url:
        remote = connection(url, tmp_path)
        configured = settings.model_copy(update={"claude_sdk_profiles_json": json.dumps({"safe": {"model": "claude-example", "sandbox": {**remote.model_dump(mode="json", exclude={"token"}), "token": remote.token.get_secret_value()}}})})
        repository = InMemoryRunRepository()
        worker = create_worker_app(settings=configured, repository=repository)
        ctx = context()
        ctx.blueprint.tools.bindings = []
        ctx.binding.sandbox = remote.public()
        metadata = {"caipe.io/harness": {"context": ctx.model_dump(mode="json")}}
        async with worker.router.lifespan_context(worker):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=worker), base_url="https://worker.example.test", headers={**auth_headers(), "ACP-Protocol-Version": "1"}) as client:
                setup = {"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": {"cwd": "/workspace", "mcpServers": [], "_meta": metadata}}
                assert (await client.post("/acp", json=setup)).status_code == 200
                prompt = {"jsonrpc": "2.0", "id": ctx.turn.run_id, "method": "session/prompt", "params": {"sessionId": ctx.binding.binding_id, "prompt": [{"type": "text", "text": ctx.turn.message}], "_meta": metadata}}
                for _ in range(2):
                    response = await asyncio.wait_for(client.post("/acp", json=prompt), 3)
                    assert "execution_unconfirmed" in response.text
                assert opened_count == 1
                binding = await repository.get_session(ctx.binding.binding_id)
                assert binding.active_run.run_id == ctx.turn.run_id


async def test_full_receive_queue_still_exposes_eof_after_remote_exit() -> None:
    class ClosedPeer:
        def __aiter__(self) -> ClosedPeer:
            return self

        async def __anext__(self) -> str:
            raise StopAsyncIteration

    transport = SandboxTransport(ClosedPeer(), context(), {"process_id": "process-example"}, None)
    for index in range(64):
        transport.inbox.put_nowait({"jsonrpc": "2.0", "id": index, "result": {}})
    await transport.pump()
    assert [message["id"] for message in [await transport.receive() for _ in range(64)]] == list(range(64))
    assert await asyncio.wait_for(transport.receive(), 0.1) is None


async def test_sandbox_tool_frames_cannot_target_other_credentials_or_dispatch_after_stop() -> None:
    class Peer:
        def __init__(self) -> None:
            self.frames = []

        async def send(self, value: str) -> None:
            self.frames.append(json.loads(value))

    class Bridge:
        def __init__(self) -> None:
            self.calls = 0

        async def forward(self, *args: Any, **kwargs: Any) -> Any:
            self.calls += 1
            return 200, {}, b"{}"

    peer = Peer()
    bridge = Bridge()
    transport = SandboxTransport(peer, context(), {"process_id": "process-example"}, bridge)
    frame = {"type": "mcp_request", "id": "request-example", "method": "POST", "headers": {"X-Harness-Caller-Token": "foreign-token"}, "body": base64.b64encode(b"{}").decode()}
    with pytest.raises(ValueError, match="headers"):
        await transport.tool_request(frame)
    frame["headers"] = {"Authorization": "Bearer run-capability"}
    transport.cancelled = True
    await transport.tool_request(frame)
    assert bridge.calls == 0
    assert peer.frames[-1]["status"] == 409
    with pytest.raises(ValueError, match="duplicate"):
        await transport.tool_request(frame)
