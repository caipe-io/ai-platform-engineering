"""Stateful helper for parsing LangGraph stream chunks.

Extracted from stream_events.py. Owns LangGraph-specific state (namespace
correlation, content accumulation) while also providing stateless static
helpers for message inspection and extraction. No event building, no
protocol knowledge.

Encoders instantiate one LangGraphStreamHelper per stream and delegate all
LangGraph parsing to it, so namespace mapping and content tracking are
never duplicated across encoders.

## Namespace Correlation

When using subagents (via the ``task`` tool), LangGraph assigns each subagent
invocation an internal UUID used in the namespace (e.g., ``tools:e3b034a3-...``).
However, clients need to correlate subagent events to the ``tool_start`` event
they already received, which contains the ``tool_call_id``.

By streaming with ``tasks`` mode enabled, LangGraph emits task metadata
containing both the internal task UUID and the original ``tool_call_id``. We
build a mapping ``{namespace_uuid: tool_call_id}`` and use it to replace the
LangGraph namespace with the correlated ``tool_call_id`` before emitting SSE
events.

This correlation is done server-side so all clients (Web UI, Slack, Webex,
Backstage) receive pre-correlated events without duplicating logic.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Max chars of tool result content to send to the frontend.
# Larger results are truncated with a "[...N chars]" suffix.
TOOL_RESULT_DISPLAY_LIMIT = 2000


def truncate_tool_result(content: str, limit: int = TOOL_RESULT_DISPLAY_LIMIT) -> str:
    """Truncate tool result content for frontend display."""
    if len(content) <= limit:
        return content
    remaining = len(content) - limit
    return content[:limit] + f"...[{remaining} chars]"


def normalize_tool_message_content(content: Any) -> str:
    """Coerce ``ToolMessage.content`` into a flat string.

    LangChain >= 0.3 may return ``ToolMessage.content`` as either ``str``
    or ``list[dict | str]`` (content blocks). AWS Bedrock and many MCP
    tools that emit ``TextContent`` items arrive as the list shape.

    Downstream consumers in the autonomous-agents pipeline (the Webex
    thread-map scanner in particular -- it grepps ``messageId=...`` out
    of the artifact text) need a single string. Mirrors the helper in
    ``multi_agents/platform_engineer/protocol_bindings/a2a/agent_executor.py``
    so the two streaming paths stay in sync.

    Returns an empty string for ``None`` / unknown shapes; the caller is
    expected to check truthiness before emitting a ``result`` field.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


class LangGraphStreamHelper:
    """Stateful helper for parsing LangGraph stream chunks.

    Owns state that is LangGraph-specific (not protocol-specific):
    - namespace_mapping: correlates subagent task UUIDs to tool_call_ids
    - accumulated_content: tracks total streamed content

    Encoders instantiate one per stream and call its methods.
    """

    def __init__(self) -> None:
        self._namespace_mapping: dict[str, str] = {}
        # LLM text tokens in stream order; used by invoke to extract final answer vs thinking.
        # _last_tool_start_pos marks where the last tool_start boundary is in the array.
        self._content_chunks: list[str] = []
        self._last_tool_start_pos: int = 0

    # ── Stateful methods ──────────────────────────────────

    def parse_chunk(self, chunk: tuple) -> tuple[tuple[str, ...], str, Any]:
        """Parse (namespace, mode, data) or (mode, data) from astream().

        For tasks-mode chunks, updates internal namespace_mapping automatically
        and returns mode="tasks" so the caller knows no events are needed.
        Returns (namespace, mode, data) normalized to always include namespace.
        """
        if len(chunk) == 3:
            namespace, mode, data = chunk
        elif len(chunk) == 2:
            mode, data = chunk
            namespace = ()
        else:
            logger.warning(f"[sse] Unexpected chunk format: {chunk}")
            return ((), "", None)

        # Log non-empty namespaces for debugging subagent events
        if namespace:
            logger.debug(f"[sse:chunk] mode={mode} namespace={namespace}")

        # Handle tasks mode — update namespace mapping, no events emitted
        if mode == "tasks":
            self._handle_tasks_chunk(data)

        return (namespace, mode, data)

    @staticmethod
    def _extract_task_tool_calls(task_input: Any) -> list[dict]:
        """Return the tool calls from a ``tasks``-mode chunk input.

        LangGraph has emitted two shapes for this field:

        - Before 1.2, a dict containing one call under ``tool_call``.
        - Since 1.2, a list of tool-call dicts.

        Normalize both shapes so namespace correlation remains compatible
        across LangGraph versions. Unknown shapes yield an empty list.
        """
        if isinstance(task_input, dict):
            tool_call = task_input.get("tool_call")
            return [tool_call] if isinstance(tool_call, dict) else []
        if isinstance(task_input, list):
            return [tool_call for tool_call in task_input if isinstance(tool_call, dict)]
        return []

    def _handle_tasks_chunk(self, data: Any) -> None:
        """Extract namespace UUID -> tool_call_id mapping from tasks events.

        LangGraph's ``tasks`` stream mode emits task metadata when a tool is
        invoked. For the ``task`` tool (subagent invocation), this contains:
        - id: The task UUID (used in namespace as "tools:{id}")
        - a tool call carrying the original ``tool_call_id`` and name

        We build this mapping so subagent events can be correlated to their
        ``tool_start`` events, which clients already have. The shape of the
        ``input`` field varies across LangGraph versions.
        """
        # Tasks data comes as a single dict per event, not a list
        if not isinstance(data, dict):
            return

        task_id = data.get("id")
        if not task_id:
            return

        # Only task tool calls spawn subgraphs with their own namespace.
        for tool_call in self._extract_task_tool_calls(data.get("input")):
            if tool_call.get("name") != "task":
                continue
            tool_call_id = tool_call.get("id")
            if not tool_call_id:
                continue
            namespace_key = f"tools:{task_id}"
            if namespace_key not in self._namespace_mapping:
                self._namespace_mapping[namespace_key] = tool_call_id
                logger.debug(f"[sse:tasks] Mapped {namespace_key} → {tool_call_id}")
            break

    def correlate_namespace(self, namespace: tuple[str, ...]) -> tuple[str, ...]:
        """Correlate using internal namespace_mapping.

        Replaces LangGraph internal UUID with the correlated tool_call_id.
        Unknown namespaces return empty tuple (treated as parent agent).
        """
        if not namespace:
            return namespace

        first = namespace[0]
        if first in self._namespace_mapping:
            # Replace with correlated tool_call_id
            correlated = (self._namespace_mapping[first],) + namespace[1:]
            logger.debug(f"[sse:correlate] {first} → {self._namespace_mapping[first]}")
            return correlated
        else:
            # Unknown namespace — treat as parent agent
            logger.warning(
                f"[sse:correlate] Unknown namespace {first}, mapping has {list(self._namespace_mapping.keys())}"
            )
            return ()

    def accumulate_content(self, content: str) -> None:
        """Append a content chunk to the buffer."""
        self._content_chunks.append(content)

    def reset_accumulated_content(self) -> None:
        """Mark the current position as a tool boundary."""
        self._last_tool_start_pos = len(self._content_chunks)

    def get_accumulated_content(self) -> str:
        """Return content after the last tool call (the final answer)."""
        return "".join(self._content_chunks[self._last_tool_start_pos :])

    def get_thinking_content(self) -> str:
        """Return content before the last tool call (intermediate reasoning)."""
        if self._last_tool_start_pos == 0:
            return ""
        return "".join(self._content_chunks[: self._last_tool_start_pos])

    # ── Static/stateless methods ──────────────────────────

    @staticmethod
    def is_tool_message(msg: Any) -> bool:
        """Check if message is a ToolMessage (tool result, not for display)."""
        return "ToolMessage" in type(msg).__name__

    @staticmethod
    def has_tool_calls(msg: Any) -> bool:
        """Check if message is invoking tools (not generating content)."""
        return bool(getattr(msg, "tool_calls", None))

    @staticmethod
    def is_summarization_chunk(msg: Any, metadata: Any) -> bool:
        """Check if a chunk is Deep Agents internal summarization content."""
        if isinstance(metadata, dict) and metadata.get("lc_source") == "summarization":
            return True

        additional_kwargs = getattr(msg, "additional_kwargs", None)
        return isinstance(additional_kwargs, dict) and additional_kwargs.get("lc_source") == "summarization"

    @staticmethod
    def extract_content(msg: Any) -> str:
        """Extract and normalize content from a message chunk.

        Handles content as string or list of content blocks.
        """
        raw_content = getattr(msg, "content", "")
        if isinstance(raw_content, list):
            return "".join(block.get("text", "") if isinstance(block, dict) else str(block) for block in raw_content)
        return raw_content if isinstance(raw_content, str) else ""

    @staticmethod
    def extract_tool_call(tc: Any) -> dict[str, Any]:
        """Extract tool call info (name, id, args) from a tool call object or dict."""
        if isinstance(tc, dict):
            return {
                "name": tc.get("name", "unknown"),
                "id": tc.get("id", ""),
                "args": tc.get("args", {}),
            }
        return {
            "name": getattr(tc, "name", "unknown"),
            "id": getattr(tc, "id", ""),
            "args": getattr(tc, "args", {}),
        }
