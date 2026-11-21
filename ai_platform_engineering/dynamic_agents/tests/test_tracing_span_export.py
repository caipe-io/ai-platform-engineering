"""Which OpenTelemetry spans the tracing manager exports to Langfuse."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any

import langfuse
import langfuse.langchain
import pytest
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider

from dynamic_agents.services import tracing

LANGFUSE_SCOPE = "langfuse-sdk"
PROVIDER_SDK_SCOPE = "com.anthropic.sdk.python.bedrock"


def _span(scope: str) -> ReadableSpan:
    tracer = TracerProvider().get_tracer(scope)
    with tracer.start_as_current_span("example", attributes={"gen_ai.request.model": "example-model"}) as span:
        pass
    return span  # type: ignore[return-value]


@pytest.fixture
def export_filter(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[[ReadableSpan], bool]]:
    captured: dict[str, Any] = {}

    class _FakeLangfuse:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    monkeypatch.setenv("ENABLE_TRACING", "true")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test")
    monkeypatch.setattr(langfuse, "Langfuse", _FakeLangfuse)
    monkeypatch.setattr(langfuse.langchain, "CallbackHandler", lambda: object())
    monkeypatch.setattr(tracing.TracingManager, "_instance", None)
    monkeypatch.setattr(tracing.TracingManager, "_initialized", False)

    manager = tracing.TracingManager()

    assert manager.is_enabled
    yield captured["should_export_span"]


def test_exports_langfuse_spans(export_filter: Callable[[ReadableSpan], bool]) -> None:
    assert export_filter(_span(LANGFUSE_SCOPE))


def test_drops_provider_sdk_llm_spans(export_filter: Callable[[ReadableSpan], bool]) -> None:
    assert not export_filter(_span(PROVIDER_SDK_SCOPE))
