from collections.abc import AsyncIterator

import pytest
from agent_telemetry import scope as scope_module
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from harness_engine.config import Settings
from harness_engine.main import create_app
from harness_engine.models import CanonicalEventDraft, RunContext
from tests.conftest import FakeHarnessAdapter, auth_headers, blueprint
from tests.test_execution_lifecycle import wait_for_run


class ToolAdapter(FakeHarnessAdapter):
    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft]:
        yield CanonicalEventDraft(event_type='tool.started', data={
            'tool_call_id': 'tool-primary', 'tool_name': 'lookup', 'args': {'secret': 'private-input'},
        })
        yield CanonicalEventDraft(event_type='tool.completed', data={
            'tool_call_id': 'tool-primary', 'result': 'private-result',
        })


def test_detached_run_exports_once_even_when_admission_is_retried(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(scope_module, '_provider', lambda: provider)
    app = create_app(settings=settings, adapters=[ToolAdapter()])
    try:
        with TestClient(app) as client:
            assert client.put('/api/v1/agents/agent-example', headers=auth_headers(), json={'blueprint': blueprint()}).status_code == 200
            request = {'agent_id': 'agent-example', 'conversation_id': 'conversation-example',
                       'message': 'private-prompt', 'client_request_id': 'request-example'}
            run = client.post('/api/v1/runs', headers=auth_headers(), json=request).json()['data']
            assert wait_for_run(client, run['run_id'])['status'] == 'completed'
            retry = client.post('/api/v1/runs', headers=auth_headers(), json=request).json()['data']
            assert retry['run_id'] == run['run_id']
        spans = exporter.get_finished_spans()
        assert [s.name for s in spans].count('session.end') == 1
        assert any(s.name == 'lookup.tool' for s in spans)
        assert {s.attributes['session.id'] for s in spans} == {run['run_id']}
        assert not any('private-' in str(s.attributes) for s in spans)
    finally:
        provider.shutdown()
