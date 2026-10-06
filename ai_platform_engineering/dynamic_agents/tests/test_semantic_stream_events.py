"""Pin shared native semantics and the existing browser wire formats."""

import json

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from dynamic_agents.services.stream_encoders import get_encoder
from dynamic_agents.services.stream_encoders.events import STREAM_EVENT_ADAPTER, TextDelta, ToolCompleted
from dynamic_agents.services.stream_encoders.semantic import SemanticStreamEncoder


def test_native_events_keep_full_results_and_suppress_rejected_tool_replay() -> None:
    encoder = SemanticStreamEncoder()
    tool_content = "Example result " * 200
    events = encoder.on_chunk(((), "updates", {"tools": {"messages": [
        AIMessage(content="", tool_calls=[
            {"id": "rejected-tool", "name": "search", "args": {}},
            {"id": "executed-tool", "name": "search", "args": {"query": "example"}},
        ]),
        ToolMessage(content="Tool call rejected", tool_call_id="rejected-tool"),
        ToolMessage(content=[{"type": "text", "text": tool_content}], tool_call_id="executed-tool"),
    ]}}))
    assert [event.kind for event in events] == ["updates_boundary", "tool_started", "tool_completed"]
    result = events[-1]
    assert isinstance(result, ToolCompleted)
    assert result.tool_call_id == "executed-tool"
    assert result.content == tool_content
    assert STREAM_EVENT_ADAPTER.validate_json(result.model_dump_json()) == result


def test_custom_format_golden_semantic_event_sequence() -> None:
    encoder = get_encoder("custom")
    events = [
        TextDelta(text="Thinking. "),
        STREAM_EVENT_ADAPTER.validate_python({
            "kind": "tool_started", "tool_name": "search", "tool_call_id": "example-tool", "args": {"query": "example"},
        }),
        ToolCompleted(tool_call_id="example-tool", message_id=None, content="ERROR: Example failure", error="ERROR: Example failure"),
        TextDelta(text="Final."),
    ]
    assert [frame for event in events for frame in encoder.encode_event(event)] == [
        'event: content\ndata: {"text": "Thinking. ", "namespace": []}\n\n',
        'event: tool_start\ndata: {"tool_name": "search", "tool_call_id": "example-tool", "args": {"query": "example"}, "namespace": []}\n\n',
        'event: tool_end\ndata: {"tool_call_id": "example-tool", "namespace": [], "error": "ERROR: Example failure"}\n\n',
        'event: content\ndata: {"text": "Final.", "namespace": []}\n\n',
    ]
    assert encoder.get_thinking_content() == "Thinking. "
    assert encoder.get_accumulated_content() == "Final."


def test_agui_empty_update_retains_text_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("dynamic_agents.services.stream_encoders.agui_sse._ts", lambda: 1.0)
    monkeypatch.setattr("dynamic_agents.services.stream_encoders.agui_sse._new_id", lambda prefix="": f"{prefix}example")
    encoder = get_encoder("agui")
    encoder.on_chunk(((), "messages", (AIMessageChunk(content="hello"), {})))
    assert encoder.on_chunk(((), "updates", {})) == [
        'event: TEXT_MESSAGE_END\ndata: {"type": "TEXT_MESSAGE_END", "messageId": "msg-example", "timestamp": 1.0}\n\n',
    ]
    assert encoder.on_stream_end() == []


@pytest.mark.parametrize("protocol", ["agui", "custom"])
def test_ui_display_limit_does_not_change_native_tool_result(protocol: str) -> None:
    result = ToolCompleted(tool_call_id="example-tool", message_id=None, content="x" * 2200)
    frames = get_encoder(protocol).encode_event(result)
    payloads = [json.loads(frame.split("data: ", 1)[1]) for frame in frames]
    displayed = next(payload.get("content", payload.get("result")) for payload in payloads
                     if "content" in payload or "result" in payload)
    assert displayed == "x" * 2000 + "...[200 chars]"
    assert result.content == "x" * 2200
