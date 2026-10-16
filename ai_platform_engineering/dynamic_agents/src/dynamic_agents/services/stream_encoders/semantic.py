"""Native event output from the same lifecycle used by the UI encoders."""

from typing import Any

from dynamic_agents.services.stream_encoders import StreamEncoder
from dynamic_agents.services.stream_encoders.events import (
    InputRequired,
    RunError,
    RunFinished,
    RunStarted,
    StreamEnded,
    StreamEvent,
    WarningEvent,
)


class SemanticStreamEncoder(StreamEncoder[StreamEvent]):
    """Emit typed native values without choosing a browser wire protocol."""

    def _format_event(self, event: StreamEvent) -> list[StreamEvent]:
        return [event]

    def on_run_start(self, run_id: str, thread_id: str) -> list[StreamEvent]:
        return [RunStarted(run_id=run_id, thread_id=thread_id)]

    def on_stream_end(self) -> list[StreamEvent]:
        return [StreamEnded()]

    def on_run_finish(self, run_id: str, thread_id: str) -> list[StreamEvent]:
        return [RunFinished(run_id=run_id, thread_id=thread_id)]

    def on_run_error(self, message: str, code: str | None = None) -> list[StreamEvent]:
        return [RunError(message=message, code=code)]

    def on_warning(self, message: str) -> list[StreamEvent]:
        return [WarningEvent(message=message)]

    def on_input_required(
        self, interrupt_id: str, interrupt_type: str, prompt: str,
        fields: list[dict[str, Any]], agent: str, tool_name: str | None = None,
        tool_args: dict[str, Any] | None = None, allowed_decisions: list[str] | None = None,
        tool_approvals: list[dict[str, Any]] | None = None,
    ) -> list[StreamEvent]:
        return [InputRequired(
            interrupt_id=interrupt_id, interrupt_type=interrupt_type, prompt=prompt, fields=fields,
            agent=agent, tool_name=tool_name, tool_args=tool_args,
            allowed_decisions=allowed_decisions, tool_approvals=tool_approvals,
        )]
