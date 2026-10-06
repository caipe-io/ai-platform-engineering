"""AG-UI protocol stream encoder for dynamic agents.

Produces **AG-UI protocol format** SSE frames. Composes a
``LangGraphStreamHelper`` for chunk parsing and namespace correlation.
Owns AG-UI-specific state (``_active_message_ids`` for
TEXT_MESSAGE_START/END pairing, ``_last_emitted_namespace`` for
change-based NAMESPACE_CONTEXT emission).

Wire format examples::

    event: RUN_STARTED\\ndata: {"type":"RUN_STARTED","runId":"...","threadId":"..."}\\n\\n
    event: TEXT_MESSAGE_START\\ndata: {"type":"TEXT_MESSAGE_START","messageId":"..."}\\n\\n
    event: TEXT_MESSAGE_CONTENT\\ndata: {"type":"TEXT_MESSAGE_CONTENT",...}\\n\\n
    event: TOOL_CALL_START\\ndata: {"type":"TOOL_CALL_START","toolCallId":"...",...}\\n\\n
    event: TOOL_CALL_ARGS\\ndata: {"type":"TOOL_CALL_ARGS","toolCallId":"...","delta":"..."}\\n\\n
    event: TOOL_CALL_END\\ndata: {"type":"TOOL_CALL_END","toolCallId":"..."}\\n\\n
    event: RUN_FINISHED\\ndata: {"type":"RUN_FINISHED","runId":"...","threadId":"..."}\\n\\n

Self-contained — builds AG-UI SSE frames directly with plain dicts.
No dependency on ``ai_platform_engineering.utils.agui``.
"""

import json
import time
from typing import Any
from uuid import uuid4

from dynamic_agents.services.stream_encoders import StreamEncoder
from dynamic_agents.services.stream_encoders.events import (
    ContextUsage,
    StreamEvent,
    TextDelta,
    ToolCompleted,
    ToolStarted,
    UpdatesBoundary,
)
from dynamic_agents.services.stream_encoders.langgraph_helpers import truncate_tool_result

# ═══════════════════════════════════════════════════════════════
# AG-UI SSE helpers
# ═══════════════════════════════════════════════════════════════

def _ts() -> float:
    """Current Unix timestamp."""
    return time.time()

def _new_id(prefix: str = "") -> str:
    """Generate a prefixed UUID4."""
    return f"{prefix}{uuid4()}"

def _sse_frame(event_type: str, data: dict[str, Any]) -> str:
    """Build an AG-UI SSE frame from event type and payload dict.

    The ``type`` field in data must already be set to the AG-UI event type.
    """
    raw = json.dumps(data, ensure_ascii=False)
    if "\n" in raw:
        data_lines = "\n".join(f"data: {line}" for line in raw.split("\n"))
    else:
        data_lines = f"data: {raw}"
    return f"event: {event_type}\n{data_lines}\n\n"

def _namespace_key(namespace: tuple[str, ...]) -> str:
    """Return a stable dict key for a namespace tuple."""
    return namespace[0] if namespace else ""

# ═══════════════════════════════════════════════════════════════
# AGUIStreamEncoder
# ═══════════════════════════════════════════════════════════════

class AGUIStreamEncoder(StreamEncoder[str]):
    """Encodes LangGraph stream chunks to AG-UI protocol SSE format.

    Builds AG-UI events as plain dicts and serializes them directly.

    AG-UI-specific state:
    - ``_active_message_ids``: tracks open TEXT_MESSAGE per namespace key
      for proper START/END pairing.
    - ``_last_emitted_namespace``: tracks the most recently emitted
      NAMESPACE_CONTEXT to avoid redundant emissions and ensure correct
      attribution when concurrent subagent events interleave.
    """

    def __init__(self) -> None:
        super().__init__()
        self._active_message_ids: dict[str, str | None] = {}
        self._last_emitted_namespace: tuple[str, ...] = ()
        self._run_id: str = ""
        self._thread_id: str = ""

    # ── Core lifecycle ────────────────────────────────────

    def on_run_start(self, run_id: str, thread_id: str) -> list[str]:
        self._run_id = run_id
        self._thread_id = thread_id
        return [
            _sse_frame(
                "RUN_STARTED",
                {
                    "type": "RUN_STARTED",
                    "runId": run_id,
                    "threadId": thread_id,
                    "timestamp": _ts(),
                },
            )
        ]

    def on_stream_end(self) -> list[str]:
        """Close any still-open text messages."""
        frames: list[str] = []
        for ns_key, msg_id in self._active_message_ids.items():
            if msg_id is not None:
                frames.append(
                    _sse_frame(
                        "TEXT_MESSAGE_END",
                        {
                            "type": "TEXT_MESSAGE_END",
                            "messageId": msg_id,
                            "timestamp": _ts(),
                        },
                    )
                )
                self._active_message_ids[ns_key] = None
        return frames

    def on_run_finish(self, run_id: str, thread_id: str) -> list[str]:
        return [
            _sse_frame(
                "RUN_FINISHED",
                {
                    "type": "RUN_FINISHED",
                    "runId": run_id,
                    "threadId": thread_id,
                    "outcome": "success",
                    "timestamp": _ts(),
                },
            )
        ]

    def on_run_error(self, message: str, code: str | None = None) -> list[str]:
        data: dict[str, Any] = {
            "type": "RUN_ERROR",
            "message": message,
            "timestamp": _ts(),
        }
        if code is not None:
            data["code"] = code
        return [_sse_frame("RUN_ERROR", data)]

    def on_warning(self, message: str) -> list[str]:
        return [
            _sse_frame(
                "CUSTOM",
                {
                    "type": "CUSTOM",
                    "name": "WARNING",
                    "value": {"message": message, "namespace": []},
                    "timestamp": _ts(),
                },
            )
        ]

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
        """Emit RUN_FINISHED with outcome ``"interrupt"`` per the AG-UI spec.

        The interrupt payload carries metadata so the UI can render the
        appropriate HITL component.  Because this *is* the RUN_FINISHED frame,
        the caller must **not** call ``on_run_finish`` afterwards.
        """
        if interrupt_type == "tool_approval":
            payload: dict[str, Any] = {
                "tool_name": tool_name,
                "tool_args": tool_args or {},
                "allowed_decisions": allowed_decisions or ["approve", "edit", "reject"],
                "agent": agent,
            }
            if tool_approvals and len(tool_approvals) > 1:
                payload["tool_approvals"] = tool_approvals
            reason = "tool_approval"
        else:
            payload = {
                "prompt": prompt,
                "fields": fields,
                "agent": agent,
            }
            reason = "human_input"

        return [
            _sse_frame(
                "RUN_FINISHED",
                {
                    "type": "RUN_FINISHED",
                    "runId": self._run_id,
                    "threadId": self._thread_id,
                    "outcome": "interrupt",
                    "interrupt": {
                        "id": interrupt_id,
                        "reason": reason,
                        "payload": payload,
                    },
                    "timestamp": _ts(),
                },
            )
        ]

    # ── Namespace tracking ────────────────────────────────

    def _emit_namespace_if_changed(self, namespace: tuple[str, ...]) -> list[str]:
        """Emit NAMESPACE_CONTEXT only when the namespace has changed.

        Tracks ``_last_emitted_namespace`` to avoid redundant emissions.
        This ensures correct attribution when concurrent subagent events
        interleave on a single SSE connection — the client updates its
        ``currentNamespace`` state from these events.
        """
        if namespace == self._last_emitted_namespace:
            return []
        self._last_emitted_namespace = namespace
        return [
            _sse_frame(
                "CUSTOM",
                {
                    "type": "CUSTOM",
                    "name": "NAMESPACE_CONTEXT",
                    "value": {"namespace": list(namespace)},
                    "timestamp": _ts(),
                },
            )
        ]

    # ── Semantic event formatting ─────────────────────────

    def _format_event(self, event: StreamEvent) -> list[str]:
        if isinstance(event, TextDelta):
            return self._format_text(event)
        if isinstance(event, UpdatesBoundary):
            return self._close_text(event.namespace)
        if isinstance(event, ToolStarted):
            return [
                *self._emit_namespace_if_changed(event.namespace),
                _sse_frame("TOOL_CALL_START", {
                    "type": "TOOL_CALL_START", "toolCallId": event.tool_call_id,
                    "toolCallName": event.tool_name, "timestamp": _ts(),
                }),
                _sse_frame("TOOL_CALL_ARGS", {
                    "type": "TOOL_CALL_ARGS", "toolCallId": event.tool_call_id,
                    "delta": json.dumps(event.args), "timestamp": _ts(),
                }),
            ]
        if isinstance(event, ToolCompleted):
            frames = self._emit_namespace_if_changed(event.namespace)
            if event.content:
                frames.append(_sse_frame("TOOL_CALL_RESULT", {
                    "type": "TOOL_CALL_RESULT", "message_id": event.message_id,
                    "tool_call_id": event.tool_call_id, "content": truncate_tool_result(event.content),
                    "role": "tool", "timestamp": _ts(),
                }))
            frames.append(_sse_frame("TOOL_CALL_END", {
                "type": "TOOL_CALL_END", "toolCallId": event.tool_call_id, "timestamp": _ts(),
            }))
            return frames
        if isinstance(event, ContextUsage):
            return [_sse_frame("CUSTOM", {
                "type": "CUSTOM", "name": "CONTEXT_USAGE",
                "value": {**event.value, "namespace": list(event.namespace)}, "timestamp": _ts(),
            })]
        return []

    def _format_text(self, event: TextDelta) -> list[str]:
        ns_key = _namespace_key(event.namespace)
        frames: list[str] = []
        if self._active_message_ids.get(ns_key) is None:
            message_id = _new_id("msg-")
            self._active_message_ids[ns_key] = message_id
            frames.extend(self._emit_namespace_if_changed(event.namespace))
            frames.append(_sse_frame("TEXT_MESSAGE_START", {
                "type": "TEXT_MESSAGE_START", "messageId": message_id,
                "role": "assistant", "timestamp": _ts(),
            }))
        frames.extend(self._emit_namespace_if_changed(event.namespace))
        frames.append(_sse_frame("TEXT_MESSAGE_CONTENT", {
            "type": "TEXT_MESSAGE_CONTENT", "messageId": self._active_message_ids[ns_key],
            "delta": event.text, "timestamp": _ts(),
        }))
        return frames

    def _close_text(self, namespace: tuple[str, ...]) -> list[str]:
        ns_key = _namespace_key(namespace)
        message_id = self._active_message_ids.get(ns_key)
        if message_id is None:
            return []
        self._active_message_ids[ns_key] = None
        return [_sse_frame("TEXT_MESSAGE_END", {
            "type": "TEXT_MESSAGE_END", "messageId": message_id, "timestamp": _ts(),
        })]
