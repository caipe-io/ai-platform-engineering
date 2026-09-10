"""Pydantic models for Autonomous Agents service."""

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator


class TriggerType(str, Enum):
    CRON = "cron"
    WEBHOOK = "webhook"
    INTERVAL = "interval"


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


# =============================================================================
# Trigger definitions
# =============================================================================

class CronTrigger(BaseModel):
    """Trigger for cron-scheduled tasks"""
    type: Literal[TriggerType.CRON] = TriggerType.CRON
    schedule: str = Field(..., description="Cron expression e.g. '0 9 * * *'")


class IntervalTrigger(BaseModel):
    """Trigger for interval-scheduled tasks"""
    type: Literal[TriggerType.INTERVAL] = TriggerType.INTERVAL
    seconds: int | None = None
    minutes: int | None = None
    hours: int | None = None

    @model_validator(mode="after")
    def require_positive_interval(self) -> "IntervalTrigger":
        """Require at least one positive field and reject non-positive values."""
        invalid = [name for name, val in [("seconds", self.seconds), ("minutes", self.minutes), ("hours", self.hours)] if val is not None and val <= 0]
        if invalid:
            raise ValueError(f"IntervalTrigger fields must be positive integers: {', '.join(invalid)}")
        if not any([self.seconds, self.minutes, self.hours]):
            raise ValueError("IntervalTrigger requires at least one of seconds, minutes, or hours to be a positive integer")
        return self


class WebhookTrigger(BaseModel):
    """Trigger for webhook-scheduled tasks"""
    type: Literal[TriggerType.WEBHOOK] = TriggerType.WEBHOOK
    secret: str | None = Field(
        None,
        description=(
            "HMAC secret for payload validation. The create route always generates "
            "this value; None is accepted only so redacted update payloads can "
            "preserve the already-stored secret."
        ),
    )
    provider: str = Field(
        default="generic_hmac",
        description=(
            "Webhook provider adapter id from webhook_providers.yaml "
            "Use 'generic_hmac' for vendor-neutral HMAC webhooks. "
            "Missing values default to 'generic_hmac'."
        ),
    )
    dedup_header: str | None = Field(
        default=None,
        description=(
            "HTTP header name carrying a unique delivery id. When set "
            "Used as the dedup key for the trigger_instances collection "
            "so retries from the sender don't double-fire the task."
        ),
    )


Trigger = CronTrigger | IntervalTrigger | WebhookTrigger


# =============================================================================
# Pre-flight acknowledgement
# =============================================================================

class Acknowledgement(BaseModel):
    """Structured pre-flight result for an autonomous task target.

    Both supervisor-backed tasks and dynamic-agent-backed tasks persist
    this shape on ``TaskDefinition.last_ack`` so the UI can render the
    same badge regardless of which backend will execute the task.
    """

    ack_status: Literal["ok", "warn", "failed", "pending"] = Field(
        ...,
        description=(
            "ok = target confirmed the routing path is viable. "
            "warn = target reachable but flagged a soft issue. "
            "failed = target reachable and flagged a hard issue. "
            "pending = target unreachable; will retry."
        ),
    )
    ack_detail: str = Field(
        default="",
        description="Human-readable detail line shown in the UI badge tooltip.",
    )
    routed_to: Optional[str] = Field(
        default=None,
        description="Sub-agent or dynamic agent the task would route to.",
    )
    tools: list[str] = Field(
        default_factory=list,
        description="Tool names the target has loaded.",
    )
    available_agents: list[str] = Field(
        default_factory=list,
        description="All agents currently visible to the target service.",
    )
    credentials_status: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Map of credential-name -> status (e.g. 'github_pat': 'ok'). "
            "Empty in the light preflight; populated by future heavy-probe."
        ),
    )
    dry_run_summary: str = Field(
        default="",
        description="Plain-English summary of what the task will do at run time.",
    )
    ack_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        description="When this ack was produced (server time).",
    )

    @classmethod
    def transport_failure(cls, detail: str) -> "Acknowledgement":
        """Build an ack representing 'target never answered'."""
        return cls(
            ack_status="pending",
            ack_detail=detail,
            routed_to=None,
            tools=[],
            available_agents=[],
            credentials_status={},
            dry_run_summary="Target service unreachable; will retry on next task touch.",
        )

    @classmethod
    def application_failure(cls, detail: str) -> "Acknowledgement":
        """Build an ack representing 'target answered with an application error'."""
        return cls(
            ack_status="failed",
            ack_detail=detail,
            routed_to=None,
            tools=[],
            available_agents=[],
            credentials_status={},
            dry_run_summary="Target service refused the preflight; see ack_detail.",
        )


# =============================================================================
# Task definition
# =============================================================================

class TaskDefinition(BaseModel):
    id: str = Field(..., description="Unique task identifier")
    name: str = Field(..., description="Human-readable task name")
    description: str | None = None
    agent: str | None = Field(
        default=None,
        description=(
            "Deprecated supervisor sub-agent hint. The supervisor was removed "
            "upstream; this field is ignored for routing and retained only so "
            "task definitions persisted before the dynamic-only model still "
            "load. Use dynamic_agent_id instead."
        ),
    )
    dynamic_agent_id: str | None = Field(
        default=None,
        description=(
            "Dynamic-agents service agent id. Required for new tasks: the "
            "dynamic-agents runtime is the only execution backend, so every "
            "task runs the prompt through this custom agent (its tools / "
            "system prompt / model / middleware). Optional on the model only "
            "so legacy rows load; creation rejects tasks without it."
        ),
    )
    prompt: str = Field(..., description="Prompt sent to the agent when this task fires")
    trigger: CronTrigger | IntervalTrigger | WebhookTrigger = Field(..., discriminator="type")
    llm_provider: str | None = Field(
        None,
        description=(
            "Deprecated. The dynamic agent's own model configuration governs "
            "execution; this field is ignored and kept only for backward "
            "compatibility with persisted task definitions."
        ),
    )
    enabled: bool = True
    metadata: dict[str, Any] = Field(default_factory=dict)
    owner_id: str | None = Field(
        default=None,
        description=(
            "Email of the user who created this task. "
            "Stamped by the Next.js gateway at creation time and used to scope "
            "conversation ownership and task-list filtering. "
            "None for tasks created before this field was introduced."
        ),
    )
    owner_sub: str | None = Field(
        default=None,
        description=(
            "Keycloak subject (UUID) of the user who created this task. "
            "Stamped by the Next.js gateway at creation time alongside "
            "owner_id. Unlike owner_id (an email), this is the identifier "
            "OpenFGA/CAS use to key subjects, so it is what the dynamic-agents "
            "runtime authorizes against when running the task unattended on the "
            "owner's behalf. None for tasks created before this field was "
            "introduced — such tasks cannot be authorized per-owner and must be "
            "recreated."
        ),
    )

    @model_validator(mode="after")
    def _drop_deprecated_agent_hint(self) -> "TaskDefinition":
        """Clear the deprecated ``agent`` hint when a dynamic agent is set.

        ``agent`` is a no-op legacy field (the supervisor it routed to was
        removed). When a task also carries ``dynamic_agent_id`` we drop the
        stale hint so persisted definitions converge on the dynamic-only
        routing model.
        """
        if self.dynamic_agent_id and self.agent:
            object.__setattr__(self, "agent", None)
        return self

    # ------------------------------------------------------------------
    # Pre-flight acknowledgement (spec #099, FR-002)
    # ------------------------------------------------------------------
    # Server-managed: the create/update routes scrub any client-supplied
    # value and overwrite this field with the result of the actual
    # preflight call to the target service. We declare the field as ``Any``
    # rather than typing it as ``Acknowledgement`` so persisted plain dicts
    # loaded from MongoDB remain valid without a conversion step.
    last_ack: Any | None = Field(
        default=None,
        description=(
            "Most recent pre-flight acknowledgement for this task. "
            "Server-managed; client-supplied values are ignored on POST/PUT."
        ),
    )


# =============================================================================
# Task run records
# =============================================================================

class FollowUpContext(BaseModel):
    """Operator follow-up that re-fires an existing webhook task.

    Carries the bits the task-runtime LLM needs to keep the conversation
    going: who replied, what they said, and which prior run they are
    responding to. The chat-thread synthesiser uses ``parent_run_id`` to
    link the resulting TaskRun back to its originator so the UI can
    render a single timeline instead of two unrelated rows.
    """

    parent_run_id: str = Field(
        ..., description="run_id of the task run that this is a follow-up to"
    )
    user_text: str = Field(
        ..., description="Free-form follow-up text from the operator"
    )
    user_ref: str | None = Field(
        default=None,
        description=(
            "Stable identifier for the replier (e.g. Webex personEmail) -- "
            "used as a non-PII audit hint in chat history. Optional so "
            "non-Webex transports can omit it."
        ),
    )
    transport: str | None = Field(
        default=None,
        description=(
            "Name of the inbound bridge that produced this follow-up "
            "(e.g. 'webex'). Free-form so future bridges (slack, "
            "teams, ...) can reuse the field without a model bump."
        ),
    )


class TaskRunFollowUpCreate(BaseModel):
    """Authenticated UI request to continue one webhook run."""

    user_text: str = Field(
        ...,
        min_length=1,
        max_length=10_000,
        description="Operator message to send in the selected run's context.",
    )



class TaskCreate(TaskDefinition):
    """Request body for ``POST /tasks``.

    ``id`` is server-generated it is optional here purely
    so FastAPI does not 422 a body that omits it, and any value supplied is
    discarded by the route. ``TaskDefinition.id`` deliberately stays REQUIRED
    so every reader keeps its non-empty guarantee -- subclassing scopes the
    looseness to the one place that needs it.
    """

    id: str = Field(default="", description="Ignored -- the server generates the id.")


class TaskRun(BaseModel):
    """Record of a single execution of a task definition."""
    run_id: str
    task_id: str
    task_name: str
    status: TaskStatus
    started_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: datetime | None = None
    response_preview: str | None = None
    error: str | None = None
    # When this run was produced by a follow-up reply (e.g. the Webex
    # bot forwarding an in-thread message), this points at the run
    # the operator was replying to. Lets the UI render a single
    # threaded timeline instead of unrelated rows. ``None`` for the
    # original webhook fire and for cron / interval / manual runs.
    parent_run_id: str | None = None
    # Root delivery for a webhook conversation branch. Initial deliveries set
    # this to their own run_id; follow-ups inherit it from the selected parent.
    # None for cron/interval runs and legacy webhook records.
    root_run_id: str | None = None
    # Dynamic Agents conversation/checkpointer id used for execution. This is
    # intentionally distinct from ``conversation_id`` below: the latter is a
    # UI chat-history link, while this field protects execution isolation.
    execution_context_id: str | None = None
    # Exact operator message for a follow-up run. Stored separately from the
    # augmented request_prompt so timeline clients can render a clean user turn.
    follow_up_text: str | None = None
    follow_up_transport: str | None = None
    # Prompt materialised for this specific run. For normal scheduled
    # runs this is the task prompt; for inbound follow-ups it includes
    # the operator reply appended by task_runner. The UI's autonomous
    # chat synthesiser uses this for the user-side prompt bubble.
    request_prompt: str | None = None
    # IMP-13: id of the chat-history conversation that mirrors this
    # run, when publishing is enabled. Lets the UI deep-link from a
    # run row to ``/chat/<conversation_id>``. Optional and stable per
    # ``run_id`` (UUID5-derived) so the field is safe to leave unset
    # for runs from before publishing was turned on.
    conversation_id: str | None = None
    # When this run was kicked off by a webhook delivery, this is the
    # ``_id`` of the row in ``trigger_instances`` that recorded the
    # delivery. Lets audit tooling navigate from "what fired this run?"
    # back to the originating webhook payload metadata. ``None`` for
    # cron / interval / manual-trigger runs.
    trigger_instance_id: str | None = None
    # Full agent response and captured streaming events from the
    # dynamic-agents run (``invoke_dynamic_agent_streaming``). ``None`` /
    # empty for runs persisted before this field existed.
    # The chat-thread synthesiser in the UI replays ``events`` so past
    # scheduled fires render with the same plan + tools + timeline a
    # typed chat reply gets, rather than the 500-char ``response_preview``
    # tombstone. ``response_full`` is the same text that appears in the
    # final_result artifact, kept alongside the events as a cheap
    # convenience for callers (search, downstream formatters, audit
    # logs) that don't want to walk the events list.
    response_full: str | None = None
    events: list[dict[str, Any]] = Field(default_factory=list)
    # Email of the user who owns the parent task, copied from
    # TaskDefinition.owner_id at run creation time. Allows direct run
    # filtering without joining through tasks, and is used by the chat
    # history publisher to set conversation owner_id. None for runs
    # created before per-user ownership was introduced.
    owner_id: str | None = None


# =============================================================================
# Webhook payload
# =============================================================================

class WebhookPayload(BaseModel):
    """Generic webhook payload — passed as context to the agent prompt."""
    source: str | None = None
    event: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)
