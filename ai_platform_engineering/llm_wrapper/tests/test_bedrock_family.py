"""Behaviour must match cnoe_agent_utils 0.5.0 exactly (spec FR-014, A-006)."""

from __future__ import annotations

import pytest

from ai_platform_engineering.llm_wrapper.bedrock_family import (
    BEDROCK_FAMILY_TO_PROVIDER,
    resolve_bedrock_client,
    uses_anthropic_bedrock_client,
)


@pytest.fixture(autouse=True)
def _clear_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AWS_BEDROCK_CLIENT", raising=False)


@pytest.mark.parametrize(
    "model_id",
    [
        "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
        "anthropic.claude-3-5-haiku-20241022-v1:0",
        "US.ANTHROPIC.CLAUDE-OPUS",  # case-insensitive
    ],
)
def test_anthropic_model_ids_use_the_anthropic_client(model_id: str) -> None:
    assert resolve_bedrock_client(model_id) == "anthropic"
    assert uses_anthropic_bedrock_client(model_id) is True


def test_non_anthropic_defaults_to_legacy_without_cache() -> None:
    assert resolve_bedrock_client("us.amazon.nova-pro-v1:0") == "legacy"


def test_non_anthropic_uses_converse_when_cache_wanted() -> None:
    assert resolve_bedrock_client("us.amazon.nova-pro-v1:0", enable_cache=True) == "converse"


def test_cache_flag_does_not_override_anthropic() -> None:
    assert resolve_bedrock_client("anthropic.claude-v2", enable_cache=True) == "anthropic"


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        ("anthropic", "anthropic"),
        ("anthropic-bedrock", "anthropic"),
        ("chatanthropicbedrock", "anthropic"),
        ("converse", "converse"),
        ("bedrock-converse", "converse"),
        ("legacy", "legacy"),
        ("bedrock", "legacy"),
        ("chatbedrock", "legacy"),
        ("  CONVERSE  ", "converse"),  # trimmed and lowercased
    ],
)
def test_env_override_forces_family(
    monkeypatch: pytest.MonkeyPatch, configured: str, expected: str
) -> None:
    monkeypatch.setenv("AWS_BEDROCK_CLIENT", configured)
    # Override wins even when the model id says otherwise.
    assert resolve_bedrock_client("anthropic.claude-v2") == expected


def test_auto_defers_to_model_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_BEDROCK_CLIENT", "auto")
    assert resolve_bedrock_client("anthropic.claude-v2") == "anthropic"
    assert resolve_bedrock_client("amazon.titan") == "legacy"


def test_unknown_override_raises_and_names_the_allowed_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AWS_BEDROCK_CLIENT", "nonsense")
    with pytest.raises(ValueError, match="Unsupported AWS_BEDROCK_CLIENT"):
        resolve_bedrock_client("anthropic.claude-v2")


def test_every_family_maps_to_a_langchain_provider() -> None:
    assert BEDROCK_FAMILY_TO_PROVIDER == {
        "anthropic": "anthropic_bedrock",
        "converse": "bedrock_converse",
        "legacy": "bedrock",
    }
