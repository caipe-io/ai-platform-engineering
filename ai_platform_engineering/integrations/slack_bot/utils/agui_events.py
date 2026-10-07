# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Protocol-only interpretation of AG-UI events and control markers."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import json
import re
from typing import Any

from loguru import logger

try:
  from sse_client import SSEEvent, SSEEventType  # type: ignore[import]
except ImportError:
  from ..sse_client import SSEEvent, SSEEventType


class AguiEventKind(Enum):
  """Stable semantic event kinds consumed by Slack presentation code."""

  RUN_STARTED = "run_started"
  TEXT_MESSAGE_START = "text_message_start"
  TEXT_MESSAGE_CONTENT = "text_message_content"
  TEXT_MESSAGE_END = "text_message_end"
  TOOL_CALL_START = "tool_call_start"
  TOOL_CALL_ARGS = "tool_call_args"
  TOOL_CALL_END = "tool_call_end"
  STEP_STARTED = "step_started"
  STEP_FINISHED = "step_finished"
  CUSTOM = "custom"
  RUN_FINISHED = "run_finished"
  RUN_ERROR = "run_error"
  RAW = "raw"


_EVENT_KIND_BY_TYPE = {
  SSEEventType.RUN_STARTED: AguiEventKind.RUN_STARTED,
  SSEEventType.TEXT_MESSAGE_START: AguiEventKind.TEXT_MESSAGE_START,
  SSEEventType.TEXT_MESSAGE_CONTENT: AguiEventKind.TEXT_MESSAGE_CONTENT,
  SSEEventType.TEXT_MESSAGE_END: AguiEventKind.TEXT_MESSAGE_END,
  SSEEventType.TOOL_CALL_START: AguiEventKind.TOOL_CALL_START,
  SSEEventType.TOOL_CALL_ARGS: AguiEventKind.TOOL_CALL_ARGS,
  SSEEventType.TOOL_CALL_END: AguiEventKind.TOOL_CALL_END,
  SSEEventType.STEP_STARTED: AguiEventKind.STEP_STARTED,
  SSEEventType.STEP_FINISHED: AguiEventKind.STEP_FINISHED,
  SSEEventType.CUSTOM: AguiEventKind.CUSTOM,
  SSEEventType.RUN_FINISHED: AguiEventKind.RUN_FINISHED,
  SSEEventType.RUN_ERROR: AguiEventKind.RUN_ERROR,
  SSEEventType.RAW: AguiEventKind.RAW,
}


@dataclass(frozen=True)
class AguiEvent:
  """Normalized event data with no Slack presentation concerns."""

  kind: AguiEventKind
  raw: SSEEvent
  run_id: str | None
  message_id: str | None
  delta: str | None
  tool_call_id: str | None
  tool_call_name: str | None
  name: str | None
  value: dict[str, Any]
  outcome: str | None
  interrupt: dict[str, Any] | None
  message: str | None


def interpret_agui_event(event: SSEEvent) -> AguiEvent:
  """Normalize an SSE event for consumers that do not know AG-UI wire types."""
  value = event.value if isinstance(event.value, dict) else {}
  interrupt = event.interrupt if isinstance(event.interrupt, dict) else None
  return AguiEvent(
    kind=_EVENT_KIND_BY_TYPE.get(event.type, AguiEventKind.RAW),
    raw=event,
    run_id=event.run_id,
    message_id=event.message_id,
    delta=event.delta,
    tool_call_id=event.tool_call_id,
    tool_call_name=event.tool_call_name,
    name=event.name,
    value=value,
    outcome=event.outcome,
    interrupt=interrupt,
    message=event.message,
  )


_THOUGHT_KEYS = (
  "thought",
  "thoughts",
  "reason",
  "thinking",
  "rationale",
  "explanation",
  "description",
  "purpose",
  "intent",
  "goal",
)
_MAX_DETAILS_LEN = 200


def parse_write_todos_args(raw_args_json: str | None) -> list[dict] | None:
  """Parse a non-empty todo list from write_todos arguments."""
  if not raw_args_json:
    return None
  try:
    args = json.loads(raw_args_json)
  except (json.JSONDecodeError, TypeError):
    return None
  if not isinstance(args, dict):
    return None
  todos = args.get("todos")
  if not isinstance(todos, list) or not todos:
    return None
  return todos


def extract_tool_thought(raw_args_json: str | None) -> str | None:
  """Extract and bound the first recognized thought field in tool arguments."""
  if not raw_args_json:
    return None
  try:
    args = json.loads(raw_args_json)
  except (json.JSONDecodeError, TypeError):
    return None
  if not isinstance(args, dict):
    return None
  for key in _THOUGHT_KEYS:
    value = args.get(key)
    if isinstance(value, str) and value.strip():
      trimmed = value.strip()
      if len(trimmed) > _MAX_DETAILS_LEN:
        return trimmed[:_MAX_DETAILS_LEN] + "..."
      return trimmed
  return None


def check_overthink_skip(
  final_text: str,
  thread_ts: str,
  skip_markers: list[str] | None = None,
) -> dict | None:
  """Interpret configured control markers in a completed response."""
  markers = skip_markers or ["DEFER", "LOW_CONFIDENCE"]
  for marker in markers:
    if f"[{marker}]" in final_text:
      logger.info(f"[{thread_ts}] Overthink: skipping response ({marker})")
      return {"skipped": True, "reason": marker.lower()}
  return None


_CONFIDENCE_MARKER_RE = re.compile(
  r"\[(?:CONFIDENCE:\s*\w+|LOW_CONFIDENCE|DEFER)\]"
)


def strip_confidence_markers(text: str) -> str:
  """Remove AG-UI control markers from user-visible response text."""
  return _CONFIDENCE_MARKER_RE.sub("", text).strip()
