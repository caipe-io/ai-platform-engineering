"""Execution-owner hook for compiled subagents; no provider credentials in graph state."""

from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any

from langchain_core.messages import AIMessage, ToolMessage

from dynamic_agents.models import SubAgentRef

subagent_factory: ContextVar[Callable[[SubAgentRef], Awaitable[dict[str, Any]]] | None] = ContextVar(
    "subagent_factory", default=None
)


def child_tool_update(data: dict[str, Any]) -> dict[str, Any] | None:
    """Reuse the existing encoders' tool-event contract for Harness children."""
    event, payload = data.get("event_type"), data.get("data", {})
    if event == "tool.started":
        message = AIMessage(content="", tool_calls=[{
            "id": payload["tool_call_id"], "name": payload["tool_name"], "args": payload.get("args", {}),
        }])
    elif event == "tool.completed":
        message = ToolMessage(
            content=f"ERROR: {payload['error']}" if payload.get("error") else str(payload.get("result", "")),
            tool_call_id=payload["tool_call_id"],
        )
    else:
        return None
    return {"delegate": {"messages": [message]}}
