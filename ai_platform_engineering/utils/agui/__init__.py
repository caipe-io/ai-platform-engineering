# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0

"""
AG-UI event emitter module.

Provides standardised AG-UI event types, emitter helpers, and SSE encoding
utilities that all agents can use to emit consistent streaming events.

Quick start::

    from ai_platform_engineering.utils.agui import (
        # Event models
        RunStartedEvent,
        TextMessageContentEvent,
        ToolCallStartEvent,
        CustomEvent,
        AGUIEventType,
        # Emitter helpers
        emit_run_started,
        emit_run_finished,
        emit_run_error,
        emit_text_start,
        emit_text_content,
        emit_text_end,
        emit_tool_start,
        emit_tool_args,
        emit_tool_end,
        emit_state_snapshot,
        emit_state_delta,
        emit_custom,
        # SSE encoding
        format_sse_event,
        encode_events,
        encode_events_async,
    )

    # Emit a text chunk and encode it as SSE
    event = emit_text_content(message_id="msg-1", delta="Hello ")
    sse_frame = format_sse_event(event)
"""

# Event type enum and Pydantic models
from .event_types import (
    AGUIEvent,
    AGUIEventType,
    BaseAGUIEvent,
    CustomEvent,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateDeltaEvent,
    StateSnapshotEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
)

# Emitter factory functions
from .event_emitter import (
    emit_custom,
    emit_run_error,
    emit_run_finished,
    emit_run_started,
    emit_state_delta,
    emit_state_snapshot,
    emit_text_content,
    emit_text_end,
    emit_text_start,
    emit_tool_args,
    emit_tool_end,
    emit_tool_start,
)

# SSE encoder
from .encoder import (
    encode_events,
    encode_events_async,
    format_sse_event,
)

__all__ = [
    # ---- Event type enum ----
    "AGUIEventType",
    # ---- Base model ----
    "BaseAGUIEvent",
    # ---- Run lifecycle ----
    "RunStartedEvent",
    "RunFinishedEvent",
    "RunErrorEvent",
    # ---- Text message lifecycle ----
    "TextMessageStartEvent",
    "TextMessageContentEvent",
    "TextMessageEndEvent",
    # ---- Tool call lifecycle ----
    "ToolCallStartEvent",
    "ToolCallArgsEvent",
    "ToolCallEndEvent",
    # ---- State management ----
    "StateSnapshotEvent",
    "StateDeltaEvent",
    # ---- Custom events ----
    "CustomEvent",
    # ---- Union type ----
    "AGUIEvent",
    # ---- Emitter helpers ----
    "emit_run_started",
    "emit_run_finished",
    "emit_run_error",
    "emit_text_start",
    "emit_text_content",
    "emit_text_end",
    "emit_tool_start",
    "emit_tool_args",
    "emit_tool_end",
    "emit_state_snapshot",
    "emit_state_delta",
    "emit_custom",
    # ---- SSE encoder ----
    "format_sse_event",
    "encode_events",
    "encode_events_async",
]
