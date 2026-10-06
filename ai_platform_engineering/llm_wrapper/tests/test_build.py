"""`build_chat_model` maps configuration onto init_chat_model correctly."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from llm_wrapper import build as build_mod
from llm_wrapper.build import (
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
    build_chat_model("aws-bedrock", "us.amazon.nova-pro-v1:0", client=sentinel, temperature=1.0)
    assert captured["kwargs"]["client"] is sentinel
    assert captured["kwargs"]["temperature"] == 1.0


def test_anthropic_bedrock_uses_sdk_kwargs_instead_of_botocore_clients(captured: dict[str, Any]) -> None:
    build_chat_model(
        "aws-bedrock",
        "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
        client=object(),
        bedrock_client=object(),
        config=SimpleNamespace(read_timeout=300, connect_timeout=60),
        reasoning_effort="medium",
    )

    kwargs = captured["kwargs"]
    assert "client" not in kwargs
    assert "bedrock_client" not in kwargs
    assert "config" not in kwargs
    assert "reasoning_effort" not in kwargs
    assert kwargs["timeout"] == 300
    assert kwargs["thinking"] == {"type": "enabled", "budget_tokens": 4096}
    assert kwargs["max_tokens"] > kwargs["thinking"]["budget_tokens"]


def test_bedrock_converse_keeps_botocore_clients(captured: dict[str, Any]) -> None:
    client = object()
    config = object()
    build_chat_model("aws-bedrock", "us.amazon.nova-pro-v1:0", enable_cache=True, client=client, config=config)

    assert captured["model_provider"] == "bedrock_converse"
    assert captured["kwargs"]["client"] is client
    assert captured["kwargs"]["config"] is config


def test_sonnet_five_receives_adaptive_thinking(captured: dict[str, Any]) -> None:
    build_chat_model("aws-bedrock", "global.anthropic.claude-sonnet-5", reasoning_effort="high", temperature=1.0)
    assert captured["model_provider"] == "anthropic_bedrock"
    assert captured["kwargs"]["thinking"] == {"type": "adaptive"}
    assert captured["kwargs"]["output_config"] == {"effort": "high"}
    assert "temperature" not in captured["kwargs"]


def test_openai_compatible_injects_base_url(
    captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_COMPATIBLE_BASE_URL", "http://gateway.internal:4000/v1")
    build_chat_model("openai-compatible", "some-model")
    assert captured["model_provider"] == "openai"
    assert captured["kwargs"]["base_url"] == "http://gateway.internal:4000/v1"


def test_openai_uses_legacy_endpoint_without_overriding_explicit_base_url(
    captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_ENDPOINT", "https://openai.example.com/v1")
    build_chat_model("openai", "example-model")
    assert captured["kwargs"]["base_url"] == "https://openai.example.com/v1"

    build_chat_model("openai", "example-model", base_url="https://override.example.com/v1")
    assert captured["kwargs"]["base_url"] == "https://override.example.com/v1"


def test_azure_uses_legacy_provider_settings(captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_OPENAI_API_VERSION", "2025-03-01-preview")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://azure.example.com")
    monkeypatch.setenv("AZURE_OPENAI_USE_RESPONSES", "true")

    build_chat_model("azure-openai", "example-deployment")

    assert captured["kwargs"]["api_version"] == "2025-03-01-preview"
    assert captured["kwargs"]["azure_endpoint"] == "https://azure.example.com"
    assert captured["kwargs"]["use_responses_api"] is True


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


AIP_MODEL_ID = "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123"


def _access_denied_error() -> ClientError:
    return ClientError(
        error_response={"Error": {"Code": "AccessDeniedException", "Message": "denied"}},
        operation_name="GetInferenceProfile",
    )


class TestBedrockBaseModelId:
    """Resolve ARN metadata before native validation, without real AWS calls."""

    @pytest.mark.parametrize("enable_cache", [True, False], ids=["converse", "legacy"])
    def test_base_model_override_supplies_native_provider(
        self, captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch, enable_cache: bool
    ) -> None:
        monkeypatch.setenv("AWS_BEDROCK_BASE_MODEL_ID", "anthropic.claude-3-7-sonnet-20250219-v1:0")
        control = MagicMock()
        build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=enable_cache, bedrock_client=control)
        assert captured["kwargs"]["base_model_id"] == "anthropic.claude-3-7-sonnet-20250219-v1:0"
        assert captured["kwargs"]["provider"] == "anthropic"
        control.get_inference_profile.assert_not_called()

    @pytest.mark.parametrize("enable_cache", [True, False])
    def test_override_is_ignored_for_plain_models(
        self, captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch, enable_cache: bool
    ) -> None:
        monkeypatch.setenv("AWS_BEDROCK_BASE_MODEL_ID", "amazon.nova-pro-v1:0")
        build_chat_model("aws-bedrock", "us.amazon.nova-pro-v1:0", enable_cache=enable_cache)
        assert "base_model_id" not in captured["kwargs"]
        assert "provider" not in captured["kwargs"]

    @pytest.mark.parametrize("keyword", ["base_model_id", "base_model"])
    def test_explicit_base_model_wins(
        self, captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch, keyword: str
    ) -> None:
        monkeypatch.setenv("AWS_BEDROCK_BASE_MODEL_ID", "amazon.nova-pro-v1:0")
        build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=True, **{keyword: "global.anthropic.claude-haiku-4-5-20251001-v1:0"})
        assert captured["kwargs"]["base_model_id"].startswith("global.anthropic.")
        assert captured["kwargs"]["provider"] == "anthropic"

    @pytest.mark.parametrize("enable_cache", [True, False])
    def test_discovery_resolves_base_model_and_provider(
        self, captured: dict[str, Any], enable_cache: bool
    ) -> None:
        control = MagicMock()
        control.get_inference_profile.return_value = {"models": [{"modelArn": "arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0"}]}
        build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=enable_cache, bedrock_client=control)
        control.get_inference_profile.assert_called_once_with(inferenceProfileIdentifier=AIP_MODEL_ID)
        assert captured["kwargs"]["base_model_id"] == "amazon.nova-pro-v1:0"
        assert captured["kwargs"]["provider"] == "amazon"

    @pytest.mark.parametrize("enable_cache", [True, False])
    def test_denied_discovery_requires_actionable_base_override(
        self, captured: dict[str, Any], enable_cache: bool
    ) -> None:
        control = MagicMock()
        control.get_inference_profile.side_effect = _access_denied_error()
        with pytest.raises(LLMConfigError, match="AWS_BEDROCK_BASE_MODEL_ID"):
            build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=enable_cache, bedrock_client=control)
        assert captured == {}
        control.get_inference_profile.assert_called_once()

    def test_non_access_denied_error_propagates(self, captured: dict[str, Any]) -> None:
        control = MagicMock()
        control.get_inference_profile.side_effect = ClientError(
            {"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "GetInferenceProfile"
        )
        with pytest.raises(ClientError):
            build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=True, bedrock_client=control)
        assert captured == {}

    @pytest.mark.parametrize("response", [{}, {"models": []}, {"models": [{}]}])
    def test_empty_profile_is_actionable(self, captured: dict[str, Any], response: dict[str, Any]) -> None:
        control = MagicMock()
        control.get_inference_profile.return_value = response
        with pytest.raises(LLMConfigError, match="no foundation model"):
            build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=True, bedrock_client=control)

    def test_invalid_base_model_fails_before_construction(self, captured: dict[str, Any]) -> None:
        with pytest.raises(LLMConfigError, match="must identify a foundation model"):
            build_chat_model("aws-bedrock", AIP_MODEL_ID, base_model_id="unresolved")
        assert captured == {}


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


@pytest.mark.parametrize("provider,model", [("anthropic-claude", "claude-sonnet-4-5"), ("aws-bedrock", "anthropic.claude-3-7-sonnet-20250219-v1:0")])
@pytest.mark.parametrize("limit", [1, 512, 1024])
def test_invalid_thinking_limit_is_actionable(
    captured: dict[str, Any], provider: str, model: str, limit: int
) -> None:
    with pytest.raises(LLMConfigError, match="max_tokens > 1024"):
        build_chat_model(provider, model, reasoning_effort="high", max_tokens=limit)
    assert captured == {}
