"""Thinking limits respect explicit output caps and reject impossible budgets."""

from __future__ import annotations

import pytest

from llm_wrapper.reasoning import apply_reasoning_effort


@pytest.mark.parametrize("provider", ["anthropic", "anthropic_bedrock", "bedrock_converse", "bedrock"])
@pytest.mark.parametrize("limit", [1, 512, 1024])
def test_impossible_thinking_limit_is_rejected(provider: str, limit: int) -> None:
    with pytest.raises(ValueError, match="max_tokens > 1024"):
        apply_reasoning_effort(provider, "high", {"max_tokens": limit})


@pytest.mark.parametrize("provider", ["anthropic", "anthropic_bedrock", "bedrock_converse", "bedrock"])
@pytest.mark.parametrize("limit", [1025, 4096, 5120, 8192, None])
def test_valid_thinking_limit_exceeds_budget(provider: str, limit: int | None) -> None:
    result = apply_reasoning_effort(provider, "high", {"max_tokens": limit})
    assert result["max_tokens"] > result["thinking"]["budget_tokens"]
    if limit is not None:
        assert result["max_tokens"] == limit


@pytest.mark.parametrize("provider", ["anthropic", "anthropic_bedrock", "bedrock_converse", "bedrock"])
@pytest.mark.parametrize("model", ["claude-sonnet-5", "global.anthropic.claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-4-7"])
@pytest.mark.parametrize("effort", ["low", "medium", "high", "max"])
def test_adaptive_thinking_uses_effort_without_budgets_or_sampling(provider: str, model: str, effort: str) -> None:
    result = apply_reasoning_effort(
        provider, effort, {"temperature": 1.0, "top_p": 0.9, "top_k": 10, "max_tokens": 512},
        model_id=model,
    )
    payload = result
    if provider == "bedrock_converse":
        payload = result["additional_model_request_fields"]
    elif provider == "bedrock":
        payload = result["model_kwargs"]
    assert payload["thinking"] == {"type": "adaptive"}
    assert payload["output_config"] == {"effort": effort}
    assert result["max_tokens"] == 512
    assert not {"temperature", "top_p", "top_k", "reasoning_effort"} & result.keys()


@pytest.mark.parametrize("model", ["claude-3-7-sonnet", "claude-sonnet-4-5", "claude-haiku-4-5"])
def test_older_claude_models_keep_budget_based_thinking(model: str) -> None:
    result = apply_reasoning_effort("anthropic_bedrock", "medium", {}, model_id=model)
    assert result["thinking"] == {"type": "enabled", "budget_tokens": 4096}
    assert result["max_tokens"] > result["thinking"]["budget_tokens"]
    assert "output_config" not in result


@pytest.mark.parametrize("provider,container", [
    ("bedrock_converse", "additional_model_request_fields"),
    ("bedrock", "model_kwargs"),
])
def test_adaptive_bedrock_removes_nested_sampling_and_preserves_request_fields(provider: str, container: str) -> None:
    nested = {"temperature": 0.4, "top_p": 0.8, "top_k": 20, "stop_sequences": ["stop"]}
    result = apply_reasoning_effort(provider, "medium", {container: nested}, model_id="claude-sonnet-5")
    assert not {"temperature", "top_p", "top_k"} & result[container].keys()
    assert result[container]["stop_sequences"] == ["stop"]
    assert result[container]["thinking"] == {"type": "adaptive"}
    assert nested == {"temperature": 0.4, "top_p": 0.8, "top_k": 20, "stop_sequences": ["stop"]}


@pytest.mark.parametrize("provider,container", [
    ("bedrock_converse", "additional_model_request_fields"),
    ("bedrock", "model_kwargs"),
])
def test_adaptive_bedrock_preserves_nested_output_format(provider: str, container: str) -> None:
    output_config = {"format": {"type": "json_schema", "schema": {"type": "object"}}, "effort": "low"}
    result = apply_reasoning_effort(
        provider, "high", {container: {"output_config": output_config}}, model_id="claude-sonnet-5",
    )
    assert result[container]["output_config"] == {**output_config, "effort": "high"}
    assert output_config["effort"] == "low"


@pytest.mark.parametrize("provider,container", [
    ("anthropic", None), ("anthropic_bedrock", None),
    ("bedrock_converse", "additional_model_request_fields"), ("bedrock", "model_kwargs"),
])
def test_adaptive_preserves_top_level_output_format(provider: str, container: str | None) -> None:
    output_config = {"format": {"type": "json_schema", "schema": {"type": "object"}}}
    result = apply_reasoning_effort(provider, "high", {"output_config": output_config}, model_id="claude-sonnet-5")
    payload = result[container] if container else result
    assert payload["output_config"] == {**output_config, "effort": "high"}


@pytest.mark.parametrize("provider,container", [
    ("bedrock_converse", "additional_model_request_fields"),
    ("bedrock", "model_kwargs"),
])
def test_adaptive_bedrock_merges_output_config_with_explicit_overrides(provider: str, container: str) -> None:
    result = apply_reasoning_effort(
        provider, "high",
        {"output_config": {"effort": "medium", "format": {"type": "json_schema"}},
         container: {"output_config": {"effort": "low", "format": {"type": "text"}, "custom_field": True}}},
        model_id="claude-sonnet-5",
    )
    assert "output_config" not in result
    assert result[container]["output_config"] == {
        "effort": "high", "format": {"type": "json_schema"}, "custom_field": True,
    }
