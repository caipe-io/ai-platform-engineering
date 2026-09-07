"""Stream encoder abstraction for dynamic agents.

Contains the ``StreamEncoder`` ABC and the ``get_encoder()`` factory function.

Protocol selection is per-request via query parameter::

    POST /chat/start-stream?protocol=custom   # Default — old SSE format
    POST /chat/start-stream?protocol=agui     # AG-UI protocol
"""

from abc import ABC, abstractmethod
from typing import Any

# ═══════════════════════════════════════════════════════════════
# StreamEncoder ABC
# ═══════════════════════════════════════════════════════════════


class StreamEncoder(ABC):
    """Abstract base class for stream encoders.

    Each abstract method corresponds to a specific event in the stream
    lifecycle. Encoders implement these to produce protocol-specific
    SSE frame strings.

    Design principles:

    - **Protocol-agnostic interface.** Method signatures carry only the
      domain-level data the runtime knows about (interrupt IDs, prompts,
      field definitions, etc.). They must never expose protocol-specific
      concepts such as AG-UI event types, wire-format field names, or
      framing conventions. If a protocol needs extra context (e.g.
      ``run_id`` inside an interrupt frame), the encoder must capture it
      from an earlier lifecycle call (like ``on_run_start``) and store
      it as instance state.

    - **Encoders own their state.** Any protocol-specific bookkeeping
      (open message IDs, namespace tracking, accumulated content) lives
      in the encoder instance, not in the runtime or the ABC. The ABC
      defines *what* happens; each encoder decides *how* to represent it
      on the wire.
    """

    @abstractmethod
    def on_run_start(self, run_id: str, thread_id: str) -> list[str]:
        """Stream is beginning. Called once at the top of stream/resume."""

    @abstractmethod
    def on_chunk(self, chunk: tuple) -> list[str]:
        """Process a raw LangGraph astream() chunk. Called per chunk."""

    @abstractmethod
    def on_stream_end(self) -> list[str]:
        """All chunks have been processed. Flush any buffered state."""

    @abstractmethod
    def on_run_finish(self, run_id: str, thread_id: str) -> list[str]:
        """Stream completed successfully."""

    @abstractmethod
    def on_run_error(self, message: str, code: str | None = None) -> list[str]:
        """Unrecoverable error terminated the stream."""

    @abstractmethod
    def on_warning(self, message: str) -> list[str]:
        """Non-fatal warning (e.g., MCP server unavailable)."""

    @abstractmethod
    def on_memory_injected(self, memory_ids: list[str]) -> list[str]:
        """Memory records were injected into the model context for this turn."""

    @abstractmethod
    def on_memory_update(self, memory_ids: list[str], action: str) -> list[str]:
        """The agent created, updated, or deleted memory records."""

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
    ) -> list[str]:
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

    @abstractmethod
    def get_accumulated_content(self) -> str:
        """Return final answer content (after the last tool call)."""

    @abstractmethod
    def get_thinking_content(self) -> str:
        """Return all content emitted during the run (thinking + final answer)."""


# ═══════════════════════════════════════════════════════════════
# Factory
# ═══════════════════════════════════════════════════════════════


def get_encoder(protocol: str = "custom") -> StreamEncoder:
    """Create an encoder for the given protocol.

    Args:
        protocol: "custom" (old SSE format) or "agui" (AG-UI protocol)
    """
    if protocol == "agui":
        from .agui_sse import AGUIStreamEncoder

        return AGUIStreamEncoder()
    from .custom_sse import CustomStreamEncoder

    return CustomStreamEncoder()
