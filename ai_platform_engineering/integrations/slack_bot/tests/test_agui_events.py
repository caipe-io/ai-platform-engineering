# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for protocol-only AG-UI event interpretation."""

from ai_platform_engineering.integrations.slack_bot.sse_client import (
  SSEEvent,
  SSEEventType,
)
from ai_platform_engineering.integrations.slack_bot.utils.agui_events import (
  AguiEventKind,
  interpret_agui_event,
  strip_confidence_markers,
)


def test_interprets_text_content_without_slack_types() -> None:
  raw = SSEEvent(
    type=SSEEventType.TEXT_MESSAGE_CONTENT,
    message_id="message-1",
    delta="partial response",
  )

  event = interpret_agui_event(raw)

  assert event.kind is AguiEventKind.TEXT_MESSAGE_CONTENT
  assert event.message_id == "message-1"
  assert event.delta == "partial response"
  assert event.raw is raw


def test_interprets_custom_payload_as_mapping() -> None:
  raw = SSEEvent(
    type=SSEEventType.CUSTOM,
    name="WARNING",
    value={"message": "example warning"},
  )

  event = interpret_agui_event(raw)

  assert event.kind is AguiEventKind.CUSTOM
  assert event.name == "WARNING"
  assert event.value == {"message": "example warning"}


def test_unknown_event_is_safe_raw_update() -> None:
  raw = SSEEvent(type="FUTURE_EVENT", delta="opaque")

  event = interpret_agui_event(raw)

  assert event.kind is AguiEventKind.RAW
  assert event.delta == "opaque"


def test_control_markers_are_removed_before_delivery() -> None:
  assert strip_confidence_markers("Answer [LOW_CONFIDENCE]") == "Answer"
