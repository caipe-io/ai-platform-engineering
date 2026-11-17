"""Explicitly selected, bounded visible content for Scope assessments."""

from __future__ import annotations

import json
import os
from typing import Any

from agent_telemetry import current_scope_run


def capture_enabled() -> bool:
    """Require both an opt-in and an exact root-agent allowlist match."""
    run = current_scope_run()
    allowed = {value.strip() for value in os.getenv("SCOPE_CONTENT_CAPTURE_AGENT_IDS", "").split(",") if value.strip()}
    return (
        os.getenv("SCOPE_CONTENT_CAPTURE_ENABLED", "false").lower() == "true"
        and run is not None
        and run.attributes["agent_id"] in allowed
    )


def visible_text(content: Any) -> str:
    """Exclude image, file, reasoning and arbitrary object representations."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block["text"] for block in content
            if isinstance(block, dict) and block.get("type") in {"text", "output_text"}
            and isinstance(block.get("text"), str)
        )
    return ""


def message_attributes(messages: list[Any], prefix: str) -> dict[str, Any]:
    """Bound each text and the aggregate, marking any loss of evidence."""
    selected = messages if len(messages) <= 32 else messages[:2] + messages[-30:]
    attrs: dict[str, Any] = {"scope.content.capture": True}
    captured: list[dict[str, Any]] = []
    truncated = len(selected) != len(messages)
    budget = 131072
    for index, message in enumerate(selected):
        role = {"human": "user", "ai": "assistant"}.get(message.type, message.type)
        text = visible_text(message.content)
        calls = getattr(message, "tool_calls", None)
        if calls:
            text += "\nTool calls: " + json.dumps(calls, ensure_ascii=False)
        limit = min(32768, budget)
        truncated = truncated or len(text) > limit
        if text and limit:
            attrs[f"{prefix}.{index}.role"] = role
            attrs[f"{prefix}.{index}.content"] = text[:limit]
            captured.append({"role": role, "parts": [{"type": "text", "content": text[:limit]}]})
            budget -= min(len(text), limit)
    # The UI span reader uses flattened fields; the normalizer uses GenAI messages.
    direction = "input" if prefix == "gen_ai.prompt" else "output"
    attrs[f"gen_ai.{direction}.messages"] = json.dumps(captured, ensure_ascii=False)
    attrs[f"scope.content.{prefix.rsplit('.', 1)[-1]}_truncated"] = truncated
    return attrs


def entity_attributes(value: Any, direction: str) -> dict[str, Any]:
    """Export structured tool/delegation data using both Scope attribute dialects."""
    if hasattr(value, "content"):
        text = visible_text(value.content)
    elif isinstance(value, str):
        text = value
    elif isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False)
    else:
        text = ""
    return {
        f"traceloop.entity.{direction}": text[:16384],
        f"ioa_observe.entity.{direction}": text[:16384],
        "scope.content.capture": True,
        f"scope.content.{direction}_truncated": len(text) > 16384,
    }
