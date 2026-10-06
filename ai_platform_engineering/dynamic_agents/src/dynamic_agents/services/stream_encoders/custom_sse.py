"""Custom SSE stream encoder for dynamic agents.

Produces the **old SSE format** that ``da-streaming-client.ts`` already
understands. Composes a ``LangGraphStreamHelper`` for chunk parsing and
namespace correlation. No protocol-specific state beyond what the helper
provides.

Wire format examples::

    event: content\\ndata: {"text": "hello", "namespace": []}\\n\\n
    event: tool_start\\ndata: {"tool_name": "search", "tool_call_id": "tc-1", ...}\\n\\n
    event: tool_end\\ndata: {"tool_call_id": "tc-1", "namespace": []}\\n\\n
    event: warning\\ndata: {"message": "...", "namespace": []}\\n\\n
    event: input_required\\ndata: {"interrupt_id": "...", ...}\\n\\n
    event: error\\ndata: {"error": "..."}\\n\\n
    event: done\\ndata: {}\\n\\n
"""

import json
from typing import Any

from dynamic_agents.services.context_usage import CONTEXT_USAGE_EVENT
from dynamic_agents.services.stream_encoders import StreamEncoder
from dynamic_agents.services.stream_encoders.events import (
    ContextUsage,
    StreamEvent,
    TextDelta,
    ToolCompleted,
    ToolStarted,
)
from dynamic_agents.services.stream_encoders.langgraph_helpers import truncate_tool_result

# ═══════════════════════════════════════════════════════════════
# SSE Frame Helper
# ═══════════════════════════════════════════════════════════════

def _sse_frame(event_type: str, data: dict[str, Any]) -> str:
    """Build a complete SSE frame string.

    Handles newlines in JSON data by splitting into multiple ``data:`` lines
    per the SSE spec. Extracted from the old ``chat.py::_encode_sse_data()``.

    Returns:
        ``"event: {type}\\ndata: {json}\\n\\n"``
    """
    raw = json.dumps(data)
    if "\n" in raw:
        lines = raw.split("\n")
        sse_data = "\n".join(f"data: {line}" for line in lines)
    else:
        sse_data = f"data: {raw}"
    return f"event: {event_type}\n{sse_data}\n\n"

# ═══════════════════════════════════════════════════════════════
# CustomStreamEncoder
# ═══════════════════════════════════════════════════════════════

class CustomStreamEncoder(StreamEncoder[str]):
    """Encodes LangGraph stream chunks to the original custom SSE format.

    This encoder reproduces the exact wire format that the existing frontend
    (``da-streaming-client.ts``) expects. The old format used plain dicts with
    ``type``, ``data``, and ``namespace`` fields, formatted as SSE frames by
    ``chat.py``.
    """

    # ── Core lifecycle ────────────────────────────────────

    def on_run_start(self, run_id: str, thread_id: str) -> list[str]:
        return []  # Old format has no run_started event

    def on_stream_end(self) -> list[str]:
        return []  # No state to flush in custom format

    def on_run_finish(self, run_id: str, thread_id: str) -> list[str]:
        return [_sse_frame("done", {})]

    def on_run_error(self, message: str, code: str | None = None) -> list[str]:
        return [_sse_frame("error", {"error": message})]

    def on_warning(self, message: str) -> list[str]:
        return [_sse_frame("warning", {"message": message, "namespace": []})]

    def on_input_required(
        self,
        interrupt_id: str,
        interrupt_type: str,
        prompt: str,
        fields: list[dict[str, Any]],
        agent: str,
        tool_name: str | None = None,
        tool_args: dict[str, Any] | None = None,
        allowed_decisions: list[str] | None = None,
        tool_approvals: list[dict[str, Any]] | None = None,
    ) -> list[str]:
        payload: dict[str, Any] = {
            "type": interrupt_type,
            "interrupt_id": interrupt_id,
            "agent": agent,
        }
        if interrupt_type == "tool_approval":
            payload["tool_name"] = tool_name
            payload["tool_args"] = tool_args or {}
            payload["allowed_decisions"] = allowed_decisions or ["approve", "edit", "reject"]
            if tool_approvals and len(tool_approvals) > 1:
                payload["tool_approvals"] = tool_approvals
        else:
            payload["prompt"] = prompt
            payload["fields"] = fields
        return [_sse_frame("input_required", payload)]

    # ── Semantic event formatting ─────────────────────────

    def _format_event(self, event: StreamEvent) -> list[str]:
        if isinstance(event, TextDelta):
            return [_sse_frame("content", {"text": event.text, "namespace": list(event.namespace)})]
        if isinstance(event, ToolStarted):
            return [_sse_frame("tool_start", {
                "tool_name": event.tool_name, "tool_call_id": event.tool_call_id,
                "args": event.args, "namespace": list(event.namespace),
            })]
        if isinstance(event, ToolCompleted):
            payload: dict[str, Any] = {"tool_call_id": event.tool_call_id, "namespace": list(event.namespace)}
            if event.error:
                payload["error"] = event.error
            elif event.content:
                payload["result"] = truncate_tool_result(event.content)
            return [_sse_frame("tool_end", payload)]
        if isinstance(event, ContextUsage):
            return [_sse_frame(CONTEXT_USAGE_EVENT, {**event.value, "namespace": list(event.namespace)})]
        return []
