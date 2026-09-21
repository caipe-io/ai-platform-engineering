"""Regression tests for ``normalize_tool_message_content`` + tool_end emission.

These pin down the LangChain >= 0.3 list-shape ``ToolMessage.content``
handling. The Webex inbound thread map relies on the artifact text
containing literal ``messageId=...`` substrings; when MCP tools (e.g.
the Webex MCP ``post_message`` tool) return ``TextContent`` items via
Bedrock or modern LangChain transports, ``msg.content`` arrives as a
list of content blocks rather than a flat string. Previously the
encoders silently dropped this on the floor, breaking thread-mapped
follow-up replies for custom (dynamic) agents. Keep these tests as
the canary if anyone reverts the normalisation helper.
"""

from __future__ import annotations

import json
from typing import Any

from dynamic_agents.services.stream_encoders.langgraph_helpers import (
    normalize_tool_message_content,
)


class _FakeToolMessage:
    """Stand-in for ``langchain_core.messages.ToolMessage`` shape."""

    def __init__(self, *, tool_call_id: str, content: Any, message_id: str | None = None) -> None:
        self.tool_call_id = tool_call_id
        self.content = content
        if message_id is not None:
            self.id = message_id


# ---------------------------------------------------------------------------
# normalize_tool_message_content
# ---------------------------------------------------------------------------


class TestNormalizeToolMessageContent:
    def test_str_passthrough(self) -> None:
        assert normalize_tool_message_content("hello") == "hello"

    def test_empty_str(self) -> None:
        assert normalize_tool_message_content("") == ""

    def test_none(self) -> None:
        assert normalize_tool_message_content(None) == ""

    def test_list_of_text_blocks(self) -> None:
        content = [
            {"type": "text", "text": "Message sent successfully "},
            {"type": "text", "text": "(messageId=Y2lzY29zcGFy, roomId=Y2lzY29yb29t)."},
        ]
        out = normalize_tool_message_content(content)
        assert "messageId=Y2lzY29zcGFy" in out
        assert "roomId=Y2lzY29yb29t" in out

    def test_list_with_plain_strings(self) -> None:
        assert normalize_tool_message_content(["foo", "bar"]) == "foobar"

    def test_list_mixed_str_and_blocks(self) -> None:
        content = [
            "prefix ",
            {"type": "text", "text": "middle "},
            {"type": "image_url", "image_url": {"url": "..."}},
            "suffix",
        ]
        assert normalize_tool_message_content(content) == "prefix middle suffix"

    def test_unknown_shape_returns_empty(self) -> None:
        assert normalize_tool_message_content(42) == ""
        assert normalize_tool_message_content({"text": "ignored"}) == ""


# ---------------------------------------------------------------------------
# Custom SSE encoder -- exercises the load-bearing path for Webex thread map
# ---------------------------------------------------------------------------


def _parse_sse_events(frames: list[str]) -> list[dict]:
    """Reassemble multi-line SSE ``data:`` payloads into JSON dicts."""
    out: list[dict] = []
    for frame in frames:
        data_lines: list[str] = []
        for line in frame.split("\n"):
            if line.startswith("data: "):
                data_lines.append(line[len("data: "):])
        if data_lines:
            out.append(json.loads("\n".join(data_lines)))
    return out


def _tool_end_payload_from_updates(messages: list[Any]) -> dict | None:
    """Run a list of LangGraph-style ``messages`` through the custom-SSE
    encoder's ``_handle_updates`` path and return the parsed ``tool_end``
    SSE payload (or ``None`` if the encoder emitted no tool-end frame).
    """
    from dynamic_agents.services.stream_encoders.custom_sse import CustomStreamEncoder

    enc = CustomStreamEncoder()
    update_chunk = {"agent": {"messages": messages}}
    frames = enc._handle_updates(update_chunk, namespace=())
    events = _parse_sse_events(frames)
    tool_end_events = [
        e for e in events
        if "tool_call_id" in e and "tool_name" not in e
    ]
    return tool_end_events[0] if tool_end_events else None


class TestCustomSSEToolEndEmitsListContent:
    """``custom_sse`` is the encoder ``autonomous_agents`` consumes -- this
    pins the fix for the Webex follow-up bug specifically. Without the
    list-content normalisation, the ``result`` field is silently dropped
    and the Webex thread-map scanner finds no ``messageId=`` substrings,
    so inbound replies to dynamic-agent task posts get DROP_NO_MAPPING."""

    def test_list_content_lands_in_result_field(self) -> None:
        webex_text = (
            "Message sent successfully (messageId=Y2lzY29zcGFyazovL3VybjpURUFNOnVz, "
            "roomId=Y2lzY29zcGFyazovL3VybjpURUFNOnJvb20)."
        )
        msg = _FakeToolMessage(
            tool_call_id="tc-abc",
            content=[{"type": "text", "text": webex_text}],
        )

        tool_end = _tool_end_payload_from_updates([msg])

        assert tool_end is not None
        assert tool_end["result"] == webex_text
        assert "messageId=" in tool_end["result"]

    def test_str_content_still_works(self) -> None:
        msg = _FakeToolMessage(tool_call_id="tc-1", content="plain string result")
        tool_end = _tool_end_payload_from_updates([msg])
        assert tool_end is not None
        assert tool_end["result"] == "plain string result"

    def test_empty_list_omits_result(self) -> None:
        msg = _FakeToolMessage(tool_call_id="tc-2", content=[])
        tool_end = _tool_end_payload_from_updates([msg])
        assert tool_end is not None
        assert "result" not in tool_end
        assert "error" not in tool_end

    def test_list_error_prefix_propagates(self) -> None:
        msg = _FakeToolMessage(
            tool_call_id="tc-3",
            content=[{"type": "text", "text": "ERROR: tool failed"}],
        )
        tool_end = _tool_end_payload_from_updates([msg])
        assert tool_end is not None
        assert tool_end["error"] == "ERROR: tool failed"
        assert "result" not in tool_end
