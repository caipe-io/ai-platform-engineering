# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0

"""
AG-UI event emitter helpers.

Provides factory functions for constructing every AG-UI event type.
Each function returns a fully-initialised Pydantic model that is ready
to be serialised by the encoder module.

Usage::

    from ai_platform_engineering.utils.agui.event_emitter import (
        emit_run_started,
        emit_text_content,
        emit_tool_start,
    )

    event = emit_run_started(run_id="run-123", thread_id="thread-456")
    event = emit_text_content(message_id="msg-1", delta="Hello ")
    event = emit_tool_start(tool_call_id="tc-1", tool_call_name="search")
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from .event_types import (
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


# ---------------------------------------------------------------------------
# Convenience ID generators
# ---------------------------------------------------------------------------


def _new_id(prefix: str = "") -> str:
    """Return a new UUID4 string, optionally prefixed."""
    uid = str(uuid.uuid4())
    return f"{prefix}{uid}" if prefix else uid


# ---------------------------------------------------------------------------
# Run lifecycle
# ---------------------------------------------------------------------------


def emit_run_started(
    *,
    run_id: Optional[str] = None,
    thread_id: Optional[str] = None,
) -> RunStartedEvent:
    """Create a RUN_STARTED event.

    Parameters
    ----------
    run_id:
        Unique identifier for this run.  A new UUID is generated when ``None``.
    thread_id:
        Conversation thread identifier.  A new UUID is generated when ``None``.
    """
    return RunStartedEvent(
        runId=run_id or _new_id("run-"),
        threadId=thread_id or _new_id("thread-"),
    )


def emit_run_finished(
    *,
    run_id: str,
    thread_id: str,
) -> RunFinishedEvent:
    """Create a RUN_FINISHED event.

    Parameters
    ----------
    run_id:
        Identifier of the run that completed.
    thread_id:
        Conversation thread identifier.
    """
    return RunFinishedEvent(runId=run_id, threadId=thread_id)


def emit_run_error(
    *,
    message: str,
    code: Optional[str] = None,
) -> RunErrorEvent:
    """Create a RUN_ERROR event.

    Parameters
    ----------
    message:
        Human-readable description of the error.
    code:
        Optional machine-readable error code.
    """
    return RunErrorEvent(message=message, code=code)


# ---------------------------------------------------------------------------
# Text message lifecycle
# ---------------------------------------------------------------------------


def emit_text_start(
    *,
    message_id: Optional[str] = None,
    role: str = "assistant",
) -> TextMessageStartEvent:
    """Create a TEXT_MESSAGE_START event.

    Parameters
    ----------
    message_id:
        Unique identifier for the message being started.  Auto-generated
        when ``None``.
    role:
        Message role, typically ``"assistant"``.
    """
    return TextMessageStartEvent(
        messageId=message_id or _new_id("msg-"),
        role=role,
    )


def emit_text_content(
    *,
    message_id: str,
    delta: str,
) -> TextMessageContentEvent:
    """Create a TEXT_MESSAGE_CONTENT event for a single text chunk.

    Parameters
    ----------
    message_id:
        Identifier of the owning message.
    delta:
        The incremental text being streamed.
    """
    return TextMessageContentEvent(messageId=message_id, delta=delta)


def emit_text_end(
    *,
    message_id: str,
) -> TextMessageEndEvent:
    """Create a TEXT_MESSAGE_END event.

    Parameters
    ----------
    message_id:
        Identifier of the message that has been fully streamed.
    """
    return TextMessageEndEvent(messageId=message_id)


# ---------------------------------------------------------------------------
# Tool call lifecycle
# ---------------------------------------------------------------------------


def emit_tool_start(
    *,
    tool_call_id: Optional[str] = None,
    tool_call_name: str,
    parent_message_id: Optional[str] = None,
) -> ToolCallStartEvent:
    """Create a TOOL_CALL_START event.

    Parameters
    ----------
    tool_call_id:
        Unique identifier for this tool invocation.  Auto-generated when
        ``None``.
    tool_call_name:
        Name of the tool being called.
    parent_message_id:
        Optional ID of the assistant message that triggered the call.
    """
    return ToolCallStartEvent(
        toolCallId=tool_call_id or _new_id("tc-"),
        toolCallName=tool_call_name,
        parentMessageId=parent_message_id,
    )


def emit_tool_args(
    *,
    tool_call_id: str,
    delta: str,
) -> ToolCallArgsEvent:
    """Create a TOOL_CALL_ARGS event for a streamed argument fragment.

    Parameters
    ----------
    tool_call_id:
        Identifier of the owning tool call.
    delta:
        Incremental JSON fragment for the tool arguments.
    """
    return ToolCallArgsEvent(toolCallId=tool_call_id, delta=delta)


def emit_tool_end(
    *,
    tool_call_id: str,
) -> ToolCallEndEvent:
    """Create a TOOL_CALL_END event.

    Parameters
    ----------
    tool_call_id:
        Identifier of the tool call that has completed.
    """
    return ToolCallEndEvent(toolCallId=tool_call_id)


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------


def emit_state_snapshot(
    *,
    snapshot: dict[str, Any],
) -> StateSnapshotEvent:
    """Create a STATE_SNAPSHOT event carrying the full agent state.

    Parameters
    ----------
    snapshot:
        Complete serialised agent state dictionary.
    """
    return StateSnapshotEvent(snapshot=snapshot)


def emit_state_delta(
    *,
    delta: list[dict[str, Any]],
) -> StateDeltaEvent:
    """Create a STATE_DELTA event carrying an RFC 6902 JSON Patch.

    Parameters
    ----------
    delta:
        List of JSON Patch operation dicts, e.g.
        ``[{"op": "replace", "path": "/status", "value": "done"}]``.
    """
    return StateDeltaEvent(delta=delta)


# ---------------------------------------------------------------------------
# Custom / extension events
# ---------------------------------------------------------------------------


def emit_custom(
    *,
    name: str,
    value: Any = None,
) -> CustomEvent:
    """Create a CUSTOM event for HITL forms, warnings, or other extensions.

    Parameters
    ----------
    name:
        Sub-type discriminator (e.g. ``"hitl_form"``, ``"warning"``).
    value:
        Arbitrary payload associated with the event.
    """
    return CustomEvent(name=name, value=value)
