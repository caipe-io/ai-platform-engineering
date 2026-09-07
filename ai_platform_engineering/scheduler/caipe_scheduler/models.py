"""Pydantic models for the schedules API + Mongo docs."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


RunStatus = Literal["ok", "error"]
OneOffRunStatus = Literal[
  "pending",
  "claimed",
  "fired",
  "succeeded",
  "failed",
  "cancelled",
]
DEFAULT_HTTP_TIMEOUT_SECONDS = 300


def _default_http_timeout(value: Any) -> Any:
  return DEFAULT_HTTP_TIMEOUT_SECONDS if value is None else value


class LastRun(BaseModel):
  ts: datetime
  status: RunStatus
  error: str | None = None
  http_status: int | None = None


class ScheduleVersion(BaseModel):
  """Previous schedule settings captured before a successful PATCH."""

  model_config = ConfigDict(extra="ignore")

  version: int = 1
  superseded_at: datetime
  changed_fields: list[str] = Field(default_factory=list)
  title: str | None = None
  agent_id: str
  project_id: str | None = None
  edit_agent_id: str | None = None
  message_template: str
  attributes: dict[str, Any] = Field(default_factory=dict)
  cron: str
  tz: str
  http_timeout_seconds: int = DEFAULT_HTTP_TIMEOUT_SECONDS
  enabled: bool = True
  cronjob_name: str | None = None
  created_at: datetime | None = None
  updated_at: datetime | None = None

  @field_validator("http_timeout_seconds", mode="before")
  @classmethod
  def default_http_timeout(cls, value: Any) -> Any:
    return _default_http_timeout(value)


class ScheduleChange(BaseModel):
  before: Any = None
  after: Any = None


class ScheduleEvent(BaseModel):
  """Non-restorable schedule history, such as an infrastructure update."""

  model_config = ConfigDict(extra="ignore")

  event_id: str
  event_type: Literal["runner_image_reconciled"]
  occurred_at: datetime
  actor_type: Literal["user", "admin", "system"]
  actor_id: str
  source: Literal["deployment_reconcile", "operator_reconcile"]
  changed_fields: list[str] = Field(default_factory=list)
  changes: dict[str, ScheduleChange] = Field(default_factory=dict)


class ScheduleCreate(BaseModel):
  """Body of POST /v1/schedules."""

  model_config = ConfigDict(extra="forbid")

  agent_id: str = Field(
    ...,
    description="Dynamic agent _id (e.g. 'agent-weekly-report'). Must exist in dynamic_agents collection.",
  )
  project_id: str | None = Field(
    default=None,
    description="Optional immutable memory Project ID for each scheduled chat run.",
  )
  title: str = Field(
    ...,
    min_length=1,
    max_length=200,
    description="Human-readable job title shown in schedule UIs.",
  )
  message_template: str = Field(
    ...,
    description="The chat message body posted on each fire. Plain text, no template engine.",
  )
  cron: str = Field(..., description="Standard 5-field cron string (e.g. '0 9 * * MON').")
  tz: str = Field(..., description="IANA timezone name (e.g. 'America/Los_Angeles').")
  attributes: dict[str, Any] = Field(
    default_factory=dict,
    description=("Optional JSON object with small display attributes for UIs (for example {'project': 'platform'})."),
  )
  edit_agent_id: str | None = Field(
    default=None,
    description=("Optional Dynamic Agent _id to use when a user wants to edit this schedule. When unset, UIs use their default schedule editor agent."),
  )
  http_timeout_seconds: int = Field(
    default=DEFAULT_HTTP_TIMEOUT_SECONDS,
    ge=1,
    description=(
      "Optional per-fire HTTP timeout in seconds for the cron-runner chat invoke. "
      "Defaults to 300."
    ),
  )

  @field_validator("title")
  @classmethod
  def title_must_not_be_blank(cls, value: str) -> str:
    value = value.strip()
    if not value:
      raise ValueError("title must be a non-empty string")
    return value

  @field_validator("edit_agent_id")
  @classmethod
  def edit_agent_id_must_not_be_blank(cls, value: str | None) -> str | None:
    if value is None:
      return value
    value = value.strip()
    if not value:
      raise ValueError("edit_agent_id must be a non-empty string")
    return value

  @field_validator("project_id")
  @classmethod
  def project_id_must_not_be_blank(cls, value: str | None) -> str | None:
    if value is None:
      return value
    value = value.strip()
    if not value:
      raise ValueError("project_id must be a non-empty string")
    return value


class SchedulePatch(BaseModel):
  """Body of PATCH /v1/schedules/{id}. All fields optional."""

  model_config = ConfigDict(extra="forbid")

  agent_id: str | None = None
  project_id: str | None = None
  edit_agent_id: str | None = None
  enabled: bool | None = None
  cron: str | None = None
  tz: str | None = None
  message_template: str | None = None
  title: str | None = None
  attributes: dict[str, Any] | None = None
  http_timeout_seconds: int | None = Field(default=None, ge=1)

  @field_validator("title")
  @classmethod
  def patch_title_must_not_be_blank(cls, value: str | None) -> str | None:
    if value is None:
      return value
    value = value.strip()
    if not value:
      raise ValueError("title must be a non-empty string")
    return value

  @field_validator("edit_agent_id")
  @classmethod
  def patch_edit_agent_id_must_not_be_blank(cls, value: str | None) -> str | None:
    if value is None:
      return value
    value = value.strip()
    if not value:
      raise ValueError("edit_agent_id must be a non-empty string")
    return value

  @field_validator("project_id")
  @classmethod
  def patch_project_id_must_not_be_blank(cls, value: str | None) -> str | None:
    if value is None:
      return value
    value = value.strip()
    if not value:
      raise ValueError("project_id must be a non-empty string")
    return value


class Schedule(BaseModel):
  """Full schedule doc as stored in Mongo + returned by API."""

  model_config = ConfigDict(extra="ignore")

  schedule_id: str
  owner_sub: str | None = None
  owner_user_id: str
  agent_id: str
  project_id: str | None = None
  edit_agent_id: str | None = None
  title: str | None = None
  message_template: str
  attributes: dict[str, Any] = Field(default_factory=dict)
  cron: str
  tz: str
  http_timeout_seconds: int = DEFAULT_HTTP_TIMEOUT_SECONDS
  enabled: bool = True
  cronjob_name: str | None = None
  created_at: datetime
  updated_at: datetime
  last_run: LastRun | None = None
  version: int = 1
  versions: list[ScheduleVersion] = Field(default_factory=list)
  events: list[ScheduleEvent] = Field(default_factory=list)

  @field_validator("http_timeout_seconds", mode="before")
  @classmethod
  def default_http_timeout(cls, value: Any) -> Any:
    return _default_http_timeout(value)


class ScheduleCreateResponse(BaseModel):
  schedule_id: str
  cronjob_name: str


class ScheduleList(BaseModel):
  items: list[Schedule]


class CronJobReconcileRequest(BaseModel):
  """Body of POST /v1/admin/reconcile-cronjobs."""

  model_config = ConfigDict(extra="forbid")

  dry_run: bool = True
  schedule_id: str | None = Field(
    default=None,
    description="Optional single schedule to reconcile. When omitted, all schedules are checked.",
  )


class CronJobReconcileItem(BaseModel):
  schedule_id: str
  cronjob_name: str
  status: Literal["current", "would_patch", "patched", "missing", "error"]
  current_image: str | None = None
  desired_image: str | None = None
  current_image_pull_policy: str | None = None
  desired_image_pull_policy: str | None = None
  error: str | None = None


class CronJobReconcileResponse(BaseModel):
  dry_run: bool
  desired_image: str
  desired_image_pull_policy: str
  total: int
  current: int
  would_patch: int
  patched: int
  missing: int
  failed: int
  items: list[CronJobReconcileItem]


class ScheduleOneOffCreate(BaseModel):
  """Body of POST /v1/schedules/{id}/one-off-runs."""

  model_config = ConfigDict(extra="forbid")

  run_at: datetime | None = Field(
    default=None,
    description=("Exact UTC or timezone-aware timestamp for the one-off fire. If omitted, pass delay_minutes."),
  )
  delay_minutes: int | None = Field(
    default=None,
    ge=0,
    description="Delay from now before firing. Mutually exclusive with run_at.",
  )
  message_template: str | None = Field(
    default=None,
    description=("Optional one-off message body. When omitted, the parent schedule's message_template is used."),
  )
  reason: str | None = Field(
    default=None,
    max_length=200,
    description="Optional short reason such as upstream_not_ready.",
  )
  metadata: dict[str, Any] = Field(
    default_factory=dict,
    description=("Optional small JSON object carried into the one-off runner metadata. Use for domain context such as requested_by, source_event, or retry_reason."),
  )
  retry_num: int | None = Field(
    default=None,
    ge=0,
    description="Optional retry attempt number carried into the runner.",
  )
  retry_limit: int | None = Field(
    default=None,
    ge=0,
    description="Optional retry limit carried into the runner.",
  )

  @model_validator(mode="after")
  def exactly_one_time_source(self) -> "ScheduleOneOffCreate":
    if (self.run_at is None) == (self.delay_minutes is None):
      raise ValueError("Pass exactly one of run_at or delay_minutes.")
    return self


class ScheduleOneOffRun(BaseModel):
  """Stored one-off fire linked to a recurring parent schedule."""

  model_config = ConfigDict(extra="ignore")

  one_off_run_id: str
  schedule_id: str
  owner_sub: str | None = None
  owner_user_id: str
  run_at: datetime
  status: OneOffRunStatus = "pending"
  message_template: str | None = None
  reason: str | None = None
  metadata: dict[str, Any] = Field(default_factory=dict)
  retry_num: int | None = None
  retry_limit: int | None = None
  job_name: str | None = None
  error: str | None = None
  http_status: int | None = None
  created_at: datetime
  updated_at: datetime
  claimed_at: datetime | None = None
  fired_at: datetime | None = None
  completed_at: datetime | None = None


class ScheduleOneOffList(BaseModel):
  items: list[ScheduleOneOffRun]


class LastRunReport(BaseModel):
  """Body of POST /v1/schedules/{id}/runs (cron-runner reports back)."""

  model_config = ConfigDict(extra="forbid")

  status: RunStatus
  error: str | None = None
  http_status: int | None = None
  one_off_run_id: str | None = None
