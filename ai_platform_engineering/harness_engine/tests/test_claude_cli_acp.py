from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx2 as httpx
import pytest
from acp import RequestError
from acp.schema import HttpHeader, HttpMcpServer, TextContentBlock
from pydantic import SecretStr

from harness_engine.adapters.claude_acp import ClaudeACPAdapter
from harness_engine.adapters.claude_remote import RemoteClaudeSDKAdapter
from harness_engine.claude_cli_acp import ClaudeCodeCLIAgent
from harness_engine.config import Settings
from harness_engine.main import create_app
from harness_engine.models import CanonicalEventDraft
from harness_engine.repository import InMemoryRunRepository
from tests.conftest import auth_headers, blueprint
from tests.test_claude_workers import context

FIXTURE = Path(__file__).parent / "fixtures" / "claude_cli.py"


class Updates:
    def __init__(self) -> None:
        self.events: list[Any] = []

    async def session_update(self, session_id: str, update: Any) -> None:
        self.events.append(update)


def policy() -> dict[str, Any]:
    return {"systemPrompt": "Example instructions", "claudeCode": {"options": {
        "model": "example-model", "maxTurns": 5, "tools": [], "allowedTools": ["mcp__caipe__example_wait"],
        "settingSources": [], "allowDangerouslySkipPermissions": False,
    }}}


def servers() -> list[HttpMcpServer]:
    return [HttpMcpServer(type="http", name="caipe", url="http://127.0.0.1:8010/internal/claude-tools/run-example",
                          headers=[HttpHeader(name="Authorization", value="Bearer example-capability")])]


async def configured(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[ClaudeCodeCLIAgent, Updates, str]:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude"))
    agent = ClaudeCodeCLIAgent([sys.executable, str(FIXTURE)])
    client = Updates()
    agent.on_connect(client)
    session = await agent.new_session(str(tmp_path), servers(), **policy())
    return agent, client, session.session_id


async def test_cli_streams_once_and_keeps_capabilities_out_of_argv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    agent, client, session = await configured(tmp_path, monkeypatch)
    result = await agent.prompt(session, [TextContentBlock(type="text", text="hello")])
    assert result.stop_reason == "end_turn"
    assert [e.content.text for e in client.events if e.session_update == "agent_message_chunk"] == ["CLI answer"]
    assert [e.status for e in client.events if e.session_update.startswith("tool_call")] == ["in_progress", "completed"]
    recorded = json.loads((tmp_path / "cli-policy.json").read_text())
    args = recorded["arguments"]
    assert "--session-id" in args and "--resume" not in args
    assert "example-capability" not in json.dumps(args)
    assert recorded["mcp"]["mcpServers"]["caipe"]["headers"]["Authorization"] == "Bearer example-capability"
    assert args[args.index("--tools") + 1] == ""
    assert "--strict-mcp-config" in args and "--bare" not in args
    assert args[args.index("--setting-sources") + 1] == ""
    assert "--disable-slash-commands" in args
    assert "--dangerously-skip-permissions" not in args
    assert not list(tmp_path.glob(".caipe-cli-turn-*"))
    replacement = ClaudeCodeCLIAgent([sys.executable, str(FIXTURE)])
    replacement.on_connect(client)
    await replacement.load_session(str(tmp_path), session, servers(), **policy())
    await replacement.prompt(session, [TextContentBlock(type="text", text="follow-up")])
    resumed = json.loads((tmp_path / "cli-policy.json").read_text())["arguments"]
    assert "--resume" in resumed and resumed[resumed.index("--resume") + 1] == session


@pytest.mark.parametrize("first_turn", ["not-prompted", "cancel-before-prompt", "wait-before-native", "startup-failure"])
async def test_allocated_session_survives_early_stop_or_startup_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, first_turn: str,
) -> None:
    agent, client, session = await configured(tmp_path, monkeypatch)
    prompt = [TextContentBlock(type="text", text=first_turn)]
    if first_turn == "cancel-before-prompt":
        await agent.cancel(session)
        assert (await agent.prompt(session, prompt)).stop_reason == "cancelled"
    elif first_turn == "startup-failure":
        with pytest.raises(RequestError):
            await agent.prompt(session, prompt)
    elif first_turn == "wait-before-native":
        task = asyncio.create_task(agent.prompt(session, prompt))
        for _ in range(300):
            if (tmp_path / "cli-started").exists():
                break
            await asyncio.sleep(0.01)
        assert (tmp_path / "cli-started").exists()
        await agent.cancel(session)
        assert (await asyncio.wait_for(task, 3)).stop_reason == "cancelled"
        assert agent.process is None
    replacement = ClaudeCodeCLIAgent([sys.executable, str(FIXTURE)])
    replacement.on_connect(client)
    await replacement.load_session(str(tmp_path), session, servers(), **policy())
    assert (await replacement.prompt(session, [TextContentBlock(type="text", text="continue")])).stop_reason == "end_turn"
    args = json.loads((tmp_path / "cli-policy.json").read_text())["arguments"]
    assert "--resume" not in args and args[args.index("--session-id") + 1] == session
    assert (await replacement.prompt(session, [TextContentBlock(type="text", text="next")])).stop_reason == "end_turn"
    assert "--resume" in json.loads((tmp_path / "cli-policy.json").read_text())["arguments"]


async def test_native_transcript_survives_lost_start_acknowledgement(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _, client, session = await configured(tmp_path, monkeypatch)
    native = tmp_path / ".claude" / "projects" / "example" / f"{session}.jsonl"
    native.parent.mkdir(parents=True)
    native.write_text(json.dumps({"type": "user", "sessionId": session}) + "\n")
    replacement = ClaudeCodeCLIAgent([sys.executable, str(FIXTURE)])
    replacement.on_connect(client)
    await replacement.load_session(str(tmp_path), session, servers(), **policy())
    assert (tmp_path / f".caipe-cli-{session}").read_text().strip() == "claude-code-cli-acp-v2:started"
    assert (await replacement.prompt(session, [TextContentBlock(type="text", text="continue")])).stop_reason == "end_turn"
    assert "--resume" in json.loads((tmp_path / "cli-policy.json").read_text())["arguments"]


@pytest.mark.parametrize("marker", ["claude-code-cli-acp-v1", "claude-code-cli-acp-v2:started"])
async def test_started_or_legacy_session_never_falls_back_to_fresh_inference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, marker: str,
) -> None:
    _, client, session = await configured(tmp_path, monkeypatch)
    (tmp_path / f".caipe-cli-{session}").write_text(marker + "\n")
    replacement = ClaudeCodeCLIAgent([sys.executable, str(FIXTURE)])
    replacement.on_connect(client)
    await replacement.load_session(str(tmp_path), session, servers(), **policy())
    with pytest.raises(RequestError):
        await replacement.prompt(session, [TextContentBlock(type="text", text="continue")])
    assert "--resume" in json.loads((tmp_path / "cli-policy.json").read_text())["arguments"]


async def test_cli_stop_drains_process_and_rejects_a_concurrent_prompt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    agent, _, session = await configured(tmp_path, monkeypatch)
    prompt = [TextContentBlock(type="text", text="wait")]
    task = asyncio.create_task(agent.prompt(session, prompt))
    for _ in range(300):
        if (tmp_path / "cli-started").exists():
            break
        await asyncio.sleep(0.01)
    assert (tmp_path / "cli-started").exists()
    with pytest.raises(ValueError, match="concurrent"):
        await agent.prompt(session, prompt)
    await agent.cancel(session)
    assert (await asyncio.wait_for(task, 3)).stop_reason == "cancelled"
    assert agent.process is None and (tmp_path / "cli-cancelled").exists()
    assert not list(tmp_path.glob(".caipe-cli-turn-*"))
    assert (await agent.prompt(session, [TextContentBlock(type="text", text="continue")])).stop_reason == "end_turn"
    assert "--resume" in json.loads((tmp_path / "cli-policy.json").read_text())["arguments"]


@pytest.mark.parametrize("message", ["missing-result", "failed-result"])
async def test_cli_requires_confirmed_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, message: str) -> None:
    agent, _, session = await configured(tmp_path, monkeypatch)
    with pytest.raises(RequestError):
        await agent.prompt(session, [TextContentBlock(type="text", text=message)])


async def test_cli_rejects_external_mcp_and_missing_native_session(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude"))
    agent = ClaudeCodeCLIAgent()
    external = servers()[0].model_copy(update={"url": "https://tools.example.test/mcp"})
    with pytest.raises(ValueError, match="loopback"):
        await agent.new_session(str(tmp_path), [external], **policy())
    with pytest.raises(ValueError, match="unavailable"):
        await agent.load_session(str(tmp_path), "11111111-1111-4111-8111-111111111111", servers(), **policy())


async def test_cli_uses_the_official_acp_stdio_transport(settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    executable = tmp_path / "claude"
    executable.write_text(f"#!{sys.executable}\n" + FIXTURE.read_text().replace("from __future__ import annotations\n", ""))
    executable.chmod(0o700)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])
    adapter = ClaudeACPAdapter(settings.model_copy(update={
        "claude_acp_command": [sys.executable, str(Path(__file__).parents[1] / "src/harness_engine/claude_cli_acp.py")],
        "claude_acp_runtime": "claude_code_cli_acp",
    }))
    ctx = context()
    ctx.blueprint.tools.bindings = []
    events = [event async for event in adapter.execute(ctx)]
    assert events[-1].status == "completed"
    assert [e.data["text"] for e in events if isinstance(e, CanonicalEventDraft) and e.event_type == "content.delta"] == ["CLI answer"]


def test_sdk_and_cli_acp_catalogs_keep_distinct_profiles(settings: Settings) -> None:
    profiles = {name: {"url": "http://worker.example.test", "token": "example-worker-token", "profile_id": "safe", "runtime": runtime}
                for name, runtime in [("sdk-acp", "claude_code_acp"), ("cli-acp", "claude_code_cli_acp")]}
    config = settings.model_copy(update={"claude_worker_profiles_json": SecretStr(json.dumps(profiles))})
    sdk, cli = RemoteClaudeSDKAdapter(config, claude_acp=True), RemoteClaudeSDKAdapter(config, claude_cli_acp=True)
    assert sdk.descriptor.id == "claude_code_acp" and cli.descriptor.id == "claude_code_cli_acp"
    assert [p.id for p in sdk.descriptor.profiles] == ["sdk-acp"]
    assert [p.id for p in cli.descriptor.profiles] == ["cli-acp"]
    assert [p.id for p in RemoteClaudeSDKAdapter(config).descriptor.profiles] == ["sdk-acp"]


@pytest.mark.parametrize("harness_id", ["claude_code_acp", "claude_code_cli_acp"])
async def test_both_acp_harnesses_reject_mcp_admission_without_a_caller(settings: Settings, harness_id: str) -> None:
    config = settings.model_copy(update={"claude_worker_profiles_json": SecretStr(json.dumps({"remote": {
        "url": "http://worker.example.test", "token": "example-private-worker-token", "profile_id": "safe",
        "runtime": harness_id, "tools_enabled": True,
    }}))})
    def never_dispatch(request: httpx.Request) -> httpx.Response:
        pytest.fail("A missing caller must be rejected before worker dispatch")
    remote = RemoteClaudeSDKAdapter(config, httpx.MockTransport(never_dispatch),
                                   claude_acp=harness_id == "claude_code_acp", claude_cli_acp=harness_id == "claude_code_cli_acp")
    app = create_app(settings=config, repository=InMemoryRunRepository(), adapters=[remote])
    draft = blueprint(harness_id=harness_id, profile_id="remote", options={})
    draft["tools"] = {"bindings": [{"tool_id": "example.lookup"}], "approval_policy": "never"}
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://engine.example.test", headers=auth_headers()) as client:
            assert (await client.put("/api/v1/agents/agent-example", json={"blueprint": draft})).status_code == 200
            response = await client.post("/api/v1/runs", json={"agent_id": "agent-example", "conversation_id": "conversation-example", "message": "hello"})
            assert response.status_code == 401
