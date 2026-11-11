"""Claude Agent SDK adapter implementing the portable harness contract."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    SessionStore,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from harness_engine.claude_session_store import MongoClaudeSessionStore
from harness_engine.claude_tools import ClaudeToolBroker
from harness_engine.config import ClaudeSDKProfile, Settings
from harness_engine.models import (
    AdapterEvaluation,
    AgentBlueprint,
    CanonicalEventDraft,
    CapabilityLevel,
    CapabilityResult,
    ExecutionMode,
    HarnessDescriptor,
    HarnessProfile,
    RunContext,
    TurnOutcome,
    ValidationIssue,
)
from harness_engine.sessions import EventAssignedProviderSessionManager, ProviderSessionManager


class ClaudeHarnessOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_turns: int = Field(20, ge=1, le=100)
    permission_mode: str | None = Field(None, pattern=r"^(default|acceptEdits|plan|dontAsk)$")


ClaudeQuery = Callable[..., AsyncIterator[Any]]


class ClaudeSDKAdapter:
    def __init__(
        self,
        settings: Settings,
        *,
        query_fn: ClaudeQuery = query,
        transcript_store: SessionStore | None = None,
        tool_broker: ClaudeToolBroker | None = None,
    ) -> None:
        self._profiles = settings.claude_sdk_profiles()
        self._tool_broker = tool_broker or ClaudeToolBroker(settings)
        self._active: dict[str, asyncio.Task[Any]] = {}
        self._query = query_fn
        self._transcript_store = transcript_store
        if self._transcript_store is None and settings.storage_backend == "mongodb":
            self._transcript_store = MongoClaudeSessionStore(
                settings.mongodb_uri,
                settings.mongodb_database,
            )
        self._session_manager = EventAssignedProviderSessionManager(
            "claude_agent_sdk", checkpoint_strategy="adapter_store"
        )

    @property
    def session_manager(self) -> ProviderSessionManager:
        return self._session_manager

    @property
    def descriptor(self) -> HarnessDescriptor:
        profiles = [
            HarnessProfile(
                id=alias,
                harness_id="claude_agent_sdk",
                display_name=alias.replace("-", " ").replace("_", " ").title(),
                description=profile.description or "Operator-managed Claude SDK policy",
                sandbox=profile.sandbox.public() if profile.sandbox else None,
                owner_subject=profile.sandbox.owner_subject if profile.sandbox else None,
            )
            for alias, profile in sorted(self._profiles.items())
        ]
        return HarnessDescriptor(
            id="claude_agent_sdk",
            display_name="Claude Agent SDK",
            adapter_version="2.0.0",
            contract_version=2,
            execution_mode=ExecutionMode.IN_PROCESS,
            availability="available" if profiles else "misconfigured",
            certification="experimental",
            profiles=profiles,
            options_schema={
                "type": "object",
                "properties": {
                    "max_turns": {
                        "type": "integer",
                        "title": "Maximum turns",
                        "minimum": 1,
                        "maximum": 100,
                        "default": 20,
                    },
                    "permission_mode": {
                        "type": "string",
                        "title": "Permission mode",
                        "enum": ["dontAsk", "plan"],
                    },
                },
                "additionalProperties": False,
            },
            ui_schema={"ui:order": ["max_turns", "permission_mode"]},
            capabilities={
                "stream.text": CapabilityResult(level=CapabilityLevel.NATIVE),
                "stream.replay": CapabilityResult(
                    level=CapabilityLevel.EMULATED,
                    explanation="Harness Engine persists the canonical event log",
                ),
                "thread.persistence": CapabilityResult(
                    level=CapabilityLevel.NATIVE,
                    explanation="Claude session IDs are persisted and supplied through resume",
                ),
                "session.cross_replica": CapabilityResult(
                    level=(
                        CapabilityLevel.NATIVE if self._transcript_store is not None else CapabilityLevel.UNAVAILABLE
                    ),
                    explanation=(
                        "Claude transcripts and the provider session ID are stored in shared MongoDB"
                        if self._transcript_store is not None
                        else "A shared Claude transcript store is not configured"
                    ),
                ),
                "sandbox.isolation": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="SDK processes share the host boundary; sandbox pods are not allocated",
                ),
                "sandbox.workspace": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="Sandbox workspace leasing is not connected yet",
                ),
                "memory.long_term": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="Portable long-term memory is not connected yet",
                ),
                "tools.broker": CapabilityResult(
                    level=CapabilityLevel.EMULATED if self._tool_broker.url else CapabilityLevel.UNAVAILABLE,
                    explanation="Selected MCP tools use the caller-scoped CAIPE broker",
                    constraints={"approval_policy": ["never"]},
                ),
                "multi_agent.delegation": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="Portable delegation is not connected yet",
                ),
            },
        )

    def _profile(self, profile_id: str) -> ClaudeSDKProfile:
        try:
            return self._profiles[profile_id]
        except KeyError as exc:
            raise ValueError("Claude SDK profile is not configured") from exc

    def evaluate(self, blueprint: AgentBlueprint) -> AdapterEvaluation:
        try:
            options = ClaudeHarnessOptions.model_validate(blueprint.harness.options)
        except ValidationError as exc:
            return AdapterEvaluation(
                normalized_options={},
                issues=[
                    ValidationIssue(
                        path="harness.options",
                        capability="configuration",
                        level=CapabilityLevel.UNSUPPORTED,
                        severity="error",
                        message=error["msg"],
                    )
                    for error in exc.errors()
                ],
            )
        profile = self._profiles.get(blueprint.harness.profile_id)
        if options.permission_mode and profile and options.permission_mode != profile.permission_mode:
            return AdapterEvaluation(
                normalized_options=options.model_dump(exclude_none=True),
                issues=[
                    ValidationIssue(
                        path="harness.options.permission_mode",
                        capability="configuration",
                        level=CapabilityLevel.UNSUPPORTED,
                        severity="error",
                        message="The permission mode must match the operator profile",
                    )
                ],
            )
        issues = []
        if blueprint.tools.bindings and blueprint.tools.approval_policy != "never":
            issues.append(
                ValidationIssue(
                    path="tools.approval_policy",
                    capability="tools.broker",
                    level=CapabilityLevel.UNSUPPORTED,
                    severity="error",
                    message="SDK MCP tools require an explicit policy without per-call approvals",
                )
            )
        return AdapterEvaluation(normalized_options=options.model_dump(exclude_none=True), issues=issues)

    async def cancel_run(self, run_id: str) -> bool:
        task = self._active.get(run_id)
        if task is None:
            return False
        if not task.cancelling():
            task.cancel()
        return True

    async def execute(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | TurnOutcome]:
        task = asyncio.current_task()
        assert task is not None
        self._active[context.turn.run_id] = task
        content = []
        try:
            async with aclosing(self.stream(context)) as events:
                async for event in events:
                    if event.event_type == "content.delta":
                        content.append(event.data["text"])
                    yield event
            yield TurnOutcome(status="completed", result={"content": "".join(content)})
        finally:
            self._active.pop(context.turn.run_id, None)

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft]:
        profile = self._profile(context.binding.profile_id)
        options = ClaudeHarnessOptions.model_validate(context.blueprint.harness.options)
        # Tool permissions never imply access to another caller's local workspace.
        directory = hashlib.sha256(context.binding.binding_id.encode()).hexdigest()
        workspace = Path(profile.cwd) / directory
        await asyncio.to_thread(workspace.mkdir, parents=True, exist_ok=True, mode=0o700)
        async with self._tool_broker.bind(context) as (mcp_servers, tool_names):
            sdk_options = ClaudeAgentOptions(
                system_prompt=context.prompt.system,
                model=profile.model,
                cwd=str(workspace),
                max_turns=options.max_turns,
                permission_mode=profile.permission_mode,
                resume=context.binding.provider_session_id,
                setting_sources=[],
                tools=[],
                allowed_tools=list(tool_names),
                mcp_servers=mcp_servers,
                env={"CLAUDE_CONFIG_DIR": f"/tmp/claude-agent-sdk/{directory}"},
                session_store=self._transcript_store,
                session_store_flush="eager",
                include_partial_messages=True,
            )

            async def prompt_messages() -> AsyncIterator[dict[str, Any]]:
                yield {"type": "user", "message": {"role": "user", "content": context.turn.message}}

            prompt = prompt_messages() if mcp_servers else context.turn.message
            provider_id = context.binding.provider_session_id
            streamed_text = False
            calls: dict[str, str] = {}
            async with aclosing(self._query(prompt=prompt, options=sdk_options)) as messages:
                async for message in messages:
                    if isinstance(message, SystemMessage) and message.subtype == "init":
                        native_id = message.data.get("session_id")
                        if native_id and native_id != provider_id:
                            provider_id = native_id
                            yield CanonicalEventDraft(
                                event_type="session.updated", data={"provider_session_id": native_id}
                            )
                    elif isinstance(message, StreamEvent):
                        delta = message.event.get("delta", {})
                        if delta.get("type") == "text_delta" and delta.get("text"):
                            streamed_text = True
                            yield CanonicalEventDraft(event_type="content.delta", data={"text": delta["text"]})
                        elif delta.get("type") == "thinking_delta" and delta.get("thinking"):
                            yield CanonicalEventDraft(event_type="reasoning.delta", data={"text": delta["thinking"]})
                    elif isinstance(message, AssistantMessage):
                        for block in message.content:
                            if isinstance(block, TextBlock) and block.text and not streamed_text:
                                yield CanonicalEventDraft(event_type="content.delta", data={"text": block.text})
                            elif isinstance(block, ToolUseBlock):
                                if block.name not in tool_names:
                                    raise PermissionError("The SDK requested a tool outside its allowlist")
                                calls[block.id] = tool_names[block.name]
                                yield CanonicalEventDraft(
                                    event_type="tool.started",
                                    data={
                                        "tool_call_id": block.id,
                                        "tool_name": tool_names[block.name],
                                        "args": block.input,
                                    },
                                )
                        streamed_text = False
                    elif isinstance(message, UserMessage) and isinstance(message.content, list):
                        for block in message.content:
                            if isinstance(block, ToolResultBlock) and block.tool_use_id in calls:
                                yield CanonicalEventDraft(
                                    event_type="tool.completed",
                                    data={
                                        "tool_call_id": block.tool_use_id,
                                        "tool_name": calls[block.tool_use_id],
                                        "result": block.content,
                                        "error": "MCP tool failed" if block.is_error else None,
                                    },
                                )
                    elif isinstance(message, ResultMessage):
                        if message.is_error:
                            raise RuntimeError("Claude Agent SDK run failed")
                        if message.session_id != provider_id:
                            provider_id = message.session_id
                            yield CanonicalEventDraft(
                                event_type="session.updated", data={"provider_session_id": message.session_id}
                            )
                        if message.usage:
                            yield CanonicalEventDraft(event_type="usage.updated", data={"usage": message.usage})
