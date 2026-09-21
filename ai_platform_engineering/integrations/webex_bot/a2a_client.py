# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""AG-UI SSE client for Dynamic Agents streaming (Webex bot)."""

from __future__ import annotations

import json
import logging
import re
import uuid
from contextvars import ContextVar
from typing import Any, Dict, Iterator, Optional

import httpx

logger = logging.getLogger("caipe.webex_bot.a2a_client")

_SSE_ERROR_BODY_MAX_LEN = 200
_SENSITIVE_SSE_ERROR_RE = re.compile(
    r"(?i)(authorization|bearer\s+\S+|access_token|refresh_token|client_secret)",
)

WEBEX_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "webex.caipe.io")


class AgentAccessDeniedError(Exception):
    """Raised when the API returns 403 agent#use — the user lacks can_use on the agent."""

    def __init__(self, agent_id: str) -> None:
        super().__init__(f"Access denied to agent {agent_id!r}")
        self.agent_id = agent_id

_obo_token_cv: ContextVar[Optional[str]] = ContextVar("caipe_webex_obo_token", default=None)


def set_obo_token(token: Optional[str]) -> object:
    """Bind an OBO token to the current execution context."""

    return _obo_token_cv.set(token)


def get_obo_token() -> Optional[str]:
    return _obo_token_cv.get()


def space_message_to_conversation_id(space_id: str, message_id: str) -> str:
    """Deterministic conversation UUID for a Webex space message thread."""

    return str(uuid.uuid5(WEBEX_NAMESPACE, f"{space_id}:{message_id}"))


class SSEEventType(str):
    RUN_STARTED = "RUN_STARTED"
    RUN_FINISHED = "RUN_FINISHED"
    RUN_ERROR = "RUN_ERROR"
    TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
    TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
    TOOL_CALL_START = "TOOL_CALL_START"
    TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
    TOOL_CALL_END = "TOOL_CALL_END"
    STATE_DELTA = "STATE_DELTA"
    STATE_SNAPSHOT = "STATE_SNAPSHOT"
    CUSTOM = "CUSTOM"
    RAW = "RAW"

    _KNOWN = {
        "RUN_STARTED",
        "RUN_FINISHED",
        "RUN_ERROR",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "STATE_DELTA",
        "STATE_SNAPSHOT",
        "CUSTOM",
        "RAW",
    }

    @classmethod
    def is_known(cls, value: str) -> bool:
        return value in cls._KNOWN


class SSEEvent:
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
        "metadata",
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
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
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
        self.metadata = metadata


def redact_sse_error_body(error_text: str, *, max_len: int = _SSE_ERROR_BODY_MAX_LEN) -> str:
    """Return a safe, truncated SSE error snippet for exceptions."""

    redacted = _SENSITIVE_SSE_ERROR_RE.sub("[REDACTED]", error_text)
    if len(redacted) > max_len:
        return f"{redacted[:max_len]}…"
    return redacted


def streaming_metadata_from_event(event: SSEEvent) -> Dict[str, bool]:
    """Extract ``is_narration`` / ``is_final_answer`` flags from an AG-UI event."""

    meta: Dict[str, bool] = {}
    if event.metadata:
        if event.metadata.get("is_narration"):
            meta["is_narration"] = True
        if event.metadata.get("is_final_answer"):
            meta["is_final_answer"] = True
    if event.type == SSEEventType.CUSTOM and isinstance(event.value, dict):
        if event.value.get("is_narration"):
            meta["is_narration"] = True
        if event.value.get("is_final_answer"):
            meta["is_final_answer"] = True
    return meta


class WebexSSEClient:
    """SSE client for Dynamic Agents via the CAIPE API gateway."""

    def __init__(
        self,
        base_url: str,
        timeout: int = 300,
        auth_client: Optional[Any] = None,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.auth_client = auth_client
        self._http_client = http_client

    def _get_headers(self, bearer_token: Optional[str] = None) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "X-Client-Source": "webex-bot",
            "User-Agent": "caipe-webex-bot/0.5.0",
        }
        chosen = bearer_token or get_obo_token()
        if chosen:
            headers["Authorization"] = f"Bearer {chosen}"
        elif self.auth_client:
            token = self.auth_client.get_access_token()
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def stream_chat(
        self,
        message: str,
        conversation_id: str,
        agent_id: str,
        trace_id: Optional[str] = None,
        client_context: Optional[Dict[str, Any]] = None,
        bearer_token: Optional[str] = None,
    ) -> Iterator[SSEEvent]:
        payload: Dict[str, Any] = {
            "message": message,
            "conversation_id": conversation_id,
            "agent_id": agent_id,
            "protocol": "agui",
            "trace_id": trace_id,
        }
        if client_context:
            payload["client_context"] = client_context

        url = f"{self.base_url}/api/v1/chat/stream/start"
        yield from self._stream_sse(url, payload, bearer_token=bearer_token)

    def create_conversation(
        self,
        *,
        title: str,
        agent_id: str,
        idempotency_key: str,
        metadata: Optional[Dict[str, Any]] = None,
        bearer_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create or retrieve the CAIPE conversation backing a Webex thread."""

        payload: Dict[str, Any] = {
            "title": title,
            "client_type": "webex",
            "agent_id": agent_id,
            "idempotency_key": idempotency_key,
        }
        if metadata:
            payload["metadata"] = metadata

        client = self._http_client
        owns_client = client is None
        if owns_client:
            client = httpx.Client(timeout=30)
        assert client is not None
        try:
            response = client.post(
                f"{self.base_url}/api/chat/conversations",
                json=payload,
                headers={
                    **self._get_headers(bearer_token=bearer_token),
                    "Accept": "application/json",
                },
            )
            if response.status_code == 403:
                try:
                    body = response.json()
                    code = body.get("code") if isinstance(body, dict) else None
                except json.JSONDecodeError:
                    code = None
                if code == "agent#use":
                    raise AgentAccessDeniedError(agent_id)
            if response.status_code not in (200, 201):
                safe_detail = redact_sse_error_body(response.text)
                raise RuntimeError(
                    f"Conversation create failed: {response.status_code} {safe_detail}"
                )
            data = response.json()
            result = data.get("data", data)
            conversation = result.get("conversation", {})
            conversation_id = str(conversation.get("_id") or "")
            if not conversation_id:
                raise RuntimeError("Conversation create response missing conversation id")
            return {
                "conversation_id": conversation_id,
                "created": bool(result.get("created", True)),
                "metadata": conversation.get("metadata", {}),
            }
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Failed to create Webex conversation: {exc}") from exc
        finally:
            if owns_client:
                client.close()

    def update_conversation_metadata(
        self,
        conversation_id: str,
        metadata: Dict[str, Any],
        bearer_token: Optional[str] = None,
    ) -> None:
        """Merge keys into an existing conversation's metadata.

        Calls ``PATCH /api/chat/conversations/{id}/metadata``. Only the
        ``metadata`` field is updated — no other conversation fields are
        touched. Failures are logged, not raised, so a metadata-persist
        error never breaks the Webex reply that triggered it.
        """
        url = f"{self.base_url}/api/chat/conversations/{conversation_id}/metadata"
        headers = {
            **self._get_headers(bearer_token=bearer_token),
            "Accept": "application/json",
        }
        client = self._http_client
        owns_client = client is None
        if owns_client:
            client = httpx.Client(timeout=30)
        assert client is not None
        try:
            response = client.patch(url, json={"metadata": metadata}, headers=headers)
            if response.status_code not in (200, 204):
                logger.warning(
                    "Failed to update Webex conversation metadata: status=%s body=%s",
                    response.status_code,
                    response.text[:500],
                )
        finally:
            if owns_client:
                client.close()

    def add_message(
        self,
        *,
        conversation_id: str,
        message_id: str,
        role: str,
        metadata: Optional[Dict[str, Any]] = None,
        content: str = "",
        bearer_token: Optional[str] = None,
    ) -> None:
        """Persist a single message row via the shared API (metadata-only).

        Calls ``POST /api/chat/conversations/{id}/messages``. Mirrors the
        Slack bot's ``SSEClient.add_message``: records per-turn message
        metadata (source, agent, latency, linking) so admin stats count
        Webex messages the same way as web and Slack — WITHOUT duplicating
        the message content that already lives in Webex. ``content``
        defaults to empty.

        The upsert is keyed on ``message_id``, so this is idempotent — a
        retried dispatch updates the row instead of duplicating it.
        """
        url = f"{self.base_url}/api/chat/conversations/{conversation_id}/messages"
        headers = {
            **self._get_headers(bearer_token=bearer_token),
            "Accept": "application/json",
        }
        payload: Dict[str, Any] = {
            "message_id": message_id,
            "role": role,
            "content": content,
        }
        if metadata:
            payload["metadata"] = metadata

        client = self._http_client
        owns_client = client is None
        if owns_client:
            client = httpx.Client(timeout=30)
        assert client is not None
        try:
            response = client.post(url, json=payload, headers=headers)
            if response.status_code not in (200, 201):
                safe_detail = redact_sse_error_body(response.text)
                raise RuntimeError(
                    f"Failed to add Webex message: {response.status_code} {safe_detail}"
                )
        finally:
            if owns_client:
                client.close()

    def _stream_sse(
        self,
        url: str,
        payload: Dict[str, Any],
        bearer_token: Optional[str] = None,
    ) -> Iterator[SSEEvent]:
        client = self._http_client
        owns_client = client is None
        if owns_client:
            client = httpx.Client(timeout=self.timeout)
        assert client is not None
        try:
            with client.stream(
                "POST",
                url,
                json=payload,
                headers=self._get_headers(bearer_token=bearer_token),
            ) as response:
                if not response.is_success:
                    error_text = response.read().decode(errors="replace")
                    safe_detail = redact_sse_error_body(error_text)
                    raise RuntimeError(f"SSE request failed: {response.status_code} {safe_detail}")

                buffer = ""
                for chunk in response.iter_text():
                    if not chunk:
                        continue
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
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Failed to connect to SSE endpoint at {url}: {exc}") from exc
        finally:
            if owns_client:
                client.close()

    def _parse_event(self, json_str: str) -> Optional[SSEEvent]:
        try:
            data = json.loads(json_str)
        except json.JSONDecodeError:
            return None

        raw_type = data.get("type", "")
        if not SSEEventType.is_known(raw_type):
            return None

        steps = None
        if raw_type == SSEEventType.STATE_DELTA:
            raw_delta = data.get("delta")
            if isinstance(raw_delta, list):
                steps = raw_delta
            elif isinstance(raw_delta, dict):
                steps = raw_delta.get("steps")

        snapshot = data.get("snapshot") if raw_type == SSEEventType.STATE_SNAPSHOT else None

        metadata_raw = data.get("metadata")
        metadata = metadata_raw if isinstance(metadata_raw, dict) else None

        return SSEEvent(
            type=raw_type,
            delta=(
                data.get("delta")
                if raw_type in (SSEEventType.TEXT_MESSAGE_CONTENT, SSEEventType.TOOL_CALL_ARGS)
                else None
            ),
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
            metadata=metadata,
        )
