"""Tests for todo-aware streaming in ai.py.

When the agent uses write_todos, the Slack bot should:
- Parse todos from write_todos TOOL_CALL_ARGS (no API call — checkpoint not persisted mid-stream)
- Show todos as task cards instead of raw tool names
- Keep plan card clean: no thinking text in details, no tool thoughts in output
- Suppress raw tool cards when in todo-aware mode
- Fall back to raw tool cards when no todos exist
"""

import json
from unittest.mock import Mock

from ai_platform_engineering.integrations.slack_bot.utils.ai import stream_response
from ai_platform_engineering.integrations.slack_bot.utils.agui_events import (
  parse_write_todos_args as _parse_write_todos_args,
)
from ai_platform_engineering.integrations.slack_bot.sse_client import SSEEvent, SSEEventType


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SAMPLE_TODOS = [
  {"id": 1, "content": "Research the deployment issue", "status": "completed"},
  {"id": 2, "content": "Create tracking ticket", "status": "in_progress"},
  {"id": 3, "content": "Summarize findings", "status": "pending"},
]

SAMPLE_TODOS_JSON = json.dumps({"todos": SAMPLE_TODOS})

# Real backend write_todos args omit 'id' — only 'content' and 'status'
SAMPLE_TODOS_NO_ID = [
  {"content": "Task 1 - Initial setup", "status": "completed"},
  {"content": "Task 2 - Processing", "status": "in_progress"},
  {"content": "Task 3 - Finalization", "status": "pending"},
]

SAMPLE_TODOS_NO_ID_JSON = json.dumps({"todos": SAMPLE_TODOS_NO_ID})


def _content_event(text):
  return SSEEvent(type=SSEEventType.TEXT_MESSAGE_CONTENT, delta=text)


def _tool_start_event(name="search", tool_call_id="tc-1"):
  return SSEEvent(type=SSEEventType.TOOL_CALL_START, tool_call_name=name, tool_call_id=tool_call_id)


def _tool_args_event(tool_call_id="tc-1", delta='{"thought": "Looking for docs"}'):
  return SSEEvent(type=SSEEventType.TOOL_CALL_ARGS, tool_call_id=tool_call_id, delta=delta)


def _tool_end_event(tool_call_id="tc-1"):
  return SSEEvent(type=SSEEventType.TOOL_CALL_END, tool_call_id=tool_call_id)


def _run_started_event(run_id="run-1"):
  return SSEEvent(type=SSEEventType.RUN_STARTED, run_id=run_id)


def _done_event(run_id="run-1"):
  return SSEEvent(type=SSEEventType.RUN_FINISHED, run_id=run_id)


def _namespace_event(namespace):
  """NAMESPACE_CONTEXT custom event. Empty list = root agent, non-empty = subagent."""
  return SSEEvent(type=SSEEventType.CUSTOM, name="NAMESPACE_CONTEXT", value={"namespace": namespace})


def _mock_slack():
  mock = Mock()
  mock.chat_startStream.return_value = {"ts": "stream-ts-1"}
  mock.chat_appendStream.return_value = {"ok": True}
  mock.chat_stopStream.return_value = {"ok": True}
  mock.chat_postMessage.return_value = {"ts": "msg-ts-1"}
  mock.chat_delete.return_value = {"ok": True}
  mock.assistant_threads_setStatus.return_value = {"ok": True}
  return mock


def _mock_sse_client(events):
  """Create a mock SSE client that yields events.

  Args:
      events: List of SSEEvent to yield from stream_chat.
  """
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


def _get_plan_updates(mock_slack):
  """Collect all plan_update chunks from appendStream calls."""
  updates = []
  for c in mock_slack.chat_appendStream.call_args_list:
    for chunk in c.kwargs.get("chunks", []):
      if chunk.get("type") == "plan_update":
        updates.append(chunk)
  return updates


def _run_stream(events, **kwargs):
  """Run stream_response with mocks. Returns (mock_slack, mock_sse)."""
  mock_sse = _mock_sse_client(events)
  mock_slack = _mock_slack()
  stream_response(
    sse_client=mock_sse,
    slack_client=mock_slack,
    channel_id="C1",
    thread_ts="t1",
    message_text="test query",
    team_id="T1",
    user_id="U123",
    agent_id="test-agent",
    conversation_id="conv-1",
    **kwargs,
  )
  return mock_slack, mock_sse


# ---------------------------------------------------------------------------
# Tests: _parse_write_todos_args
# ---------------------------------------------------------------------------


class TestParseWriteTodosArgs:
  """Tests for the _parse_write_todos_args helper."""

  def test_basic_parse(self):
    result = _parse_write_todos_args('{"todos": [{"id": 1, "content": "Step 1", "status": "pending"}]}')
    assert len(result) == 1
    assert result[0]["content"] == "Step 1"

  def test_multiple_todos(self):
    result = _parse_write_todos_args(SAMPLE_TODOS_JSON)
    assert len(result) == 3

  def test_empty_string(self):
    assert _parse_write_todos_args("") is None

  def test_none(self):
    assert _parse_write_todos_args(None) is None

  def test_invalid_json(self):
    assert _parse_write_todos_args("not json") is None

  def test_no_todos_key(self):
    assert _parse_write_todos_args('{"other": "data"}') is None

  def test_empty_todos_list(self):
    assert _parse_write_todos_args('{"todos": []}') is None

  def test_todos_not_list(self):
    assert _parse_write_todos_args('{"todos": "not a list"}') is None


# ---------------------------------------------------------------------------
# Tests: write_todos parses from TOOL_CALL_ARGS
# ---------------------------------------------------------------------------


class TestWriteTodosFromArgs:
  """write_todos parses todos from TOOL_CALL_ARGS, not from the API."""

  def test_write_todos_parses_from_args(self):
    """write_todos uses TOOL_CALL_ARGS data, no API call needed."""
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", SAMPLE_TODOS_JSON),
      _tool_end_event("tc-wt-1"),
      _content_event("Done."),
      _done_event(),
    ]
    mock_slack, mock_sse = _run_stream(events)

    # Todos should be emitted (parsed from args)
    plan_updates = _get_plan_updates(mock_slack)
    assert len(plan_updates) >= 1

  def test_write_todos_emits_plan_and_task_updates(self):
    """After write_todos, plan_update and task_update chunks are emitted."""
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", SAMPLE_TODOS_JSON),
      _tool_end_event("tc-wt-1"),
      _content_event("Done."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    plan_updates = _get_plan_updates(mock_slack)
    assert len(plan_updates) >= 1
    # Plan title should be the active todo's content
    assert plan_updates[0]["title"] == "Create tracking ticket"

    task_updates = _get_task_updates(mock_slack)
    todo_updates = [u for u in task_updates if u["id"].startswith("todo_")]
    assert len(todo_updates) >= 3
    todo_ids = {u["id"] for u in todo_updates}
    assert {"todo_1", "todo_2", "todo_3"} == todo_ids

  def test_write_todos_not_shown_as_raw_tool_card(self):
    """write_todos itself is never shown as a raw task_update card."""
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", SAMPLE_TODOS_JSON),
      _tool_end_event("tc-wt-1"),
      _content_event("Done."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    task_updates = _get_task_updates(mock_slack)
    raw_write_todos = [u for u in task_updates if u.get("title") == "write_todos"]
    assert len(raw_write_todos) == 0, "write_todos should never appear as a raw tool card"

  def test_write_todos_no_args_logs_warning(self):
    """write_todos with no TOOL_CALL_ARGS logs a warning and doesn't crash."""
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      # No _tool_args_event — args buffer will be empty
      _tool_end_event("tc-wt-1"),
      _tool_start_event("rag_search", "tc-2"),
      _tool_end_event("tc-2"),
      _content_event("Done."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    # Should still work — no raw tool cards rendered (raw cards removed)
    task_updates = _get_task_updates(mock_slack)
    raw_search = [u for u in task_updates if u.get("title") == "rag_search"]
    assert len(raw_search) == 0, "raw tool cards should not be rendered"
    mock_slack.chat_stopStream.assert_called_once()


# ---------------------------------------------------------------------------
# Tests: Backend todos without 'id' field (real-world behavior)
# ---------------------------------------------------------------------------


class TestTodosWithoutIdField:
  """The real backend omits 'id' from write_todos args — index-based IDs assigned."""

  def test_no_id_assigns_index_based_ids(self):
    """Todos without 'id' get 1-based index IDs so each card is unique."""
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", SAMPLE_TODOS_NO_ID_JSON),
      _tool_end_event("tc-wt-1"),
      _content_event("Done."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    task_updates = _get_task_updates(mock_slack)
    todo_updates = [u for u in task_updates if u["id"].startswith("todo_")]
    todo_ids = {u["id"] for u in todo_updates}
    assert {"todo_1", "todo_2", "todo_3"} == todo_ids, f"Expected unique IDs, got: {todo_ids}"

  def test_no_id_plan_title_uses_active_todo(self):
    """Plan title should be the in_progress todo, not the first todo."""
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", SAMPLE_TODOS_NO_ID_JSON),
      _tool_end_event("tc-wt-1"),
      _content_event("Done."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    plan_updates = _get_plan_updates(mock_slack)
    assert len(plan_updates) >= 1
    # Task 2 is in_progress, so it should be the plan title
    assert plan_updates[0]["title"] == "Task 2 - Processing"

  def test_no_id_thinking_not_in_details(self):
    """Thinking text is NOT sent to the plan card details — plan stays clean."""
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", SAMPLE_TODOS_NO_ID_JSON),
      _tool_end_event("tc-wt-1"),
      _content_event("Checking sources..."),
      _tool_start_event("rag_search", "tc-2"),
      _tool_end_event("tc-2"),
      _content_event("Done."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    task_updates = _get_task_updates(mock_slack)
    # No task_update should have details — thinking is not sent to plan cards
    updates_with_details = [u for u in task_updates if u.get("details")]
    assert len(updates_with_details) == 0, f"No details expected in plan cards, got: {updates_with_details}"


class TestRawToolSuppression:
  """When has_todos is True, raw tool names are suppressed from the UI."""

  def test_raw_tool_suppressed_after_todos_loaded(self):
    """Regular tool calls after write_todos do NOT produce raw task_update cards."""
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", SAMPLE_TODOS_JSON),
      _tool_end_event("tc-wt-1"),
      # Now a regular tool call — should be suppressed
      _tool_start_event("rag_search", "tc-2"),
      _tool_args_event("tc-2", '{"thought": "Searching knowledge base"}'),
      _tool_end_event("tc-2"),
      _content_event("Found the answer."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    task_updates = _get_task_updates(mock_slack)
    raw_search = [u for u in task_updates if u.get("title") == "rag_search"]
    assert len(raw_search) == 0, "Raw tool card should be suppressed in todo-aware mode"

  def test_no_raw_tool_cards_without_todos(self):
    """Without todos, regular tool calls do not show as task_update cards."""
    events = [
      _run_started_event(),
      _tool_start_event("rag_search", "tc-1"),
      _tool_end_event("tc-1"),
      _content_event("Found the answer."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    task_updates = _get_task_updates(mock_slack)
    raw_search = [u for u in task_updates if u.get("title") == "rag_search"]
    assert len(raw_search) == 0, "Raw tool cards should not appear — task cards are only for todos"


# ---------------------------------------------------------------------------
# Tests: Thinking text attached to active todo
# ---------------------------------------------------------------------------


class TestThinkingOnActiveTodo:
  """Thinking text between tool calls is NOT sent to plan card details."""

  def test_thinking_text_not_in_details(self):
    """Thinking text before a tool call is NOT attached to the active todo as details."""
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", SAMPLE_TODOS_JSON),
      _tool_end_event("tc-wt-1"),
      _content_event("Let me search the knowledge base..."),
      _tool_start_event("rag_search", "tc-2"),
      _tool_end_event("tc-2"),
      _content_event("Here is the answer."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    task_updates = _get_task_updates(mock_slack)
    # No task_update should have details — plan card stays clean
    updates_with_details = [u for u in task_updates if u.get("details")]
    assert len(updates_with_details) == 0, f"No details expected, got: {updates_with_details}"

  def test_thinking_text_not_emitted_on_boundary(self):
    """Thinking text is not emitted to plan card on TEXT_MESSAGE_END or TOOL_CALL_START."""
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", SAMPLE_TODOS_JSON),
      _tool_end_event("tc-wt-1"),
      _content_event("Thinking part 1. "),
      _content_event("Thinking part 2."),
      _tool_start_event("rag_search", "tc-2"),
      _tool_end_event("tc-2"),
      _content_event("Done."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    task_updates = _get_task_updates(mock_slack)
    updates_with_details = [u for u in task_updates if u.get("details")]
    assert len(updates_with_details) == 0, f"No details expected, got: {updates_with_details}"


# ---------------------------------------------------------------------------
# Tests: No tool thoughts in plan card output
# ---------------------------------------------------------------------------


class TestNoToolThoughtInPlanCard:
  """Tool thoughts are NOT sent to the plan card — keep it clean."""

  def test_tool_thought_not_in_output(self):
    """Tool thought from args is NOT attached to the active todo as output."""
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", SAMPLE_TODOS_JSON),
      _tool_end_event("tc-wt-1"),
      _tool_start_event("rag_search", "tc-2"),
      _tool_args_event("tc-2", '{"thought": "Found 3 relevant docs", "query": "k8s"}'),
      _tool_end_event("tc-2"),
      _content_event("Here is the answer."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    task_updates = _get_task_updates(mock_slack)
    updates_with_output = [u for u in task_updates if u.get("output")]
    assert len(updates_with_output) == 0, f"No output expected in plan cards, got: {updates_with_output}"


# ---------------------------------------------------------------------------
# Tests: Multiple write_todos calls update state
# ---------------------------------------------------------------------------


class TestMultipleWriteTodos:
  """Multiple write_todos calls each update the todo state from args."""

  def test_two_write_todos_updates_state(self):
    """Two write_todos calls each parse from their own TOOL_CALL_ARGS."""
    initial_json = json.dumps(
      {
        "todos": [
          {"id": 1, "content": "Step 1", "status": "in_progress"},
        ]
      }
    )
    updated_json = json.dumps(
      {
        "todos": [
          {"id": 1, "content": "Step 1", "status": "completed"},
          {"id": 2, "content": "Step 2", "status": "in_progress"},
        ]
      }
    )
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", initial_json),
      _tool_end_event("tc-wt-1"),
      _tool_start_event("rag_search", "tc-2"),
      _tool_end_event("tc-2"),
      _tool_start_event("write_todos", "tc-wt-2"),
      _tool_args_event("tc-wt-2", updated_json),
      _tool_end_event("tc-wt-2"),
      _content_event("Done."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    # Should have plan updates from both write_todos calls
    plan_updates = _get_plan_updates(mock_slack)
    assert len(plan_updates) >= 2

    # Second batch should include Step 2
    task_updates = _get_task_updates(mock_slack)
    step2_updates = [u for u in task_updates if u.get("title") == "Step 2"]
    assert len(step2_updates) >= 1


# ---------------------------------------------------------------------------
# Tests: Full realistic scenario
# ---------------------------------------------------------------------------


class TestFullTodoScenario:
  """End-to-end test of a realistic todo-aware streaming flow."""

  def test_full_flow_with_todos(self):
    """
    Realistic flow:
    1. RUN_STARTED — no pre-existing todos
    2. write_todos — creates 3 todos (from args)
    3. rag_search — with thinking and thought
    4. write_todos — updates todo statuses (from args)
    5. Final answer
    """
    initial_json = json.dumps(
      {
        "todos": [
          {"id": 1, "content": "Research issue", "status": "in_progress"},
          {"id": 2, "content": "Create ticket", "status": "pending"},
          {"id": 3, "content": "Summarize", "status": "pending"},
        ]
      }
    )
    updated_json = json.dumps(
      {
        "todos": [
          {"id": 1, "content": "Research issue", "status": "completed"},
          {"id": 2, "content": "Create ticket", "status": "in_progress"},
          {"id": 3, "content": "Summarize", "status": "pending"},
        ]
      }
    )
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      _tool_args_event("tc-wt-1", initial_json),
      _tool_end_event("tc-wt-1"),
      _content_event("Let me search for relevant docs..."),
      _tool_start_event("rag_search", "tc-2"),
      _tool_args_event("tc-2", '{"thought": "Found 3 guides", "query": "deploy"}'),
      _tool_end_event("tc-2"),
      _tool_start_event("write_todos", "tc-wt-2"),
      _tool_args_event("tc-wt-2", updated_json),
      _tool_end_event("tc-wt-2"),
      _content_event("Here is the summary of the deployment issue."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    # Verify no raw tool cards
    task_updates = _get_task_updates(mock_slack)
    raw_cards = [u for u in task_updates if u.get("title") in ("rag_search", "write_todos")]
    assert len(raw_cards) == 0, f"Raw tool cards should be suppressed, got: {raw_cards}"

    # Verify plan updates exist
    plan_updates = _get_plan_updates(mock_slack)
    assert len(plan_updates) >= 1

    # Verify todo task cards exist
    todo_cards = [u for u in task_updates if u["id"].startswith("todo_")]
    assert len(todo_cards) >= 3

    # Verify final text is delivered
    stop_call = mock_slack.chat_stopStream.call_args
    assert stop_call is not None

  def test_write_todos_no_args_falls_back_gracefully(self):
    """If write_todos has no parseable args, no task cards shown but response still delivered."""
    events = [
      _run_started_event(),
      _tool_start_event("write_todos", "tc-wt-1"),
      # No args event
      _tool_end_event("tc-wt-1"),
      _tool_start_event("rag_search", "tc-2"),
      _tool_end_event("tc-2"),
      _content_event("Done."),
      _done_event(),
    ]
    mock_slack, _ = _run_stream(events)

    # No raw tool cards — task cards are only for todos
    task_updates = _get_task_updates(mock_slack)
    raw_cards = [u for u in task_updates if u.get("title") == "rag_search"]
    assert len(raw_cards) == 0, "Raw tool cards should not appear"
    mock_slack.chat_stopStream.assert_called_once()
