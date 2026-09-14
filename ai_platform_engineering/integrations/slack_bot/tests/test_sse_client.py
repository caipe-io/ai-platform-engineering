# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for the AG-UI SSE client."""

import json
import uuid

from unittest.mock import Mock

from ai_platform_engineering.integrations.slack_bot.sse_client import (
  SSEClient,
  SSEEvent,
  SSEEventType,
  thread_ts_to_conversation_id,
  SLACK_NAMESPACE,
)


class TestThreadTsToConversationId:
  """Tests for deterministic conversation ID generation."""

  def test_returns_uuid_string(self):
    result = thread_ts_to_conversation_id("1234567890.123456")
    # Should be a valid UUID string
    uuid.UUID(result)  # Raises if invalid

  def test_deterministic(self):
    """Same thread_ts always produces the same UUID."""
    ts = "1234567890.123456"
    assert thread_ts_to_conversation_id(ts) == thread_ts_to_conversation_id(ts)

  def test_different_threads_different_ids(self):
    """Different thread_ts values produce different UUIDs."""
    id1 = thread_ts_to_conversation_id("1234567890.123456")
    id2 = thread_ts_to_conversation_id("1234567890.789012")
    assert id1 != id2

  def test_is_uuid5_with_slack_namespace(self):
    """Verify the UUID is constructed with the SLACK_NAMESPACE."""
    ts = "1234567890.123456"
    expected = str(uuid.uuid5(SLACK_NAMESPACE, ts))
    assert thread_ts_to_conversation_id(ts) == expected


class TestSSEEventType:
  """Tests for SSEEventType constants and is_known()."""

  def test_known_types(self):
    assert SSEEventType.is_known("RUN_STARTED")
    assert SSEEventType.is_known("RUN_FINISHED")
    assert SSEEventType.is_known("TEXT_MESSAGE_CONTENT")
    assert SSEEventType.is_known("TOOL_CALL_START")
    assert SSEEventType.is_known("STATE_DELTA")

  def test_unknown_type(self):
    assert not SSEEventType.is_known("UNKNOWN_EVENT")
    assert not SSEEventType.is_known("")

  def test_type_constants_match_strings(self):
    assert SSEEventType.RUN_STARTED == "RUN_STARTED"
    assert SSEEventType.RUN_FINISHED == "RUN_FINISHED"
    assert SSEEventType.TEXT_MESSAGE_CONTENT == "TEXT_MESSAGE_CONTENT"


class TestSSEEvent:
  """Tests for SSEEvent data class."""

  def test_basic_construction(self):
    event = SSEEvent(type="RUN_STARTED", run_id="run-1")
    assert event.type == "RUN_STARTED"
    assert event.run_id == "run-1"
    assert event.delta is None

  def test_content_event(self):
    event = SSEEvent(type="TEXT_MESSAGE_CONTENT", delta="hello", message_id="msg-1")
    assert event.delta == "hello"
    assert event.message_id == "msg-1"

  def test_interrupt_event(self):
    interrupt = {"id": "int-1", "reason": "human_input", "payload": {}}
    event = SSEEvent(type="RUN_FINISHED", outcome="interrupt", interrupt=interrupt)
    assert event.outcome == "interrupt"
    assert event.interrupt["id"] == "int-1"


class TestSSEClientInit:
  """Tests for SSEClient initialization."""

  def test_init_strips_trailing_slash(self):
    client = SSEClient("http://example.com/")
    assert client.base_url == "http://example.com"

  def test_init_default_timeout(self):
    client = SSEClient("http://example.com")
    assert client.timeout == 300

  def test_init_custom_timeout(self):
    client = SSEClient("http://example.com", timeout=60)
    assert client.timeout == 60

  def test_headers_include_client_source(self):
    client = SSEClient("http://example.com")
    headers = client._get_headers()
    assert headers["X-Client-Source"] == "slack-bot"
    assert headers["Content-Type"] == "application/json"
    assert headers["Accept"] == "text/event-stream"

  def test_headers_include_auth_when_client_provided(self):
    mock_auth = Mock()
    mock_auth.get_access_token.return_value = "test-token"
    client = SSEClient("http://example.com", auth_client=mock_auth)
    headers = client._get_headers()
    assert headers["Authorization"] == "Bearer test-token"

  def test_headers_no_auth_when_no_client(self):
    client = SSEClient("http://example.com")
    headers = client._get_headers()
    assert "Authorization" not in headers


class TestSSEClientParseEvent:
  """Tests for the _parse_event method."""

  def test_parse_content_event(self):
    client = SSEClient("http://example.com")
    data = json.dumps(
      {
        "type": "TEXT_MESSAGE_CONTENT",
        "delta": "hello world",
        "messageId": "msg-1",
      }
    )
    event = client._parse_event(data)
    assert event is not None
    assert event.type == SSEEventType.TEXT_MESSAGE_CONTENT
    assert event.delta == "hello world"
    assert event.message_id == "msg-1"

  def test_parse_run_finished_with_interrupt(self):
    client = SSEClient("http://example.com")
    interrupt = {"id": "int-1", "reason": "human_input", "payload": {"prompt": "Confirm?"}}
    data = json.dumps(
      {
        "type": "RUN_FINISHED",
        "outcome": "interrupt",
        "interrupt": interrupt,
        "runId": "run-1",
      }
    )
    event = client._parse_event(data)
    assert event is not None
    assert event.type == SSEEventType.RUN_FINISHED
    assert event.outcome == "interrupt"
    assert event.interrupt["id"] == "int-1"

  def test_parse_state_delta_with_steps(self):
    client = SSEClient("http://example.com")
    steps = [{"step_id": "s1", "title": "Search", "status": "in_progress"}]
    data = json.dumps(
      {
        "type": "STATE_DELTA",
        "delta": steps,
      }
    )
    event = client._parse_event(data)
    assert event is not None
    assert event.type == SSEEventType.STATE_DELTA
    assert event.steps == steps

  def test_parse_unknown_type_returns_none(self):
    client = SSEClient("http://example.com")
    data = json.dumps({"type": "UNKNOWN_EVENT", "data": "test"})
    event = client._parse_event(data)
    assert event is None

  def test_parse_invalid_json_returns_none(self):
    client = SSEClient("http://example.com")
    event = client._parse_event("not json{")
    assert event is None

  def test_parse_tool_call_start(self):
    client = SSEClient("http://example.com")
    data = json.dumps(
      {
        "type": "TOOL_CALL_START",
        "toolCallId": "tc-1",
        "toolCallName": "rag_search",
      }
    )
    event = client._parse_event(data)
    assert event is not None
    assert event.tool_call_id == "tc-1"
    assert event.tool_call_name == "rag_search"

  def test_parse_run_error(self):
    client = SSEClient("http://example.com")
    data = json.dumps(
      {
        "type": "RUN_ERROR",
        "message": "Agent failed",
      }
    )
    event = client._parse_event(data)
    assert event is not None
    assert event.type == SSEEventType.RUN_ERROR
    assert event.message == "Agent failed"

  def test_delta_not_set_for_state_delta(self):
    """STATE_DELTA has a 'delta' in raw JSON, but SSEEvent.delta should not be set."""
    client = SSEClient("http://example.com")
    data = json.dumps(
      {
        "type": "STATE_DELTA",
        "delta": [{"step_id": "s1"}],
      }
    )
    event = client._parse_event(data)
    assert event.delta is None  # Not a TEXT_MESSAGE_CONTENT or TOOL_CALL_ARGS
    assert event.steps is not None  # But steps should be populated

  def test_delta_set_for_tool_call_args(self):
    """TOOL_CALL_ARGS events should have delta populated with the args JSON string."""
    client = SSEClient("http://example.com")
    data = json.dumps(
      {
        "type": "TOOL_CALL_ARGS",
        "toolCallId": "tc-1",
        "delta": '{"thought": "searching"}',
      }
    )
    event = client._parse_event(data)
    assert event.type == SSEEventType.TOOL_CALL_ARGS
    assert event.delta == '{"thought": "searching"}'
    assert event.tool_call_id == "tc-1"


class TestStreamChatPayload:
  """The request body stream_chat builds — the seam multimodal files ride on."""

  def _capture_payload(self, monkeypatch):
    """Stub _stream_sse and return a dict that receives the built payload."""
    captured: dict = {}

    def fake_stream_sse(self, url, payload, bearer_token=None):
      captured["url"] = url
      captured["payload"] = payload
      return iter(())

    monkeypatch.setattr(SSEClient, "_stream_sse", fake_stream_sse)
    return captured

  def test_files_included_when_present(self, monkeypatch):
    captured = self._capture_payload(monkeypatch)
    client = SSEClient("http://example.com")
    files = [{"mime_type": "image/png", "data": "Zm9v", "name": "a.png"}]

    list(client.stream_chat("hi", "conv-1", "agent-1", files=files))

    assert captured["payload"]["files"] == files
    # Base fields still present and correct.
    assert captured["payload"]["message"] == "hi"
    assert captured["payload"]["protocol"] == "agui"
    assert captured["url"].endswith("/api/v1/chat/stream/start")

  def test_files_omitted_when_empty(self, monkeypatch):
    captured = self._capture_payload(monkeypatch)
    client = SSEClient("http://example.com")

    list(client.stream_chat("hi", "conv-1", "agent-1", files=[]))

    # No empty "files" key — the backend/gateway should see the same body as
    # a plain text turn.
    assert "files" not in captured["payload"]

  def test_files_omitted_when_none(self, monkeypatch):
    captured = self._capture_payload(monkeypatch)
    client = SSEClient("http://example.com")

    list(client.stream_chat("hi", "conv-1", "agent-1"))

    assert "files" not in captured["payload"]
