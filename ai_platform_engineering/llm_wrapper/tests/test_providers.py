"""The public provider strings are a compatibility surface (spec FR-006)."""

from __future__ import annotations

import pytest

from ai_platform_engineering.llm_wrapper.providers import (
    BEDROCK,
    OPENAI_COMPATIBLE,
    PROVIDERS,
    is_bedrock,
    model_env_var,
    normalize,
    resolve_model_id,
    supported_providers,
)

#: The strings stored in agent records and rendered in the admin UI. Changing
#: any of these breaks existing agents, so the set is asserted, not sampled.
UI_PROVIDER_STRINGS = {
    "openai",
    "azure-openai",
    "anthropic-claude",
    "google-gemini",
    "gcp-vertexai",
    "groq",
    "aws-bedrock",
}


def test_every_ui_provider_string_is_supported() -> None:
    assert UI_PROVIDER_STRINGS <= supported_providers()


def test_model_env_vars_match_the_documented_contract() -> None:
    # These names are the deployment contract; renaming one is a breaking change.
    assert model_env_var("aws-bedrock") == "AWS_BEDROCK_MODEL_ID"
    assert model_env_var("openai") == "OPENAI_MODEL_NAME"
    assert model_env_var("azure-openai") == "AZURE_OPENAI_DEPLOYMENT"
    assert model_env_var("anthropic-claude") == "ANTHROPIC_MODEL_NAME"
    assert model_env_var("google-gemini") == "GOOGLE_GEMINI_MODEL_NAME"
    assert model_env_var("gcp-vertexai") == "VERTEXAI_MODEL_NAME"
    assert model_env_var("groq") == "GROQ_MODEL_NAME"


@pytest.mark.parametrize(
    ("given", "expected"),
    [("AWS-BEDROCK", "aws-bedrock"), ("aws_bedrock", "aws-bedrock"), ("  openai ", "openai")],
)
def test_normalize_accepts_case_and_underscore_variants(given: str, expected: str) -> None:
    assert normalize(given) == expected


def test_is_bedrock_accepts_both_spellings() -> None:
    assert is_bedrock("aws-bedrock")
    assert is_bedrock("bedrock")
    assert is_bedrock("AWS_BEDROCK")
    assert not is_bedrock("openai")


def test_explicit_model_wins_over_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_MODEL_NAME", "from-env")
    assert resolve_model_id("openai", "explicit") == "explicit"


def test_environment_used_when_no_explicit_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_BEDROCK_MODEL_ID", "us.amazon.nova-pro-v1:0")
    assert resolve_model_id("aws-bedrock", None) == "us.amazon.nova-pro-v1:0"


def test_gemini_falls_back_to_its_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GOOGLE_GEMINI_MODEL_NAME", raising=False)
    assert resolve_model_id("google-gemini", None) == "gemini-2.0-flash"


def test_providers_without_a_default_return_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_MODEL_NAME", raising=False)
    assert resolve_model_id("openai", None) is None


def test_unknown_provider_resolves_to_none(monkeypatch: pytest.MonkeyPatch) -> None:
    assert resolve_model_id("does-not-exist", None) is None


def test_openai_compatible_is_present_and_maps_to_openai() -> None:
    # Required, not optional: a sandboxed runtime cannot hold raw provider
    # credentials, so this is a precondition for sandboxed execution (FR-021).
    assert OPENAI_COMPATIBLE in PROVIDERS
    assert PROVIDERS[OPENAI_COMPATIBLE].langchain_provider == "openai"


def test_litellm_is_available_as_an_opt_in_provider() -> None:
    # Present in the map, but `langchain-litellm` is not a default dependency.
    assert PROVIDERS["litellm"].langchain_provider == "litellm"


def test_bedrock_is_not_in_the_static_map() -> None:
    # It resolves per-model to one of three client families instead.
    assert BEDROCK not in PROVIDERS
