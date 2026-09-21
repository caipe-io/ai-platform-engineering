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
import logging
from typing import Any

from dynamic_agents.services.stream_encoders import StreamEncoder
from dynamic_agents.services.stream_encoders.langgraph_helpers import (
    LangGraphStreamHelper,
    normalize_tool_message_content,
    truncate_tool_result,
)

logger = logging.getLogger(__name__)


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


class CustomStreamEncoder(StreamEncoder):
    """Encodes LangGraph stream chunks to the original custom SSE format.

    This encoder reproduces the exact wire format that the existing frontend
    (``da-streaming-client.ts``) expects. The old format used plain dicts with
    ``type``, ``data``, and ``namespace`` fields, formatted as SSE frames by
    ``chat.py``.
    """

    def __init__(self) -> None:
        self._helper = LangGraphStreamHelper()

    # ── Core lifecycle ────────────────────────────────────

    def on_run_start(self, run_id: str, thread_id: str) -> list[str]:
        return []  # Old format has no run_started event

    def on_chunk(self, chunk: tuple) -> list[str]:
        namespace, mode, data = self._helper.parse_chunk(chunk)
        if mode == "tasks":
            return []  # Helper already updated its namespace mapping

        correlated_ns = self._helper.correlate_namespace(namespace)

        if mode == "messages":
            return self._handle_messages(data, correlated_ns)

        if mode == "updates":
            return self._handle_updates(data, correlated_ns)

        return []

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
            payload["allowed_decisions"] = allowed_decisions or ["approve", "edit", "reject"]
        else:
            payload["prompt"] = prompt
            payload["fields"] = fields
        return [_sse_frame("input_required", payload)]

    # ── Content retrieval ─────────────────────────────────

    def get_accumulated_content(self) -> str:
        return self._helper.get_accumulated_content()

    def get_thinking_content(self) -> str:
        return self._helper.get_thinking_content()

    # ── Private: messages mode ────────────────────────────

    def _handle_messages(
        self,
        data: Any,
        namespace: tuple[str, ...],
    ) -> list[str]:
        """Handle 'messages' mode chunks -> content events.

        Reproduces the old ``_handle_messages_chunk()`` behavior from
        ``stream_events.py`` (main branch): yields a single ``content``
        event per non-empty text chunk.
        """
        if not isinstance(data, tuple) or len(data) != 2:
            return []

        msg_chunk, metadata = data

        if LangGraphStreamHelper.is_summarization_chunk(msg_chunk, metadata):
            return []

        # Skip ToolMessage content (tool results, not for display)
        if LangGraphStreamHelper.is_tool_message(msg_chunk):
            return []

        # Skip if the chunk has tool_calls (invoking tools, not content)
        if LangGraphStreamHelper.has_tool_calls(msg_chunk):
            return []

        content = LangGraphStreamHelper.extract_content(msg_chunk)
        if not content:
            return []

        self._helper.accumulate_content(content)

        # Old format: event type "content", data wrapped as {"text": ..., "namespace": [...]}
        return [_sse_frame("content", {"text": content, "namespace": list(namespace)})]

    # ── Private: updates mode ─────────────────────────────

    def _handle_updates(
        self,
        data: Any,
        namespace: tuple[str, ...],
    ) -> list[str]:
        """Handle 'updates' mode chunks -> tool events.

        Reproduces the old ``_handle_updates_chunk()`` behavior from
        ``stream_events.py`` (main branch).
        """
        results: list[str] = []

        if not isinstance(data, dict):
            return results

        for _node_name, node_data in data.items():
            if not isinstance(node_data, dict):
                continue

            messages = node_data.get("messages", [])
            if not isinstance(messages, list):
                continue

            # ── Pre-scan: identify rejected tool_call_ids ──────────────────
            # LangGraph quirk: when a tool call is rejected via HITL
            # (HumanInTheLoopMiddleware), the resume stream re-emits the
            # original AIMessage (with tool_calls) AND a ToolMessage containing
            # the rejection text — all in the same "updates" chunk.
            # We suppress ALL tool events (start, end) for rejected tools
            # because:
            #   1. The tool was already shown in the pre-interrupt stream
            #   2. The tool never actually executed — showing it as "completed"
            #      would be misleading
            # The LLM still receives the rejection ToolMessage in its context,
            # so it knows the tool was blocked and can respond accordingly.
            rejected_tool_call_ids: set[str] = set()
            for msg in messages:
                tc_id = getattr(msg, "tool_call_id", None)
                if tc_id:
                    content = normalize_tool_message_content(getattr(msg, "content", ""))
                    if "rejected" in content.lower():
                        rejected_tool_call_ids.add(tc_id)

            for msg in messages:
                # Handle AIMessage with tool_calls
                tool_calls = getattr(msg, "tool_calls", None)
                if tool_calls:
                    for tc in tool_calls:
                        tc_info = LangGraphStreamHelper.extract_tool_call(tc)
                        tool_name = tc_info["name"]
                        tool_call_id = tc_info["id"]
                        args = tc_info["args"]

                        # Skip rejected tools (see pre-scan comment above)
                        if tool_call_id in rejected_tool_call_ids:
                            logger.debug(f"[sse:tool_start] SUPPRESSED (rejected) {tool_name} id={tool_call_id[:8]}...")
                            continue

                        logger.debug(f"[sse:tool_start] {tool_name} id={tool_call_id[:8]}... ns={namespace}")
                        self._helper.reset_accumulated_content()
                        results.append(
                            _sse_frame(
                                "tool_start",
                                {
                                    "tool_name": tool_name,
                                    "tool_call_id": tool_call_id,
                                    "args": args,
                                    "namespace": list(namespace),
                                },
                            )
                        )

                # Handle ToolMessage (tool results)
                tool_call_id = getattr(msg, "tool_call_id", None)
                if tool_call_id:
                    # Skip rejected tools — already suppressed above
                    if tool_call_id in rejected_tool_call_ids:
                        logger.debug(f"[sse:tool_end] SUPPRESSED (rejected) id={tool_call_id[:8]}...")
                        continue

                    # Detect tool errors: wrap_tools_with_error_handling() returns
                    # "ERROR: ..." strings instead of raising exceptions.
                    # ToolMessage.content can be str OR list[dict | str] (LangChain
                    # >= 0.3) -- MCP tools that return TextContent items arrive as
                    # the list shape. Normalise first so downstream artifact-text
                    # scanners (e.g. the Webex thread map) see the tool's textual
                    # response regardless of LLM transport.
                    raw_content = getattr(msg, "content", "")
                    content = normalize_tool_message_content(raw_content)
                    error = None
                    if content.startswith("ERROR: "):
                        error = content

                    logger.debug(f"[sse:tool_end] id={tool_call_id[:8]}... ns={namespace} error={bool(error)}")
                    tool_end_data: dict[str, Any] = {
                        "tool_call_id": tool_call_id,
                        "namespace": list(namespace),
                    }
                    if error:
                        tool_end_data["error"] = error
                    elif content:
                        tool_end_data["result"] = truncate_tool_result(content)
                    results.append(_sse_frame("tool_end", tool_end_data))

        return results
