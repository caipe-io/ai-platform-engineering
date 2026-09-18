"""Conversation context usage reporting for streaming clients."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable, Mapping
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, AnyMessage
from langchain_core.messages.utils import count_tokens_approximately
from langgraph.config import get_stream_writer

DEFAULT_COMPACTION_FRACTION = 0.85
DEFAULT_COMPACTION_TOKEN_LIMIT = 170_000
CONTEXT_USAGE_EVENT = "context_usage"


def compaction_token_limit(model: Any) -> int:
    """Return the automatic compaction threshold for a chat model."""
    profile = getattr(model, "profile", None)
    if isinstance(profile, Mapping):
        max_input_tokens = profile.get("max_input_tokens")
        if isinstance(max_input_tokens, int) and not isinstance(max_input_tokens, bool) and max_input_tokens > 0:
            return max(1, int(max_input_tokens * DEFAULT_COMPACTION_FRACTION))
    return DEFAULT_COMPACTION_TOKEN_LIMIT


def request_token_count(
    request: ModelRequest,
    additional_messages: Iterable[AnyMessage] = (),
) -> int:
    """Approximate the prompt size using the same counter as compaction."""
    messages = (
        [request.system_message, *request.messages, *additional_messages]
        if request.system_message is not None
        else [*request.messages, *additional_messages]
    )
    counter_options: dict[str, Any] = {
        "tools": request.tools,
        "use_usage_metadata_scaling": True,
    }
    if getattr(request.model, "_llm_type", "").startswith("anthropic-chat"):
        counter_options["chars_per_token"] = 3.3
    return count_tokens_approximately(messages, **counter_options)


def context_usage_payload(
    request: ModelRequest,
    additional_messages: Iterable[AnyMessage] = (),
) -> dict[str, int | str]:
    """Build a transport-neutral context usage snapshot."""
    used_tokens = request_token_count(request, additional_messages)
    compaction_threshold = compaction_token_limit(request.model)
    remaining_tokens = max(0, compaction_threshold - used_tokens)
    remaining_percent = round((remaining_tokens / compaction_threshold) * 100)
    return {
        "type": CONTEXT_USAGE_EVENT,
        "used_tokens": used_tokens,
        "compaction_threshold": compaction_threshold,
        "remaining_tokens": remaining_tokens,
        "remaining_percent": remaining_percent,
    }


class ContextUsageMiddleware(AgentMiddleware):
    """Publish effective context usage before and after each model call."""

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse | AIMessage:
        writer = get_stream_writer()
        writer(context_usage_payload(request))
        response = await handler(request)
        response_messages = response.result if isinstance(response, ModelResponse) else [response]
        writer(context_usage_payload(request, response_messages))
        return response
