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
