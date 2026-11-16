"""Independent Scope export. Only explicitly selected metadata leaves this module."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

logger = logging.getLogger(__name__)
_current: ContextVar[ScopeRun | None] = ContextVar("scope_run", default=None)


@lru_cache(maxsize=1)
def _provider() -> TracerProvider | None:
    if os.getenv("SCOPE_TRACING_ENABLED", "false").strip().lower() not in {"true", "1", "yes", "on"}:
        return None
    endpoint = os.getenv("SCOPE_OTLP_ENDPOINT", "").rstrip("/")
    try:
        url = urlsplit(endpoint)
    except ValueError:
        logger.warning("Scope tracing disabled: invalid endpoint URL")
        return None
    if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment:
        logger.warning("Scope tracing disabled: SCOPE_OTLP_ENDPOINT must be an HTTP(S) base URL without credentials")
        return None
    try:
        provider = TracerProvider(resource=Resource.create({
            "service.name": os.getenv("SCOPE_SERVICE_NAME", "agent-runtime").strip() or "agent-runtime",
        }))
        # A non-empty explicit header map prevents inheriting another backend's
        # OTEL_EXPORTER_OTLP_HEADERS. No Langfuse credentials are read here.
        exporter = OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces", headers={"User-Agent": "agent-telemetry"}, timeout=3)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        return provider
    except Exception:  # Telemetry setup must not affect agent availability.
        logger.warning("Scope tracing initialization failed", exc_info=False)
        return None


class ScopeRun:
    def __init__(self, provider: TracerProvider, agent_id: str, conversation_id: str,
                 run_id: str, traceparent: str | None, canonical_tools: bool) -> None:
        self.tracer = provider.get_tracer("agent-telemetry.scope")
        self.attributes = {
            "application_id": str(provider.resource.attributes["service.name"]),
            "session.id": run_id,
            "agent_id": agent_id,
            "ioa_observe.entity.name": agent_id,
            "conversation.id": conversation_id,
        }
        self.status = "completed"
        self.canonical_tools = canonical_tools
        self._lock = threading.Lock()
        self._operations: dict[str, trace.Span] = {}
        self._closed = False
        parent = TraceContextTextMapPropagator().extract({"traceparent": traceparent}) if traceparent else None
        self.agent = self.tracer.start_span(f"{agent_id}.agent", context=parent, attributes=self.attributes)
        self.context = trace.set_span_in_context(self.agent)
        self.child_attributes = {
            **self.attributes,
            "ioa_observe.agent.span_id": format(self.agent.get_span_context().span_id, "016x"),
        }
        self.marker("session.start")

    def marker(self, name: str) -> None:
        with self.tracer.start_as_current_span(name, context=self.context, attributes={
            **self.attributes, "execution.success": self.status in {"completed", "paused"}, "execution.outcome": self.status,
        }):
            pass

    def start(self, key: str, name: str, kind: str, attributes: dict[str, Any] | None = None) -> None:
        with self._lock:
            if not self._closed and key not in self._operations:
                self._operations[key] = self.tracer.start_span(f"{name}.{kind}", context=self.context, attributes={
                    **self.child_attributes, "ioa_observe.entity.name": name, **(attributes or {}),
                })

    def end(self, key: str, *, error: bool = False, attributes: dict[str, Any] | None = None) -> None:
        with self._lock:
            span = self._operations.pop(key, None)
        if span is not None:
            span.set_attributes({"execution.success": not error, **(attributes or {})})
            if error:
                span.set_status(trace.StatusCode.ERROR)
            span.end()

    def event(self, event_type: str, data: dict[str, Any]) -> None:
        """Capture canonical tool metadata without inputs, results or error text."""
        try:
            key = str(data.get("tool_call_id", ""))
            if key and event_type == "tool.started":
                self.start(key, str(data.get("tool_name", "tool")), "tool")
            elif key and event_type in {"tool.completed", "tool.failed"}:
                self.end(key, error=event_type == "tool.failed" or bool(data.get("error")))
        except Exception:
            logger.warning("Scope tool instrumentation failed", exc_info=False)

    def finish(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            keys = list(self._operations)
        for key in keys:
            self.end(key, error=True)
        self.agent.set_attributes({"execution.success": self.status in {"completed", "paused"}, "execution.outcome": self.status})
        if self.status in {"failed", "cancelled", "unconfirmed"}:
            self.agent.set_status(trace.StatusCode.ERROR)
        self.agent.end()
        # A pause ends this invocation segment; a resume gets a new session.
        # Unknown remote execution must not be reported as completed.
        if self.status != "unconfirmed":
            self.marker("session.end")


def current_scope_run() -> ScopeRun | None:
    return _current.get()


@contextmanager
def scope_session(agent_id: str, conversation_id: str, run_id: str | None = None,
                  traceparent: str | None = None, *, canonical_tools: bool = False) -> Iterator[ScopeRun | None]:
    existing = _current.get()
    provider = None if existing else _provider()
    if existing is not None or provider is None:
        yield existing
        return
    try:
        run = ScopeRun(provider, agent_id, conversation_id, run_id or uuid4().hex, traceparent, canonical_tools)
    except Exception:
        logger.warning("Scope session initialization failed", exc_info=False)
        yield None
        return
    token = _current.set(run)
    try:
        yield run
    except (asyncio.CancelledError, GeneratorExit):
        run.status = "cancelled"
        raise
    except BaseException:
        run.status = "failed"
        raise
    finally:
        _current.reset(token)
        try:
            run.finish()
        except Exception:
            logger.warning("Scope session finalization failed", exc_info=False)
