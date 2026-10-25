"""Claude Agent SDK adapter implementing the portable harness contract."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    SessionStore,
    TextBlock,
    query,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from harness_engine.claude_session_store import MongoClaudeSessionStore
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
    ValidationIssue,
)
from harness_engine.sessions import EventAssignedProviderSessionManager, ProviderSessionManager


class ClaudeHarnessOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_turns: int = Field(20, ge=1, le=100)
    permission_mode: str | None = Field(
        None, pattern=r"^(default|acceptEdits|plan|dontAsk)$"
    )


ClaudeQuery = Callable[..., AsyncIterator[Any]]


class ClaudeSDKAdapter:
    def __init__(
        self,
        settings: Settings,
        *,
        query_fn: ClaudeQuery = query,
        transcript_store: SessionStore | None = None,
    ) -> None:
        self._profiles = settings.claude_sdk_profiles()
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
            )
            for alias, profile in sorted(self._profiles.items())
        ]
        return HarnessDescriptor(
            id="claude_agent_sdk",
            display_name="Claude Agent SDK",
            adapter_version="1.0.0",
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
                        CapabilityLevel.NATIVE
                        if self._transcript_store is not None
                        else CapabilityLevel.UNAVAILABLE
                    ),
                    explanation=(
                        "Claude transcripts and the provider session ID are stored in shared MongoDB"
                        if self._transcript_store is not None
                        else "A shared Claude transcript store is not configured"
                    ),
                ),
                "sandbox.isolation": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="This first adapter runs in-process; sandbox pods are the target mode",
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
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="Portable tool bindings are not connected yet",
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
        return AdapterEvaluation(
            normalized_options=options.model_dump(exclude_none=True),
        )

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft]:
        profile = self._profile(context.binding.profile_id)
        options = ClaudeHarnessOptions.model_validate(context.blueprint.harness.options)
        sdk_options = ClaudeAgentOptions(
            system_prompt=context.prompt.system,
            model=profile.model,
            cwd=profile.cwd,
            max_turns=options.max_turns,
            permission_mode=profile.permission_mode,  # type: ignore[arg-type]
            resume=context.binding.provider_session_id,
            setting_sources=[],
            # No tool/filesystem broker is admitted for this adapter yet.
            tools=[],
            # Claude Code writes a local working copy before mirroring it to
            # SessionStore. /tmp is writable even in the non-root image.
            env={"CLAUDE_CONFIG_DIR": "/tmp/claude-agent-sdk"},
            session_store=self._transcript_store,
            session_store_flush="eager",
        )
        async for message in self._query(prompt=context.turn.message, options=sdk_options):
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock) and block.text:
                        yield CanonicalEventDraft(
                            event_type="content.delta", data={"text": block.text}
                        )
            elif isinstance(message, ResultMessage):
                if message.is_error:
                    raise RuntimeError("Claude Agent SDK run failed")
                if message.session_id != context.binding.provider_session_id:
                    yield CanonicalEventDraft(
                        event_type="session.updated",
                        data={"provider_session_id": message.session_id},
                    )
                if message.usage:
                    yield CanonicalEventDraft(
                        event_type="usage.updated", data={"usage": message.usage}
                    )
