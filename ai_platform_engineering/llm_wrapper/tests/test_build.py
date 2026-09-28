"""`build_chat_model` maps configuration onto init_chat_model correctly."""

from __future__ import annotations

from typing import Any

import pytest
from botocore.exceptions import ClientError

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


AIP_MODEL_ID = "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123"


def _access_denied_error() -> ClientError:
    return ClientError(
        error_response={"Error": {"Code": "AccessDeniedException", "Message": "denied"}},
        operation_name="GetInferenceProfile",
    )


class TestBedrockBaseModelId:
    """AWS_BEDROCK_BASE_MODEL_ID and the GetInferenceProfile fallback.

    Covers both IAM-gated clients: ChatBedrockConverse (enable_cache=True,
    non-Anthropic model id) and legacy ChatBedrock (enable_cache=False).
    ChatAnthropicBedrock is excluded deliberately - resolve_bedrock_client
    only selects it when the model id string contains "anthropic", which an
    ARN never does, so it can never receive one.
    """

    @pytest.mark.parametrize("enable_cache", [True, False], ids=["converse", "legacy"])
    def test_base_model_id_env_var_passes_through_for_an_aip_arn(
        self, captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch, enable_cache: bool
    ) -> None:
        monkeypatch.setenv("AWS_BEDROCK_BASE_MODEL_ID", "anthropic.claude-sonnet-4-5-v1:0")
        build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=enable_cache)
        assert captured["kwargs"]["base_model_id"] == "anthropic.claude-sonnet-4-5-v1:0"

    @pytest.mark.parametrize("enable_cache", [True, False], ids=["converse", "legacy"])
    def test_base_model_id_env_var_ignored_for_a_plain_model_id(
        self, captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch, enable_cache: bool
    ) -> None:
        # A global override meant for some other agent's AIP ARN must not
        # leak onto an agent whose model id needs no resolving.
        monkeypatch.setenv("AWS_BEDROCK_BASE_MODEL_ID", "amazon.nova-pro-v1:0")
        build_chat_model("aws-bedrock", "us.amazon.nova-pro-v1:0", enable_cache=enable_cache)
        assert "base_model_id" not in captured["kwargs"]

    def test_explicit_base_model_id_kwarg_is_not_overridden(
        self, captured: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AWS_BEDROCK_BASE_MODEL_ID", "from-env-var")
        build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=True, base_model_id="from-caller")
        assert captured["kwargs"]["base_model_id"] == "from-caller"

    @pytest.mark.parametrize("enable_cache", [True, False], ids=["converse", "legacy"])
    def test_retries_with_unresolved_base_model_id_on_access_denied(
        self, monkeypatch: pytest.MonkeyPatch, enable_cache: bool
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
        llm = build_chat_model("aws-bedrock", AIP_MODEL_ID, enable_cache=enable_cache)

        assert llm == "chat-model"
        assert len(calls) == 2
        assert "base_model_id" not in calls[0]
        assert calls[1]["base_model_id"] == build_mod._UNRESOLVED_BASE_MODEL_ID

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

    @pytest.mark.parametrize("enable_cache", [True, False], ids=["converse", "legacy"])
    def test_non_aip_model_id_never_retries(
        self, monkeypatch: pytest.MonkeyPatch, enable_cache: bool
    ) -> None:
        # Non-Anthropic model id, but not an application-inference-profile
        # ARN - exercises the ARN-substring guard specifically, distinct from
        # the provider-family guard.
        monkeypatch.delenv("AWS_BEDROCK_BASE_MODEL_ID", raising=False)
        monkeypatch.delenv("AWS_BEDROCK_CLIENT", raising=False)
        calls: list[dict[str, Any]] = []

        def _fake(model: str, model_provider: str, **kwargs: Any) -> str:
            calls.append(kwargs)
            raise _access_denied_error()

        monkeypatch.setattr(build_mod, "init_chat_model", _fake)
        with pytest.raises(ClientError):
            build_chat_model("aws-bedrock", "us.amazon.nova-pro-v1:0", enable_cache=enable_cache)
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


# ── reasoning effort ────────────────────────────────────────────────────────
# LangChain does not normalize this. ChatOpenAI takes `reasoning_effort`
# natively; ChatAnthropic does not, and silently forwards it into
# `model_kwargs` where thinking is never enabled. These pin the translation.


def test_openai_keeps_native_reasoning_effort(captured: dict[str, Any]) -> None:
    build_chat_model("openai", "gpt-5", reasoning_effort="high")
    assert captured["kwargs"]["reasoning_effort"] == "high"
    assert "thinking" not in captured["kwargs"]


def test_anthropic_translates_effort_to_a_thinking_budget(captured: dict[str, Any]) -> None:
    build_chat_model("anthropic-claude", "claude-sonnet-4-5", reasoning_effort="high")
    kwargs = captured["kwargs"]
    assert kwargs["thinking"] == {"type": "enabled", "budget_tokens": 8192}
    # Never forwarded raw: LangChain would bury it in model_kwargs.
    assert "reasoning_effort" not in kwargs


def test_anthropic_derives_max_tokens_above_the_budget(captured: dict[str, Any]) -> None:
    # Anthropic rejects max_tokens <= budget_tokens. Without an explicit
    # max_tokens the chat model's own default can sit at or below the budget.
    build_chat_model("anthropic-claude", "claude-sonnet-4-5", reasoning_effort="max")
    kwargs = captured["kwargs"]
    assert kwargs["max_tokens"] > kwargs["thinking"]["budget_tokens"]


def test_caller_max_tokens_clamps_the_budget(captured: dict[str, Any]) -> None:
    build_chat_model(
        "anthropic-claude", "claude-sonnet-4-5", reasoning_effort="max", max_tokens=6000
    )
    kwargs = captured["kwargs"]
    assert kwargs["max_tokens"] == 6000
    assert kwargs["thinking"]["budget_tokens"] <= 6000 - 4096


def test_tiny_max_tokens_falls_back_to_the_minimum_budget(captured: dict[str, Any]) -> None:
    build_chat_model(
        "anthropic-claude", "claude-sonnet-4-5", reasoning_effort="max", max_tokens=100
    )
    assert captured["kwargs"]["thinking"]["budget_tokens"] == 1024


def test_bedrock_anthropic_also_gets_a_thinking_budget(captured: dict[str, Any]) -> None:
    build_chat_model("aws-bedrock", "anthropic.claude-v2", reasoning_effort="low")
    assert captured["kwargs"]["thinking"]["budget_tokens"] == 1024
    # Anthropic accepts only its default temperature while thinking is enabled.
    assert captured["kwargs"]["temperature"] == 1.0


def test_gemini_uses_its_own_lower_ceiling(captured: dict[str, Any]) -> None:
    build_chat_model("google-gemini", "gemini-2.5-pro", reasoning_effort="high")
    assert captured["kwargs"]["thinking_budget"] == 24576
    assert "thinking" not in captured["kwargs"]


def test_no_effort_leaves_kwargs_untouched(captured: dict[str, Any]) -> None:
    build_chat_model("anthropic-claude", "claude-sonnet-4-5")
    assert "thinking" not in captured["kwargs"]
    assert "max_tokens" not in captured["kwargs"]
