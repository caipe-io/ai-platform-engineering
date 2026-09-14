# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0

"""
AG-UI event type definitions.

Defines the full set of standardised AG-UI event types and their
corresponding Pydantic v2 models.  All agents that emit streaming events
should use these types to ensure a consistent wire format.

Reference: https://docs.ag-ui.com/concepts/events
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Event type enum
# ---------------------------------------------------------------------------


class AGUIEventType(str, Enum):
    """Canonical AG-UI event type identifiers."""

    # Run lifecycle
    RUN_STARTED = "RUN_STARTED"
    RUN_FINISHED = "RUN_FINISHED"
    RUN_ERROR = "RUN_ERROR"

    # Text message lifecycle
    TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
    TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
    TEXT_MESSAGE_END = "TEXT_MESSAGE_END"

    # Tool call lifecycle
    TOOL_CALL_START = "TOOL_CALL_START"
    TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
    TOOL_CALL_END = "TOOL_CALL_END"

    # State management
    STATE_SNAPSHOT = "STATE_SNAPSHOT"
    STATE_DELTA = "STATE_DELTA"

    # Custom / extension events
    CUSTOM = "CUSTOM"


# ---------------------------------------------------------------------------
# Base event model
# ---------------------------------------------------------------------------


class BaseAGUIEvent(BaseModel):
    """Common fields shared by every AG-UI event."""

    type: AGUIEventType
    timestamp: float = Field(
        default_factory=lambda: datetime.now(timezone.utc).timestamp(),
        description="Unix epoch timestamp (seconds since 1970-01-01 UTC).",
    )

    model_config = {"populate_by_name": True}


# ---------------------------------------------------------------------------
# Run lifecycle events
# ---------------------------------------------------------------------------


class RunStartedEvent(BaseAGUIEvent):
    """Emitted when a new agent run (stream) begins."""

    type: AGUIEventType = AGUIEventType.RUN_STARTED
    run_id: str = Field(..., description="Unique identifier for this run.", alias="runId")
    thread_id: str = Field(..., description="Conversation thread identifier.", alias="threadId")

    model_config = {"populate_by_name": True}


class RunFinishedEvent(BaseAGUIEvent):
    """Emitted when the agent run completes successfully."""

    type: AGUIEventType = AGUIEventType.RUN_FINISHED
    run_id: str = Field(..., description="Unique identifier for the completed run.", alias="runId")
    thread_id: str = Field(..., description="Conversation thread identifier.", alias="threadId")

    model_config = {"populate_by_name": True}


class RunErrorEvent(BaseAGUIEvent):
    """Emitted when an unrecoverable error terminates the run."""

    type: AGUIEventType = AGUIEventType.RUN_ERROR
    message: str = Field(..., description="Human-readable error message.")
    code: Optional[str] = Field(default=None, description="Optional machine-readable error code.")

    model_config = {"populate_by_name": True}


# ---------------------------------------------------------------------------
# Text message lifecycle events
# ---------------------------------------------------------------------------


class TextMessageStartEvent(BaseAGUIEvent):
    """Emitted at the start of a new assistant message."""

    type: AGUIEventType = AGUIEventType.TEXT_MESSAGE_START
    message_id: str = Field(..., description="Unique identifier for this message.", alias="messageId")
    role: str = Field(
        default="assistant",
        description="Message role, typically 'assistant'.",
    )

    model_config = {"populate_by_name": True}


class TextMessageContentEvent(BaseAGUIEvent):
    """Emitted for each streamed text chunk within a message."""

    type: AGUIEventType = AGUIEventType.TEXT_MESSAGE_CONTENT
    message_id: str = Field(..., description="Identifier of the owning message.", alias="messageId")
    delta: str = Field(..., description="The incremental text chunk being streamed.")

    model_config = {"populate_by_name": True}


class TextMessageEndEvent(BaseAGUIEvent):
    """Emitted when the full message has been streamed."""

    type: AGUIEventType = AGUIEventType.TEXT_MESSAGE_END
    message_id: str = Field(..., description="Identifier of the completed message.", alias="messageId")

    model_config = {"populate_by_name": True}


# ---------------------------------------------------------------------------
# Tool call lifecycle events
# ---------------------------------------------------------------------------


class ToolCallStartEvent(BaseAGUIEvent):
    """Emitted when a tool/function call begins."""

    type: AGUIEventType = AGUIEventType.TOOL_CALL_START
    tool_call_id: str = Field(
        ...,
        description="Unique identifier for this tool invocation.",
        alias="toolCallId",
    )
    tool_call_name: str = Field(
        ...,
        description="Name of the tool being invoked.",
        alias="toolCallName",
    )
    parent_message_id: Optional[str] = Field(
        default=None,
        description="ID of the assistant message that triggered this tool call.",
        alias="parentMessageId",
    )

    model_config = {"populate_by_name": True}


class ToolCallArgsEvent(BaseAGUIEvent):
    """Emitted for each streamed chunk of tool call arguments (JSON delta)."""

    type: AGUIEventType = AGUIEventType.TOOL_CALL_ARGS
    tool_call_id: str = Field(
        ...,
        description="Identifier of the owning tool call.",
        alias="toolCallId",
    )
    delta: str = Field(..., description="Incremental JSON fragment for the tool arguments.")

    model_config = {"populate_by_name": True}


class ToolCallEndEvent(BaseAGUIEvent):
    """Emitted when a tool invocation completes."""

    type: AGUIEventType = AGUIEventType.TOOL_CALL_END
    tool_call_id: str = Field(
        ...,
        description="Identifier of the completed tool call.",
        alias="toolCallId",
    )

    model_config = {"populate_by_name": True}


# ---------------------------------------------------------------------------
# State management events
# ---------------------------------------------------------------------------


class StateSnapshotEvent(BaseAGUIEvent):
    """Emitted to deliver a full state snapshot (e.g. on reconnection)."""

    type: AGUIEventType = AGUIEventType.STATE_SNAPSHOT
    snapshot: dict[str, Any] = Field(
        ...,
        description="Complete serialised agent state.",
    )

    model_config = {"populate_by_name": True}


class StateDeltaEvent(BaseAGUIEvent):
    """Emitted as an incremental state update encoded as a JSON Patch (RFC 6902)."""

    type: AGUIEventType = AGUIEventType.STATE_DELTA
    delta: list[dict[str, Any]] = Field(
        ...,
        description="List of RFC 6902 JSON Patch operations.",
    )

    model_config = {"populate_by_name": True}


# ---------------------------------------------------------------------------
# Custom / extension event
# ---------------------------------------------------------------------------


class CustomEvent(BaseAGUIEvent):
    """
    Generic custom event for HITL forms, warnings, and other extensions.

    Use the ``name`` field as a sub-type discriminator (e.g. "hitl_form",
    "warning", "escalation").
    """

    type: AGUIEventType = AGUIEventType.CUSTOM
    name: str = Field(..., description="Sub-type name used to discriminate custom events.")
    value: Any = Field(
        default=None,
        description="Arbitrary payload associated with the custom event.",
    )

    model_config = {"populate_by_name": True}


# ---------------------------------------------------------------------------
# Union type for typed dispatch
# ---------------------------------------------------------------------------

AGUIEvent = (
    RunStartedEvent
    | RunFinishedEvent
    | RunErrorEvent
    | TextMessageStartEvent
    | TextMessageContentEvent
    | TextMessageEndEvent
    | ToolCallStartEvent
    | ToolCallArgsEvent
    | ToolCallEndEvent
    | StateSnapshotEvent
    | StateDeltaEvent
    | CustomEvent
)
