"""Typed native stream events, before any client protocol or SSE formatting."""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


class _Event(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class RunStarted(_Event):
    kind: Literal["run_started"] = "run_started"
    run_id: str
    thread_id: str


class TextDelta(_Event):
    kind: Literal["text_delta"] = "text_delta"
    text: str
    namespace: tuple[str, ...] = ()


class UpdatesBoundary(_Event):
    """A graph update closes the preceding text segment in this namespace."""

    kind: Literal["updates_boundary"] = "updates_boundary"
    namespace: tuple[str, ...] = ()


class ToolStarted(_Event):
    kind: Literal["tool_started"] = "tool_started"
    tool_call_id: str
    tool_name: str
    args: Any
    namespace: tuple[str, ...] = ()


class ToolCompleted(_Event):
    kind: Literal["tool_completed"] = "tool_completed"
    tool_call_id: str
    message_id: str | None
    content: str
    error: str | None = None
    namespace: tuple[str, ...] = ()


class ContextUsage(_Event):
    kind: Literal["context_usage"] = "context_usage"
    value: dict[str, Any]
    namespace: tuple[str, ...] = ()


class StreamEnded(_Event):
    kind: Literal["stream_ended"] = "stream_ended"


class RunFinished(_Event):
    kind: Literal["run_finished"] = "run_finished"
    run_id: str
    thread_id: str


class RunError(_Event):
    kind: Literal["run_error"] = "run_error"
    message: str
    code: str | None = None


class WarningEvent(_Event):
    kind: Literal["warning"] = "warning"
    message: str


class InputRequired(_Event):
    kind: Literal["input_required"] = "input_required"
    interrupt_id: str
    interrupt_type: str
    prompt: str
    fields: list[dict[str, Any]]
    agent: str
    tool_name: str | None = None
    tool_args: dict[str, Any] | None = None
    allowed_decisions: list[str] | None = None
    tool_approvals: list[dict[str, Any]] | None = None


StreamEvent = Annotated[
    RunStarted | TextDelta | UpdatesBoundary | ToolStarted | ToolCompleted | ContextUsage
    | StreamEnded | RunFinished | RunError | WarningEvent | InputRequired,
    Field(discriminator="kind"),
]
STREAM_EVENT_ADAPTER = TypeAdapter(StreamEvent)
