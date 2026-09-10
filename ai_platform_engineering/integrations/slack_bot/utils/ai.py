# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0

"""
AG-UI Streaming Integration

This module handles all interactions with dynamic agents via AG-UI protocol:
- Streaming responses from AI agents (stream_response)
- Non-streaming invoke for bot users (invoke_response)
- Alert processing with AI agents
- Real-time progress updates in Slack
"""

import json
import os
import re
import threading
import time

from loguru import logger

try:
  from sse_client import SSEClient, SSEEventType  # type: ignore[import]
except ImportError:
  from ..sse_client import SSEClient, SSEEventType
from . import slack_formatter

APP_NAME = os.environ.get("SLACK_INTEGRATION_APP_NAME", os.environ.get("APP_NAME", "CAIPE"))

# Keys to search for in tool arguments to find reasoning/thought text.
# Matches the UI's extractToolThought() in ui/src/types/timeline.ts.
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

# Typing indicator constants (overridable via env vars)
_STATUS_PREFIX = ""
_STATUS_MAX_LEN = 50  # Slack loading_messages hard limit is 50 chars
_DEFAULT_LOADING_MESSAGES = [
  "Thinking...",
  "Convincing the AI to stop overthinking...",
  "Resorting to magic...",
]
_raw_loading = os.environ.get("SLACK_LOADING_MESSAGES")
_INITIAL_LOADING_MESSAGES = ([m.strip() for m in _raw_loading.split(",") if m.strip()] if _raw_loading else _DEFAULT_LOADING_MESSAGES) or _DEFAULT_LOADING_MESSAGES  # fall back if split produces empty list
_STATUS_SKIP_LOW_CONFIDENCE = os.environ.get("SLACK_STATUS_SKIP_LOW_CONFIDENCE", "Response is low confidence, not responding")
_STATUS_SKIP_DEFER = os.environ.get("SLACK_STATUS_SKIP_DEFER", "Letting a human handle this")
_STATUS_ERROR = os.environ.get("SLACK_STATUS_ERROR", "Something went wrong")
_OVERTHINK_STATUS_DISPLAY_SECS = int(os.environ.get("SLACK_OVERTHINK_STATUS_DISPLAY_SECS", "7"))

# Overthink-mode keepalive: cycle these messages when no SSE events arrive.
_OVERTHINK_KEEPALIVE_INTERVAL = 60  # seconds between keepalive messages
_OVERTHINK_KEEPALIVE_MESSAGES = [
  "Still working on it...",
  "Taking longer than expected...",
  "Really overthinking this...",
]
_STATUS_OVERTHINK_WRITE_TODOS = "Checking notes..."
_STATUS_RATE_LIMIT_SECS = 1.0  # minimum seconds between setStatus calls

OVERTHINK_BOILERPLATE = (
    "You are deciding whether to respond to a Slack message. Follow these steps in order"
    " — they take priority over any other instructions in this prompt. Use the control"
    " tokens below to opt out of replying — they are intercepted and never posted to"
    " Slack, so never reply with empty text.\n"
    "\n"
    "STEP 1 — Quick filter (no search). Output ONLY `[DEFER]` (the literal token, nothing"
    " else) if the message is:\n"
    "  - A greeting, thanks, or social chit-chat (\"hi\", \"morning\", \"thanks!\")\n"
    "  - Any request to review, approve, merge, or look at an MR / PR / pipeline / deploy"
    " — even if phrased as \"please review\" to you, even if you have a tool that could"
    " fetch it. Code review is a human task.\n"
    "  - Asking a human to act — sign off, page someone, intervene, take a look\n"
    "  - A status update, FYI, or announcement, or not clearly directed at you\n"
    "\n"
    "STEP 2 — Search (MANDATORY when you reach this step). Run multiple keyword"
    " combinations, use both keyword and semantic search, and fetch full document content"
    " for promising results. Do not answer from general knowledge.\n"
    "\n"
    "STEP 3 — Respond:\n"
    "  - 2+ sources agree, OR 1 source directly and completely answers → answer in ~5"
    " sentences and end with a Sources section linking every source.\n"
    "  - Sources mention the topic but don't contain the specific answer, OR you found"
    " nothing useful → write your best-effort draft answer and list any sources you"
    " found, then on the final line output `[LOW_CONFIDENCE]` (alone, on its own line)."
    " The entire response will be intercepted and not posted to Slack — the draft is"
    " preserved in conversation history so a follow-up can build on it.\n"
    "\n"
    "If the message asks YOU to take a non-review action (create a ticket, look up an"
    " incident), do it and confirm what you did — this is not Step 1.\n"
    "\n"
    "NEVER show your reasoning, classification, or self-grading in the response (no"
    " \"Confidence: High\", \"This is a greeting\"). The bracket tokens are control"
    " signals — emit them alone, never alongside prose.\n"
    "\n"
    "---\n"
)


def _parse_write_todos_args(raw_args_json: str) -> list[dict] | None:
  """Parse the todo list from write_todos tool arguments.

  The write_todos tool is called with args like:
  {"todos": [{"id": 1, "content": "...", "status": "in_progress"}, ...]}

  Args:
      raw_args_json: JSON string of write_todos tool arguments.

  Returns:
      List of todo dicts, or None if parsing fails.
  """
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


def _extract_tool_thought(raw_args_json: str) -> str | None:
  """Extract a thought/reason string from JSON-encoded tool arguments.

  Searches for well-known keys (thought, reason, etc.) in the parsed
  args dict and returns the first non-empty string value found, truncated
  to _MAX_DETAILS_LEN characters.

  Args:
      raw_args_json: JSON string of tool arguments (may be truncated by backend).

  Returns:
      Truncated thought string, or None if no thought field found.
  """
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


class StreamBuffer:
  """Batches markdown text chunks before flushing to Slack's appendStream.

  Flushes on newline boundaries to avoid splitting mid-markdown (e.g.
  sending ``**bold`` in one chunk and `` text**`` in the next, which
  Slack renders as broken formatting).  A max-interval flush (default 1s)
  acts as a safety net so content never stalls for too long even if
  newlines are sparse.
  """

  def __init__(self, slack_client, channel_id, stream_ts, flush_interval=1.0):
    self.slack_client = slack_client
    self.channel_id = channel_id
    self.stream_ts = stream_ts
    self.flush_interval = flush_interval
    self._buffer = ""
    self._last_flush = time.monotonic()
    self._flushed_any = False

  @property
  def has_flushed(self):
    return self._flushed_any

  def append(self, text):
    """Add text to the buffer; auto-flush on newline or after the interval."""
    self._buffer += text

    elapsed = time.monotonic() - self._last_flush

    # Prefer flushing on newline boundaries so markdown isn't split mid-token
    if "\n" in self._buffer:
      # Flush up to (and including) the last newline; keep the remainder
      last_nl = self._buffer.rfind("\n")
      to_flush = self._buffer[: last_nl + 1]
      self._buffer = self._buffer[last_nl + 1 :]
      if to_flush:
        self._send(to_flush)
    elif elapsed >= self.flush_interval:
      # No newline seen for a while — flush everything as a safety net
      self.flush()

  def flush(self):
    """Send all buffered text to Slack immediately. No-op if buffer is empty."""
    if not self._buffer:
      return False
    text = self._buffer
    self._buffer = ""
    return self._send(text)

  def _send(self, text):
    """Send *text* to Slack and update bookkeeping."""
    self._last_flush = time.monotonic()
    try:
      chunks = [{"type": "markdown_text", "text": text}]
      logger.debug(f"SLACK appendStream text: {text[:100]!r}")
      self.slack_client.chat_appendStream(
        channel=self.channel_id,
        ts=self.stream_ts,
        chunks=chunks,
      )
      self._flushed_any = True
      return True
    except Exception as e:
      logger.warning(f"SLACK appendStream text FAILED: {e}")
      return False


def _build_footer_text(triggered_by_user_id=None, additional_footer=None, agent_id=None) -> str:
  """Build footer text with optional user attribution and additional text."""
  parts = []
  if additional_footer:
    parts.append(f"_{additional_footer}_")
  if agent_id:
    parts.append(f"_Agent: {agent_id}_")
  if triggered_by_user_id:
    parts.append(f"_Requested by <@{triggered_by_user_id}>_")
  parts.append(f"*_Mention @{APP_NAME} to continue_*")
  return " • ".join(parts)


# Prefix added to retry messages after tool failures
# Prefix added to retry messages after tool failures
_DEFAULT_RETRY_PREFIX = """IMPORTANT: A previous attempt to answer this question failed because some tools or subagents were unavailable or timed out.

Please try a different approach:
- If certain tools are unavailable, say so and offer alternatives
- Ask the user to paste relevant information directly if needed
- Keep it simple — avoid complex subagent chains

"""
RETRY_PROMPT_PREFIX = os.environ.get("SLACK_INTEGRATION_PROMPT_RETRY_PREFIX", _DEFAULT_RETRY_PREFIX)


def stream_response(
  sse_client: SSEClient,
  slack_client,
  channel_id: str,
  thread_ts: str,
  message_text: str,
  team_id: str,
  user_id: str,
  agent_id: str,
  conversation_id: str,
  triggered_by_user_id=None,
  additional_footer=None,
  overthink_config=None,
  escalation_config=None,
  is_resume=False,
  resume_form_data=None,
  resume_trace_id=None,
  client_context=None,
  files=None,
):
  """
  Stream an AG-UI response to Slack.

  Hybrid approach:
  1. Show typing indicator while waiting for first content
  2. Open Slack stream on first text chunk
  3. Buffer and flush markdown via StreamBuffer
  4. Show tool call progress as task_update chunks
  5. Finalize with feedback blocks on RUN_FINISHED

  Args:
      sse_client: SSEClient instance for dynamic agents.
      slack_client: Slack WebClient instance.
      channel_id: Slack channel ID.
      thread_ts: Slack thread timestamp.
      message_text: User's message text (ignored for resume).
      team_id: Slack team ID.
      user_id: Slack user ID.
      agent_id: Dynamic agent config ID.
      conversation_id: Deterministic UUID v5 from thread_ts.
      triggered_by_user_id: Optional user ID for footer attribution.
      additional_footer: Optional footer text.
      overthink_config: Optional OverthinkConfig; when present and enabled,
          process silently and skip low-confidence responses.
      escalation_config: Optional escalation config for delete buttons.
      is_resume: If True, use resume_stream() instead of stream_chat().
      resume_form_data: JSON string of form data for resume.
      resume_trace_id: Trace ID for resume.
      files: Optional multimodal attachments ({"mime_type", "data", "name"})
          from the Slack message, forwarded to the backend as ChatRequest.files.
          Ignored on resume (the original turn already carried them).

  Returns:
      List of Slack blocks for the final response, or dict with retry_needed=True
      on recoverable errors, or dict with skipped=True if overthink_mode filtered.
  """
  from .hitl_handler import parse_agui_interrupt, format_hitl_form_blocks

  # Derive boolean from config object
  overthink_mode = bool(overthink_config and overthink_config.enabled)

  # Streaming requires a valid user_id (starts with U or W), bot_ids (B) don't work
  can_stream = user_id and user_id[0] in ("U", "W")

  # Slack stream state
  thread_deleted = False
  stream_ts = None
  stream_buf = None
  response_ts = None  # progress message ts for non-streaming fallback

  # Tool tracking for progress display (bot-user fallback)
  current_tool = None
  active_tools = {}  # tool_call_id -> tool_name

  # Content accumulation
  accumulated_text = []  # TEXT_MESSAGE_CONTENT deltas
  needs_separator = False

  # Thinking buffer: text between tool calls is treated as reasoning
  # for the next tool call, shown as details on the tool's checklist item.
  # Text after the last tool call is the final answer (streamed normally).
  pending_thinking = []  # accumulated text chunks before next tool call
  tool_args_buffer = {}  # tool_call_id -> accumulated JSON args string
  typing_text_buf = []  # accumulated text for typing indicator (reset on TEXT_MESSAGE_END / TOOL_CALL_ARGS)

  # Todo-aware progress display:
  # When the agent uses write_todos, we show todos as task cards instead of
  # raw tool names. Thinking text and tool thoughts attach to the active todo.
  todo_items = []  # latest todo list from the API
  active_todo_id = None  # id of the currently in_progress todo
  has_todos = False  # True once we've seen any todos

  # Subagent context: non-empty when events come from a subagent.
  # Text from subagents is suppressed — only the main agent's text is shown.
  in_subagent = False

  # Overthink keepalive: self-rescheduling timer that cycles status messages
  # when no SSE events arrive, preventing the typing indicator from expiring.
  _keepalive_timer: threading.Timer | None = None
  _keepalive_index = 0

  def _fire_keepalive():
    """Called by the timer when no events arrive within the interval."""
    nonlocal _keepalive_index
    msg = _OVERTHINK_KEEPALIVE_MESSAGES[_keepalive_index % len(_OVERTHINK_KEEPALIVE_MESSAGES)]
    _keepalive_index += 1
    _set_typing_status(msg)
    _schedule_keepalive()

  def _schedule_keepalive():
    """(Re)start the keepalive timer. Cancels any pending timer first."""
    nonlocal _keepalive_timer
    _cancel_keepalive()
    if not overthink_mode:
      return
    _keepalive_timer = threading.Timer(_OVERTHINK_KEEPALIVE_INTERVAL, _fire_keepalive)
    _keepalive_timer.daemon = True
    _keepalive_timer.start()

  def _cancel_keepalive():
    """Cancel any pending keepalive timer."""
    nonlocal _keepalive_timer
    if _keepalive_timer:
      _keepalive_timer.cancel()
      _keepalive_timer = None

  def _cancel_pending_status():
    """Cancel any rate-limited pending status timer."""
    nonlocal _pending_status_timer, _pending_status
    if _pending_status_timer:
      _pending_status_timer.cancel()
      _pending_status_timer = None
    _pending_status = None

  def _update_and_emit_todos(todos: list):
    """Update todo state from the given list and emit plan_update + task_update chunks.

    Assigns index-based IDs when the backend omits them (write_todos tool
    does not include 'id' in its args).

    Args:
        todos: List of todo dicts with 'content', 'status', and optionally 'id'.
    """
    nonlocal todo_items, active_todo_id, has_todos
    if not todos:
      return

    # Normalize: ensure every todo has an 'id' (use 1-based index as fallback)
    for i, t in enumerate(todos):
      if "id" not in t:
        t["id"] = i + 1

    todo_items = todos
    has_todos = True

    # Find the active (in_progress) todo
    active_todo_id = None
    for t in todos:
      if t.get("status") == "in_progress":
        active_todo_id = t["id"]
        break

    # Emit plan_update with the active todo's content as title
    plan_title = None
    if active_todo_id is not None:
      for t in todos:
        if t["id"] == active_todo_id:
          plan_title = t.get("content")
          break
    if not plan_title and todos:
      plan_title = todos[0].get("content", "Working...")

    _start_stream_if_needed()
    if not stream_ts:
      return

    try:
      chunks = []
      if plan_title:
        chunks.append(slack_formatter.build_plan_update(plan_title))
      chunks.extend(slack_formatter.build_todo_task_updates(todos))
      logger.debug(f"[{thread_ts}] SLACK appendStream todos: {len(chunks)} chunks: {chunks}")
      slack_client.chat_appendStream(channel=channel_id, ts=stream_ts, chunks=chunks)
    except Exception as e:
      logger.warning(f"[{thread_ts}] SLACK appendStream todos FAILED: {e}")

  # Status rate limiting: at most one setStatus call per _STATUS_RATE_LIMIT_SECS.
  # If a new status arrives within the cooldown, it's queued as pending
  # and dispatched by a timer when the cooldown expires.
  _last_status_time = 0.0
  _pending_status: tuple | None = None  # (status_text, loading_messages)
  _pending_status_timer: threading.Timer | None = None

  def _flush_pending_status():
    """Dispatch the pending status after the rate-limit cooldown."""
    nonlocal _pending_status, _pending_status_timer
    _pending_status_timer = None
    if _pending_status:
      text, msgs = _pending_status
      _pending_status = None
      _set_typing_status(text, msgs)

  def _set_typing_status(status_text, loading_messages=None):
    """Set the typing indicator status (best-effort, non-blocking).

    Rate-limited to one call per second. If called more frequently, the
    latest status is queued and dispatched when the cooldown expires.
    Empty status (clear) is always sent immediately.

    Truncates to _STATUS_MAX_LEN (Slack hard limit) with trailing "..."
    when the text is too long.  ``loading_messages`` can be a list (passed
    through) or omitted (defaults to ``[status_text]``).

    IMPORTANT: Only call this BEFORE startStream. Calling setStatus after
    startStream creates a second message in the thread.
    Only works for streamable users (U/W prefix), not bot users (B prefix).
    """
    nonlocal _last_status_time, _pending_status, _pending_status_timer
    if not can_stream:
      return
    if status_text and len(status_text) > _STATUS_MAX_LEN:
      status_text = status_text[: _STATUS_MAX_LEN - 3] + "..."
    if not status_text:
      return
    if loading_messages is None:
      loading_messages = [status_text]

    # Empty status (clear) always sends immediately
    now = time.monotonic()
    if status_text and (now - _last_status_time) < _STATUS_RATE_LIMIT_SECS:
      # Within cooldown — queue as pending
      _pending_status = (status_text, loading_messages)
      if not _pending_status_timer:
        delay = _STATUS_RATE_LIMIT_SECS - (now - _last_status_time)
        _pending_status_timer = threading.Timer(delay, _flush_pending_status)
        _pending_status_timer.daemon = True
        _pending_status_timer.start()
      return

    # Cancel any pending timer since we're sending now
    if _pending_status_timer:
      _pending_status_timer.cancel()
      _pending_status_timer = None
    _pending_status = None
    _last_status_time = now

    try:
      kwargs = dict(
        channel_id=channel_id,
        thread_ts=thread_ts,
        status=status_text,
        loading_messages=loading_messages,
      )
      slack_client.assistant_threads_setStatus(**kwargs)
    except Exception as e:
      logger.warning(f"[{thread_ts}] SLACK setStatus('{status_text}') FAILED: {e}")

  def _start_stream_if_needed():
    """Lazily start the Slack stream on first real content. Returns stream_ts or None."""
    nonlocal stream_ts, stream_buf, thread_deleted
    if thread_deleted:
      return None
    if stream_ts:
      return stream_ts
    if not can_stream or overthink_mode:
      return None
    try:
      start_response = slack_client.chat_startStream(
        channel=channel_id,
        thread_ts=thread_ts,
        recipient_team_id=team_id,
        recipient_user_id=user_id,
        task_display_mode="plan",
      )
      stream_ts = start_response["ts"]
      stream_buf = StreamBuffer(slack_client, channel_id, stream_ts)
      logger.debug(f"[{thread_ts}] SLACK startStream -> ts={stream_ts}")
      _set_typing_status("")
      return stream_ts
    except Exception as e:
      if "invalid_thread_ts" in str(e) or "thread_not_found" in str(e):
        thread_deleted = True
        logger.warning(f"[{thread_ts}] Thread was deleted mid-processing — aborting response")
      else:
        logger.warning(f"[{thread_ts}] SLACK startStream FAILED: {e}")
      return None

  if can_stream:
    _set_typing_status(_INITIAL_LOADING_MESSAGES[0], _INITIAL_LOADING_MESSAGES)
  elif not overthink_mode:
    # Non-streaming fallback: post a "working..." message
    # (skip in overthink mode — don't post visible messages for silent evaluation)
    initial_blocks = [
      {
        "type": "section",
        "text": {"type": "mrkdwn", "text": f"*{APP_NAME} is working...*"},
      }
    ]
    initial_response = slack_client.chat_postMessage(
      channel=channel_id,
      thread_ts=thread_ts,
      blocks=initial_blocks,
      text=f"*{APP_NAME} is working...*",
    )
    response_ts = initial_response["ts"]

  # Choose stream source: resume or new
  logger.info(f"[{thread_ts}] stream_response: conv={conversation_id} agent={agent_id} resume={is_resume}")
  if is_resume:
    event_stream = sse_client.resume_stream(
      agent_id=agent_id,
      conversation_id=conversation_id,
      form_data=resume_form_data or "",
      trace_id=resume_trace_id,
      client_context=client_context,
    )
  else:
    effective_message = message_text
    event_stream = sse_client.stream_chat(
      message=effective_message,
      conversation_id=conversation_id,
      agent_id=agent_id,
      client_context=client_context,
      files=files,
    )

  try:
    for event in event_stream:
      if thread_deleted:
        logger.info(f"[{thread_ts}] Thread deleted — stopping stream processing")
        break

      # Reset keepalive timer on every event (overthink mode only).
      _schedule_keepalive()

      # --- RUN_STARTED ---
      if event.type == SSEEventType.RUN_STARTED:
        if event.run_id:
          logger.info(f"[{thread_ts}] RUN_STARTED run_id={event.run_id} conv={conversation_id} agent={agent_id}")

      # --- TEXT_MESSAGE_START ---
      elif event.type == SSEEventType.TEXT_MESSAGE_START:
        if in_subagent:
          logger.debug(f"[{thread_ts}] TEXT_MESSAGE_START suppressed (subagent)")
        else:
          logger.debug(f"[{thread_ts}] TEXT_MESSAGE_START msg_id={event.message_id}")

      # --- TEXT_MESSAGE_CONTENT ---
      elif event.type == SSEEventType.TEXT_MESSAGE_CONTENT:
        if in_subagent:
          # Don't accumulate as final answer, but update typing status
          # so the user sees subagent thinking in the typing indicator.
          if not stream_ts and event.delta:
            typing_text_buf.append(event.delta)
          continue
        if event.delta:
          accumulated_text.append(event.delta)

          # Before any tool has been seen, buffer text as potential "thinking".
          # Between tool calls (active_tools empty but seen_any_tool is True),
          # also buffer as thinking for the *next* tool call.
          # Once all tools are done and RUN_FINISHED comes, pending_thinking
          # is flushed as the final answer in the finalization block.
          #
          # While a tool IS active and stream is open (todos), stream live.
          # Otherwise buffer — the final answer will pick it up.
          if active_tools and stream_buf:
            # Mid-tool text — stream it live (only if stream already open)
            text = event.delta
            if needs_separator and stream_buf.has_flushed:
              text = "\n\n" + text
              needs_separator = False
            stream_buf.append(text)
          else:
            # No tool currently running — buffer as thinking
            pending_thinking.append(event.delta)

            if has_todos and active_todo_id is not None:
              # Todo-aware mode: thinking text is NOT sent to the plan card.
              # It only feeds the typing indicator (pre-stream).
              pass

            # Accumulate text for typing indicator — status is updated
            # on TEXT_MESSAGE_END (not on every chunk) to avoid flicker.
            if not stream_ts:
              typing_text_buf.append(event.delta)
            # Don't stream yet — might be thinking for the next tool call.
            # If RUN_FINISHED arrives, we'll stream it as the final answer.

      # --- TEXT_MESSAGE_END ---
      elif event.type == SSEEventType.TEXT_MESSAGE_END:
        if in_subagent:
          continue
        if stream_buf:
          stream_buf.flush()
        # Update typing indicator with accumulated text, then reset buffer
        if not stream_ts and typing_text_buf:
          text = "".join(typing_text_buf).strip()
          if text:
            _set_typing_status(f"{_STATUS_PREFIX}{text}")
          typing_text_buf.clear()
        logger.debug(f"[{thread_ts}] TEXT_MESSAGE_END msg_id={event.message_id}")

      # --- TOOL_CALL_START ---
      elif event.type == SSEEventType.TOOL_CALL_START:
        if stream_buf:
          stream_buf.flush()
        tool_name = event.tool_call_name or event.tool_call_id or "unknown"
        current_tool = tool_name
        if event.tool_call_id:
          active_tools[event.tool_call_id] = tool_name
          tool_args_buffer[event.tool_call_id] = ""
        logger.info(f"[{thread_ts}] Tool started: {tool_name}")

        # Overthink mode: flash a status for write_todos so the user
        # sees the bot is planning, even though there's no stream.
        if overthink_mode and tool_name == "write_todos":
          _set_typing_status(_STATUS_OVERTHINK_WRITE_TODOS)

        # Consume pending thinking text — logged but not sent to Slack plan card
        if pending_thinking:
          thinking_text = "".join(pending_thinking).strip()
          if thinking_text:
            logger.debug(f"[{thread_ts}] Thinking before {tool_name}: {thinking_text[:300]}")
          pending_thinking.clear()

        if has_todos or tool_name == "write_todos":
          # Todo-aware mode (or write_todos itself): open stream for todo cards.
          _start_stream_if_needed()

      # --- TOOL_CALL_ARGS ---
      elif event.type == SSEEventType.TOOL_CALL_ARGS:
        # Accumulate tool arguments; extract thought/reason for display
        if event.tool_call_id and event.delta:
          tool_args_buffer[event.tool_call_id] = tool_args_buffer.get(event.tool_call_id, "") + event.delta

          # Extract thought from partial args and set status immediately,
          # resetting the typing text buffer since the thought supersedes it.
          if not stream_ts:
            thought = _extract_tool_thought(tool_args_buffer[event.tool_call_id])
            if thought:
              typing_text_buf.clear()
              _set_typing_status(f"{_STATUS_PREFIX}{thought}")

      # --- TOOL_CALL_END ---
      elif event.type == SSEEventType.TOOL_CALL_END:
        tool_call_id = event.tool_call_id
        tool_name = active_tools.pop(tool_call_id, None) if tool_call_id else None
        display_name = tool_name or current_tool or "unknown"
        logger.info(f"[{thread_ts}] Tool completed: {display_name}")
        current_tool = None
        needs_separator = True

        # Extract thought from accumulated tool args
        raw_args = ""
        if tool_call_id and tool_call_id in tool_args_buffer:
          raw_args = tool_args_buffer.pop(tool_call_id, "")
        tool_thought = _extract_tool_thought(raw_args) if display_name != "write_todos" else None
        if tool_thought:
          logger.debug(f"[{thread_ts}] Tool thought ({display_name}): {tool_thought}")

        if display_name == "write_todos":
          # Parse todos directly from the tool's args — the checkpoint is not
          # persisted mid-stream, so the REST API would return stale data.
          parsed_todos = _parse_write_todos_args(raw_args)
          logger.info(f"[{thread_ts}] write_todos raw_args({len(raw_args)} chars): {raw_args[:300]}")
          logger.info(f"[{thread_ts}] write_todos parsed {len(parsed_todos) if parsed_todos else 0} todos")
          if parsed_todos:
            _update_and_emit_todos(parsed_todos)
          else:
            logger.warning(f"[{thread_ts}] write_todos completed but could not parse todos from args")
        elif has_todos:
          # Todo-aware mode: no output sent to plan card — keep it clean.
          pass
        # No raw tool cards in the else case — task cards are only for todos.
        if not stream_ts:
          if tool_thought:
            _set_typing_status(f"{_STATUS_PREFIX}{tool_thought}")

      # --- STEP_STARTED ---
      elif event.type == SSEEventType.STEP_STARTED:
        step_name = event.name or event.run_id or "step"
        logger.info(f"[{thread_ts}] Step started: {step_name}")
        if not stream_ts:
          _set_typing_status(f"{_STATUS_PREFIX}{step_name}")

      # --- STEP_FINISHED ---
      elif event.type == SSEEventType.STEP_FINISHED:
        step_name = event.name or event.run_id or "step"
        logger.info(f"[{thread_ts}] Step finished: {step_name}")

      # --- CUSTOM ---
      elif event.type == SSEEventType.CUSTOM:
        if event.name == "WARNING":
          warning_msg = (event.value or {}).get("message", "unknown warning")
          logger.warning(f"[{thread_ts}] Agent warning: {warning_msg}")
        elif event.name == "NAMESPACE_CONTEXT":
          namespace = (event.value or {}).get("namespace", [])
          in_subagent = len(namespace) > 0
          logger.info(f"[{thread_ts}] Subagent context: {namespace}")
        elif event.name == "TOOL_ERROR":
          tool_error = (event.value or {}).get("error", "unknown error")
          tool_id = (event.value or {}).get("tool_call_id")
          logger.warning(f"[{thread_ts}] Tool error (call={tool_id}): {tool_error}")
          # Tool errors are logged but not streamed to Slack — the agent
          # recovers or RUN_ERROR fires for drastic failures.
        else:
          logger.debug(f"[{thread_ts}] CUSTOM event: name={event.name}")

      # --- RUN_FINISHED ---
      elif event.type == SSEEventType.RUN_FINISHED:
        outcome = event.outcome or "success"
        logger.info(f"[{thread_ts}] RUN_FINISHED outcome={outcome} conv={conversation_id} agent={agent_id}")

        if outcome == "interrupt" and event.interrupt:
          # HITL interrupt — render form and return
          logger.info(f"[{thread_ts}] HITL interrupt: {event.interrupt.get('reason', 'unknown')}")
          form = parse_agui_interrupt(
            event,
            conversation_id=conversation_id,
            agent_id=agent_id,
          )
          form_blocks = format_hitl_form_blocks(form)

          # Stop any active stream before posting the form
          if stream_ts:
            try:
              slack_client.chat_stopStream(channel=channel_id, ts=stream_ts)
            except Exception as e:
              logger.debug(f"[{thread_ts}] Failed to stop stream before HITL form: {e}")

          # Post or update with form blocks
          if response_ts:
            try:
              slack_client.chat_update(
                channel=channel_id,
                ts=response_ts,
                blocks=form_blocks,
                text="Action required",
              )
            except Exception:
              slack_client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                blocks=form_blocks,
                text="Action required",
              )
          else:
            slack_client.chat_postMessage(
              channel=channel_id,
              thread_ts=thread_ts,
              blocks=form_blocks,
              text="Action required",
            )
          return form_blocks

        # outcome == "success" — handled in finalization below
        break

      # --- RUN_ERROR ---
      elif event.type == SSEEventType.RUN_ERROR:
        error_msg = event.message or "Unknown agent error"
        logger.error(f"[{thread_ts}] RUN_ERROR: {error_msg} conv={conversation_id} agent={agent_id}")

        # Overthink mode: don't stream errors — flash a casual status and bail
        if overthink_mode:
          logger.info(f"[{thread_ts}] Overthink: suppressing error, flashing status")
          _set_typing_status(_STATUS_ERROR)
          time.sleep(_OVERTHINK_STATUS_DISPLAY_SECS)
          _set_typing_status("")
          return {"skipped": True, "reason": "error"}

        # If we got any text content, show it despite the error
        final_text = "".join(accumulated_text).strip()
        if final_text and final_text != "I've completed your request.":
          logger.info(f"[{thread_ts}] Recovered from error — showing {len(final_text)} chars of content")
          # Fall through to finalization
          break

        # No content — return retry marker
        if stream_ts:
          try:
            error_blocks = slack_formatter.format_error_message(error_msg)
            error_blocks.extend(
              _build_stream_final_blocks(
                channel_id,
                thread_ts,
                response_ts,
                triggered_by_user_id=triggered_by_user_id,
                additional_footer=additional_footer,
                escalation_config=escalation_config,
                agent_id=agent_id,
              )
            )
            slack_client.chat_stopStream(channel=channel_id, ts=stream_ts, blocks=error_blocks)
          except Exception as e:
            logger.warning(f"[{thread_ts}] Failed to stop stream with error: {e}")
        if response_ts:
          try:
            slack_client.chat_delete(channel=channel_id, ts=response_ts)
          except Exception as e:
            logger.debug(f"[{thread_ts}] Failed to delete message {response_ts}: {e}")
        return {"retry_needed": True, "error": error_msg}

      # --- RAW / unknown ---
      elif event.type == SSEEventType.RAW:
        logger.debug(f"[{thread_ts}] RAW event (ignored)")

    # --- Finalization ---
    _cancel_keepalive()
    _cancel_pending_status()
    # When tool calls interleaved with text messages, accumulated_text
    # contains ALL text (thinking + final answer concatenated).  Only the
    # last text segment — still sitting in pending_thinking — is the real
    # answer.  Use it when available; fall back to accumulated_text only
    # when there was no tool-interleaved thinking.
    if pending_thinking:
      final_text = "".join(pending_thinking).strip()
    else:
      final_text = "".join(accumulated_text).strip()

    if overthink_mode and final_text:
      skip_markers = overthink_config.skip_markers if overthink_config else None
      skip_result = _check_overthink_skip(final_text, thread_ts, skip_markers=skip_markers)
      if skip_result:
        # Flash a brief status so the user knows the bot noticed.
        # Must block here — if we return immediately, Slack clears the
        # typing indicator when the Bolt listener exits.
        reason = skip_result.get("reason", "")
        if reason == "defer":
          _set_typing_status(_STATUS_SKIP_DEFER)
        elif reason == "low_confidence":
          _set_typing_status(_STATUS_SKIP_LOW_CONFIDENCE)
        time.sleep(_OVERTHINK_STATUS_DISPLAY_SECS)
        _set_typing_status("")
        return skip_result
      # Strip confidence markers before posting (safety net — _post_final_response
      # and stopStream also strip, but this catches the log message too).
      cleaned = _strip_confidence_markers(final_text)
      if cleaned != final_text:
        logger.info(f"[{thread_ts}] Stripped confidence markers from overthink response")
        final_text = cleaned

    # Default fallback
    if not final_text:
      final_text = "I've completed your request."

    logger.info(f"[{thread_ts}] Final text: {len(final_text)} chars, conv={conversation_id} agent={agent_id}")

    # Clear typing status
    _set_typing_status("")

    # Start stream if never started (must happen BEFORE flushing
    # pending_thinking so that stream_buf exists)
    _start_stream_if_needed()

    # Flush any pending thinking text as the final answer (stream it live)
    if pending_thinking and stream_buf:
      final_thinking = "".join(pending_thinking)
      if needs_separator and stream_buf.has_flushed:
        final_thinking = "\n\n" + final_thinking
      stream_buf.append(final_thinking)
      pending_thinking.clear()

    if stream_ts:
      # Flush remaining buffer
      if stream_buf:
        stream_buf.flush()

      streamed_any_text = stream_buf.has_flushed if stream_buf else False

      # Build stop call
      stop_chunks = []
      if not streamed_any_text and final_text:
        stop_chunks.append({"type": "markdown_text", "text": _strip_confidence_markers(final_text)})

      stop_blocks = _build_stream_final_blocks(
        channel_id,
        thread_ts,
        response_ts,
        triggered_by_user_id=triggered_by_user_id,
        additional_footer=additional_footer,
        escalation_config=escalation_config,
        agent_id=agent_id,
      )
      logger.debug(f"[{thread_ts}] SLACK stopStream: chunks={len(stop_chunks)}, blocks={len(stop_blocks)}")
      try:
        slack_client.chat_stopStream(
          channel=channel_id,
          ts=stream_ts,
          chunks=stop_chunks if stop_chunks else None,
          blocks=stop_blocks,
        )
        return stop_blocks
      except Exception as stop_err:
        err_str = str(stop_err)
        if "message_not_in_streaming_state" in err_str or "not_in_streaming_state" in err_str:
          logger.warning(f"[{thread_ts}] Streaming message expired — posting final answer as regular message")
          return _post_final_response(
            slack_client,
            channel_id,
            thread_ts,
            final_text,
            response_ts,
            triggered_by_user_id=triggered_by_user_id,
            additional_footer=additional_footer,
            escalation_config=escalation_config,
            agent_id=agent_id,
          )
        raise

    elif can_stream:
      if thread_deleted:
        logger.warning(f"[{thread_ts}] Thread deleted — dropping response")
        return None
      logger.warning(f"[{thread_ts}] Stream not started, falling back to regular post")
      return _post_final_response(
        slack_client,
        channel_id,
        thread_ts,
        final_text,
        response_ts,
        triggered_by_user_id=triggered_by_user_id,
        additional_footer=additional_footer,
        escalation_config=escalation_config,
        agent_id=agent_id,
      )
    else:
      if thread_deleted:
        logger.warning(f"[{thread_ts}] Thread deleted — dropping response")
        return None
      # Bot user — delete progress msg, post final
      if response_ts:
        try:
          slack_client.chat_delete(channel=channel_id, ts=response_ts)
          logger.info(f"[{thread_ts}] Deleted progress message {response_ts}")
        except Exception as e:
          logger.warning(f"[{thread_ts}] Could not delete progress message: {e}")
      return _post_final_response(
        slack_client,
        channel_id,
        thread_ts,
        final_text,
        response_ts,
        triggered_by_user_id=triggered_by_user_id,
        additional_footer=additional_footer,
        escalation_config=escalation_config,
        agent_id=agent_id,
      )

  except Exception as e:
    _cancel_keepalive()
    _cancel_pending_status()
    logger.exception(f"[{thread_ts}] Error during streaming: {e}")

    # Overthink mode: don't stream errors — flash a casual status and bail
    if overthink_mode:
      logger.info(f"[{thread_ts}] Overthink: suppressing exception, flashing status")
      _set_typing_status(_STATUS_ERROR)
      time.sleep(_OVERTHINK_STATUS_DISPLAY_SECS)
      _set_typing_status("")
      return {"skipped": True, "reason": "error"}

    error_blocks = slack_formatter.format_error_message(str(e))
    try:
      error_blocks.extend(
        _build_stream_final_blocks(
          channel_id,
          thread_ts,
          response_ts,
          triggered_by_user_id=triggered_by_user_id,
          additional_footer=additional_footer,
          escalation_config=escalation_config,
          agent_id=agent_id,
        )
      )
    except Exception:
      logger.warning(f"[{thread_ts}] Failed to build feedback blocks for error response")
    if stream_ts:
      try:
        slack_client.chat_stopStream(channel=channel_id, ts=stream_ts, blocks=error_blocks)
      except Exception as slack_err:
        logger.warning(f"[{thread_ts}] Failed to stop stream with error: {slack_err}")
    elif response_ts:
      try:
        slack_client.chat_update(
          channel=channel_id,
          ts=response_ts,
          blocks=error_blocks,
          text="Error",
        )
      except Exception as slack_err:
        logger.warning(f"[{thread_ts}] Failed to post error to Slack: {slack_err}")
    elif not thread_deleted:
      try:
        slack_client.chat_postMessage(
          channel=channel_id,
          thread_ts=thread_ts,
          blocks=error_blocks,
          text="Error",
        )
      except Exception as slack_err:
        logger.warning(f"[{thread_ts}] Failed to post error to Slack: {slack_err}")
    return error_blocks


def invoke_response(
  sse_client: SSEClient,
  slack_client,
  channel_id: str,
  thread_ts: str,
  message_text: str,
  agent_id: str,
  conversation_id: str,
  triggered_by_user_id=None,
  additional_footer=None,
  escalation_config=None,
  client_context=None,
  files=None,
):
  """
  Non-streaming invoke for bot users.

  Calls the invoke endpoint and posts the response as a regular message.

  Returns:
      List of Slack blocks for the response, or dict with retry_needed=True on errors.
  """
  logger.info(f"[{thread_ts}] invoke_response: conv={conversation_id} agent={agent_id}")
  try:
    result = sse_client.invoke(
      message=message_text,
      conversation_id=conversation_id,
      agent_id=agent_id,
      client_context=client_context,
      files=files,
    )

    if not result.get("success", True):
      error_msg = result.get("error", "Invoke failed")
      logger.error(f"[{thread_ts}] Invoke error: {error_msg}")
      return {"retry_needed": True, "error": error_msg}

    content = result.get("content", "I've completed your request.")
    if not content or not content.strip():
      content = "I've completed your request."

    return _post_final_response(
      slack_client,
      channel_id,
      thread_ts,
      content.strip(),
      None,
      triggered_by_user_id=triggered_by_user_id,
      additional_footer=additional_footer,
      escalation_config=escalation_config,
      agent_id=agent_id,
    )

  except Exception as e:
    logger.exception(f"[{thread_ts}] Error during invoke: {e}")
    error_blocks = slack_formatter.format_error_message(str(e))
    try:
      error_blocks.extend(
        _build_stream_final_blocks(
          channel_id,
          thread_ts,
          None,
          triggered_by_user_id=triggered_by_user_id,
          additional_footer=additional_footer,
          escalation_config=escalation_config,
          agent_id=agent_id,
        )
      )
    except Exception:
      logger.debug("Failed to build footer blocks for error response, continuing with base error blocks")
    slack_client.chat_postMessage(
      channel=channel_id,
      thread_ts=thread_ts,
      blocks=error_blocks,
      text="Error",
    )
    return error_blocks


def _check_overthink_skip(final_text: str, thread_ts: str, skip_markers: list[str] | None = None) -> dict | None:
  """Check if response should be skipped in overthink mode.

  Args:
      final_text: The agent's complete response text.
      thread_ts: Slack thread timestamp for logging.
      skip_markers: Configurable list of marker strings to check.
          Defaults to ``["DEFER", "LOW_CONFIDENCE"]``.

  Returns:
      None if response should be posted normally
      {"skipped": True, "reason": "..."} if response should be skipped
  """
  markers = skip_markers or ["DEFER", "LOW_CONFIDENCE"]
  for marker in markers:
    if f"[{marker}]" in final_text:
      logger.info(f"[{thread_ts}] Overthink: skipping response ({marker})")
      return {"skipped": True, "reason": marker.lower()}
  return None


# Regex matching all confidence/control markers: [CONFIDENCE: HIGH], [LOW_CONFIDENCE], [DEFER], etc.
_CONFIDENCE_MARKER_RE = re.compile(r"\[(?:CONFIDENCE:\s*\w+|LOW_CONFIDENCE|DEFER)\]")


def _strip_confidence_markers(text: str) -> str:
  """Remove all confidence/control markers from text before posting to Slack."""
  stripped = _CONFIDENCE_MARKER_RE.sub("", text).strip()
  return stripped


def _post_final_response(
  slack_client,
  channel_id,
  thread_ts,
  final_text,
  original_ts,
  triggered_by_user_id=None,
  additional_footer=None,
  escalation_config=None,
  agent_id=None,
):
  """Post final response as a regular message (fallback for bot messages)."""
  final_text = _strip_confidence_markers(final_text)
  if not final_text:
    logger.warning(f"[{thread_ts}] _post_final_response: empty text after stripping — suppressing post")
    return []
  text_chunks = slack_formatter.split_text_into_blocks(final_text)

  content_blocks = [{"type": "markdown", "text": chunk} for chunk in text_chunks]

  footer_blocks = _build_stream_final_blocks(
    channel_id,
    thread_ts,
    original_ts,
    triggered_by_user_id=triggered_by_user_id,
    additional_footer=additional_footer,
    escalation_config=escalation_config,
    agent_id=agent_id,
  )

  final_blocks = slack_formatter.enforce_block_limit(content_blocks, footer_blocks)

  slack_client.chat_postMessage(
    channel=channel_id,
    thread_ts=thread_ts,
    blocks=final_blocks,
    text=final_text[:100],
  )

  return final_blocks


def _build_stream_final_blocks(
  channel_id,
  thread_ts,
  original_ts,
  triggered_by_user_id=None,
  additional_footer=None,
  escalation_config=None,
  agent_id=None,
):
  """Build the feedback + footer blocks used by both stream types."""
  final_blocks = []
  action_value = f"{channel_id}|{thread_ts}|{original_ts or ''}|{agent_id or ''}"

  context_elements = [
    {
      "type": "feedback_buttons",
      "action_id": "caipe_feedback",
      "positive_button": {
        "text": {"type": "plain_text", "text": "\U0001f44d"},
        "value": f"positive|{original_ts or ''}|{agent_id or ''}",
      },
      "negative_button": {
        "text": {"type": "plain_text", "text": "\U0001f44e"},
        "value": f"negative|{original_ts or ''}|{agent_id or ''}",
      },
    },
  ]
  if escalation_config and escalation_config.delete_admins:
    context_elements.append(
      {
        "type": "icon_button",
        "action_id": "caipe_delete_message",
        "text": {"type": "plain_text", "text": "Delete"},
        "icon": "trash",
        "value": action_value,
        "accessibility_label": "Delete this response",
      }
    )
  final_blocks.append({"type": "context_actions", "elements": context_elements})

  footer_text = _build_footer_text(triggered_by_user_id=triggered_by_user_id, additional_footer=additional_footer, agent_id=agent_id)
  final_blocks.append(
    {
      "type": "context",
      "elements": [{"type": "mrkdwn", "text": footer_text}],
    }
  )

  return final_blocks
