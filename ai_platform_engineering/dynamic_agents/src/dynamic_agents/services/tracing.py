"""Langfuse + OpenTelemetry tracing for Dynamic Agents.

Replaces ``cnoe_agent_utils.tracing.TracingManager``. The environment contract
is unchanged (spec FR-017): ``ENABLE_TRACING``, ``LANGFUSE_PUBLIC_KEY``,
``LANGFUSE_SECRET_KEY``, ``LANGFUSE_HOST``.

Tracing is best-effort by design (spec FR-018). A missing dependency, absent
credentials, or an unreachable collector disables tracing and leaves the agent
serving turns; it never raises into a request path.
"""

from __future__ import annotations

import logging
import os
from contextvars import ContextVar
from typing import Any

logger = logging.getLogger(__name__)

_TRUE = {"1", "true", "t", "yes", "y", "on"}


def _tracing_requested() -> bool:
    return os.getenv("ENABLE_TRACING", "").strip().lower() in _TRUE


class TracingManager:
    """Process-wide Langfuse tracing, initialised once.

    A singleton because the Langfuse callback handler registers an OpenTelemetry
    span processor; constructing several would emit duplicate spans. Repeated
    construction returns the same initialised instance.
    """

    _instance: "TracingManager | None" = None
    _initialized: bool = False

    def __new__(cls) -> "TracingManager":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self) -> None:
        if self._initialized:
            return
        self._handler: Any | None = None
        self._client: Any | None = None
        self._is_enabled = False
        self._current_trace_id: ContextVar[str | None] = ContextVar(
            "current_trace_id", default=None
        )
        self._initialize()
        type(self)._initialized = True

    def _initialize(self) -> None:
        if not _tracing_requested():
            logger.debug("[tracing] ENABLE_TRACING is not set; tracing disabled")
            return

        missing = [
            name
            for name in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY")
            if not os.getenv(name)
        ]
        if missing:
            logger.warning(
                "[tracing] ENABLE_TRACING is set but %s missing; tracing disabled",
                ", ".join(missing),
            )
            return

        try:
            from langfuse import get_client
            from langfuse.langchain import CallbackHandler

            self._client = get_client()
            self._handler = CallbackHandler()
            self._is_enabled = True
            logger.info("[tracing] Langfuse initialized (host=%s)", os.getenv("LANGFUSE_HOST", "<default>"))
        except ImportError as exc:
            logger.warning("[tracing] Disabled, missing dependency: %s", exc)
        except Exception as exc:  # noqa: BLE001 — tracing must never break a turn
            logger.warning("[tracing] Disabled, initialization failed: %s", exc)

    @property
    def is_enabled(self) -> bool:
        """Whether traces will actually be emitted."""
        return self._is_enabled

    @property
    def langfuse_handler(self) -> Any | None:
        """The LangChain callback handler, or ``None`` when tracing is off."""
        return self._handler

    def create_config(self, context_id: str) -> dict[str, Any]:
        """Build a LangChain runnable config for ``context_id``.

        Always carries ``thread_id`` so checkpointing works; adds the Langfuse
        callback only when tracing is enabled, so callers need no branch.
        """
        config: dict[str, Any] = {"configurable": {"thread_id": context_id}}
        if self._is_enabled and self._handler is not None:
            config["callbacks"] = [self._handler]
        return config

    def set_trace_id(self, trace_id: str | None) -> None:
        """Record the active trace id so tools can correlate against it."""
        self._current_trace_id.set(trace_id)

    def get_trace_id(self) -> str | None:
        """Return the active trace id, preferring Langfuse's own when available."""
        if self._is_enabled and self._client is not None:
            try:
                current = self._client.get_current_trace_id()
                if current:
                    return current
            except Exception:  # noqa: BLE001 — fall back to the context var
                pass
        return self._current_trace_id.get()
