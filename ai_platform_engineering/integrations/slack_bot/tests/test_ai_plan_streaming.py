"""Tests for plan-mode streaming in ai.py using the SSE path.

Covers: lazy stream start, setStatus behavior, tool call streaming with
thinking text and thought extraction, stopStream final answer, and StreamBuffer batching.
"""

import time
from unittest.mock import Mock, patch

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.ai import (
  stream_response,
  StreamBuffer,
  _INITIAL_LOADING_MESSAGES,
  _STATUS_PREFIX,
  _STATUS_MAX_LEN,
  _STATUS_SKIP_LOW_CONFIDENCE,
  _STATUS_SKIP_DEFER,
  _STATUS_ERROR,
)
from ai_platform_engineering.integrations.slack_bot.utils.agui_events import (
  extract_tool_thought as _extract_tool_thought,
)
from ai_platform_engineering.integrations.slack_bot.sse_client import SSEEvent, SSEEventType
from ai_platform_engineering.integrations.slack_bot.utils.config_models import OverthinkConfig

_OVERTHINK_ENABLED = OverthinkConfig(enabled=True)


# ---------------------------------------------------------------------------
# Helpers to build SSE events
# ---------------------------------------------------------------------------


def _content_event(text):
  return SSEEvent(type=SSEEventType.TEXT_MESSAGE_CONTENT, delta=text)


def _text_message_end_event():
  return SSEEvent(type=SSEEventType.TEXT_MESSAGE_END)


def _tool_start_event(name="search", tool_call_id="tc-1"):
  return SSEEvent(type=SSEEventType.TOOL_CALL_START, tool_call_name=name, tool_call_id=tool_call_id)


def _tool_args_event(tool_call_id="tc-1", delta='{"thought": "Looking for docs"}'):
  return SSEEvent(type=SSEEventType.TOOL_CALL_ARGS, tool_call_id=tool_call_id, delta=delta)


def _tool_end_event(tool_call_id="tc-1"):
  return SSEEvent(type=SSEEventType.TOOL_CALL_END, tool_call_id=tool_call_id)


def _done_event(run_id="run-1"):
  return SSEEvent(type=SSEEventType.RUN_FINISHED, run_id=run_id)


def _error_event(message="Something failed"):
  return SSEEvent(type=SSEEventType.RUN_ERROR, message=message)


def _mock_slack():
  """Create a mock Slack client with streaming API stubs."""
  mock = Mock()
  mock.chat_startStream.return_value = {"ts": "stream-ts-1"}
  mock.chat_appendStream.return_value = {"ok": True}
  mock.chat_stopStream.return_value = {"ok": True}
  mock.chat_postMessage.return_value = {"ts": "msg-ts-1"}
  mock.chat_delete.return_value = {"ok": True}
  mock.assistant_threads_setStatus.return_value = {"ok": True}
  return mock


def _mock_sse_client(events):
  """Create a mock SSE client that yields the given events."""
  mock = Mock()
  mock.stream_chat.return_value = iter(events)
  return mock


def _get_task_updates(mock_slack):
  """Collect all task_update chunks from appendStream calls."""
  updates = []
  for c in mock_slack.chat_appendStream.call_args_list:
    for chunk in c.kwargs.get("chunks", []):
      if chunk.get("type") == "task_update":
        updates.append(chunk)
  return updates


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _disable_status_rate_limit():
  """Disable status rate limiting in tests so all setStatus calls fire immediately."""
  with patch("ai_platform_engineering.integrations.slack_bot.utils.ai._STATUS_RATE_LIMIT_SECS", 0):
    yield


class TestLazyStreamAndSetStatus:
  """Verify setStatus is called before startStream, and startStream is deferred."""

  def test_set_status_called_before_start_stream(self):
    """setStatus('thinking...') fires immediately; startStream fires on first tool call."""
    events = [
      _tool_start_event("search", "tc-1"),
      _tool_end_event("tc-1"),
      _content_event("Done"),
      _done_event(),
    ]
    mock_sse = _mock_sse_client(events)
    mock_slack = _mock_slack()

    stream_response(
      sse_client=mock_sse,
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
    )

    # setStatus should be called at least once (the initial status call)
    assert mock_slack.assistant_threads_setStatus.call_count >= 1
    first_set_status = mock_slack.assistant_threads_setStatus.call_args_list[0]
    # Initial call sends first loading message as status, full list as loading_messages
    assert first_set_status.kwargs["status"] == _INITIAL_LOADING_MESSAGES[0]
    assert len(first_set_status.kwargs["loading_messages"]) >= 2

    # startStream should have been called
    mock_slack.chat_startStream.assert_called_once()

    # Verify setStatus was called BEFORE startStream
    all_calls = mock_slack.method_calls
    set_status_idx = next(i for i, c in enumerate(all_calls) if c[0] == "assistant_threads_setStatus")
    start_stream_idx = next(i for i, c in enumerate(all_calls) if c[0] == "chat_startStream")
    assert set_status_idx < start_stream_idx

  def test_start_stream_with_content_only(self):
    """If no tool calls but content arrives, startStream fires and final text goes via stopStream."""
    events = [
      _content_event("Here is the answer"),
      _done_event(),
    ]
    mock_sse = _mock_sse_client(events)
    mock_slack = _mock_slack()

    stream_response(
      sse_client=mock_sse,
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
    )

    # Stream should start because we have content
    mock_slack.chat_startStream.assert_called_once()
    # stopStream should be called to finalize
    mock_slack.chat_stopStream.assert_called_once()


class TestStopStreamCarriesFinalAnswer:
  """When content is streamed live, stopStream has no chunks (already in stream)."""

  def test_stop_stream_called_after_streaming(self):
    """stopStream called to finalize; feedback blocks are always present."""
    events = [
      _content_event("Here is my final answer"),
      _done_event(),
    ]
    mock_sse = _mock_sse_client(events)
    mock_slack = _mock_slack()

    stream_response(
      sse_client=mock_sse,
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
    )

    mock_slack.chat_stopStream.assert_called_once()
    stop_call = mock_slack.chat_stopStream.call_args
    # Feedback blocks should always be present
    blocks = stop_call.kwargs.get("blocks")
    assert blocks is not None and len(blocks) > 0, "stopStream must have feedback blocks"


class TestToolEvents:
  """Tool start/end events start the stream and flush the buffer."""

  def test_tool_start_does_not_open_stream_without_todos(self):
    """TOOL_START without todos does not open the stream — stream opens at finalization."""
    events = [
      _tool_start_event("rag_search", "tc-1"),
      _tool_end_event("tc-1"),
      _content_event("Result"),
      _done_event(),
    ]
    mock_sse = _mock_sse_client(events)
    mock_slack = _mock_slack()

    stream_response(
      sse_client=mock_sse,
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
    )

    # Stream opens at finalization, not at TOOL_START
    mock_slack.chat_startStream.assert_called_once()
    # Verify it was called during finalization (last startStream before stopStream)
    mock_slack.chat_stopStream.assert_called_once()

  def test_stream_opens_on_tool_start_with_todos(self):
    """TOOL_START opens stream when write_todos is the tool."""
    events = [
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", '{"todos": [{"content": "Step 1", "status": "in_progress"}]}'),
      _tool_end_event("tc-wt-1"),
      _content_event("Done"),
      _done_event(),
    ]
    mock_sse = _mock_sse_client(events)
    mock_slack = _mock_slack()

    stream_response(
      sse_client=mock_sse,
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
    )

    # Stream should have been opened for the write_todos tool
    mock_slack.chat_startStream.assert_called_once()

  def test_tool_end_no_working_status_when_no_stream(self):
    """TOOL_END does NOT set 'working...' status — status only updates from content or thoughts."""
    events = [
      _tool_start_event("my_tool", "tc-1"),
      _tool_end_event("tc-1"),
      _content_event("Done"),
      _done_event(),
    ]
    mock_sse = _mock_sse_client(events)
    mock_slack = _mock_slack()
    # Make startStream fail so stream_ts stays None
    mock_slack.chat_startStream.side_effect = Exception("startStream unavailable")

    stream_response(
      sse_client=mock_sse,
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
    )

    status_calls = [c.kwargs.get("status", "") for c in mock_slack.assistant_threads_setStatus.call_args_list]
    assert not any("working" in s for s in status_calls), "Should NOT set 'working...' status on tool end"


class TestThinkingBuffer:
  """Text between tool calls is buffered as 'thinking' and shown in typing indicator."""

  def test_thinking_text_shown_as_typing_status(self):
    """Text before a tool call appears in the typing indicator status on TEXT_MESSAGE_END."""
    events = [
      _content_event("Let me search for that..."),
      _text_message_end_event(),
      _tool_start_event("rag_search", "tc-1"),
      _tool_end_event("tc-1"),
      _content_event("Here is the answer."),
      _text_message_end_event(),
      _done_event(),
    ]
    mock_slack = Mock()
    mock_slack.chat_startStream.return_value = {"ts": "stream-ts-1"}
    mock_slack.chat_appendStream.return_value = {"ok": True}
    mock_slack.chat_stopStream.return_value = {"ok": True}
    mock_slack.assistant_threads_setStatus.return_value = {"ok": True}

    stream_response(
      sse_client=_mock_sse_client(events),
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
    )

    # No raw tool cards — task cards are only for todos
    updates = _get_task_updates(mock_slack)
    assert len(updates) == 0

    # Thinking text should appear in typing status
    status_calls = [c.kwargs.get("status", "") for c in mock_slack.assistant_threads_setStatus.call_args_list]
    assert any("Let me search for that" in s for s in status_calls), f"Thinking should appear in status, got: {status_calls}"

  def test_thinking_between_tools_shown_in_status(self):
    """Text between two tool calls is shown in the typing indicator status on TEXT_MESSAGE_END."""
    events = [
      _tool_start_event("rag_search", "tc-1"),
      _tool_end_event("tc-1"),
      _content_event("Now let me check Jira..."),
      _text_message_end_event(),
      _tool_start_event("jira_search", "tc-2"),
      _tool_end_event("tc-2"),
      _content_event("Final answer."),
      _text_message_end_event(),
      _done_event(),
    ]
    mock_slack = Mock()
    mock_slack.chat_startStream.return_value = {"ts": "stream-ts-1"}
    mock_slack.chat_appendStream.return_value = {"ok": True}
    mock_slack.chat_stopStream.return_value = {"ok": True}
    mock_slack.assistant_threads_setStatus.return_value = {"ok": True}

    stream_response(
      sse_client=_mock_sse_client(events),
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
    )

    # No raw tool cards
    updates = _get_task_updates(mock_slack)
    assert len(updates) == 0

  def test_thinking_truncated_in_typing_status(self):
    """Long thinking text is truncated to fit in the typing status (Slack max 50 chars)."""
    long_text = "A" * 250
    events = [
      _content_event(long_text),
      _text_message_end_event(),
      _tool_start_event("search", "tc-1"),
      _tool_end_event("tc-1"),
      _content_event("Done."),
      _text_message_end_event(),
      _done_event(),
    ]
    mock_slack = Mock()
    mock_slack.chat_startStream.return_value = {"ts": "stream-ts-1"}
    mock_slack.chat_appendStream.return_value = {"ok": True}
    mock_slack.chat_stopStream.return_value = {"ok": True}
    mock_slack.assistant_threads_setStatus.return_value = {"ok": True}

    stream_response(
      sse_client=_mock_sse_client(events),
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
    )

    # Typing status should be truncated — Slack hard limit is 50 chars
    status_calls = [c.kwargs.get("status", "") for c in mock_slack.assistant_threads_setStatus.call_args_list]
    thinking_statuses = [s for s in status_calls if _STATUS_PREFIX.rstrip() in s]
    assert len(thinking_statuses) >= 1
    for s in thinking_statuses:
      assert len(s) <= _STATUS_MAX_LEN, f"Status should be max {_STATUS_MAX_LEN} chars, got {len(s)}: {s}"

  def test_final_text_after_tools_streamed_normally(self):
    """Text after the last tool call is the final answer, streamed via appendStream."""
    events = [
      _tool_start_event("search", "tc-1"),
      _tool_end_event("tc-1"),
      _content_event("Here is the final answer."),
      _done_event(),
    ]
    mock_slack = Mock()
    mock_slack.chat_startStream.return_value = {"ts": "stream-ts-1"}
    mock_slack.chat_appendStream.return_value = {"ok": True}
    mock_slack.chat_stopStream.return_value = {"ok": True}
    mock_slack.assistant_threads_setStatus.return_value = {"ok": True}

    stream_response(
      sse_client=_mock_sse_client(events),
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
    )

    # Final answer text should appear somewhere (appendStream or stopStream)
    all_text = []
    for c in mock_slack.chat_appendStream.call_args_list:
      for chunk in c.kwargs.get("chunks", []):
        if chunk.get("type") == "markdown_text":
          all_text.append(chunk["text"])
    stop_call = mock_slack.chat_stopStream.call_args
    for chunk in stop_call.kwargs.get("chunks") or []:
      if chunk.get("type") == "markdown_text":
        all_text.append(chunk["text"])
    combined = "".join(all_text)
    assert "Here is the final answer." in combined

  def test_interleaved_text_between_tools_only_final_shown(self):
    """Regression: text messages between tool calls must NOT leak into final output.

    Scenario: agent emits text → tool → text → tool → ... → final text → RUN_FINISHED.
    Only the last text segment ("Mars is red") should appear in the Slack message.
    The intermediate texts ("Working on it...", "Searching...") are thinking and
    must be suppressed from the rendered output.
    """
    events = [
      # First thinking text + tool
      _content_event("Working on it..."),
      _text_message_end_event(),
      _tool_start_event("sleep", "tc-1"),
      _tool_end_event("tc-1"),
      # Second thinking text + tool
      _content_event("Searching..."),
      _text_message_end_event(),
      _tool_start_event("sleep", "tc-2"),
      _tool_end_event("tc-2"),
      # Third thinking text + tool
      _content_event("Analyzing data..."),
      _text_message_end_event(),
      _tool_start_event("sleep", "tc-3"),
      _tool_end_event("tc-3"),
      # Final answer
      _content_event("Mars is red"),
      _text_message_end_event(),
      _done_event(),
    ]
    mock_slack = _mock_slack()

    stream_response(
      sse_client=_mock_sse_client(events),
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
    )

    # Collect all rendered text from appendStream and stopStream
    all_text = []
    for c in mock_slack.chat_appendStream.call_args_list:
      for chunk in c.kwargs.get("chunks", []):
        if chunk.get("type") == "markdown_text":
          all_text.append(chunk["text"])
    stop_call = mock_slack.chat_stopStream.call_args
    for chunk in stop_call.kwargs.get("chunks") or []:
      if chunk.get("type") == "markdown_text":
        all_text.append(chunk["text"])
    combined = "".join(all_text)

    # Only the final answer should be present
    assert "Mars is red" in combined
    # Intermediate thinking text must NOT appear
    assert "Working on it..." not in combined
    assert "Searching..." not in combined
    assert "Analyzing data..." not in combined


class TestToolThoughtExtraction:
  """Tests for _extract_tool_thought and TOOL_CALL_ARGS thought display."""

  def test_extract_thought_basic(self):
    assert _extract_tool_thought('{"thought": "Looking for docs"}') == "Looking for docs"

  def test_extract_reason(self):
    assert _extract_tool_thought('{"reason": "Need to check"}') == "Need to check"

  def test_extract_first_matching_key(self):
    """Returns the first matching key in priority order."""
    result = _extract_tool_thought('{"reason": "R", "thought": "T"}')
    assert result == "T"  # thought comes before reason in _THOUGHT_KEYS

  def test_extract_skips_empty(self):
    assert _extract_tool_thought('{"thought": "", "reason": "Actual reason"}') == "Actual reason"

  def test_extract_truncates_long_text(self):
    long = "X" * 300
    result = _extract_tool_thought(f'{{"thought": "{long}"}}')
    assert result.endswith("...")
    assert len(result) == 203  # 200 + "..."

  def test_extract_returns_none_for_no_thought(self):
    assert _extract_tool_thought('{"query": "kubernetes"}') is None

  def test_extract_returns_none_for_invalid_json(self):
    assert _extract_tool_thought("not json") is None

  def test_extract_returns_none_for_empty(self):
    assert _extract_tool_thought("") is None
    assert _extract_tool_thought(None) is None

  def test_tool_args_thought_shown_in_typing_status(self):
    """Thought extracted from TOOL_CALL_ARGS is shown in the typing status indicator."""
    events = [
      _tool_start_event("rag_search", "tc-1"),
      _tool_args_event("tc-1", '{"thought": "Searching for k8s docs", "query": "kubernetes"}'),
      _tool_end_event("tc-1"),
      _content_event("Here is the answer."),
      _done_event(),
    ]
    mock_slack = Mock()
    mock_slack.chat_startStream.return_value = {"ts": "stream-ts-1"}
    mock_slack.chat_appendStream.return_value = {"ok": True}
    mock_slack.chat_stopStream.return_value = {"ok": True}
    mock_slack.assistant_threads_setStatus.return_value = {"ok": True}

    stream_response(
      sse_client=_mock_sse_client(events),
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
    )

    # No raw tool cards
    updates = _get_task_updates(mock_slack)
    assert len(updates) == 0

    # Thought should appear in typing status
    status_calls = [c.kwargs.get("status", "") for c in mock_slack.assistant_threads_setStatus.call_args_list]
    assert any("Searching for k8s docs" in s for s in status_calls), f"Thought should appear in status, got: {status_calls}"


class TestStreamBuffer:
  """Tests for the StreamBuffer batching logic."""

  def test_append_buffers_within_interval(self):
    """Multiple appends within the flush interval produce a single API call."""
    mock_slack = Mock()
    mock_slack.chat_appendStream.return_value = {"ok": True}
    buf = StreamBuffer(mock_slack, "C1", "ts1", flush_interval=1.0)

    buf.append("Hello ")
    buf.append("world")
    # Neither append should have triggered a flush (interval=1s, instant calls)
    mock_slack.chat_appendStream.assert_not_called()

    buf.flush()
    mock_slack.chat_appendStream.assert_called_once()
    chunks = mock_slack.chat_appendStream.call_args.kwargs["chunks"]
    assert chunks == [{"type": "markdown_text", "text": "Hello world"}]

  def test_append_auto_flushes_after_interval(self):
    """An append after the flush interval triggers an automatic flush."""
    mock_slack = Mock()
    mock_slack.chat_appendStream.return_value = {"ok": True}
    buf = StreamBuffer(mock_slack, "C1", "ts1", flush_interval=0.05)

    buf.append("first")
    time.sleep(0.06)
    buf.append("second")  # Should trigger flush of "firstsecond"

    assert mock_slack.chat_appendStream.call_count == 1
    chunks = mock_slack.chat_appendStream.call_args.kwargs["chunks"]
    assert chunks[0]["text"] == "firstsecond"

  def test_flush_is_noop_when_empty(self):
    """Flushing an empty buffer does nothing."""
    mock_slack = Mock()
    buf = StreamBuffer(mock_slack, "C1", "ts1")

    result = buf.flush()
    assert result is False
    mock_slack.chat_appendStream.assert_not_called()

  def test_has_flushed_tracks_state(self):
    """has_flushed is False initially and True after a successful flush."""
    mock_slack = Mock()
    mock_slack.chat_appendStream.return_value = {"ok": True}
    buf = StreamBuffer(mock_slack, "C1", "ts1")

    assert buf.has_flushed is False
    buf.append("text")
    buf.flush()
    assert buf.has_flushed is True

  def test_append_flushes_on_newline_boundary(self):
    """Appending text with a newline flushes up to the newline, keeps remainder."""
    mock_slack = Mock()
    mock_slack.chat_appendStream.return_value = {"ok": True}
    buf = StreamBuffer(mock_slack, "C1", "ts1", flush_interval=10.0)

    buf.append("**bold text**\nstart of next")

    mock_slack.chat_appendStream.assert_called_once()
    chunks = mock_slack.chat_appendStream.call_args.kwargs["chunks"]
    assert chunks == [{"type": "markdown_text", "text": "**bold text**\n"}]
    # Remainder stays in buffer
    assert buf._buffer == "start of next"

  def test_no_flush_mid_markdown_without_newline(self):
    """Without a newline or interval, buffer holds — avoids splitting markdown."""
    mock_slack = Mock()
    mock_slack.chat_appendStream.return_value = {"ok": True}
    buf = StreamBuffer(mock_slack, "C1", "ts1", flush_interval=10.0)

    buf.append("**bold")
    buf.append(" text**")
    mock_slack.chat_appendStream.assert_not_called()

    buf.flush()
    chunks = mock_slack.chat_appendStream.call_args.kwargs["chunks"]
    assert chunks == [{"type": "markdown_text", "text": "**bold text**"}]

  def test_flush_handles_api_error(self):
    """If appendStream raises, buffer is cleared and has_flushed stays False."""
    mock_slack = Mock()
    mock_slack.chat_appendStream.side_effect = Exception("rate limited")
    buf = StreamBuffer(mock_slack, "C1", "ts1")

    buf.append("text")
    result = buf.flush()
    assert result is False
    assert buf.has_flushed is False
    # Buffer should be cleared even on error (don't re-send stale content)
    assert buf._buffer == ""


# ---------------------------------------------------------------------------
# Overthink mode skip status
# ---------------------------------------------------------------------------


class TestOverthinkSkipStatus:
  """Verify overthink mode flashes a typing status before skipping."""

  @patch("ai_platform_engineering.integrations.slack_bot.utils.ai.time.sleep")
  def test_low_confidence_flashes_status(self, mock_sleep):
    """LOW_CONFIDENCE flashes skip status then clears after 2s."""
    events = [
      _content_event("[LOW_CONFIDENCE] I'm not sure about this."),
      _text_message_end_event(),
      _done_event(),
    ]
    mock_slack = _mock_slack()

    result = stream_response(
      sse_client=_mock_sse_client(events),
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
      overthink_config=_OVERTHINK_ENABLED,
      client_context={"source": "slack"},
    )

    assert isinstance(result, dict)
    assert result["skipped"] is True
    assert result["reason"] == "low_confidence"

    # Should have called setStatus with the skip message (clear is a no-op)
    status_calls = [c.kwargs.get("status", "") for c in mock_slack.assistant_threads_setStatus.call_args_list]
    assert _STATUS_SKIP_LOW_CONFIDENCE in status_calls

    # Should sleep 7s to keep the status visible
    mock_sleep.assert_called_once_with(7)

  @patch("ai_platform_engineering.integrations.slack_bot.utils.ai.time.sleep")
  def test_defer_flashes_status(self, mock_sleep):
    """DEFER flashes skip status then clears after 2s."""
    events = [
      _content_event("[DEFER] This needs human approval."),
      _text_message_end_event(),
      _done_event(),
    ]
    mock_slack = _mock_slack()

    result = stream_response(
      sse_client=_mock_sse_client(events),
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
      overthink_config=_OVERTHINK_ENABLED,
      client_context={"source": "slack"},
    )

    assert isinstance(result, dict)
    assert result["skipped"] is True
    assert result["reason"] == "defer"

    status_calls = [c.kwargs.get("status", "") for c in mock_slack.assistant_threads_setStatus.call_args_list]
    assert _STATUS_SKIP_DEFER in status_calls

    mock_sleep.assert_called_once_with(7)

  @patch("ai_platform_engineering.integrations.slack_bot.utils.ai.time.sleep")
  def test_overthink_shows_thinking_then_skip_status(self, mock_sleep):
    """In overthink mode, thinking statuses are shown during processing, then skip status on skip."""
    events = [
      _content_event("Some thinking..."),
      _text_message_end_event(),
      _tool_start_event("search", "tc-1"),
      _tool_end_event("tc-1"),
      _content_event("[LOW_CONFIDENCE] Not sure."),
      _text_message_end_event(),
      _done_event(),
    ]
    mock_slack = _mock_slack()

    stream_response(
      sse_client=_mock_sse_client(events),
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
      overthink_config=_OVERTHINK_ENABLED,
      client_context={"source": "slack"},
    )

    status_calls = [c.kwargs.get("status", "") for c in mock_slack.assistant_threads_setStatus.call_args_list]

    # Should see: initial thinking prefix, thinking text on TEXT_MESSAGE_END,
    # second text on TEXT_MESSAGE_END, skip message, then cleared ""
    thinking_statuses = [s for s in status_calls if _STATUS_PREFIX.rstrip() in s]
    assert len(thinking_statuses) >= 1, f"Expected thinking statuses, got: {status_calls}"

    # Skip status should be present
    assert _STATUS_SKIP_LOW_CONFIDENCE in status_calls

  @patch("ai_platform_engineering.integrations.slack_bot.utils.ai.time.sleep")
  def test_overthink_no_stream_opened(self, mock_sleep):
    """In overthink mode, no Slack stream is opened (no todos, no plan cards)."""
    events = [
      _content_event("Thinking about this..."),
      _text_message_end_event(),
      _content_event("[LOW_CONFIDENCE] Not sure."),
      _text_message_end_event(),
      _done_event(),
    ]
    mock_slack = _mock_slack()

    stream_response(
      sse_client=_mock_sse_client(events),
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
      overthink_config=_OVERTHINK_ENABLED,
    )

    # Stream should never have been opened
    mock_slack.chat_startStream.assert_not_called()
    mock_slack.chat_appendStream.assert_not_called()
    mock_slack.chat_stopStream.assert_not_called()

  @patch("ai_platform_engineering.integrations.slack_bot.utils.ai.time.sleep")
  def test_overthink_run_error_flashes_status_no_stream(self, mock_sleep):
    """RUN_ERROR in overthink mode flashes error status, doesn't stream error."""
    events = [
      SSEEvent(type=SSEEventType.RUN_ERROR, message="MCP server timeout"),
    ]
    mock_slack = _mock_slack()

    result = stream_response(
      sse_client=_mock_sse_client(events),
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
      overthink_config=_OVERTHINK_ENABLED,
    )

    assert isinstance(result, dict)
    assert result["skipped"] is True
    assert result["reason"] == "error"

    # Should flash the error status (clear is a no-op)
    status_calls = [c.kwargs.get("status", "") for c in mock_slack.assistant_threads_setStatus.call_args_list]
    assert _STATUS_ERROR in status_calls

    mock_sleep.assert_called_once_with(7)

    # No error message posted to Slack
    mock_slack.chat_startStream.assert_not_called()
    mock_slack.chat_stopStream.assert_not_called()
    mock_slack.chat_postMessage.assert_not_called()

  @patch("ai_platform_engineering.integrations.slack_bot.utils.ai.time.sleep")
  def test_overthink_exception_flashes_status_no_stream(self, mock_sleep):
    """Exception during streaming in overthink mode flashes error status, doesn't post error."""
    mock_slack = _mock_slack()

    # SSE client whose iterator raises mid-stream (simulates connection error
    # during iteration, not during the stream_chat() call itself — stream_chat
    # returns a generator so the exception happens inside the for-loop).
    def _exploding_generator(*args, **kwargs):
      raise Exception("Connection refused")
      yield  # noqa: F841 — unreachable yield makes this a generator function

    mock_sse = Mock()
    mock_sse.stream_chat.return_value = _exploding_generator()

    result = stream_response(
      sse_client=mock_sse,
      slack_client=mock_slack,
      channel_id="C1",
      thread_ts="t1",
      message_text="hi",
      team_id="T1",
      user_id="U123",
      agent_id="test-agent",
      conversation_id="conv-1",
      overthink_config=_OVERTHINK_ENABLED,
    )

    assert isinstance(result, dict)
    assert result["skipped"] is True
    assert result["reason"] == "error"

    # Should flash the error status (clear is a no-op)
    status_calls = [c.kwargs.get("status", "") for c in mock_slack.assistant_threads_setStatus.call_args_list]
    assert _STATUS_ERROR in status_calls

    mock_sleep.assert_called_once_with(7)

    # No error message posted to Slack
    mock_slack.chat_stopStream.assert_not_called()
    mock_slack.chat_postMessage.assert_not_called()
