"""ACP stdio adapter for the Claude Code CLI, without an Agent SDK query client."""

from __future__ import annotations

import asyncio
import json
import os
import signal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from acp import Agent, Client, RequestError, run_agent
from acp.schema import (
    AgentCapabilities,
    AgentMessageChunk,
    AgentThoughtChunk,
    HttpMcpServer,
    InitializeResponse,
    LoadSessionResponse,
    McpCapabilities,
    NewSessionResponse,
    PromptResponse,
    SetSessionModeResponse,
    TextContentBlock,
    ToolCallProgress,
    ToolCallStart,
)


class ClaudeCodeCLIAgent(Agent):
    """One native CLI session in the workspace assigned by the owning worker."""

    def __init__(self, command: list[str] | None = None) -> None:
        self.command = command or ["claude"]
        self.cwd = Path.cwd().resolve()
        self.client: Client | None = None
        self.session_id: str | None = None
        self.resume = False
        self.mode = "dontAsk"
        self.process: asyncio.subprocess.Process | None = None
        self.prompting = False
        self.cancelled = False
        self.options: dict[str, Any] = {}
        self.system_prompt = ""
        self.servers: dict[str, Any] = {}

    def on_connect(self, conn: Client) -> None:
        self.client = conn

    async def initialize(self, protocol_version: int, **kwargs: Any) -> InitializeResponse:
        if protocol_version != 1:
            raise ValueError("Claude Code CLI requires ACP v1")
        return InitializeResponse(
            protocol_version=1,
            agent_capabilities=AgentCapabilities(load_session=True, mcp_capabilities=McpCapabilities(http=True)),
            auth_methods=[],
        )

    def configure(self, cwd: str, mcp_servers: list[Any] | None, metadata: dict[str, Any]) -> None:
        if Path(cwd).resolve() != self.cwd or self.session_id:
            raise ValueError("The CLI session must use its assigned workspace")
        options = metadata["claudeCode"]["options"]
        if options.get("settingSources") != [] or options.get("allowDangerouslySkipPermissions") is not False:
            raise ValueError("CLI configuration discovery and permission bypass are unavailable")
        tools, allowed = options["tools"], options["allowedTools"]
        if not isinstance(tools, list) or not isinstance(allowed, list) or any(
            not isinstance(tool, str) or not tool or "*" in tool for tool in tools + allowed
        ):
            raise ValueError("CLI tools require an exact operator allowlist")
        if not isinstance(options["model"], str) or not options["model"] or not 1 <= options["maxTurns"] <= 100:
            raise ValueError("Invalid CLI model or turn limit")
        servers: dict[str, Any] = {}
        for server in mcp_servers or []:
            if not isinstance(server, HttpMcpServer):
                raise ValueError("CLI MCP tools require the worker's HTTP broker")
            url = urlsplit(server.url)
            if (
                server.name != "caipe" or url.scheme != "http" or url.hostname not in {"127.0.0.1", "::1"}
                or url.username or url.password or url.query or url.fragment
                or not url.path.startswith("/internal/claude-tools/") or server.name in servers
            ):
                raise ValueError("CLI MCP tools must use the run-scoped loopback broker")
            servers[server.name] = {
                "type": "http", "url": server.url,
                "headers": {header.name: header.value for header in server.headers or []},
            }
        if any(tool not in tools and (not servers or not tool.startswith("mcp__caipe__")) for tool in allowed):
            raise ValueError("CLI tool permissions must match its native tools or CAIPE broker")
        self.system_prompt = metadata["systemPrompt"]
        if not isinstance(self.system_prompt, str):
            raise ValueError("CLI instructions must be text")
        self.options, self.servers = options, servers

    async def new_session(self, cwd: str, mcp_servers: list[Any] | None = None, **kwargs: Any) -> NewSessionResponse:
        self.configure(cwd, mcp_servers, kwargs)
        self.session_id = str(uuid4())
        marker = self.cwd / f".caipe-cli-{self.session_id}"
        marker.write_text("claude-code-cli-acp-v1\n")
        marker.chmod(0o600)
        return NewSessionResponse(session_id=self.session_id)

    async def load_session(
        self, cwd: str, session_id: str, mcp_servers: list[Any] | None = None, **kwargs: Any
    ) -> LoadSessionResponse:
        self.configure(cwd, mcp_servers, kwargs)
        if str(UUID(session_id)) != session_id or not (self.cwd / f".caipe-cli-{session_id}").is_file():
            raise ValueError("The CLI session is unavailable in this workspace")
        self.session_id, self.resume = session_id, True
        return LoadSessionResponse()

    async def set_session_mode(self, session_id: str, mode_id: str, **kwargs: Any) -> SetSessionModeResponse:
        if session_id != self.session_id or mode_id != "plan" or self.process:
            raise ValueError("Only the operator's plan mode is supported")
        self.mode = mode_id
        return SetSessionModeResponse()

    async def update(self, update: Any) -> None:
        assert self.client is not None and self.session_id is not None
        await self.client.session_update(session_id=self.session_id, update=update)

    async def prompt(self, session_id: str, prompt: list[Any], **kwargs: Any) -> PromptResponse:
        if session_id != self.session_id or self.prompting or not prompt or any(
            not isinstance(block, TextContentBlock) for block in prompt
        ):
            raise ValueError("Invalid or concurrent CLI prompt")
        self.prompting = True
        try:
            if self.cancelled:
                return PromptResponse(stop_reason="cancelled")
            return await self.run_prompt(session_id, prompt)
        finally:
            self.prompting = False
            self.cancelled = False

    async def run_prompt(self, session_id: str, prompt: list[Any]) -> PromptResponse:
        with TemporaryDirectory(prefix=".caipe-cli-turn-", dir=self.cwd) as directory:
            folder = Path(directory)
            mcp_file, instructions = folder / "mcp.json", folder / "instructions.txt"
            mcp_file.write_text(json.dumps({"mcpServers": self.servers}))
            instructions.write_text(self.system_prompt)
            mcp_file.chmod(0o600)
            instructions.chmod(0o600)
            command = [
                *self.command, "--bare", "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--model", self.options["model"], "--max-turns", str(self.options["maxTurns"]),
                "--permission-mode", self.mode, "--tools", ",".join(self.options["tools"]),
                "--allowedTools", ",".join(self.options["allowedTools"]),
                "--setting-sources", "", "--strict-mcp-config", "--mcp-config", str(mcp_file),
                "--append-system-prompt-file", str(instructions), "--disable-slash-commands",
                "--resume" if self.resume else "--session-id", session_id,
            ]
            # No SDK client or caller credential is used here. The child remains
            # in the outer worker's dedicated process group, which drains it.
            process = await asyncio.create_subprocess_exec(
                *command, cwd=self.cwd, env=dict(os.environ), limit=64 * 1024 * 1024,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            self.process = process
            try:
                if self.cancelled:
                    process.send_signal(signal.SIGINT)
                    await process.wait()
                    return PromptResponse(stop_reason="cancelled")
                assert process.stdin is not None and process.stdout is not None
                process.stdin.write("\n".join(block.text for block in prompt).encode())
                await process.stdin.drain()
                process.stdin.close()
                result: dict[str, Any] | None = None
                streamed_text = False
                started: set[str] = set()
                async for line in process.stdout:
                    event = json.loads(line)
                    if event.get("session_id", session_id) != session_id:
                        raise ValueError("CLI returned a different session")
                    kind = event.get("type")
                    if kind == "system" and event.get("subtype") == "init":
                        self.resume = True
                    elif kind == "stream_event" and not event.get("parent_tool_use_id"):
                        delta = event.get("event", {}).get("delta", {})
                        if delta.get("type") in {"text_delta", "thinking_delta"}:
                            thought = delta["type"] == "thinking_delta"
                            text = delta["thinking" if thought else "text"]
                            chunk = AgentThoughtChunk if thought else AgentMessageChunk
                            await self.update(chunk(
                                session_update="agent_thought_chunk" if thought else "agent_message_chunk",
                                content=TextContentBlock(type="text", text=text),
                            ))
                            streamed_text = streamed_text or not thought
                    elif kind == "assistant" and not event.get("parent_tool_use_id"):
                        for block in event.get("message", {}).get("content", []):
                            if block["type"] == "text" and not streamed_text:
                                await self.update(AgentMessageChunk(
                                    session_update="agent_message_chunk", content=TextContentBlock(type="text", text=block["text"]),
                                ))
                            elif block["type"] == "tool_use" and block["id"] not in started:
                                started.add(block["id"])
                                await self.update(ToolCallStart(
                                    session_update="tool_call", tool_call_id=block["id"], title=block["name"],
                                    status="in_progress", raw_input=block["input"],
                                ))
                        streamed_text = False
                    elif kind == "user":
                        content = event.get("message", {}).get("content", [])
                        for block in content if isinstance(content, list) else []:
                            if block.get("type") == "tool_result" and block["tool_use_id"] in started:
                                await self.update(ToolCallProgress(
                                    session_update="tool_call_update", tool_call_id=block["tool_use_id"],
                                    status="failed" if block.get("is_error") else "completed", raw_output=block.get("content"),
                                ))
                    elif kind == "result":
                        result = event
                exit_code = await process.wait()
                if self.cancelled:
                    return PromptResponse(stop_reason="cancelled")
                if exit_code or result is None or result.get("is_error") or result.get("subtype") != "success":
                    raise RequestError.internal_error({"message": "Claude Code CLI did not complete its turn"})
                self.resume = True
                return PromptResponse(stop_reason="end_turn")
            finally:
                if process.returncode is None:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), 2)
                    except TimeoutError:
                        process.kill()
                        await process.wait()
                self.process = None

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        if session_id != self.session_id:
            raise ValueError("Unknown CLI session")
        self.cancelled = True
        if self.process is not None and self.process.returncode is None:
            try:
                self.process.send_signal(signal.SIGINT)
            except ProcessLookupError:
                pass


def main() -> None:
    asyncio.run(run_agent(ClaudeCodeCLIAgent()))


if __name__ == "__main__":
    main()
