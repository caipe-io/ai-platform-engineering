from langchain.agents.middleware.context_editing import ContextEditingMiddleware
from langchain.agents.middleware.model_retry import ModelRetryMiddleware

from dynamic_agents.services.context_usage import ContextUsageMiddleware
from dynamic_agents.services.middleware import (
    InterruptAwareToolRetryMiddleware,
    ToolResultInvariantMiddleware,
    build_middleware,
    get_default_middleware_entries,
    get_middleware_definitions,
)


def test_default_middleware_entries_enable_context_editing_and_raise_model_errors():
    entries = {entry["type"]: entry for entry in get_default_middleware_entries()}

    assert entries["model_retry"]["params"]["on_failure"] == "error"
    assert entries["tool_retry"]["params"]["on_failure"] == "continue"
    assert entries["context_editing"]["enabled"] is True
    assert entries["context_editing"]["params"] == {"trigger": 100_000, "keep": 3}


def test_middleware_definitions_mark_context_editing_enabled_by_default():
    definitions = {definition["key"]: definition for definition in get_middleware_definitions()}

    assert definitions["model_retry"]["default_params"]["on_failure"] == "error"
    assert definitions["context_editing"]["enabled_by_default"] is True


def test_build_middleware_uses_context_editing_guardrail_by_default():
    stack = build_middleware(None, agent_name="test-agent", model_id="test-model")

    model_retry = next(middleware for middleware in stack if isinstance(middleware, ModelRetryMiddleware))
    tool_retry = next(
        middleware for middleware in stack if isinstance(middleware, InterruptAwareToolRetryMiddleware)
    )
    context_editing = next(middleware for middleware in stack if isinstance(middleware, ContextEditingMiddleware))

    assert model_retry.on_failure == "error"
    assert tool_retry.max_retries == 3
    assert context_editing.edits[0].trigger == 100_000
    assert context_editing.edits[0].keep == 3
    assert any(isinstance(middleware, ToolResultInvariantMiddleware) for middleware in stack)
    assert any(isinstance(middleware, ContextUsageMiddleware) for middleware in stack)
