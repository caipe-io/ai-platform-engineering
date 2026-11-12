"""Real isolated CLI + ACP + MCP + resume, with a deterministic local model.

Run inside the CLI worker image. No real model, credentials or external services.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

import httpx2 as httpx
import uvicorn
from starlette.applications import Starlette
from starlette.routing import Mount

from harness_engine.adapters.claude_acp import ClaudeACPAdapter
from harness_engine.claude_acp_tools import ClaudeACPToolBridge
from harness_engine.claude_isolation import check_isolation
from harness_engine.claude_tools import ClaudeToolBroker
from harness_engine.config import Settings
from harness_engine.models import (
    AgentBlueprint,
    ExecutionIdentity,
    RenderedPrompt,
    RunContext,
    SessionBinding,
    TurnInput,
)


class Model(BaseHTTPRequestHandler):
    errors: list[object] = []
    def log_message(self, *_: object) -> None:
        pass

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if "messages" not in body:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")
            return
        content = body["messages"][-1]["content"]
        results = [b for b in content if b.get("type") == "tool_result"] if isinstance(content, list) else []
        done = any(b["tool_use_id"].startswith("toolu_mcp_") for b in results)
        if done:
            block = {"type": "text", "text": "isolated MCP completed"}
        elif results:
            if any(b.get("is_error") for b in results):
                self.errors.extend(results)
                done = True
                block = {"type": "text", "text": "Bash fixture failed"}
            else:
                block = {"type": "tool_use", "id": "toolu_mcp_" + uuid4().hex, "name": "mcp__caipe__tool_0", "input": {}}
        else:
            block = {"type": "tool_use", "id": "toolu_bash_" + uuid4().hex, "name": "Bash",
                     "input": {"command": "printf 'isolated-shell-ok\\n'", "description": "Print a test marker"}}
        message = {"id": "msg_" + uuid4().hex, "type": "message", "role": "assistant",
                   "model": body["model"], "content": [block], "stop_reason": "end_turn" if done else "tool_use",
                   "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}
        self.send_response(200)
        if not body.get("stream"):
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(message).encode())
            return
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        start = {**block, "text": ""} if done else {**block, "input": {}}
        frames = [
            {"type": "message_start", "message": {**message, "content": [], "stop_reason": None}},
            {"type": "content_block_start", "index": 0, "content_block": start},
        ]
        if done:
            frames.append({"type": "content_block_delta", "index": 0,
                           "delta": {"type": "text_delta", "text": block["text"]}})
        else:
            frames.append({"type": "content_block_delta", "index": 0,
                           "delta": {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}})
        frames.extend([
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": message["stop_reason"], "stop_sequence": None},
             "usage": {"output_tokens": 1}},
            {"type": "message_stop"},
        ])
        for frame in frames:
            self.wfile.write(f"event: {frame['type']}\ndata: {json.dumps(frame)}\n\n".encode())
        self.wfile.flush()


async def verify(root: str, proxy_port: int) -> None:
    await check_isolation()
    # Emulate Kubernetes fsGroup: new session directories inherit setgid.
    os.chmod(root, 0o2700)
    # All values are disposable fixtures, including the caller bearer retained
    # in the parent broker. Never inherit real provider credentials in this test.
    for key in list(os.environ):
        if key.startswith(("ANTHROPIC_", "AWS_", "CLAUDE_CODE_", "HARNESS_ENGINE_")):
            del os.environ[key]
    os.environ.update(ANTHROPIC_API_KEY="fixture-model-key", ANTHROPIC_BASE_URL="http://model.example.test")
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
        os.environ[key] = f"http://127.0.0.1:{proxy_port}"
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    bridge = ClaudeACPToolBridge(port)
    server = uvicorn.Server(uvicorn.Config(Starlette(routes=[Mount("/internal/claude-tools", bridge)]),
                                          log_level="critical"))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    while not server.started:
        await asyncio.sleep(.01)
    calls: list[str] = []

    def broker(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer fixture-caller-identity"
        body = json.loads(request.content)
        if body["operation"] == "list":
            data = {"tools": [{"tool_id": "example.lookup", "description": "Return a test value",
                               "input_schema": {"type": "object", "properties": {}}}]}
        else:
            calls.append(body["tool_id"])
            data = {"content": [{"type": "text", "text": "fixture-tool-result"}]}
        return httpx.Response(200, json={"success": True, "data": data})

    settings = Settings(port=port, claude_acp_runtime="claude_code_cli_acp",
                        claude_acp_tools=["Bash"],
                        claude_acp_command=["python", "/app/src/harness_engine/claude_cli_acp.py"],
                        claude_tool_broker_url="http://broker.example.test",
                        claude_sdk_profiles_json=json.dumps({"test": {"model": "claude-sonnet-4-5", "cwd": root}}))
    adapter = ClaudeACPAdapter(settings, tool_bridge=bridge)
    adapter._tool_broker = ClaudeToolBroker(settings, httpx.MockTransport(broker))
    agent = AgentBlueprint.model_validate({
        "id": "agent-example", "name": "Example", "harness": {"id": "claude_agent_sdk", "profile_id": "test"},
        "prompt": {"system": "Call the provided tool once, then finish."},
        "tools": {"bindings": [{"tool_id": "example.lookup"}], "approval_policy": "never"},
    })
    ctx = RunContext(blueprint=agent, binding=SessionBinding(
        binding_id="binding-isolation-test", owner_subject="example-user", agent_id=agent.id, agent_version=1,
        conversation_id="conversation-example", harness_id="claude_agent_sdk", profile_id="test",
        checkpoint_strategy="adapter_store"), prompt=RenderedPrompt(system=agent.prompt.system),
        turn=TurnInput(run_id="run-first", message="Call the tool then finish."),
        identity=ExecutionIdentity(subject="example-user", bearer="fixture-caller-identity"))
    try:
        first = [e async for e in adapter.execute(ctx)]
        assert not Model.errors, Model.errors
        assert first[-1].status == "completed", first[-1]
        session_id = next(e.data["provider_session_id"] for e in first if getattr(e, "event_type", None) == "session.updated")
        assert calls == ["example.lookup"], calls
        ctx.binding.provider_session_id = session_id
        ctx.turn = TurnInput(run_id="run-resume", message="Call the tool again then finish.")
        resumed = [e async for e in adapter.execute(ctx)]
        assert resumed[-1].status == "completed", resumed[-1]
        assert calls == ["example.lookup", "example.lookup"], calls
        assert not bridge._sessions, "run capabilities were not revoked"
        for file in Path(root).rglob("*"):
            if file.is_file():
                assert b"fixture-caller-identity" not in file.read_bytes(), "caller token persisted"
        print("PASS: isolated real CLI, Bash, ACP streaming, two MCP calls, session resume, token exclusion and capability revocation")
    finally:
        server.should_exit = True
        try:
            # Wait for graceful shutdown, but fail the fixture if the server hangs.
            await asyncio.wait_for(serving, timeout=10)
        finally:
            listener.close()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="claude-integration-") as root, ThreadingHTTPServer(("127.0.0.1", 0), Model) as proxy:
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        try:
            asyncio.run(asyncio.wait_for(verify(root, proxy.server_port), 90))
        finally:
            proxy.shutdown()
            thread.join()
