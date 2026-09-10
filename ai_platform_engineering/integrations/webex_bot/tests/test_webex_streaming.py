# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for Webex AG-UI SSE streaming client."""

from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest

from ai_platform_engineering.integrations.webex_bot.a2a_client import (
    WEBEX_NAMESPACE,
    SSEEvent,
    SSEEventType,
    WebexSSEClient,
    redact_sse_error_body,
    set_obo_token,
    space_message_to_conversation_id,
    streaming_metadata_from_event,
)


@pytest.fixture(autouse=True)
def _reset_obo_token() -> None:
    set_obo_token(None)
    yield
    set_obo_token(None)


def test_space_message_to_conversation_id_is_deterministic() -> None:
    first = space_message_to_conversation_id("space-1", "msg-1")
    second = space_message_to_conversation_id("space-1", "msg-1")
    expected = str(uuid.uuid5(WEBEX_NAMESPACE, "space-1:msg-1"))

    assert first == second == expected


def test_headers_prefer_explicit_bearer_over_contextvar_and_sa() -> None:
    auth_client = MagicMock()
    auth_client.get_access_token.return_value = "sa-token"
    client = WebexSSEClient("http://caipe-ui:3000", auth_client=auth_client)
    set_obo_token("obo-token")

    headers = client._get_headers(bearer_token="explicit-token")

    assert headers["Authorization"] == "Bearer explicit-token"
    assert headers["X-Client-Source"] == "webex-bot"
    auth_client.get_access_token.assert_not_called()


def test_headers_use_obo_contextvar_over_sa() -> None:
    auth_client = MagicMock()
    auth_client.get_access_token.return_value = "sa-token"
    client = WebexSSEClient("http://caipe-ui:3000", auth_client=auth_client)
    set_obo_token("obo-from-context")

    headers = client._get_headers()

    assert headers["Authorization"] == "Bearer obo-from-context"
    auth_client.get_access_token.assert_not_called()


def test_parse_event_preserves_streaming_metadata_flags() -> None:
    client = WebexSSEClient("http://caipe-ui:3000")
    data = json.dumps(
        {
            "type": "TEXT_MESSAGE_CONTENT",
            "delta": "answer text",
            "messageId": "msg-1",
            "metadata": {"is_final_answer": True},
        }
    )

    event = client._parse_event(data)

    assert event is not None
    assert event.type == SSEEventType.TEXT_MESSAGE_CONTENT
    assert streaming_metadata_from_event(event) == {"is_final_answer": True}


def test_custom_event_narration_metadata() -> None:
    event = SSEEvent(
        type=SSEEventType.CUSTOM,
        name="STREAM_METADATA",
        value={"is_narration": True},
    )

    assert streaming_metadata_from_event(event) == {"is_narration": True}


def test_stream_chat_parses_sse_lines_and_metadata() -> None:
    sse_payload = json.dumps(
        {
            "type": "TEXT_MESSAGE_CONTENT",
            "delta": "final answer chunk",
            "messageId": "msg-99",
            "metadata": {"is_final_answer": True},
        }
    )
    sse_body = f"data: {sse_payload}\n\n"

    mock_response = MagicMock()
    mock_response.is_success = True
    mock_response.iter_text.return_value = iter([sse_body])

    @contextmanager
    def fake_stream(*_args: object, **_kwargs: object):
        yield mock_response

    mock_client = MagicMock()
    mock_client.stream.side_effect = fake_stream

    client = WebexSSEClient("http://caipe-ui:3000", http_client=mock_client)
    events = list(
        client.stream_chat(
            message="hello",
            conversation_id="conv-1",
            agent_id="agent-1",
        )
    )

    assert len(events) == 1
    assert events[0].type == SSEEventType.TEXT_MESSAGE_CONTENT
    assert events[0].delta == "final answer chunk"
    assert streaming_metadata_from_event(events[0]) == {"is_final_answer": True}
    mock_client.stream.assert_called_once()


def test_redact_sse_error_body_strips_secrets_and_truncates() -> None:
    body = (
        "Authorization: Bearer super-secret-token " + ("x" * 300)
    )
    redacted = redact_sse_error_body(body)

    assert "super-secret-token" not in redacted
    assert "[REDACTED]" in redacted
    assert len(redacted) <= 201


def test_stream_sse_handles_crlf_chunks_and_skips_unknown_events() -> None:
    line_one = json.dumps({"type": "TEXT_MESSAGE_CONTENT", "delta": "part1", "messageId": "m1"})
    line_unknown = json.dumps({"type": "NOT_A_REAL_EVENT", "delta": "skip"})
    line_two = json.dumps({"type": "TEXT_MESSAGE_CONTENT", "delta": "part2"})
    sse_body = f"data: {line_one}\r\ndata: {line_unknown}\r\n\r\ndata: {line_two}\n"

    mock_response = MagicMock()
    mock_response.is_success = True
    mock_response.iter_text.return_value = iter([sse_body[:20], sse_body[20:]])

    @contextmanager
    def fake_stream(*_args: object, **_kwargs: object):
        yield mock_response

    mock_client = MagicMock()
    mock_client.stream.side_effect = fake_stream

    client = WebexSSEClient("http://caipe-ui:3000", http_client=mock_client)
    events = list(
        client._stream_sse(
            "http://caipe-ui:3000/api/v1/chat/stream/start",
            {"message": "hi", "conversation_id": "c1", "agent_id": "a1", "protocol": "agui"},
        )
    )

    assert len(events) == 2
    assert events[0].delta == "part1"
    assert events[1].delta == "part2"


def test_stream_chat_raises_redacted_error_on_non_success() -> None:
    mock_response = MagicMock()
    mock_response.is_success = False
    mock_response.status_code = 502
    mock_response.read.return_value = b'{"error":"Bearer leaked-token"}'

    @contextmanager
    def fake_stream(*_args: object, **_kwargs: object):
        yield mock_response

    mock_client = MagicMock()
    mock_client.stream.side_effect = fake_stream

    client = WebexSSEClient("http://caipe-ui:3000", http_client=mock_client)

    with pytest.raises(RuntimeError, match="502") as exc_info:
        list(
            client.stream_chat(
                message="hello",
                conversation_id="conv-1",
                agent_id="agent-1",
            )
        )

    assert "leaked-token" not in str(exc_info.value)
    assert "[REDACTED]" in str(exc_info.value)
