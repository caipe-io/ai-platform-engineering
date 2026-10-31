"""Provider-neutral Harness Engine API and persistence models."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from harness_engine.config import AgentCoreRuntimeTarget


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConnectAgentCoreRequest(StrictModel):
    profile_id: str = Field(..., pattern=r"^existing-[a-z0-9][a-z0-9-]{0,54}$")
    arn: str = Field(..., min_length=20, max_length=2048)
    region: str = Field(..., min_length=1, max_length=32)
    qualifier: str = Field("DEFAULT", min_length=1, max_length=64)

    def target(self) -> AgentCoreRuntimeTarget:
        return AgentCoreRuntimeTarget(arn=self.arn, region=self.region, qualifier=self.qualifier)

    @model_validator(mode="after")
    def validate_target(self) -> ConnectAgentCoreRequest:
        target = self.target()
        if self.arn.split(":")[3] != target.region:
            raise ValueError("Region must match the AgentCore ARN")
        return self


class RegisteredAgentCoreProfile(StrictModel):
    profile_id: str
    target: AgentCoreRuntimeTarget
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)


class CapabilityLevel(StrEnum):
    NATIVE = "native"
    EMULATED = "emulated"
    UNSUPPORTED = "unsupported"
    UNAVAILABLE = "unavailable"


class ExecutionMode(StrEnum):
    PROVIDER_MANAGED = "provider_managed"
    SANDBOX_POD = "sandbox_pod"
    IN_PROCESS = "in_process"


class CapabilityResult(StrictModel):
    level: CapabilityLevel
    explanation: str = ""
    constraints: dict[str, Any] = Field(default_factory=dict)


class HarnessProfile(StrictModel):
    """Sanitized operator-owned resource profile exposed to agent authors."""

    id: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    harness_id: str
    display_name: str
    description: str = ""
    available: bool = True


class HarnessDescriptor(StrictModel):
    id: str = Field(..., pattern=r"^[a-z][a-z0-9_]{1,63}$")
    display_name: str
    adapter_version: str
    contract_version: int = 1
    execution_mode: ExecutionMode
    availability: Literal["available", "misconfigured", "unavailable"]
    certification: Literal["experimental", "certified", "blocked"] = "experimental"
    profiles: list[HarnessProfile] = Field(default_factory=list)
    options_schema: dict[str, Any]
    ui_schema: dict[str, Any] = Field(default_factory=dict)
    capabilities: dict[str, CapabilityResult]


class HarnessSelection(StrictModel):
    id: str = Field(..., pattern=r"^[a-z][a-z0-9_]{1,63}$")
    profile_id: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    options: dict[str, Any] = Field(default_factory=dict)


class PromptDefinition(StrictModel):
    system: str = Field(..., min_length=1, max_length=200_000)
    variables: dict[str, str] = Field(default_factory=dict)
    context_sources: list[str] = Field(default_factory=list, max_length=32)


class ModelPolicy(StrictModel):
    policy: Literal["harness_default", "configured"] = "harness_default"
    id: str | None = Field(None, max_length=256)
    provider: str | None = Field(None, max_length=64)


class ToolBinding(StrictModel):
    tool_id: str = Field(..., min_length=1, max_length=256)
    revision: int | None = Field(None, ge=1)


class ToolsPolicy(StrictModel):
    bindings: list[ToolBinding] = Field(default_factory=list, max_length=256)
    approval_policy: Literal["never", "sensitive_only", "always"] = "sensitive_only"


class ThreadPolicy(StrictModel):
    persistence: Literal["durable", "ephemeral"] = "durable"
    retention_profile: str = Field("standard", max_length=64)
    clear_policy: Literal["new_epoch"] = "new_epoch"


class MemoryPolicy(StrictModel):
    enabled: bool = False
    read_scopes: list[Literal["user", "agent", "organization"]] = Field(
        default_factory=lambda: ["user"], max_length=3
    )
    write_scope: Literal["user", "agent"] = "user"
    kinds: list[Literal["semantic", "episodic_reference", "procedural"]] = Field(
        default_factory=lambda: ["semantic"], max_length=3
    )
    retrieval: Literal["startup_bounded", "on_demand"] = "on_demand"
    max_results: int = Field(10, ge=1, le=50)
    write_policy: Literal["disabled", "automatic_scoped", "approval_for_sensitive"] = (
        "approval_for_sensitive"
    )
    retention_profile: str = Field("standard", max_length=64)


class WorkspacePolicy(StrictModel):
    persistence: Literal["none", "run", "thread"] = "none"
    sandbox_profile: str | None = Field(None, max_length=64)


class StreamingPolicy(StrictModel):
    protocol: Literal["canonical"] = "canonical"
    replay: Literal["required", "best_effort"] = "required"


class DelegationPolicy(StrictModel):
    agents: list[str] = Field(default_factory=list, max_length=32)
    max_depth: int = Field(1, ge=0, le=8)
    max_parallel: int = Field(1, ge=1, le=16)


class RunLimits(StrictModel):
    max_run_seconds: int = Field(900, ge=1, le=28_800)
    max_tool_calls: int = Field(50, ge=0, le=1_000)


class AgentBlueprint(StrictModel):
    """Portable, user-authored configuration compiled for one harness."""

    id: str = Field(..., min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.-]+$")
    name: str = Field(..., min_length=1, max_length=128)
    description: str = Field("", max_length=2_000)
    harness: HarnessSelection
    prompt: PromptDefinition
    model: ModelPolicy = Field(default_factory=ModelPolicy)
    tools: ToolsPolicy = Field(default_factory=ToolsPolicy)
    thread: ThreadPolicy = Field(default_factory=ThreadPolicy)
    memory: MemoryPolicy = Field(default_factory=MemoryPolicy)
    workspace: WorkspacePolicy = Field(default_factory=WorkspacePolicy)
    streaming: StreamingPolicy = Field(default_factory=StreamingPolicy)
    delegation: DelegationPolicy = Field(default_factory=DelegationPolicy)
    limits: RunLimits = Field(default_factory=RunLimits)


class AgentRecord(StrictModel):
    agent_id: str
    current_version: int = Field(..., ge=1)
    revision: int = Field(..., ge=1)
    enabled: bool = True
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentVersion(StrictModel):
    agent_id: str
    version: int = Field(..., ge=1)
    blueprint: AgentBlueprint
    config_fingerprint: str
    catalog_revision: str
    created_at: datetime = Field(default_factory=utc_now)


class ProviderResource(StrictModel):
    """Server-owned provider resource; never accepted in an agent blueprint."""

    agent_id: str = Field(..., min_length=1, max_length=128)
    harness_id: str
    profile_id: str
    provider: Literal["aws_agentcore"]
    resource_type: Literal["harness"]
    resource_id: str = Field(..., min_length=1, max_length=128)
    arn: str = Field(..., min_length=20, max_length=2048)
    region: str = Field(..., pattern=r"^[a-z]{2}(?:-gov)?-[a-z]+-\d$")
    qualifier: str = Field("DEFAULT", min_length=1, max_length=64)
    configuration_fingerprint: str = ""
    status: Literal["ready"] = "ready"
    ownership: Literal["agent"] = "agent"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class SaveAgentRequest(StrictModel):
    blueprint: AgentBlueprint
    expected_revision: int | None = Field(None, ge=1)
    catalog_revision: str | None = None
    config_fingerprint: str | None = None


class ValidateAgentDraftRequest(StrictModel):
    blueprint: AgentBlueprint
    catalog_revision: str | None = None


class ValidationIssue(StrictModel):
    path: str
    capability: str
    level: CapabilityLevel
    severity: Literal["info", "warning", "error"]
    message: str
    constraints: dict[str, Any] = Field(default_factory=dict)


class HarnessDraftValidation(StrictModel):
    valid: bool
    catalog_revision: str
    config_fingerprint: str
    normalized_blueprint: AgentBlueprint
    issues: list[ValidationIssue]
    capabilities: dict[str, CapabilityResult]


class AdapterEvaluation(StrictModel):
    """Adapter-specific compilation result used by the registry."""

    normalized_options: dict[str, Any]
    issues: list[ValidationIssue] = Field(default_factory=list)


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


TERMINAL_RUN_STATUSES = {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.PAUSED}


class RunRecord(StrictModel):
    run_id: str
    owner_subject: str
    agent_id: str
    agent_version: int
    conversation_id: str
    binding_id: str
    harness_id: str
    profile_id: str
    provider_session_id: str | None = None
    status: RunStatus = RunStatus.QUEUED
    last_sequence: int = 0
    client_request_id: str | None = None
    turn_id: str | None = None
    request_fingerprint: str | None = None
    cancellation_requested: bool = False
    error_code: str | None = None
    traceparent: str | None = None
    resumes_run_id: str | None = None
    interrupt_id: str | None = None
    command: Literal["start", "resume", "rewind", "reconcile"] = "start"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

class SessionBinding(StrictModel):
    binding_id: str
    owner_subject: str
    agent_id: str
    agent_version: int
    conversation_id: str
    harness_id: str
    profile_id: str
    provider_session_id: str | None = Field(None, max_length=1024)
    checkpoint_strategy: Literal["langgraph", "adapter_store", "remote_managed", "ephemeral"]
    native_state_key: str | None = None
    epoch: int = Field(0, ge=0)
    revision: int = Field(1, ge=1)
    status: Literal["active", "degraded", "closed"] = "active"
    active_run: RunRecord | None = None
    last_run_id: str | None = None
    dispatch_started: bool = False
    pending_interrupt: dict[str, Any] | None = None
    resume_run_id: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ClearAgentSessionRequest(StrictModel):
    agent_id: str = Field(..., min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.-]+$")
    conversation_id: str = Field(..., min_length=1, max_length=256)


class LookupRunRequest(ClearAgentSessionRequest):
    client_request_id: str = Field(..., min_length=1, max_length=128)


class ClearAgentSessionResult(StrictModel):
    cleared: bool
    closed_binding_id: str | None = None
    next_epoch: int = Field(0, ge=0)


class AttachmentReference(StrictModel):
    id: str = Field(..., min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.-]+$")


class ExecutionIdentity(StrictModel):
    """Transient caller credentials. Never included in run or event records."""

    subject: str
    email: str | None = None
    principal_type: Literal["user", "service_account"] = "user"
    bearer: SecretStr = Field(exclude=True, repr=False)
    user_context: dict[str, Any] = Field(default_factory=dict, exclude=True, repr=False)


class CreateRunRequest(StrictModel):
    agent_version: int | None = Field(None, ge=1)
    agent_id: str = Field(..., min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.-]+$")
    conversation_id: str = Field(..., min_length=1, max_length=256)
    message: str = Field("", max_length=1_000_000)
    context: str | None = Field(None, max_length=500_000)
    client_request_id: str | None = Field(None, min_length=1, max_length=128)
    command: Literal["start", "resume", "rewind", "reconcile"] = "start"
    resumes_run_id: str | None = Field(None, max_length=128)
    interrupt_id: str | None = Field(None, max_length=256)
    resume_data: dict[str, Any] | None = None
    attachments: list[AttachmentReference] = Field(default_factory=list, max_length=20)
    client_context: dict[str, Any] | None = None
    turn_id: str | None = Field(None, max_length=128)
    config_override: dict[str, Any] | None = None
    rewind_data: dict[str, Any] | None = None
    handoff_owner: Literal["dynamic_agents", "harness_engine"] | None = None

    @model_validator(mode="after")
    def validate_command(self) -> CreateRunRequest:
        if self.config_override is not None:
            if set(self.config_override) - {"model", "allowed_tools"}:
                raise ValueError("Unsupported per-turn execution override")
            model = self.config_override.get("model", {})
            if not isinstance(model, dict) or set(model) - {"reasoning_effort"}:
                raise ValueError("Only model reasoning effort can be overridden per turn")
            if "reasoning_effort" in model and model["reasoning_effort"] not in ("low", "medium", "high", "max"):
                raise ValueError("Invalid reasoning effort override")
            if "allowed_tools" in self.config_override:
                tools = self.config_override["allowed_tools"]
                if not isinstance(tools, dict) or any(
                    not isinstance(value, bool) and not (isinstance(value, list) and all(isinstance(item, str) for item in value))
                    for value in tools.values()
                ):
                    raise ValueError("Invalid allowed tools override")
        if self.handoff_owner and self.command != "reconcile":
            raise ValueError("Execution ownership changes require checkpoint reconciliation")
        if self.command == "reconcile":
            if self.attachments or self.resume_data is not None or self.message or self.resumes_run_id or self.interrupt_id:
                raise ValueError("Reconcile only inspects the native checkpoint")
        elif self.command == "rewind":
            if not self.turn_id or not self.rewind_data or not isinstance(self.rewind_data.get("message_content"), str) or type(self.rewind_data.get("content_occurrence")) is not int or self.rewind_data["content_occurrence"] < 1:
                raise ValueError("Rewind requires the persisted target turn and content occurrence")
            if self.attachments or self.resume_data is not None or self.resumes_run_id or self.interrupt_id:
                raise ValueError("Rewind cannot include new attachments or an approval")
        elif self.command == "resume":
            if not self.resumes_run_id or not self.interrupt_id or self.resume_data is None or self.attachments:
                raise ValueError("Resume requires the paused run, interrupt and response; attachments remain in native state")
        elif self.resume_data is not None or self.resumes_run_id or self.interrupt_id or not (self.message.strip() or self.attachments):
            raise ValueError("Start requires a message or attachments and cannot contain a resume response")
        return self


class CancelActiveRunRequest(StrictModel):
    agent_id: str = Field(..., min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.-]+$")
    conversation_id: str = Field(..., min_length=1, max_length=256)


class CancelActiveRunResult(StrictModel):
    cancelled: bool
    run_id: str | None = None
    cancellation_requested: bool = False


CanonicalEventType = Literal[
    "run.started",
    "session.updated",
    "content.delta",
    "reasoning.delta",
    "tool.started",
    "tool.completed",
    "interrupt.requested",
    "subagent.started",
    "subagent.event",
    "usage.updated",
    "runtime.event",
    "result.updated",
    "run.paused",
    "run.completed",
    "run.failed",
    "run.cancelled",
]


class CanonicalEventDraft(StrictModel):
    event_type: CanonicalEventType
    data: dict[str, Any] = Field(default_factory=dict)


class RunEvent(CanonicalEventDraft):
    run_id: str
    sequence: int = Field(..., ge=1)
    created_at: datetime = Field(default_factory=utc_now)


class EventPage(StrictModel):
    run: RunRecord
    events: list[RunEvent]
    next_cursor: int


class RenderedPrompt(StrictModel):
    system: str


class TurnInput(StrictModel):
    run_id: str
    message: str
    traceparent: str | None = None
    command: Literal["start", "resume", "rewind", "reconcile"] = "start"
    resume_data: dict[str, Any] | None = None
    attachments: list[AttachmentReference] = Field(default_factory=list)
    client_context: dict[str, Any] | None = None
    turn_id: str | None = None
    config_override: dict[str, Any] | None = None
    rewind_data: dict[str, Any] | None = None
    handoff_owner: Literal["dynamic_agents", "harness_engine"] | None = None


class TurnOutcome(StrictModel):
    status: Literal["completed", "paused", "cancelled"]
    interrupt: dict[str, Any] | None = None
    result: dict[str, Any] | None = None


class RunContext(StrictModel):
    blueprint: AgentBlueprint
    binding: SessionBinding
    prompt: RenderedPrompt
    turn: TurnInput
    identity: ExecutionIdentity | None = Field(None, exclude=True, repr=False)
