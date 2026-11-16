import json
import sys
from types import SimpleNamespace
from uuid import uuid4

import pytest
from agent_telemetry import scope as scope_module
from agent_telemetry.scope import scope_session
from deepagents import create_deep_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
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


def test_delegates_keep_separate_model_and_tool_ownership(monkeypatch: pytest.MonkeyPatch) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(scope_module, '_provider', lambda: provider)
    handler = ScopeCallbackHandler()
    first, second, chain, model, tool = (uuid4() for _ in range(5))
    try:
        with scope_session('primary', 'conversation-primary', 'run-primary'):
            for run_id, name in [(first, 'specialist-primary'), (second, 'specialist-secondary')]:
                handler.on_tool_start({'name': 'task'}, json.dumps({
                    'subagent_type': name, 'description': 'private-delegation-prompt',
                }), run_id=run_id)
            handler.on_chain_start(None, 'private-chain-input', run_id=chain, parent_run_id=first)
            handler.on_chat_model_start({}, 'private-prompt', run_id=model, parent_run_id=chain,
                                        invocation_params={'model': 'model-primary'})
            handler.on_tool_start({'name': 'lookup'}, 'private-tool-input', run_id=tool, parent_run_id=second)
            handler.on_llm_end(SimpleNamespace(llm_output={}, generations=[]), run_id=model)
            handler.on_tool_end('private-output', run_id=tool)
            handler.on_tool_end('private-delegate-output', run_id=first)
            handler.on_tool_end('private-delegate-output', run_id=second)
        spans = {s.name: s for s in exporter.get_finished_spans()}
        root = spans['primary.agent']
        first_agent, second_agent = spans['specialist-primary.agent'], spans['specialist-secondary.agent']
        assert first_agent.parent.span_id == root.context.span_id
        assert second_agent.parent.span_id == root.context.span_id
        for child, owner in [(spans['model-primary.chat'], first_agent), (spans['lookup.tool'], second_agent)]:
            assert child.parent.span_id == owner.context.span_id
            assert child.attributes['agent_id'] == owner.attributes['agent_id']
            assert child.attributes['ioa_observe.agent.span_id'] == format(owner.context.span_id, '016x')
        assert {s.attributes['session.id'] for s in spans.values()} == {'run-primary'}
        assert not any('private-' in str(s.attributes) for s in spans.values())
    finally:
        provider.shutdown()


@pytest.mark.asyncio
async def test_real_langchain_delegation_events_preserve_ownership(monkeypatch: pytest.MonkeyPatch) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(scope_module, '_provider', lambda: provider)
    handler = ScopeCallbackHandler()
    model = FakeMessagesListChatModel(responses=[AIMessage(content='private-result')])

    @tool
    async def task(description: str, subagent_type: str) -> str:
        """Execute the selected delegate."""
        result = await model.ainvoke(description)
        return str(result.content)

    try:
        with scope_session('primary', 'conversation-primary'):
            result = await task.ainvoke(
                {'description': 'private-prompt', 'subagent_type': 'specialist-primary'},
                config={'callbacks': [handler]},
            )
        assert result == 'private-result'
        spans = exporter.get_finished_spans()
        delegate = next(s for s in spans if s.name == 'specialist-primary.agent')
        chat = next(s for s in spans if s.name.endswith('.chat'))
        assert chat.parent.span_id == delegate.context.span_id
        assert chat.attributes['agent_id'] == 'specialist-primary'
        assert not any('private-' in str(s.attributes) for s in spans)
    finally:
        provider.shutdown()


@pytest.mark.asyncio
async def test_real_parallel_deep_agent_graph_attributes_both_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    class ToolCallingModel(FakeMessagesListChatModel):
        def bind_tools(self, tools: object, **kwargs: object) -> 'ToolCallingModel':
            return self

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(scope_module, '_provider', lambda: provider)
    names = ['specialist-primary', 'specialist-secondary']
    parent = ToolCallingModel(responses=[AIMessage(content='', tool_calls=[{
        'name': 'task', 'args': {'description': 'private-task', 'subagent_type': name}, 'id': f'call-{i}',
    } for i, name in enumerate(names)]), AIMessage(content='private-final')])
    graph = create_deep_agent(parent, subagents=[{
        'name': name, 'description': 'Example specialist', 'system_prompt': 'Return a short answer.',
        'model': ToolCallingModel(responses=[AIMessage(content='private-result')]), 'tools': [],
    } for name in names])
    try:
        with scope_session('primary', 'conversation-primary', 'run-primary'):
            await graph.ainvoke({'messages': [('user', 'private-query')]},
                               config={'callbacks': [ScopeCallbackHandler()]})
        spans = exporter.get_finished_spans()
        delegates = [s for s in spans if s.name in {f'{name}.agent' for name in names}]
        assert len(delegates) == 2
        for delegate in delegates:
            children = [s for s in spans if s.name.endswith('.chat') and s.parent.span_id == delegate.context.span_id]
            assert len(children) == 1
            assert children[0].attributes['agent_id'] == delegate.attributes['agent_id']
        assert not any('private-' in str(s.attributes) for s in spans)
    finally:
        provider.shutdown()


@pytest.mark.parametrize('enabled', [False, True])
def test_protocol_evidence_is_opt_in_and_excludes_content(monkeypatch: pytest.MonkeyPatch, enabled: bool) -> None:
    from langchain_core.messages import HumanMessage, SystemMessage

    monkeypatch.setenv('SCOPE_PROTOCOL_EVIDENCE_ENABLED', str(enabled).lower())
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(scope_module, '_provider', lambda: provider)
    handler = ScopeCallbackHandler()
    model_run, tool_run = uuid4(), uuid4()
    path = '/skills/hub-example/concord-initiator/SKILL.md'
    prompt = f'private-system\n- **concord-initiator**: private-description\n  -> Read `{path}` for full instructions'
    try:
        with scope_session('primary', 'example-conversation'):
            handler.on_chat_model_start({}, [[SystemMessage(content=prompt), HumanMessage(content='private-user')]], run_id=model_run)
            handler.on_llm_end(SimpleNamespace(llm_output={}, generations=[]), run_id=model_run)
            handler.on_tool_start({'name': 'read_file'}, 'private-input', run_id=tool_run,
                                  inputs={'file_path': path, 'other': 'private-secret'})
            handler.on_tool_end('private-result', run_id=tool_run)
        spans = exporter.get_finished_spans()
        model = next(s for s in spans if s.name.endswith('.chat'))
        tool_span = next(s for s in spans if s.name == 'read_file.tool')
        assert ('gen_ai.prompt.0.content' in model.attributes) is enabled
        assert ('ioa_observe.entity.input' in tool_span.attributes) is enabled
        if enabled:
            assert json.loads(tool_span.attributes['ioa_observe.entity.input']) == {'file_path': path}
            assert 'concord-initiator' in model.attributes['gen_ai.prompt.0.content']
        assert not any('private-' in str(s.attributes) for s in spans)
        assert handler._protocol_arguments('read_file', {'file_path': '/etc/private-file'}) == {}
        assert handler._protocol_arguments('lookup', {'name': 'concord-initiator'}) == {}
        assert handler._protocol_arguments('activate_skill', {'name': 'concord-initiator-private-token'}) == {}
    finally:
        provider.shutdown()
