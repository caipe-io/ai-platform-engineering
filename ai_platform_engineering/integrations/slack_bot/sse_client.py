# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""
SSE client for Dynamic Agents streaming via AG-UI protocol.

Routes requests through the Next.js API gateway which proxies to the
dynamic agents backend.  Uses flat ``/api/v1/chat/`` routes with all
parameters (including ``conversation_id`` and ``protocol``) in the
request body.  Uses httpx for streaming HTTP requests.
"""

import json
import uuid
from contextvars import ContextVar
from typing import Any, Dict, Iterator, Optional

import httpx
from loguru import logger


# Spec 104 Story 3 — per-request OBO token. The Slack handler thread sets
# this BEFORE calling into the SSE client (directly or via utils/ai.py), so
# `_get_headers` can prefer the user-scoped token over the bot's SA token
# without every intermediate function having to forward an extra kwarg.
#
# We use ContextVar (not threading.local) because the bot uses asyncio
# under Slack Bolt and asyncio.run_in_executor. ContextVar values are
# inherited across both await points and run_in_executor → so the right
# token is always seen by whichever thread ends up making the HTTP call.
#
# Default is None which means "no OBO token bound → fall back to SA token".
_obo_token_cv: ContextVar[Optional[str]] = ContextVar(
  "caipe_slack_obo_token", default=None
)


def set_obo_token(token: Optional[str]) -> object:
  """Bind an OBO token to the current execution context.

  Call this once at the top of a Slack handler (after impersonation has
  succeeded) and the SSE client will pick it up for every downstream call
  in this handler's scope. Returns the contextvars `Token` so callers can
  reset it in a `finally` block; in practice we don't bother because the
  ContextVar is naturally scoped to the handler's task.
  """
  return _obo_token_cv.set(token)


def get_obo_token() -> Optional[str]:
  """Read the currently-bound OBO token (None when unbound)."""
  return _obo_token_cv.get()

# Deterministic namespace for Slack conversation IDs.
# uuid5(NAMESPACE_URL, "slack.caipe.io") — fixed constant.
SLACK_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "slack.caipe.io")


def thread_ts_to_conversation_id(thread_ts: str) -> str:
  """Convert a Slack thread_ts to a deterministic conversation UUID.

  .. deprecated::
      Use ``SSEClient.create_conversation()`` instead.  This function is
      kept only as a fallback for secondary handlers (button actions) that
      operate on threads whose conversation was already created by a primary
      handler.  It will be removed once all handlers are migrated.

  Args:
      thread_ts: Slack thread timestamp string.

  Returns:
      UUID v5 string derived from thread_ts.
  """
  return str(uuid.uuid5(SLACK_NAMESPACE, thread_ts))


class SSEEventType(str):
  """AG-UI event types (mirrors ag_ui.core.EventType)."""

  RUN_STARTED = "RUN_STARTED"
  RUN_FINISHED = "RUN_FINISHED"
  RUN_ERROR = "RUN_ERROR"
  STEP_STARTED = "STEP_STARTED"
  STEP_FINISHED = "STEP_FINISHED"
  TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
  TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
  TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
  TOOL_CALL_START = "TOOL_CALL_START"
  TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
  TOOL_CALL_END = "TOOL_CALL_END"
  STATE_SNAPSHOT = "STATE_SNAPSHOT"
  STATE_DELTA = "STATE_DELTA"
  CUSTOM = "CUSTOM"
  RAW = "RAW"

  # Set of known types for validation
  _KNOWN = {
    "RUN_STARTED",
    "RUN_FINISHED",
    "RUN_ERROR",
    "STEP_STARTED",
    "STEP_FINISHED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "STATE_SNAPSHOT",
    "STATE_DELTA",
    "CUSTOM",
    "RAW",
  }

  @classmethod
  def is_known(cls, value: str) -> bool:
    """Check if a string is a known AG-UI event type."""
    return value in cls._KNOWN


class SSEEvent:
  """Parsed AG-UI Server-Sent Event."""

  __slots__ = (
    "type",
    "delta",
    "message_id",
    "tool_call_id",
    "tool_call_name",
    "steps",
    "snapshot",
    "name",
    "value",
    "run_id",
    "thread_id",
    "message",
    "outcome",
    "interrupt",
  )

  def __init__(
    self,
    type: str,
    delta: Optional[str] = None,
    message_id: Optional[str] = None,
    tool_call_id: Optional[str] = None,
    tool_call_name: Optional[str] = None,
    steps: Optional[list] = None,
    snapshot: Optional[dict] = None,
    name: Optional[str] = None,
    value: Optional[Any] = None,
    run_id: Optional[str] = None,
    thread_id: Optional[str] = None,
    message: Optional[str] = None,
    outcome: Optional[str] = None,
    interrupt: Optional[dict] = None,
  ):
    self.type = type
    self.delta = delta
    self.message_id = message_id
    self.tool_call_id = tool_call_id
    self.tool_call_name = tool_call_name
    self.steps = steps
    self.snapshot = snapshot
    self.name = name
    self.value = value
    self.run_id = run_id
    self.thread_id = thread_id
    self.message = message
    self.outcome = outcome
    self.interrupt = interrupt


class AgentAccessDeniedError(Exception):
  """Raised when the API returns 403 agent#use — the user lacks can_use on the agent."""

  def __init__(self, agent_id: str) -> None:
    super().__init__(f"Access denied to agent {agent_id!r}")
    self.agent_id = agent_id


class SSEClient:
  """SSE client for Dynamic Agents streaming via AG-UI protocol.

  Routes through the Next.js API gateway (flat paths, all params in body):
  - stream_chat(): POST /api/v1/chat/stream/start (SSE stream)
  - invoke(): POST /api/v1/chat/invoke (JSON response)
  - resume_stream(): POST /api/v1/chat/stream/resume (SSE stream)
  """

  def __init__(self, base_url: str, timeout: int = 300, auth_client: Optional[Any] = None):
    """Initialize SSE client.

    Args:
        base_url: CAIPE API URL (e.g. http://caipe-ui:3000).
        timeout: Streaming timeout in seconds.
        auth_client: Optional OAuth2ClientCredentials instance for Bearer tokens.
    """
    self.base_url = base_url.rstrip("/")
    self.timeout = timeout
    self.auth_client = auth_client

  def _get_headers(self, bearer_token: Optional[str] = None) -> Dict[str, str]:
    """Build request headers with auth and client source.

    Args:
        bearer_token: Optional pre-minted token to use INSTEAD of the
            service-account `auth_client`. The caller passes the per-user
            OBO token here (Spec 104 Story 3) so downstream services see
            the real user's identity (`sub`) with the bot delegated in the
            `act` claim. Falls back to the SA token only when ``None``,
            which preserves backwards compatibility for callers that
            haven't been updated yet (e.g. background escalation jobs that
            legitimately have no user context).
    """
    headers = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "X-Client-Source": "slack-bot",
    }
    # Precedence: explicit kwarg > per-request OBO ContextVar > SA fallback.
    # The ContextVar middle tier is what makes Spec 104 Story 3 work without
    # threading an extra kwarg through utils/ai.py — Slack handlers set it
    # once at entry via `set_obo_token(...)` and we read it here.
    chosen = bearer_token or get_obo_token()
    if chosen:
      headers["Authorization"] = f"Bearer {chosen}"
    elif self.auth_client:
      token = self.auth_client.get_access_token()
      headers["Authorization"] = f"Bearer {token}"
    return headers

  def create_conversation(
    self,
    title: str,
    agent_id: str,
    owner_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    bearer_token: Optional[str] = None,
  ) -> Dict[str, Any]:
    """Create or retrieve an existing conversation via the shared API.

    Uses the Next.js ``POST /api/chat/conversations`` endpoint. When an
    ``idempotency_key`` is provided, the server returns the existing
    conversation instead of creating a duplicate. This maintains a 1-1
    mapping between integration-specific identities (e.g. Slack thread_ts)
    and the conversation_id used by UI and LangGraph checkpoints.

    Args:
        title: Conversation title (first message truncated).
        agent_id: Dynamic agent config ID.
        owner_id: User email. If omitted, server uses the service account identity.
        idempotency_key: Dedup key mapping integration identity to conversation_id
            (e.g. Slack thread_ts).
        metadata: Arbitrary metadata (channel_id, channel_name, etc.).

    Returns:
        Dict with ``conversation_id`` (str) and ``created`` (bool).

    Raises:
        Exception: On HTTP errors or invalid response.
    """
    url = f"{self.base_url}/api/chat/conversations"
    headers = self._get_headers(bearer_token=bearer_token)
    # Conversation API expects JSON, not SSE
    headers["Accept"] = "application/json"

    payload: Dict[str, Any] = {
      "title": title,
      "client_type": "slack",
      "agent_id": agent_id,
    }
    if owner_id:
      payload["owner_id"] = owner_id
    if idempotency_key:
      payload["idempotency_key"] = idempotency_key
    if metadata:
      payload["metadata"] = metadata

    logger.debug(
      "Creating conversation: url={} owner_id={} idempotency_key={}",
      url,
      owner_id,
      idempotency_key,
    )

    with httpx.Client(timeout=30) as client:
      response = client.post(url, json=payload, headers=headers)

    if response.status_code not in (200, 201):
      logger.error(
        "Failed to create conversation: status={} body={}",
        response.status_code,
        response.text[:500],
      )
      if response.status_code == 403:
        try:
          body = response.json()
          # requireAgentUsePermission returns a flat JSON body (no `data` wrapper):
          # { "success": false, "code": "agent#use", ... }
          code = body.get("code", "")
        except Exception:
          code = ""
        if code == "agent#use":
          raise AgentAccessDeniedError(agent_id)
      raise Exception(f"Failed to create conversation: HTTP {response.status_code}")

    data = response.json()
    result = data.get("data", data)
    conversation = result.get("conversation", {})
    created = result.get("created", True)

    conversation_id = conversation.get("_id", "")
    logger.info(
      "Conversation {}: id={} created={}",
      "created" if created else "found existing",
      conversation_id,
      created,
    )

    return {
      "conversation_id": conversation_id,
      "created": created,
      "metadata": conversation.get("metadata", {}),
    }

  def update_conversation_metadata(
    self,
    conversation_id: str,
    metadata: Dict[str, Any],
  ) -> None:
    """Merge keys into an existing conversation's metadata.

    Calls ``PATCH /api/chat/conversations/{id}/metadata``.  Only the
    ``metadata`` field is updated — no other conversation fields are
    touched.

    Args:
        conversation_id: UUID of the conversation to update.
        metadata: Dict of keys to shallow-merge into existing metadata.

    Raises:
        Exception: On HTTP errors.
    """
    url = f"{self.base_url}/api/chat/conversations/{conversation_id}/metadata"
    headers = self._get_headers()
    headers["Accept"] = "application/json"

    with httpx.Client(timeout=30) as client:
      response = client.patch(url, json={"metadata": metadata}, headers=headers)

    if response.status_code not in (200, 204):
      logger.error(
        "Failed to update conversation metadata: status={} body={}",
        response.status_code,
        response.text[:500],
      )
      raise Exception(f"Failed to update conversation metadata: HTTP {response.status_code}")

    logger.debug("Updated metadata for conversation {}: {}", conversation_id, metadata)

  def add_message(
    self,
    conversation_id: str,
    message_id: str,
    role: str,
    metadata: Optional[Dict[str, Any]] = None,
    content: str = "",
  ) -> None:
    """Persist a single message row via the shared API (metadata-only).

    Calls ``POST /api/chat/conversations/{id}/messages``. The Slack bot records
    per-turn message metadata (source, agent, latency, linking) so admin stats
    count Slack messages like web messages — WITHOUT duplicating the message
    content that already lives in Slack. ``content`` defaults to empty.

    The upsert is keyed on ``message_id``, so this is idempotent — re-posting
    the same turn updates the row instead of duplicating it.

    Args:
        conversation_id: UUID of the conversation this turn belongs to.
        message_id: Stable per-turn id (dedupe key for the upsert).
        role: "user" | "assistant".
        metadata: Message metadata (source, agent_id, latency_ms, channel_id,
            channel_name, thread_ts, slack_permalink, turn_id, is_final, ...).
        content: Optional content; omitted (empty) for Slack turns.

    Raises:
        Exception: On HTTP errors.
    """
    url = f"{self.base_url}/api/chat/conversations/{conversation_id}/messages"
    headers = self._get_headers()
    headers["Accept"] = "application/json"

    payload: Dict[str, Any] = {
      "message_id": message_id,
      "role": role,
      "content": content,
    }
    if metadata:
      payload["metadata"] = metadata

    with httpx.Client(timeout=30) as client:
      response = client.post(url, json=payload, headers=headers)

    if response.status_code not in (200, 201):
      logger.error(
        "Failed to add message: status={} body={}",
        response.status_code,
        response.text[:500],
      )
      raise Exception(f"Failed to add message: HTTP {response.status_code}")

    logger.debug("Added {} message for conversation {}", role, conversation_id)

  def stream_chat(
    self,
    message: str,
    conversation_id: str,
    agent_id: str,
    trace_id: Optional[str] = None,
    client_context: Optional[Dict[str, Any]] = None,
    bearer_token: Optional[str] = None,
    files: Optional[list[Dict[str, Any]]] = None,
  ) -> Iterator[SSEEvent]:
    """Stream a chat response from a dynamic agent.

    Args:
        message: User's message text.
        conversation_id: UUID v5 from thread_ts.
        agent_id: Dynamic agent config ID.
        trace_id: Optional Langfuse trace ID.
        client_context: Optional client context dict for system prompt rendering.
        files: Optional multimodal attachments ({"mime_type", "data", "name"});
            forwarded verbatim as the request's top-level ``files`` field.

    Yields:
        SSEEvent objects for each AG-UI event.

    Raises:
        Exception: On connection or HTTP errors.
    """
    payload = {
      "message": message,
      "conversation_id": conversation_id,
      "agent_id": agent_id,
      "protocol": "agui",
      "trace_id": trace_id,
    }
    if client_context:
      payload["client_context"] = client_context
    if files:
      payload["files"] = files

    url = f"{self.base_url}/api/v1/chat/stream/start"
    yield from self._stream_sse(url, payload, bearer_token=bearer_token)

  def resume_stream(
    self,
    agent_id: str,
    conversation_id: str,
    form_data: str,
    trace_id: Optional[str] = None,
    client_context: Optional[Dict[str, Any]] = None,
    bearer_token: Optional[str] = None,
  ) -> Iterator[SSEEvent]:
    """Resume a stream after HITL interrupt.

    Args:
        agent_id: Same agent_id as the interrupted stream.
        conversation_id: Same conversation_id as the interrupted stream.
        form_data: JSON string of form field values, or rejection message.
        trace_id: Optional Langfuse trace ID.
        client_context: Optional client context dict for system prompt rendering.

    Yields:
        SSEEvent objects for the resumed stream.

    Raises:
        Exception: On connection or HTTP errors.
    """
    payload = {
      "conversation_id": conversation_id,
      "agent_id": agent_id,
      "form_data": form_data,
      "protocol": "agui",
      "trace_id": trace_id,
    }
    if client_context:
      payload["client_context"] = client_context

    url = f"{self.base_url}/api/v1/chat/stream/resume"
    yield from self._stream_sse(url, payload, bearer_token=bearer_token)

  def invoke(
    self,
    message: str,
    conversation_id: str,
    agent_id: str,
    trace_id: Optional[str] = None,
    client_context: Optional[Dict[str, Any]] = None,
    bearer_token: Optional[str] = None,
    files: Optional[list[Dict[str, Any]]] = None,
  ) -> Dict[str, Any]:
    """Non-streaming chat invocation for bot users.

    Args:
        message: User's message text.
        conversation_id: UUID v5 from thread_ts.
        agent_id: Dynamic agent config ID.
        trace_id: Optional Langfuse trace ID.
        client_context: Optional client context dict for system prompt rendering.
        files: Optional multimodal attachments ({"mime_type", "data", "name"});
            forwarded verbatim as the request's top-level ``files`` field.

    Returns:
        Response dict with 'success', 'content', etc.

    Raises:
        Exception: On connection or HTTP errors.
    """
    payload = {
      "message": message,
      "conversation_id": conversation_id,
      "agent_id": agent_id,
      "trace_id": trace_id,
    }
    if client_context:
      payload["client_context"] = client_context
    if files:
      payload["files"] = files

    headers = self._get_headers(bearer_token=bearer_token)
    headers["Accept"] = "application/json"

    url = f"{self.base_url}/api/v1/chat/invoke"

    try:
      with httpx.Client(timeout=self.timeout) as client:
        response = client.post(url, json=payload, headers=headers)
    except httpx.HTTPError as e:
      raise Exception(f"Failed to connect to invoke endpoint at {url}: {e}")

    if not response.is_success:
      raise Exception(f"Invoke request failed: {response.status_code} {response.text}")

    return response.json()

  def _stream_sse(
    self,
    url: str,
    payload: Dict[str, Any],
    bearer_token: Optional[str] = None,
  ) -> Iterator[SSEEvent]:
    """Internal: POST to an SSE endpoint and yield parsed events.

    Args:
        url: Full endpoint URL.
        payload: JSON request body (includes protocol, conversation_id, etc.).
        bearer_token: Optional per-user OBO token; falls back to SA token.

    Yields:
        SSEEvent objects.
    """
    try:
      with httpx.Client(timeout=self.timeout) as client:
        with client.stream(
          "POST",
          url,
          json=payload,
          headers=self._get_headers(bearer_token=bearer_token),
        ) as response:
          if not response.is_success:
            error_text = response.read().decode()
            raise Exception(f"SSE request failed: {response.status_code} {error_text}")

          buffer = ""
          for chunk in response.iter_text():
            if chunk:
              buffer += chunk
              while "\n" in buffer:
                line_end = buffer.index("\n")
                line = buffer[:line_end].strip()
                buffer = buffer[line_end + 1 :]

                if line.startswith("data: "):
                  json_str = line[6:].strip()
                  if json_str:
                    event = self._parse_event(json_str)
                    if event is not None:
                      yield event

    except httpx.HTTPError as e:
      raise Exception(f"Failed to connect to SSE endpoint at {url}: {e}")

  def _parse_event(self, json_str: str) -> Optional[SSEEvent]:
    """Parse a single SSE data line into an SSEEvent.

    Args:
        json_str: Raw JSON string from the SSE data field.

    Returns:
        SSEEvent if parseable and a known type, None otherwise.
    """
    try:
      data = json.loads(json_str)
    except json.JSONDecodeError as e:
      logger.warning(f"Error parsing SSE JSON: {e}, data: {json_str[:200]}")
      return None

    raw_type = data.get("type", "")
    if not SSEEventType.is_known(raw_type):
      return None

    # STATE_DELTA: extract plan steps from JSON Patch ops
    steps = None
    if raw_type == SSEEventType.STATE_DELTA:
      raw_delta = data.get("delta")
      if isinstance(raw_delta, list):
        steps = raw_delta
      elif isinstance(raw_delta, dict):
        steps = raw_delta.get("steps")

    # STATE_SNAPSHOT: full state
    snapshot = None
    if raw_type == SSEEventType.STATE_SNAPSHOT:
      snapshot = data.get("snapshot")

    return SSEEvent(
      type=raw_type,
      delta=data.get("delta") if raw_type in (SSEEventType.TEXT_MESSAGE_CONTENT, SSEEventType.TOOL_CALL_ARGS) else None,
      message_id=data.get("messageId"),
      tool_call_id=data.get("toolCallId"),
      tool_call_name=data.get("toolCallName"),
      steps=steps,
      snapshot=snapshot,
      name=data.get("name"),
      value=data.get("value"),
      run_id=data.get("runId"),
      thread_id=data.get("threadId"),
      message=data.get("message"),
      outcome=data.get("outcome"),
      interrupt=data.get("interrupt"),
    )
