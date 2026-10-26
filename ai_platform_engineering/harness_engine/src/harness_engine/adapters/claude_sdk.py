"""Claude Agent SDK adapter implementing the portable harness contract."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import aclosing
from tempfile import TemporaryDirectory
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    MirrorErrorMessage,
    ResultMessage,
    SystemMessage,
    TextBlock,
    query,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from harness_engine.claude_session_store import ClaudeTranscriptStore, MongoClaudeSessionStore
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
    SessionBinding,
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
        transcript_store: ClaudeTranscriptStore | None = None,
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
                    level=(
                        CapabilityLevel.NATIVE if self._transcript_store is not None else CapabilityLevel.UNAVAILABLE
                    ),
                    explanation=(
                        "Owned Claude transcripts and provider session IDs are persisted for resume"
                        if self._transcript_store is not None
                        else "A shared Claude transcript store is required for resume"
                    ),
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
        if context.binding.provider_session_id and self._transcript_store is None:
            raise RuntimeError("A shared Claude transcript store is required to resume this session")
        scoped_store = self._transcript_store.for_run(context) if self._transcript_store else None
        try:
            if scoped_store is not None:
                await scoped_store.ready()
            # SessionStore is a mirror: the CLI always writes a local copy.
            # A per-run disposable config directory prevents a later caller
            # from falling back to a prior run's local transcript or config.
            with TemporaryDirectory(prefix="caipe-claude-") as config_dir:
                sdk_options = ClaudeAgentOptions(
                    system_prompt=context.prompt.system,
                    model=profile.model,
                    cwd=profile.cwd,
                    max_turns=options.max_turns,
                    permission_mode=profile.permission_mode,  # type: ignore[arg-type]
                    resume=context.binding.provider_session_id,
                    setting_sources=[],
                    # No qualified logical filesystem/tool broker is wired
                    # here. Permission mode does not disable CLI built-ins.
                    tools=[],
                    env={"CLAUDE_CONFIG_DIR": config_dir},
                    session_store=scoped_store,
                    session_store_flush="eager",
                )
                provider_session_id = context.binding.provider_session_id
                async with aclosing(self._query(prompt=context.turn.message, options=sdk_options)) as messages:
                    async for message in messages:
                        # Init/assistant metadata can identify partial sessions
                        # before ResultMessage. This records identity only; an
                        # interrupted run is never replayed automatically.
                        session_id = None
                        if isinstance(message, SystemMessage) and message.subtype == "init":
                            session_id = message.data.get("session_id")
                        elif isinstance(message, (AssistantMessage, ResultMessage)):
                            session_id = message.session_id
                        if isinstance(session_id, str) and session_id and session_id != provider_session_id:
                            provider_session_id = session_id
                            yield CanonicalEventDraft(
                                event_type="session.updated", data={"provider_session_id": session_id}
                            )
                        if isinstance(message, MirrorErrorMessage):
                            raise RuntimeError(
                                "Claude transcript mirroring failed; the session requires reconciliation"
                            )
                        if isinstance(message, AssistantMessage):
                            for block in message.content:
                                if isinstance(block, TextBlock) and block.text:
                                    yield CanonicalEventDraft(event_type="content.delta", data={"text": block.text})
                        elif isinstance(message, ResultMessage):
                            if message.is_error:
                                raise RuntimeError("Claude Agent SDK run failed")
                            if message.usage:
                                yield CanonicalEventDraft(event_type="usage.updated", data={"usage": message.usage})
        finally:
            # Explicitly drain blocking mirror writes before the coordinator
            # can acknowledge producer shutdown and purge the binding.
            if scoped_store is not None:
                await scoped_store.close()

    async def delete_session(self, binding: SessionBinding) -> None:
        if self._transcript_store is not None:
            await self._transcript_store.purge_for_binding(binding)
