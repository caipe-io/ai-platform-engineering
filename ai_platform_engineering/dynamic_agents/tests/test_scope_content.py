"""Unit checks for capture policy and wire fields; no spans leave the process."""

from types import SimpleNamespace
from uuid import uuid4

import pytest
from agent_telemetry import scope as scope_module
from agent_telemetry.scope import scope_session
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from dynamic_agents.services.scope_content import entity_attributes, message_attributes
from dynamic_agents.services.scope_tracing import ScopeCallbackHandler


@pytest.mark.parametrize('enabled,allowed,expected', [
    ('false', 'primary', False), ('true', '', False), ('true', '*', False),
    ('true', 'secondary', False), ('true', 'secondary, primary', True),
])
def test_capture_requires_opt_in_and_exact_root_selection(
    monkeypatch: pytest.MonkeyPatch, enabled: str, allowed: str, expected: bool,
) -> None:
    monkeypatch.setenv('SCOPE_CONTENT_CAPTURE_ENABLED', enabled)
    monkeypatch.setenv('SCOPE_CONTENT_CAPTURE_AGENT_IDS', allowed)
    monkeypatch.delenv('SCOPE_PROTOCOL_EVIDENCE_ENABLED', raising=False)
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(scope_module, '_provider', lambda: provider)
    try:
        for agent in ['primary', 'unselected']:
            handler = ScopeCallbackHandler()
            delegate, model, lookup = uuid4(), uuid4(), uuid4()
            with scope_session(agent, f'conversation-{agent}'):
                handler.on_tool_start({'name': 'task'}, '', run_id=delegate,
                                      inputs={'subagent_type': 'specialist', 'description': 'private-task'})
                handler.on_chat_model_start({}, [[SystemMessage(content='private-system'), HumanMessage(content='private-user')]],
                                            run_id=model, parent_run_id=delegate)
                handler.on_tool_start({'name': 'lookup'}, '', run_id=lookup, parent_run_id=delegate,
                                      inputs={'query': 'private-query'})
                handler.on_tool_end(ToolMessage(content='private-result', tool_call_id='example'), run_id=lookup)
                handler.on_llm_end(SimpleNamespace(llm_output={}, generations=[[
                    SimpleNamespace(message=AIMessage(content='private-answer')),
                ]]), run_id=model)
                handler.on_tool_end('private-delegate-result', run_id=delegate)
            spans = [s for s in exporter.get_finished_spans() if s.attributes['conversation.id'] == f'conversation-{agent}']
            captured = expected and agent == 'primary'
            assert any('private-' in str(s.attributes) for s in spans) is captured
            if captured:
                chat = next(s for s in spans if s.name.endswith('.chat'))
                tool = next(s for s in spans if s.name == 'lookup.tool')
                delegated = next(s for s in spans if s.name == 'specialist.agent')
                assert chat.attributes['gen_ai.prompt.1.content'] == 'private-user'
                assert chat.attributes['gen_ai.completion.0.content'] == 'private-answer'
                assert tool.attributes['traceloop.entity.input'] == '{"query": "private-query"}'
                assert tool.attributes['traceloop.entity.output'] == 'private-result'
                assert delegated.attributes['ioa_observe.entity.output'] == 'private-delegate-result'
                assert chat.parent.span_id == delegated.context.span_id
    finally:
        provider.shutdown()


def test_capture_selects_visible_blocks_and_preserves_actual_tool_calls() -> None:
    message = AIMessage(content=[
        {'type': 'text', 'text': 'visible answer'},
        {'type': 'thinking', 'thinking': 'excluded reasoning'},
        {'type': 'image_url', 'image_url': {'url': 'excluded image'}},
    ], tool_calls=[{'name': 'lookup', 'args': {'query': 'example'}, 'id': 'call-example'}])
    attrs = message_attributes([message], 'gen_ai.completion')
    assert 'visible answer' in attrs['gen_ai.completion.0.content']
    assert 'lookup' in attrs['gen_ai.completion.0.content']
    assert 'excluded' not in str(attrs)


def test_capture_limits_and_truncation_are_explicit() -> None:
    messages = [HumanMessage(content='x' * 40000) for _ in range(40)]
    attrs = message_attributes(messages, 'gen_ai.prompt')
    assert attrs['scope.content.prompt_truncated'] is True
    assert sum(len(v) for k, v in attrs.items() if k.endswith('.content')) <= 131072
    assert all(len(v) <= 32768 for k, v in attrs.items() if k.endswith('.content'))
    output = entity_attributes('x' * 20000, 'output')
    assert output['scope.content.output_truncated'] is True
    assert len(output['traceloop.entity.output']) == 16384


def test_long_system_instructions_and_initial_user_request_are_retained() -> None:
    system = 'instruction\n' * 2000
    messages = [SystemMessage(content=system), HumanMessage(content='original request')]
    messages += [ToolMessage(content='observation', tool_call_id=str(i)) for i in range(35)]
    attrs = message_attributes(messages, 'gen_ai.prompt')
    assert attrs['gen_ai.prompt.0.content'] == system
    assert attrs['gen_ai.prompt.1.content'] == 'original request'
    assert attrs['scope.content.prompt_truncated'] is True


def test_canonical_tools_are_not_duplicated_or_captured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('SCOPE_CONTENT_CAPTURE_ENABLED', 'true')
    monkeypatch.setenv('SCOPE_CONTENT_CAPTURE_AGENT_IDS', 'primary')
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(scope_module, '_provider', lambda: provider)
    handler = ScopeCallbackHandler()
    try:
        with scope_session('primary', 'example', canonical_tools=True):
            tool = uuid4()
            handler.on_tool_start({'name': 'lookup'}, 'private-input', run_id=tool)
            handler.on_tool_end('private-result', run_id=tool)
        assert not any(s.name.endswith('.tool') for s in exporter.get_finished_spans())
        assert not handler._content_runs
    finally:
        provider.shutdown()
