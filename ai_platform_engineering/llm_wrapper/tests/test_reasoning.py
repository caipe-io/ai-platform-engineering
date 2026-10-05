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
