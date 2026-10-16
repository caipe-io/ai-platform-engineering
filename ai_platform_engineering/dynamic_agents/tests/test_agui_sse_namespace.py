"""Unit tests for AGUIStreamEncoder namespace tracking.

Covers:
- _emit_namespace_if_changed: deduplication, root namespace, subagent switching
- _handle_messages: NAMESPACE_CONTEXT emitted before TEXT_MESSAGE_CONTENT on switch
- _handle_updates: NAMESPACE_CONTEXT emitted before TOOL_CALL_START / TOOL_CALL_END
- Concurrent interleaving: correct attribution when two subagents alternate
"""

import json
from unittest.mock import MagicMock, patch

from dynamic_agents.services.stream_encoders.agui_sse import AGUIStreamEncoder


def _parse_frames(frames: list[str]) -> list[dict]:
    """Parse SSE frame strings into a list of event dicts."""
    events = []
    for frame in frames:
        for line in frame.strip().split("\n"):
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


def _event_types(frames: list[str]) -> list[str]:
    """Extract just the event type sequence from SSE frames."""
    return [e["type"] for e in _parse_frames(frames)]


def _namespace_values(frames: list[str]) -> list[list[str]]:
    """Extract namespace values from NAMESPACE_CONTEXT events only."""
    return [e["value"]["namespace"] for e in _parse_frames(frames) if e.get("name") == "NAMESPACE_CONTEXT"]


class TestEmitNamespaceIfChanged:
    """Direct tests for the _emit_namespace_if_changed method."""

    def test_no_emit_when_same_as_initial(self):
        """Root namespace () matches initial state — no emission."""
        enc = AGUIStreamEncoder()
        assert enc._emit_namespace_if_changed(()) == []

    def test_emits_on_first_subagent(self):
        """Switching from root to a subagent emits NAMESPACE_CONTEXT."""
        enc = AGUIStreamEncoder()
        frames = enc._emit_namespace_if_changed(("agent-A",))
        assert len(frames) == 1
        events = _parse_frames(frames)
        assert events[0]["name"] == "NAMESPACE_CONTEXT"
        assert events[0]["value"]["namespace"] == ["agent-A"]

    def test_no_redundant_emit(self):
        """Same namespace twice — second call returns empty."""
        enc = AGUIStreamEncoder()
        enc._emit_namespace_if_changed(("agent-A",))
        assert enc._emit_namespace_if_changed(("agent-A",)) == []

    def test_emits_on_switch_back_to_root(self):
        """Switching from subagent back to root emits namespace=[]."""
        enc = AGUIStreamEncoder()
        enc._emit_namespace_if_changed(("agent-A",))
        frames = enc._emit_namespace_if_changed(())
        assert len(frames) == 1
        events = _parse_frames(frames)
        assert events[0]["value"]["namespace"] == []

    def test_emits_on_switch_between_subagents(self):
        """Switching from agent-A to agent-B emits NAMESPACE_CONTEXT."""
        enc = AGUIStreamEncoder()
        enc._emit_namespace_if_changed(("agent-A",))
        frames = enc._emit_namespace_if_changed(("agent-B",))
        assert len(frames) == 1
        events = _parse_frames(frames)
        assert events[0]["value"]["namespace"] == ["agent-B"]

    def test_tracks_state_correctly_through_sequence(self):
        """Full sequence: root -> A -> A -> B -> root."""
        enc = AGUIStreamEncoder()
        assert enc._emit_namespace_if_changed(()) == []  # no change
        assert len(enc._emit_namespace_if_changed(("A",))) == 1  # root -> A
        assert enc._emit_namespace_if_changed(("A",)) == []  # no change
        assert len(enc._emit_namespace_if_changed(("B",))) == 1  # A -> B
        assert len(enc._emit_namespace_if_changed(())) == 1  # B -> root


class TestHandleMessagesNamespace:
    """Test that _handle_messages emits NAMESPACE_CONTEXT correctly."""

    def _make_msg_chunk(self, content: str):
        """Create a mock message chunk with content."""
        chunk = MagicMock()
        chunk.content = content
        chunk.type = "ai"
        return chunk

    def test_root_namespace_no_context_event(self):
        """Root agent content should NOT emit NAMESPACE_CONTEXT."""
        enc = AGUIStreamEncoder()
        chunk = self._make_msg_chunk("hello")
        with (
            patch(
                "dynamic_agents.services.stream_encoders.langgraph_helpers.LangGraphStreamHelper.is_tool_message",
                return_value=False,
            ),
            patch(
                "dynamic_agents.services.stream_encoders.langgraph_helpers.LangGraphStreamHelper.has_tool_calls",
                return_value=False,
            ),
            patch(
                "dynamic_agents.services.stream_encoders.langgraph_helpers.LangGraphStreamHelper.extract_content",
                return_value="hello",
            ),
        ):
            frames = enc._handle_messages((chunk, {}), ())
            ns_events = _namespace_values(frames)
            assert ns_events == []

    def test_subagent_emits_context_on_first_content(self):
        """Subagent content should emit NAMESPACE_CONTEXT before TEXT_MESSAGE_START."""
        enc = AGUIStreamEncoder()
        chunk = self._make_msg_chunk("hello")
        with (
            patch(
                "dynamic_agents.services.stream_encoders.langgraph_helpers.LangGraphStreamHelper.is_tool_message",
                return_value=False,
            ),
            patch(
                "dynamic_agents.services.stream_encoders.langgraph_helpers.LangGraphStreamHelper.has_tool_calls",
                return_value=False,
            ),
            patch(
                "dynamic_agents.services.stream_encoders.langgraph_helpers.LangGraphStreamHelper.extract_content",
                return_value="hello",
            ),
        ):
            frames = enc._handle_messages((chunk, {}), ("agent-A",))
            types = _event_types(frames)
            # Should be: NAMESPACE_CONTEXT, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT
            assert types[0] == "CUSTOM"  # NAMESPACE_CONTEXT
            assert types[1] == "TEXT_MESSAGE_START"
            assert types[2] == "TEXT_MESSAGE_CONTENT"

    def test_interleaved_content_emits_context_on_switch(self):
        """When two subagents alternate content, NAMESPACE_CONTEXT is emitted at each switch."""
        enc = AGUIStreamEncoder()
        chunk = self._make_msg_chunk("x")
        with (
            patch(
                "dynamic_agents.services.stream_encoders.langgraph_helpers.LangGraphStreamHelper.is_tool_message",
                return_value=False,
            ),
            patch(
                "dynamic_agents.services.stream_encoders.langgraph_helpers.LangGraphStreamHelper.has_tool_calls",
                return_value=False,
            ),
            patch(
                "dynamic_agents.services.stream_encoders.langgraph_helpers.LangGraphStreamHelper.extract_content",
                return_value="x",
            ),
        ):
            # First content from agent-A
            frames_a1 = enc._handle_messages((chunk, {}), ("agent-A",))
            assert _namespace_values(frames_a1) == [["agent-A"]]

            # First content from agent-B
            frames_b1 = enc._handle_messages((chunk, {}), ("agent-B",))
            assert _namespace_values(frames_b1) == [["agent-B"]]

            # Second content from agent-A (the bug fix — must re-emit)
            frames_a2 = enc._handle_messages((chunk, {}), ("agent-A",))
            assert _namespace_values(frames_a2) == [["agent-A"]]

    def test_consecutive_same_namespace_no_redundant_context(self):
        """Multiple content chunks from same subagent should NOT emit redundant NAMESPACE_CONTEXT."""
        enc = AGUIStreamEncoder()
        chunk = self._make_msg_chunk("x")
        with (
            patch(
                "dynamic_agents.services.stream_encoders.langgraph_helpers.LangGraphStreamHelper.is_tool_message",
                return_value=False,
            ),
            patch(
                "dynamic_agents.services.stream_encoders.langgraph_helpers.LangGraphStreamHelper.has_tool_calls",
                return_value=False,
            ),
            patch(
                "dynamic_agents.services.stream_encoders.langgraph_helpers.LangGraphStreamHelper.extract_content",
                return_value="x",
            ),
        ):
            frames_1 = enc._handle_messages((chunk, {}), ("agent-A",))
            assert _namespace_values(frames_1) == [["agent-A"]]  # first time

            frames_2 = enc._handle_messages((chunk, {}), ("agent-A",))
            assert _namespace_values(frames_2) == []  # no redundant emit


class TestTasksChunkNamespaceMapping:
    """Cover task-input shapes emitted before and after LangGraph 1.2."""

    TASK_ID = "abc123-def456"
    TOOL_CALL_ID = "toolu_subagent_1"

    def _legacy_dict_chunk(self) -> dict:
        """LangGraph before 1.2 nests the tool call in an input dict."""
        return {
            "id": self.TASK_ID,
            "name": "tools",
            "input": {
                "__type": "tool_call_with_context",
                "tool_call": {
                    "name": "task",
                    "args": {"subagent_type": "worker", "description": "do work"},
                    "id": self.TOOL_CALL_ID,
                    "type": "tool_call",
                },
                "state": {"messages": []},
            },
        }

    def _list_chunk(self) -> dict:
        """LangGraph 1.2 and later emit a list of tool-call dicts."""
        return {
            "id": self.TASK_ID,
            "name": "tools",
            "input": [
                {
                    "name": "task",
                    "args": {"subagent_type": "worker", "description": "do work"},
                    "id": self.TOOL_CALL_ID,
                    "type": "tool_call",
                }
            ],
        }

    def test_legacy_dict_shape_populates_mapping(self):
        enc = AGUIStreamEncoder()
        enc._helper._handle_tasks_chunk(self._legacy_dict_chunk())
        assert enc._helper._namespace_mapping == {f"tools:{self.TASK_ID}": self.TOOL_CALL_ID}

    def test_list_shape_populates_mapping(self):
        enc = AGUIStreamEncoder()
        enc._helper._handle_tasks_chunk(self._list_chunk())
        assert enc._helper._namespace_mapping == {f"tools:{self.TASK_ID}": self.TOOL_CALL_ID}

    def test_subagent_namespace_correlates_after_list_chunk(self):
        enc = AGUIStreamEncoder()
        enc._helper._handle_tasks_chunk(self._list_chunk())
        correlated = enc._helper.correlate_namespace((f"tools:{self.TASK_ID}",))
        assert correlated == (self.TOOL_CALL_ID,)

    def test_uncorrelated_subagent_namespace_falls_back_to_parent(self):
        enc = AGUIStreamEncoder()
        correlated = enc._helper.correlate_namespace((f"tools:{self.TASK_ID}",))
        assert correlated == ()

    def test_non_task_tool_calls_are_ignored(self):
        enc = AGUIStreamEncoder()
        chunk = self._list_chunk()
        chunk["input"][0]["name"] = "get_weather"
        enc._helper._handle_tasks_chunk(chunk)
        assert enc._helper._namespace_mapping == {}

    def test_result_chunk_without_tool_call_is_ignored(self):
        enc = AGUIStreamEncoder()
        enc._helper._handle_tasks_chunk(
            {"id": self.TASK_ID, "name": "tools", "result": {"messages": []}, "interrupts": []}
        )
        assert enc._helper._namespace_mapping == {}
