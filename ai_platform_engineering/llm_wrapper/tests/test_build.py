"""`build_chat_model` maps configuration onto init_chat_model correctly."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

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
    """AWS_BEDROCK_BASE_MODEL_ID and the GetInferenceProfile fallback (converse only)."""

    def test_base_model_id_env_var_passes_through_for_converse(
        self, captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AWS_BEDROCK_BASE_MODEL_ID", "anthropic.claude-sonnet-4-5-v1:0")
        build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=True)
        assert captured["kwargs"]["base_model_id"] == "anthropic.claude-sonnet-4-5-v1:0"

    def test_base_model_id_env_var_ignored_for_legacy_client(
        self, captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AWS_BEDROCK_BASE_MODEL_ID", "amazon.nova-pro-v1:0")
        build_chat_model("aws-bedrock", "us.amazon.nova-pro-v1:0", enable_cache=False)
        assert "base_model_id" not in captured["kwargs"]

    def test_explicit_base_model_id_kwarg_is_not_overridden(
        self, captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AWS_BEDROCK_BASE_MODEL_ID", "from-env-var")
        build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=True, base_model_id="from-caller")
        assert captured["kwargs"]["base_model_id"] == "from-caller"

    def test_retries_with_empty_base_model_id_on_access_denied(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("AWS_BEDROCK_BASE_MODEL_ID", raising=False)
        monkeypatch.delenv("AWS_BEDROCK_CLIENT", raising=False)
        calls: list[dict[str, Any]] = []

        def _fake(model: str, model_provider: str, **kwargs: Any) -> str:
            calls.append(kwargs)
            if len(calls) == 1:
                raise _access_denied_error()
            return "chat-model"

        monkeypatch.setattr(build_mod, "init_chat_model", _fake)
        llm = build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=True)

        assert llm == "chat-model"
        assert len(calls) == 2
        assert "base_model_id" not in calls[0]
        assert calls[1]["base_model_id"] == ""

    def test_non_access_denied_client_error_propagates(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("AWS_BEDROCK_BASE_MODEL_ID", raising=False)
        monkeypatch.delenv("AWS_BEDROCK_CLIENT", raising=False)
        throttling_error = ClientError(
            error_response={"Error": {"Code": "ThrottlingException", "Message": "slow down"}},
            operation_name="GetInferenceProfile",
        )

        def _fake(model: str, model_provider: str, **kwargs: Any) -> str:
            raise throttling_error

        monkeypatch.setattr(build_mod, "init_chat_model", _fake)
        with pytest.raises(ClientError) as exc_info:
            build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=True)
        assert exc_info.value.response["Error"]["Code"] == "ThrottlingException"

    def test_non_aip_model_id_never_retries(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Converse family (non-Anthropic model id, caching on), but not an
        # application-inference-profile ARN - exercises the ARN-substring
        # guard specifically, distinct from the provider-family guard.
        monkeypatch.delenv("AWS_BEDROCK_BASE_MODEL_ID", raising=False)
        monkeypatch.delenv("AWS_BEDROCK_CLIENT", raising=False)
        calls: list[dict[str, Any]] = []

        def _fake(model: str, model_provider: str, **kwargs: Any) -> str:
            calls.append(kwargs)
            raise _access_denied_error()

        monkeypatch.setattr(build_mod, "init_chat_model", _fake)
        with pytest.raises(ClientError):
            build_chat_model("aws-bedrock", "us.amazon.nova-pro-v1:0", enable_cache=True)
        assert len(calls) == 1


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
