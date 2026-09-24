"""`build_chat_model` maps configuration onto init_chat_model correctly."""

from __future__ import annotations

from typing import Any

import pytest

from ai_platform_engineering.llm_wrapper import build as build_mod
from ai_platform_engineering.llm_wrapper.build import (
    LLMConfigError,
    build_chat_model,
    langchain_provider_for,
)


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Capture what would be passed to init_chat_model."""
    seen: dict[str, Any] = {}

    def _fake(model: str, model_provider: str, **kwargs: Any) -> str:
        seen.update(model=model, model_provider=model_provider, kwargs=kwargs)
        return "chat-model"

    monkeypatch.setattr(build_mod, "init_chat_model", _fake)
    monkeypatch.delenv("AWS_BEDROCK_CLIENT", raising=False)
    return seen


def test_bedrock_anthropic_model_selects_the_anthropic_client(captured: dict[str, Any]) -> None:
    build_chat_model("aws-bedrock", "us.anthropic.claude-3-7-sonnet-20250219-v1:0")
    assert captured["model_provider"] == "anthropic_bedrock"


def test_bedrock_non_anthropic_selects_legacy_without_cache(captured: dict[str, Any]) -> None:
    build_chat_model("aws-bedrock", "us.amazon.nova-pro-v1:0")
    assert captured["model_provider"] == "bedrock"


def test_bedrock_non_anthropic_selects_converse_with_cache(captured: dict[str, Any]) -> None:
    build_chat_model("aws-bedrock", "us.amazon.nova-pro-v1:0", enable_cache=True)
    assert captured["model_provider"] == "bedrock_converse"


@pytest.mark.parametrize(
    ("caipe_provider", "langchain_provider"),
    [
        ("openai", "openai"),
        ("azure-openai", "azure_openai"),
        ("anthropic-claude", "anthropic"),
        ("google-gemini", "google_genai"),
        ("gcp-vertexai", "google_vertexai"),
        ("groq", "groq"),
    ],
)
def test_provider_strings_map_to_langchain(
    captured: dict[str, Any], caipe_provider: str, langchain_provider: str
) -> None:
    build_chat_model(caipe_provider, "some-model")
    assert captured["model_provider"] == langchain_provider


def test_kwargs_pass_through_untouched(captured: dict[str, Any]) -> None:
    sentinel = object()
    build_chat_model("aws-bedrock", "anthropic.claude-v2", client=sentinel, temperature=1.0)
    assert captured["kwargs"]["client"] is sentinel
    assert captured["kwargs"]["temperature"] == 1.0


def test_openai_compatible_injects_base_url(
    captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_COMPATIBLE_BASE_URL", "http://gateway.internal:4000/v1")
    build_chat_model("openai-compatible", "some-model")
    assert captured["model_provider"] == "openai"
    assert captured["kwargs"]["base_url"] == "http://gateway.internal:4000/v1"


def test_openai_compatible_without_base_url_is_an_actionable_error(
    captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENAI_COMPATIBLE_BASE_URL", raising=False)
    with pytest.raises(LLMConfigError, match="OPENAI_COMPATIBLE_BASE_URL"):
        build_chat_model("openai-compatible", "some-model")


def test_missing_model_id_names_the_env_var(
    captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENAI_MODEL_NAME", raising=False)
    with pytest.raises(LLMConfigError, match="OPENAI_MODEL_NAME"):
        build_chat_model("openai", None)


def test_unknown_provider_lists_the_supported_ones(captured: dict[str, Any]) -> None:
    with pytest.raises(LLMConfigError, match="Unsupported LLM provider"):
        build_chat_model("not-a-provider", "m")


def test_missing_integration_package_is_actionable(monkeypatch: pytest.MonkeyPatch) -> None:
    # A single-provider image should explain itself rather than raise ImportError.
    def _boom(**_: Any) -> Any:
        raise ImportError("No module named 'langchain_groq'")

    monkeypatch.setattr(build_mod, "init_chat_model", _boom)
    with pytest.raises(LLMConfigError, match="not installed in this image"):
        build_chat_model("groq", "llama-3")


def test_provider_error_is_wrapped_with_context(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(**_: Any) -> Any:
        raise ValueError("bad credentials")

    monkeypatch.setattr(build_mod, "init_chat_model", _boom)
    with pytest.raises(LLMConfigError, match="provider='openai'"):
        build_chat_model("openai", "gpt-4o")


def test_langchain_provider_for_is_usable_without_building() -> None:
    assert langchain_provider_for("aws-bedrock", "anthropic.claude-v2") == "anthropic_bedrock"
