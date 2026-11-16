import sys
from types import SimpleNamespace
from uuid import uuid4

import pytest
from agent_telemetry import scope as scope_module
from agent_telemetry.scope import scope_session
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from dynamic_agents.services.scope_tracing import ScopeCallbackHandler
from dynamic_agents.services.tracing import TracingManager


@pytest.mark.parametrize('langfuse_enabled,scope_enabled', [(False, False), (True, False), (False, True), (True, True)])
def test_backends_are_independently_optional(monkeypatch: pytest.MonkeyPatch, langfuse_enabled: bool, scope_enabled: bool) -> None:
    monkeypatch.setenv('ENABLE_TRACING', str(langfuse_enabled))
    monkeypatch.setenv('LANGFUSE_PUBLIC_KEY', 'public-example')
    monkeypatch.setenv('LANGFUSE_SECRET_KEY', 'secret-example')
    langfuse_handler = object()
    monkeypatch.setitem(sys.modules, 'langfuse', SimpleNamespace(get_client=lambda: object()))
    monkeypatch.setitem(sys.modules, 'langfuse.langchain', SimpleNamespace(CallbackHandler=lambda: langfuse_handler))
    monkeypatch.setattr(TracingManager, '_instance', None)
    monkeypatch.setattr(TracingManager, '_initialized', False)
    provider = TracerProvider() if scope_enabled else None
    monkeypatch.setattr(scope_module, '_provider', lambda: provider)
    try:
        manager = TracingManager()
        with scope_session('primary', 'conversation-primary'):
            config = manager.create_config('thread-primary')
            callbacks = config.get('callbacks', [])
            assert (langfuse_handler in callbacks) is langfuse_enabled
            assert any(isinstance(c, ScopeCallbackHandler) for c in callbacks) is scope_enabled
            assert config['configurable']['thread_id'] == 'thread-primary'
        assert manager.is_enabled is langfuse_enabled
    finally:
        if provider:
            provider.shutdown()


def test_scope_callbacks_capture_usage_without_content(monkeypatch: pytest.MonkeyPatch) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(scope_module, '_provider', lambda: provider)
    handler = ScopeCallbackHandler()
    model_run, tool_run = uuid4(), uuid4()
    try:
        with scope_session('primary', 'conversation-primary'):
            handler.on_chat_model_start({}, 'private-prompt', run_id=model_run, invocation_params={'model': 'model-primary'})
            handler.on_llm_end(SimpleNamespace(llm_output={'token_usage': {'prompt_tokens': 3, 'completion_tokens': 2}}, generations=[]), run_id=model_run)
            handler.on_tool_start({'name': 'lookup'}, 'private-input', run_id=tool_run)
            handler.on_tool_error(ValueError('private-error'), run_id=tool_run)
        spans = exporter.get_finished_spans()
        model = next(s for s in spans if s.name == 'model-primary.chat')
        assert model.attributes['gen_ai.usage.input_tokens'] == 3
        assert model.attributes['gen_ai.usage.output_tokens'] == 2
        tool = next(s for s in spans if s.name == 'lookup.tool')
        assert tool.attributes['execution.success'] is False
        assert not any('private-' in str(s.attributes) for s in spans)
    finally:
        provider.shutdown()


def test_scope_without_langfuse_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('ENABLE_TRACING', 'true')
    monkeypatch.delenv('LANGFUSE_PUBLIC_KEY', raising=False)
    monkeypatch.delenv('LANGFUSE_SECRET_KEY', raising=False)
    monkeypatch.setattr(TracingManager, '_instance', None)
    monkeypatch.setattr(TracingManager, '_initialized', False)
    provider = TracerProvider()
    monkeypatch.setattr(scope_module, '_provider', lambda: provider)
    try:
        with scope_session('primary', 'conversation-primary'):
            manager = TracingManager()
            assert not manager.is_enabled
            assert isinstance(manager.create_config('thread-primary')['callbacks'][0], ScopeCallbackHandler)
    finally:
        provider.shutdown()
