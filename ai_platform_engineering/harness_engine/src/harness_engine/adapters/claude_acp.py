"""Experimental Claude ACP subprocess behind the durable worker boundary."""

from __future__ import annotations

import asyncio
import hashlib
import os
from collections.abc import AsyncIterator
from contextlib import aclosing, asynccontextmanager, suppress
from pathlib import Path
from typing import Any

from acp import RequestError
from acp.schema import ClientCapabilities, HttpMcpServer, RequestPermissionResponse, TextContentBlock

from harness_engine.acp_events import canonical_update
from harness_engine.adapters.base import ExecutionUnconfirmedError
from harness_engine.adapters.claude_sdk import ClaudeHarnessOptions, ClaudeSDKAdapter
from harness_engine.claude_acp_process import managed_acp_process
from harness_engine.claude_acp_tools import ClaudeACPToolBridge
from harness_engine.config import Settings
from harness_engine.models import (
    AdapterEvaluation,
    AgentBlueprint,
    CanonicalEventDraft,
    CapabilityLevel,
    CapabilityResult,
    HarnessDescriptor,
    RunContext,
    ValidationIssue,
)


class ACPEventClient:
    def __init__(self, tool_names: dict[str, str] | None = None) -> None:
        self.events: asyncio.Queue[CanonicalEventDraft] = asyncio.Queue(maxsize=64)
        self.replaying = True
        self.tool_names = tool_names or {}

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        if not self.replaying:
            event = canonical_update(update.model_dump(mode="json", by_alias=True))
            if event is not None:
                if event.event_type == "tool.started":
                    name = event.data["tool_name"]
                    event.data["tool_name"] = self.tool_names.get(name, name)
                await self.events.put(event)

    async def request_permission(self, **kwargs: Any) -> RequestPermissionResponse:
        # No interactive approvals or blanket allow decisions in a detached worker.
        return RequestPermissionResponse.model_validate({"outcome": {"outcome": "cancelled"}})

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        raise RequestError.method_not_found(method)

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        # Unnegotiated agent extensions are not part of the canonical transcript.
        return None


class ClaudeACPAdapter(ClaudeSDKAdapter):
    def __init__(self, settings: Settings, *, tool_bridge: ClaudeACPToolBridge | None = None) -> None:
        super().__init__(settings)
        self._tool_bridge = tool_bridge
        self._command = settings.claude_acp_command
        self._tools = settings.claude_acp_tools
        self._runtime = settings.claude_acp_runtime

    @property
    def descriptor(self) -> HarnessDescriptor:
        descriptor = super().descriptor
        return descriptor.model_copy(
            update={
                "display_name": "Claude Code CLI ACP worker" if self._runtime == "claude_code_cli_acp" else "Claude Agent SDK ACP worker",
                "capabilities": {
                    **descriptor.capabilities,
                    "tools.broker": CapabilityResult(
                        level=CapabilityLevel.EMULATED
                        if self._tool_bridge and self._tool_broker.url
                        else CapabilityLevel.UNAVAILABLE,
                        explanation="Selected MCP tools retain caller and agent authorization through CAIPE",
                        constraints={"approval_policy": ["never"]},
                    ),
                    "session.cross_replica": CapabilityResult(
                        level=CapabilityLevel.UNAVAILABLE,
                        explanation="Provider transcripts require the worker's persistent workspace volume",
                    ),
                },
            }
        )

    def evaluate(self, blueprint: AgentBlueprint) -> AdapterEvaluation:
        result = super().evaluate(blueprint)
        if blueprint.tools.bindings and self._tool_bridge is None:
            result.issues.append(
                ValidationIssue(
                    path="tools.bindings",
                    capability="tools.broker",
                    level=CapabilityLevel.UNAVAILABLE,
                    severity="error",
                    message="The Claude ACP worker tool bridge is not configured",
                )
            )
        return result

    @asynccontextmanager
    async def _bind_tools(self, context: RunContext) -> AsyncIterator[tuple[list[HttpMcpServer], dict[str, str]]]:
        if self._tool_bridge is None:
            if context.blueprint.tools.bindings:
                raise PermissionError("The Claude ACP worker tool bridge is not configured")
            yield [], {}
        else:
            async with self._tool_bridge.bind(context, self._tool_broker) as tools:
                yield tools

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft]:
        async with self._bind_tools(context) as (mcp_servers, tool_names):
            async with aclosing(self._stream(context, mcp_servers, tool_names)) as events:
                async for event in events:
                    yield event

    async def _stream(
        self, context: RunContext, mcp_servers: list[HttpMcpServer], tool_names: dict[str, str]
    ) -> AsyncIterator[CanonicalEventDraft]:
        profile = self._profile(context.binding.profile_id)
        options = ClaudeHarnessOptions.model_validate(context.blueprint.harness.options)
        workspace = Path(profile.cwd) / hashlib.sha256(context.binding.binding_id.encode()).hexdigest()
        await asyncio.to_thread(workspace.mkdir, parents=True, exist_ok=True, mode=0o700)
        # Service and delegated caller tokens never enter the agent subprocess.
        provider_keys = {
            "PATH",
            "HOME",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NO_PROXY",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_USE_BEDROCK",
            "AWS_REGION",
            "AWS_DEFAULT_REGION",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_ROLE_ARN",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
        }
        env = {key: os.environ[key] for key in provider_keys if key in os.environ}
        env["CLAUDE_CONFIG_DIR"] = str(workspace / ".claude")
        # Keep a tool in this turn until it returns. Claude's HTTP MCP client
        # otherwise times out at 60 seconds, before the broker's 16-minute limit.
        env["MCP_TOOL_TIMEOUT"] = "900000"
        env["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"] = "900000"
        env["CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS"] = "0"
        client = ACPEventClient(tool_names)
        async with managed_acp_process(
            client,
            self._command,
            env=env,
            cwd=workspace,
            run_id=context.turn.run_id,
        ) as connection:
            initialized = await connection.initialize(protocol_version=1, client_capabilities=ClientCapabilities())
            if initialized.protocol_version != 1:
                raise ValueError("The configured agent did not negotiate ACP v1")
            if mcp_servers and (
                not initialized.agent_capabilities.mcp_capabilities
                or not initialized.agent_capabilities.mcp_capabilities.http
            ):
                raise ValueError("The configured ACP agent does not support HTTP MCP servers")
            # These are upstream Claude ACP extension options, never agent-draft commands.
            meta = {
                "systemPrompt": context.prompt.system,
                "claudeCode": {
                    "options": {
                        "model": profile.model,
                        "maxTurns": options.max_turns,
                        "settingSources": [],
                        "tools": self._tools,
                        "allowedTools": self._tools + list(tool_names),
                        "allowDangerouslySkipPermissions": False,
                    }
                },
            }
            session_id = context.binding.provider_session_id
            if session_id:
                if not initialized.agent_capabilities or not initialized.agent_capabilities.load_session:
                    raise ValueError("The configured ACP agent cannot reload persistent sessions")
                await connection.load_session(
                    cwd=str(workspace), session_id=session_id, mcp_servers=mcp_servers, **meta
                )
            else:
                session = await connection.new_session(cwd=str(workspace), mcp_servers=mcp_servers, **meta)
                session_id = session.session_id
                yield CanonicalEventDraft(event_type="session.updated", data={"provider_session_id": session_id})
            if profile.permission_mode == "plan":
                await connection.set_session_mode(session_id=session_id, mode_id="plan")
            client.replaying = False
            task = asyncio.create_task(
                connection.prompt(
                    session_id=session_id, prompt=[TextContentBlock(type="text", text=context.turn.message)]
                )
            )
            pending: asyncio.Task[CanonicalEventDraft] | None = None
            try:
                while not task.done() or not client.events.empty():
                    if task.done():
                        while not client.events.empty():
                            yield client.events.get_nowait()
                        break
                    pending = asyncio.create_task(client.events.get())
                    done, _ = await asyncio.wait({task, pending}, return_when=asyncio.FIRST_COMPLETED)
                    if pending in done:
                        yield pending.result()
                    else:
                        pending.cancel()
                        with suppress(asyncio.CancelledError):
                            await pending
                    pending = None
                result = await task
                if result.stop_reason != "end_turn":
                    raise RuntimeError("The ACP agent did not complete its turn")
            finally:
                if pending is not None:
                    pending.cancel()
                    with suppress(asyncio.CancelledError):
                        await pending
                if not task.done():
                    client.replaying = True
                    while not client.events.empty():
                        client.events.get_nowait()
                    await connection.cancel(session_id=session_id)
                    try:
                        await asyncio.wait_for(asyncio.shield(task), timeout=10)
                    except TimeoutError:
                        task.cancel()
                        with suppress(asyncio.CancelledError):
                            await task
                        raise ExecutionUnconfirmedError(
                            "ACP cancellation did not confirm that the agent drained"
                        ) from None
                    except (ConnectionError, RequestError):
                        raise ExecutionUnconfirmedError(
                            "ACP cancellation response was lost; retain the session reservation"
                        ) from None
                client.replaying = True
                capabilities = (
                    initialized.agent_capabilities.session_capabilities if initialized.agent_capabilities else None
                )
                if capabilities and capabilities.close is not None:
                    try:
                        await asyncio.wait_for(connection.close_session(session_id=session_id), timeout=10)
                    except (TimeoutError, ConnectionError, RequestError):
                        raise ExecutionUnconfirmedError("ACP session closure could not be confirmed") from None
