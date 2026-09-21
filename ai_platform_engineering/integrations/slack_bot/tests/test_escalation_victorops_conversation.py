# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Regression test: VictorOps on-call lookup must register its conversation.

`_ping_victorops_oncall` streams a one-off "who is on-call" prompt through
`sse_client.stream_chat()` using a conversation_id that is never registered
with the server via `create_conversation()`. The server's
`/api/v1/chat/stream/start` endpoint 404s ("Conversation not found") for any
conversation_id it doesn't recognize, so every VictorOps escalation failed
with the generic "Could not determine on-call" fallback message regardless
of whether the on-call lookup itself would have succeeded.
"""

from __future__ import annotations

import pathlib
import sys
from unittest.mock import MagicMock

_SLACK_BOT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(_SLACK_BOT_DIR) not in sys.path:
    sys.path.insert(0, str(_SLACK_BOT_DIR))

from sse_client import SSEEvent, SSEEventType  # noqa: E402
from utils.escalation import _ping_victorops_oncall  # noqa: E402


def _sse_client_stub(oncall_email: str) -> MagicMock:
    sse_client = MagicMock()
    sse_client.create_conversation.return_value = {
        "conversation_id": "registered-conv-id",
        "created": True,
    }
    sse_client.stream_chat.return_value = iter(
        [
            SSEEvent(type=SSEEventType.TEXT_MESSAGE_CONTENT, delta=oncall_email),
            SSEEvent(type=SSEEventType.RUN_FINISHED),
        ]
    )
    return sse_client


def test_ping_victorops_oncall_registers_conversation_before_streaming():
    sse_client = _sse_client_stub("oncall@example.com")
    slack_client = MagicMock()
    slack_client.users_lookupByEmail.return_value = {"user": {"id": "UONCALL"}}

    result = _ping_victorops_oncall(
        sse_client,
        slack_client,
        channel_id="C123",
        thread_ts="1.1",
        team="SCS Search Services",
        agent_id="victorops-oncall",
    )

    sse_client.create_conversation.assert_called_once()
    assert sse_client.create_conversation.call_args.kwargs["agent_id"] == "victorops-oncall"
    assert sse_client.create_conversation.call_args.kwargs["metadata"] == {
        "channel_id": "C123",
        "thread_ts": "1.1",
    }

    # stream_chat must use the conversation_id create_conversation returned,
    # not an ad hoc, unregistered id.
    sse_client.stream_chat.assert_called_once()
    assert sse_client.stream_chat.call_args.kwargs["conversation_id"] == "registered-conv-id"

    assert result == "victorops: pinged oncall@example.com (<@UONCALL>)"


def test_ping_victorops_oncall_reports_error_when_stream_chat_fails():
    sse_client = _sse_client_stub("oncall@example.com")
    sse_client.stream_chat.side_effect = Exception(
        'SSE request failed: 404 {"success":false,"error":"Conversation not found","code":"conversation#write"}'
    )
    slack_client = MagicMock()

    result = _ping_victorops_oncall(
        sse_client,
        slack_client,
        channel_id="C123",
        thread_ts="1.1",
        team="SCS Search Services",
        agent_id="victorops-oncall",
    )

    assert result.startswith("victorops: error")
    slack_client.chat_postMessage.assert_called_once()
    assert "Could not determine on-call" in slack_client.chat_postMessage.call_args.kwargs["text"]
