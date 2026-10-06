"""Stream encoder abstraction for dynamic agents.

Contains the ``StreamEncoder`` ABC and the ``get_encoder()`` factory function.

Protocol selection is per-request via query parameter::

    POST /chat/start-stream?protocol=custom   # Default — old SSE format
    POST /chat/start-stream?protocol=agui     # AG-UI protocol
"""

from abc import ABC, abstractmethod
from typing import Any, Generic, TypeVar

from dynamic_agents.services.stream_encoders.events import (
    InputRequired,
    RunError,
    RunFinished,
    RunStarted,
    StreamEnded,
    StreamEvent,
    WarningEvent,
)
from dynamic_agents.services.stream_encoders.langgraph_helpers import LangGraphStreamHelper

OutputT = TypeVar("OutputT", covariant=True)

# ═══════════════════════════════════════════════════════════════
# StreamEncoder ABC
# ═══════════════════════════════════════════════════════════════


class StreamEncoder(ABC, Generic[OutputT]):
    """Abstract base class for stream encoders.

    Each abstract method corresponds to a specific event in the stream
    lifecycle. Output is generic: typed native events for ACP, or SSE
    frame strings for a browser protocol.

    Design principles:

    - **Protocol-agnostic interface.** Method signatures carry only the
      domain-level data the runtime knows about (interrupt IDs, prompts,
      field definitions, etc.). They must never expose protocol-specific
      concepts such as AG-UI event types, wire-format field names, or
      framing conventions. If a protocol needs extra context (e.g.
      ``run_id`` inside an interrupt frame), the encoder must capture it
      from an earlier lifecycle call (like ``on_run_start``) and store
      it as instance state.

    - **One semantic projection.** The shared helper owns graph parsing,
      task correlation, message filtering and content accumulation.
      Subclasses own protocol state such as open AG-UI message IDs and
      decide how a semantic event is represented on the wire.
    """

    def __init__(self) -> None:
        self._helper = LangGraphStreamHelper()

    def on_chunk(self, chunk: tuple) -> list[OutputT]:
        """Project LangGraph data once, then format the semantic events."""
        return self._encode_events(self._helper.project_chunk(chunk))

    def _encode_events(self, events: list[StreamEvent]) -> list[OutputT]:
        return [output for event in events for output in self.encode_event(event)]

    def encode_event(self, event: StreamEvent) -> list[OutputT]:
        """Format an already projected event, including ACP-delivered events."""
        self._helper.observe_event(event)
        if isinstance(event, RunStarted):
            return self.on_run_start(event.run_id, event.thread_id)
        if isinstance(event, StreamEnded):
            return self.on_stream_end()
        if isinstance(event, RunFinished):
            return self.on_run_finish(event.run_id, event.thread_id)
        if isinstance(event, RunError):
            return self.on_run_error(event.message, event.code)
        if isinstance(event, WarningEvent):
            return self.on_warning(event.message)
        if isinstance(event, InputRequired):
            return self.on_input_required(**event.model_dump(exclude={"kind"}))
        return self._format_event(event)

    def _handle_messages(self, data: Any, namespace: tuple[str, ...]) -> list[OutputT]:
        return self._encode_events(self._helper.message_events(data, namespace))

    def _handle_updates(self, data: Any, namespace: tuple[str, ...]) -> list[OutputT]:
        return self._encode_events(self._helper.update_events(data, namespace))

    def _handle_custom(self, data: Any, namespace: tuple[str, ...]) -> list[OutputT]:
        return self._encode_events(self._helper.custom_events(data, namespace))

    @abstractmethod
    def _format_event(self, event: StreamEvent) -> list[OutputT]:
        """Format content, tool, boundary and context events."""

    @abstractmethod
    def on_run_start(self, run_id: str, thread_id: str) -> list[OutputT]:
        """Stream is beginning. Called once at the top of stream/resume."""

    @abstractmethod
    def on_stream_end(self) -> list[OutputT]:
        """All chunks have been processed. Flush any buffered state."""

    @abstractmethod
    def on_run_finish(self, run_id: str, thread_id: str) -> list[OutputT]:
        """Stream completed successfully."""

    @abstractmethod
    def on_run_error(self, message: str, code: str | None = None) -> list[OutputT]:
        """Unrecoverable error terminated the stream."""

    @abstractmethod
    def on_warning(self, message: str) -> list[OutputT]:
        """Non-fatal warning (e.g., MCP server unavailable)."""

    @abstractmethod
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
    ) -> list[OutputT]:
        """Agent execution paused — requires human input or approval.

        Emitted for both form-based input (``request_user_input``) and tool
        approval interrupts.  The ``interrupt_type`` discriminator tells the
        UI which component to render:

        - ``"form_input"``: render a form with ``fields`` and ``prompt``.
        - ``"tool_approval"``: render an approval card with ``tool_name``,
          ``tool_args``, and ``allowed_decisions``.  When multiple tools
          need approval, ``tool_approvals`` contains the full list.

        The caller must **not** follow this with ``on_run_finish()`` — the
        interrupt terminates the run.
        """

    def get_accumulated_content(self) -> str:
        """Return final answer content (after the last tool call)."""
        return self._helper.get_accumulated_content()

    def get_thinking_content(self) -> str:
        """Return all content emitted during the run (thinking + final answer)."""
        return self._helper.get_thinking_content()


# ═══════════════════════════════════════════════════════════════
# Factory
# ═══════════════════════════════════════════════════════════════


def get_encoder(protocol: str = "custom") -> StreamEncoder[str]:
    """Create an encoder for the given protocol.

    Args:
        protocol: "custom" (old SSE format) or "agui" (AG-UI protocol)
    """
    if protocol == "agui":
        from .agui_sse import AGUIStreamEncoder

        return AGUIStreamEncoder()
    from .custom_sse import CustomStreamEncoder

    return CustomStreamEncoder()
