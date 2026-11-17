from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from langchain.agents.middleware.model_fallback import ModelFallbackMiddleware
from langchain.agents.middleware.tool_selection import LLMToolSelectorMiddleware
from langchain_core.language_models.fake_chat_models import FakeListChatModel

from dynamic_agents.models import FeaturesConfig, MiddlewareEntry
from dynamic_agents.services import middleware


@pytest.mark.parametrize("kind", ["llm_tool_selector", "model_fallback"])
@pytest.mark.parametrize("streaming", [None, False, True])
def test_saved_model_id_without_provider_uses_resolved_connection(
    kind: str, streaming: bool | None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = FakeListChatModel(responses=["example"])
    plan = SimpleNamespace(instantiate=Mock(return_value=model))
    deployment_factory = Mock(side_effect=AssertionError("Must use the saved connection"))
    monkeypatch.setattr(middleware, "get_configured_llm", deployment_factory)
    features = FeaturesConfig(middleware=[MiddlewareEntry(type=kind, params={"model_id": "saved-model"})])

    stack = middleware.build_middleware(
        features, model_streaming=streaming, resolved_models={"saved-model": plan},
    )

    if kind == "llm_tool_selector":
        selector = next(item for item in stack if isinstance(item, LLMToolSelectorMiddleware))
        assert selector.model is model
    else:
        fallback = next(item for item in stack if isinstance(item, ModelFallbackMiddleware))
        assert fallback.models == [model]
    plan.instantiate.assert_called_once_with(streaming=streaming)
    deployment_factory.assert_not_called()


@pytest.mark.parametrize("kind", ["llm_tool_selector", "model_fallback"])
def test_middleware_preserves_deployment_model_configuration(
    kind: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = FakeListChatModel(responses=["example"])
    deployment_factory = Mock(return_value=model)
    monkeypatch.setattr(middleware, "get_configured_llm", deployment_factory)
    features = FeaturesConfig(middleware=[MiddlewareEntry(
        type=kind, params={"model_id": "example-model", "model_provider": "openai"},
    )])

    stack = middleware.build_middleware(features, model_streaming=False)

    if kind == "llm_tool_selector":
        selector = next(item for item in stack if isinstance(item, LLMToolSelectorMiddleware))
        assert selector.model is model
    else:
        fallback = next(item for item in stack if isinstance(item, ModelFallbackMiddleware))
        assert fallback.models == [model]
    deployment_factory.assert_called_once_with(
        model_id="example-model", model_provider="openai", streaming=False,
    )


def test_unresolved_model_without_provider_preserves_optional_middleware_behavior() -> None:
    features = FeaturesConfig(middleware=[
        MiddlewareEntry(type=kind, params={"model_id": "example-model"})
        for kind in ("llm_tool_selector", "model_fallback")
    ])

    stack = middleware.build_middleware(features)

    selector = next(item for item in stack if isinstance(item, LLMToolSelectorMiddleware))
    assert selector.model is None
    assert not any(isinstance(item, ModelFallbackMiddleware) for item in stack)
