"""Experimental Claude Code ACP subprocess behind the durable worker boundary."""

from __future__ import annotations

import asyncio
import hashlib
import os
from collections.abc import AsyncIterator
from contextlib import suppress
from pathlib import Path
from typing import Any

from acp import RequestError, spawn_agent_process
from acp.schema import ClientCapabilities, RequestPermissionResponse, TextContentBlock

from harness_engine.acp_events import canonical_update
from harness_engine.adapters.base import ExecutionUnconfirmedError
from harness_engine.adapters.claude_sdk import ClaudeHarnessOptions, ClaudeSDKAdapter
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
    def __init__(self) -> None:
        self.events: asyncio.Queue[CanonicalEventDraft] = asyncio.Queue(maxsize=64)
        self.replaying = True

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        if not self.replaying:
            event = canonical_update(update.model_dump(mode="json", by_alias=True))
            if event is not None:
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
    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self._command = settings.claude_acp_command
        self._tools = settings.claude_acp_tools

    @property
    def descriptor(self) -> HarnessDescriptor:
        descriptor = super().descriptor
        return descriptor.model_copy(
            update={
                "display_name": "Claude Code ACP worker",
                "capabilities": {
                    **descriptor.capabilities,
                    "tools.broker": CapabilityResult(level=CapabilityLevel.UNAVAILABLE),
                    "session.cross_replica": CapabilityResult(
                        level=CapabilityLevel.UNAVAILABLE,
                        explanation="Provider transcripts require the worker's persistent workspace volume",
                    ),
                },
            }
        )

    def evaluate(self, blueprint: AgentBlueprint) -> AdapterEvaluation:
        result = super().evaluate(blueprint)
        if blueprint.tools.bindings:
            result.issues.append(
                ValidationIssue(
                    path="tools.bindings",
                    capability="tools.broker",
                    level=CapabilityLevel.UNAVAILABLE,
                    severity="error",
                    message="The experimental Claude Code ACP worker does not expose the CAIPE MCP broker",
                )
            )
        return result

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft]:
        profile = self._profile(context.binding.profile_id)
        options = ClaudeHarnessOptions.model_validate(context.blueprint.harness.options)
        workspace = Path(profile.cwd) / hashlib.sha256(context.binding.binding_id.encode()).hexdigest()
        await asyncio.to_thread(workspace.mkdir, parents=True, exist_ok=True, mode=0o700)
        # Service and delegated caller tokens never enter the agent subprocess.
        provider_keys = {
            "PATH",
            "HOME",
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
        client = ACPEventClient()
        async with spawn_agent_process(
            client, *self._command, env=env, cwd=workspace, transport_kwargs={"stderr": asyncio.subprocess.DEVNULL}
        ) as (connection, _process):
            initialized = await connection.initialize(protocol_version=1, client_capabilities=ClientCapabilities())
            if initialized.protocol_version != 1:
                raise ValueError("The configured agent did not negotiate ACP v1")
            # These are upstream Claude ACP extension options, never agent-draft commands.
            meta = {
                "systemPrompt": context.prompt.system,
                "claudeCode": {
                    "options": {
                        "model": profile.model,
                        "maxTurns": options.max_turns,
                        "settingSources": [],
                        "tools": self._tools,
                        "allowedTools": self._tools,
                        "allowDangerouslySkipPermissions": False,
                    }
                },
            }
            session_id = context.binding.provider_session_id
            if session_id:
                if not initialized.agent_capabilities or not initialized.agent_capabilities.load_session:
                    raise ValueError("The configured ACP agent cannot reload persistent sessions")
                await connection.load_session(cwd=str(workspace), session_id=session_id, mcp_servers=[], **meta)
            else:
                session = await connection.new_session(cwd=str(workspace), mcp_servers=[], **meta)
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
