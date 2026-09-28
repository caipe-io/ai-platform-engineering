"""Translate a reasoning effort into provider-native thinking configuration.

LangChain's ``init_chat_model`` does not normalize this. ``ChatOpenAI`` accepts
``reasoning_effort`` natively, but ``ChatAnthropic`` does not -- passing it there
silently lands in ``model_kwargs`` and extended thinking is never enabled. This
module does the translation each provider actually needs.

Budgets and clamping are ported from ``cnoe_agent_utils`` 0.5.1, including the
``max_tokens`` headroom fix, so behaviour is preserved rather than reinvented.

Single shared source, imported directly. See README.md.
"""

from __future__ import annotations

from typing import Any, Literal

ReasoningEffort = Literal["low", "medium", "high", "max"]

#: Anthropic extended-thinking budgets, in tokens.
THINKING_BUDGETS: dict[str, int] = {
    "low": 1024,
    "medium": 4096,
    "high": 8192,
    "max": 16384,
}

#: Gemini 2.5 thinking budgets. Gemini caps lower than Anthropic, and `max`
#: intentionally matches `high` because the API rejects anything larger.
GEMINI_THINKING_BUDGETS: dict[str, int] = {
    "low": 1024,
    "medium": 8192,
    "high": 24576,
    "max": 24576,
}

#: Anthropic's minimum accepted thinking budget.
THINKING_MIN_BUDGET = 1024

#: Headroom reserved for the visible response once the thinking budget is spent.
#: Anthropic rejects ``max_tokens <= thinking.budget_tokens``. When a caller
#: enables thinking without passing ``max_tokens``, the chat model applies its
#: own default, which is not guaranteed to exceed the budget. Deriving
#: ``max_tokens`` explicitly keeps the outcome deterministic.
THINKING_RESPONSE_HEADROOM = 4096


def clamp_thinking_budget(budget: int, max_tokens: int | None) -> int:
    """Shrink ``budget`` so a visible response still fits under ``max_tokens``."""
    if max_tokens is None:
        return max(budget, THINKING_MIN_BUDGET)
    room = max_tokens - THINKING_RESPONSE_HEADROOM
    if room < THINKING_MIN_BUDGET:
        return THINKING_MIN_BUDGET
    return max(min(budget, room), THINKING_MIN_BUDGET)


def apply_reasoning_effort(
    langchain_provider: str,
    effort: ReasoningEffort | None,
    kwargs: dict[str, Any],
) -> dict[str, Any]:
    """Return ``kwargs`` with ``effort`` expressed the way the provider expects.

    - OpenAI-family providers take ``reasoning_effort`` natively; it is left
      in place untouched.
    - Anthropic-family providers need ``thinking={"type": "enabled",
      "budget_tokens": N}`` plus a ``max_tokens`` that exceeds ``N``.
    - Gemini uses its own, lower budget ceiling.

    A provider with no known mapping has ``reasoning_effort`` removed rather
    than forwarded, because LangChain would otherwise push it into
    ``model_kwargs`` and the provider would reject or ignore it.
    """
    if effort is None:
        return kwargs

    if langchain_provider in {"openai", "azure_openai"}:
        kwargs["reasoning_effort"] = effort
        return kwargs

    kwargs.pop("reasoning_effort", None)

    if langchain_provider in {"anthropic", "anthropic_bedrock", "bedrock_converse", "bedrock"}:
        budget = clamp_thinking_budget(THINKING_BUDGETS[effort], kwargs.get("max_tokens"))
        kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget}
        if kwargs.get("max_tokens") is None:
            kwargs["max_tokens"] = budget + THINKING_RESPONSE_HEADROOM
        # Extended thinking is incompatible with sampling parameters; Anthropic
        # accepts only its default temperature while thinking is enabled.
        kwargs["temperature"] = 1.0
        return kwargs

    if langchain_provider in {"google_genai", "google_vertexai"}:
        budget = clamp_thinking_budget(GEMINI_THINKING_BUDGETS[effort], kwargs.get("max_tokens"))
        kwargs["thinking_budget"] = budget
        return kwargs

    return kwargs
