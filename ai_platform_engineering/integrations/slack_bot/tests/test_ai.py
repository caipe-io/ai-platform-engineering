# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for utility functions in ai.py.

These are integration tests that require a running dynamic agents backend.
Run with: pytest -m integration
"""

import os

import pytest

from ai_platform_engineering.integrations.slack_bot.utils import ai


@pytest.mark.integration
class TestOverthinkIntegration:
  """Integration tests for overthink mode that call the actual dynamic agents API via SSE."""

  def _collect_sse_response(self, prompt):
    """Collect the full text response from the SSE endpoint."""
    from ai_platform_engineering.integrations.slack_bot.sse_client import SSEClient, SSEEventType

    dynamic_agents_url = os.getenv("DYNAMIC_AGENTS_URL", "http://localhost:8001")
    sse_client = SSEClient(dynamic_agents_url, timeout=120)

    final_text_parts = []
    for event in sse_client.stream_chat(
      message=prompt,
      conversation_id="integration-test-conv-1",
      agent_id="default",
    ):
      if event.type == SSEEventType.TEXT_MESSAGE_CONTENT and event.delta:
        final_text_parts.append(event.delta)
      elif event.type == SSEEventType.RUN_FINISHED:
        break
    return "".join(final_text_parts).strip()


class TestCheckOverthinkSkip:
  """Unit tests for _check_overthink_skip with configurable markers."""

  def test_default_markers_defer(self):
    result = ai._check_overthink_skip("[DEFER] human action needed", "ts1")
    assert result == {"skipped": True, "reason": "defer"}

  def test_default_markers_low_confidence(self):
    result = ai._check_overthink_skip("[LOW_CONFIDENCE] no good sources", "ts1")
    assert result == {"skipped": True, "reason": "low_confidence"}

  def test_default_markers_no_match(self):
    result = ai._check_overthink_skip("CONFIDENCE: HIGH - here is the answer", "ts1")
    assert result is None

  def test_custom_markers(self):
    result = ai._check_overthink_skip("[CUSTOM_SKIP] reason", "ts1", skip_markers=["CUSTOM_SKIP"])
    assert result == {"skipped": True, "reason": "custom_skip"}

  def test_custom_markers_no_match(self):
    result = ai._check_overthink_skip("[DEFER] reason", "ts1", skip_markers=["CUSTOM_SKIP"])
    assert result is None

  def test_none_markers_uses_defaults(self):
    result = ai._check_overthink_skip("[DEFER] reason", "ts1", skip_markers=None)
    assert result == {"skipped": True, "reason": "defer"}
