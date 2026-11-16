import asyncio
from collections.abc import Iterator
from unittest.mock import Mock

import pytest
from agent_telemetry import scope as scope_module
from agent_telemetry.scope import current_scope_run, scope_session
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


@pytest.fixture
def capture(monkeypatch: pytest.MonkeyPatch) -> Iterator[InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(scope_module, '_provider', lambda: provider)
    yield exporter
    provider.shutdown()


def test_disabled_does_not_construct_exporter(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('SCOPE_TRACING_ENABLED', raising=False)
    exporter = Mock(side_effect=AssertionError('exporter must not be constructed'))
    monkeypatch.setattr(scope_module, 'OTLPSpanExporter', exporter)
    scope_module._provider.cache_clear()
    try:
        with scope_session('primary', 'conversation-primary') as run:
            assert run is None
        exporter.assert_not_called()
    finally:
        scope_module._provider.cache_clear()


@pytest.mark.parametrize('endpoint', ['', 'ftp://example.test', 'https://user:secret@example.test', 'http://[invalid'])
def test_bad_configuration_disables_only_scope(monkeypatch: pytest.MonkeyPatch, endpoint: str) -> None:
    monkeypatch.setenv('SCOPE_TRACING_ENABLED', 'true')
    monkeypatch.setenv('SCOPE_OTLP_ENDPOINT', endpoint)
    scope_module._provider.cache_clear()
    try:
        with scope_session('primary', 'conversation-primary') as run:
            assert run is None
    finally:
        scope_module._provider.cache_clear()


def test_session_tool_linkage_nested_deduplication_and_payload_exclusion(capture: InMemorySpanExporter) -> None:
    global_provider = trace.get_tracer_provider()
    with scope_session('primary', 'conversation-primary', 'run-primary') as run:
        with scope_session('primary', 'conversation-primary') as nested:
            assert nested is run
            run.event('tool.started', {'tool_call_id': 'tool-primary', 'tool_name': 'lookup', 'args': 'private-input'})
            run.event('tool.started', {'tool_call_id': 'tool-primary', 'tool_name': 'lookup'})
            run.event('tool.completed', {'tool_call_id': 'tool-primary', 'result': 'private-result'})
    spans = capture.get_finished_spans()
    assert [s.name for s in spans] == ['session.start', 'lookup.tool', 'primary.agent', 'session.end']
    agent = next(s for s in spans if s.name == 'primary.agent')
    tool = next(s for s in spans if s.name == 'lookup.tool')
    assert tool.parent.span_id == agent.context.span_id
    assert tool.attributes['ioa_observe.agent.span_id'] == format(agent.context.span_id, '016x')
    assert {s.attributes['session.id'] for s in spans} == {'run-primary'}
    assert not any('private-' in str(s.attributes) for s in spans)
    assert current_scope_run() is None
    assert trace.get_tracer_provider() is global_provider


@pytest.mark.parametrize('outcome,completion', [('paused', True), ('failed', True), ('unconfirmed', False)])
def test_outcomes_do_not_claim_unknown_remote_completion(capture: InMemorySpanExporter, outcome: str, completion: bool) -> None:
    with scope_session('primary', 'conversation-primary') as run:
        run.status = outcome
    spans = capture.get_finished_spans()
    assert ('session.end' in [s.name for s in spans]) is completion
    agent = next(s for s in spans if s.name == 'primary.agent')
    assert agent.attributes['execution.outcome'] == outcome
    assert agent.attributes['execution.success'] is (outcome == 'paused')


def test_cancellation_and_instrumentation_failure_preserve_original_exception(capture: InMemorySpanExporter, monkeypatch: pytest.MonkeyPatch) -> None:
    error = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError) as raised:
        with scope_session('primary', 'conversation-primary'):
            raise error
    assert raised.value is error
    assert capture.get_finished_spans()[-1].attributes['execution.outcome'] == 'cancelled'
    monkeypatch.setattr(scope_module.ScopeRun, 'finish', Mock(side_effect=RuntimeError('collector unavailable')))
    original = ValueError('private-error')
    with pytest.raises(ValueError) as raised:
        with scope_session('primary', 'conversation-primary'):
            raise original
    assert raised.value is original


@pytest.mark.asyncio
async def test_concurrent_sessions_are_isolated(capture: InMemorySpanExporter) -> None:
    async def execute(name: str) -> None:
        with scope_session('primary', 'conversation-primary', name):
            await asyncio.sleep(0)
            assert current_scope_run().attributes['session.id'] == name
    await asyncio.gather(execute('run-primary'), execute('run-secondary'))
    agents = [s for s in capture.get_finished_spans() if s.name == 'primary.agent']
    assert len({s.context.trace_id for s in agents}) == 2


def test_incoming_trace_context_is_continued(capture: InMemorySpanExporter) -> None:
    with scope_session('primary', 'conversation-primary', traceparent='00-' + '1' * 32 + '-' + '2' * 16 + '-01'):
        pass
    agent = next(s for s in capture.get_finished_spans() if s.name == 'primary.agent')
    assert agent.context.trace_id == int('1' * 32, 16)
    assert agent.parent.span_id == int('2' * 16, 16)


def test_scope_export_configuration_is_independent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('SCOPE_TRACING_ENABLED', 'true')
    monkeypatch.setenv('SCOPE_OTLP_ENDPOINT', 'http://collector.example.test:4318')
    monkeypatch.setenv('SCOPE_SERVICE_NAME', 'primary-runtime')
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://other.example.test')
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=private-token')
    exporter = Mock(return_value=InMemorySpanExporter())
    monkeypatch.setattr(scope_module, 'OTLPSpanExporter', exporter)
    scope_module._provider.cache_clear()
    try:
        provider = scope_module._provider()
        assert provider.resource.attributes['service.name'] == 'primary-runtime'
        exporter.assert_called_once_with(endpoint='http://collector.example.test:4318/v1/traces',
                                         headers={'User-Agent': 'agent-telemetry'}, timeout=3)
        provider.shutdown()
    finally:
        scope_module._provider.cache_clear()
