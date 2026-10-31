"""Typed execution boundary shared by the HTTP runtime and Harness Engine.

The existing encoders project the same graph chunks into typed payloads before
SSE framing. Keeping both projections preserves namespace and tool correlation
for historical custom clients as well as AG-UI clients without parsing SSE.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any, Literal

from dynamic_agents.models import InputFile
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.stream_encoders import StreamEncoder
from dynamic_agents.services.stream_encoders.agui_sse import AGUIStreamEncoder
from dynamic_agents.services.stream_encoders.custom_sse import CustomStreamEncoder


@dataclass(frozen=True)
class RuntimeEvent:
    protocol: Literal["agui", "custom"]
    name: str
    data: dict[str, Any]


@dataclass(frozen=True)
class TurnOutcome:
    status: Literal["completed", "paused", "cancelled"]
    interrupt: dict[str, Any] | None = None
    result: dict[str, Any] | None = None


class ExecutionEncoder(StreamEncoder[RuntimeEvent]):
    """Fan out payload projection while executing the underlying graph once."""

    def __init__(self) -> None:
        self.agui = AGUIStreamEncoder(lambda name, data: RuntimeEvent("agui", name, data))
        self.custom = CustomStreamEncoder(lambda name, data: RuntimeEvent("custom", name, data))
        self.finished = False
        self.interrupt: dict[str, Any] | None = None

    def on_run_start(self, run_id: str, thread_id: str) -> list[RuntimeEvent]:
        # Initialize correlation state; the coordinator owns public lifecycle events.
        self.agui.on_run_start(run_id, thread_id)
        self.custom.on_run_start(run_id, thread_id)
        return []

    def on_chunk(self, chunk: tuple) -> list[RuntimeEvent]:
        return [*self.agui.on_chunk(chunk), *self.custom.on_chunk(chunk)]

    def on_stream_end(self) -> list[RuntimeEvent]:
        return [*self.agui.on_stream_end(), *self.custom.on_stream_end()]

    def on_run_finish(self, run_id: str, thread_id: str) -> list[RuntimeEvent]:
        self.finished = True
        return []

    def on_run_error(self, message: str, code: str | None = None) -> list[RuntimeEvent]:
        raise RuntimeError(code or "runtime_execution_failed")

    def on_warning(self, message: str) -> list[RuntimeEvent]:
        return [*self.agui.on_warning(message), *self.custom.on_warning(message)]

    def on_structured_output(self, payload: dict[str, Any], schema_id: str | None = None) -> list[RuntimeEvent]:
        super().on_structured_output(payload, schema_id)
        return [
            *self.agui.on_structured_output(payload, schema_id),
            *self.custom.on_structured_output(payload, schema_id),
        ]

    def on_input_required(
        self,
        interrupt_id: str,
        interrupt_type: str,
        prompt: str,
        fields: list[dict[str, Any]],
        agent: str,
        tool_name: str | None = None,
        tool_args: dict[str, Any] | None = None,
        allowed_decisions: list[str] | None = None,
        tool_approvals: list[dict[str, Any]] | None = None,
    ) -> list[RuntimeEvent]:
        self.interrupt = {
            "interrupt_id": interrupt_id,
            "interrupt_type": interrupt_type,
            "prompt": prompt,
            "fields": fields,
            "agent": agent,
            "tool_name": tool_name,
            "tool_args": tool_args,
            "allowed_decisions": allowed_decisions,
            "tool_approvals": tool_approvals,
        }
        return []

    def get_accumulated_content(self) -> str:
        return self.agui.get_accumulated_content()

    def get_thinking_content(self) -> str:
        return self.agui.get_thinking_content()


async def execute_turn(
    runtime: AgentRuntime,
    *,
    session_id: str,
    user_id: str,
    message: str = "",
    resume_data: str | None = None,
    trace_id: str | None = None,
    files: list[InputFile] | None = None,
    turn_id: str | None = None,
    cancellation_event: asyncio.Event | None = None,
) -> AsyncIterator[RuntimeEvent | TurnOutcome]:
    """Run the existing start/resume implementation and require an explicit outcome."""
    encoder = ExecutionEncoder()
    cancellation = {"cancellation_event": cancellation_event} if cancellation_event is not None else {}
    stream = (
        runtime.resume(session_id, user_id, resume_data, trace_id, encoder, **cancellation)
        if resume_data is not None
        else runtime.stream(message, session_id, user_id, trace_id, encoder, files=files, turn_id=turn_id, **cancellation)
    )
    async with aclosing(stream):
        async for event in stream:
            yield event
    if runtime._cancelled:
        yield TurnOutcome("cancelled")
    elif encoder.interrupt is not None:
        yield TurnOutcome("paused", encoder.interrupt)
    elif encoder.finished:
        yield TurnOutcome(
            "completed",
            result={
                "content": encoder.get_accumulated_content(),
                "thinking": encoder.get_thinking_content(),
                "structured_output": encoder.get_structured_output(),
            },
        )
    else:
        raise RuntimeError("Runtime ended without an execution outcome")
