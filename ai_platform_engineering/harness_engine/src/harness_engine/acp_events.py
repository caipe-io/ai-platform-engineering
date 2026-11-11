"""ACP v1 updates with a negotiated, sequenced Harness event extension."""

from __future__ import annotations

from typing import Any

from harness_engine.models import CanonicalEventDraft, RunEvent

EXTENSION = "caipe.io/harness"


def event_notification(session_id: str, event: RunEvent) -> dict[str, Any]:
    data = event.data
    update: dict[str, Any] | None = None
    if event.event_type in {"content.delta", "reasoning.delta"}:
        update = {
            "sessionUpdate": "agent_message_chunk" if event.event_type == "content.delta" else "agent_thought_chunk",
            "content": {"type": "text", "text": data["text"]},
        }
    elif event.event_type == "tool.started":
        update = {
            "sessionUpdate": "tool_call",
            "toolCallId": data["tool_call_id"],
            "title": data["tool_name"],
            "status": "in_progress",
            "rawInput": data.get("args", {}),
        }
    elif event.event_type in {"tool.completed", "tool.failed"}:
        update = {
            "sessionUpdate": "tool_call_update",
            "toolCallId": data["tool_call_id"],
            "status": "failed" if event.event_type == "tool.failed" or data.get("error") else "completed",
            "rawOutput": data.get("result"),
        }
    params: dict[str, Any] = {
        "sessionId": session_id,
        "_meta": {EXTENSION: {"event": event.model_dump(mode="json")}},
    }
    if update is not None:
        params["update"] = update
    return {"jsonrpc": "2.0", "method": "session/update" if update else "_caipe/event", "params": params}


def canonical_update(update: dict[str, Any]) -> CanonicalEventDraft | None:
    """Translate an ordinary ACP agent (without the Harness extension)."""
    kind = update.get("sessionUpdate")
    content = update.get("content", {})
    if kind in {"agent_message_chunk", "agent_thought_chunk"} and content.get("type") == "text":
        return CanonicalEventDraft(
            event_type="content.delta" if kind == "agent_message_chunk" else "reasoning.delta",
            data={"text": content["text"]},
        )
    if kind == "tool_call":
        return CanonicalEventDraft(
            event_type="tool.started",
            data={
                "tool_call_id": update["toolCallId"],
                "tool_name": update["title"],
                "args": update.get("rawInput", {}),
            },
        )
    if kind == "tool_call_update" and update.get("status") in {"completed", "failed"}:
        return CanonicalEventDraft(
            event_type="tool.completed",
            data={
                "tool_call_id": update["toolCallId"],
                "result": update.get("rawOutput", update.get("content", [])),
                **({"error": "Claude tool failed"} if update["status"] == "failed" else {}),
            },
        )
    return None
