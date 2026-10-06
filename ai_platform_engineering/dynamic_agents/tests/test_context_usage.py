"""Context usage middleware and stream encoding tests."""

import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage

from dynamic_agents.services.context_usage import (
    DEFAULT_COMPACTION_TOKEN_LIMIT,
    ContextUsageMiddleware,
    compaction_token_limit,
    context_usage_payload,
)
from dynamic_agents.services.stream_encoders.agui_sse import AGUIStreamEncoder
from dynamic_agents.services.stream_encoders.custom_sse import CustomStreamEncoder


def _request(profile: dict | None) -> ModelRequest:
    model = SimpleNamespace(profile=profile)
    return ModelRequest(
        model=model,
        messages=[HumanMessage(content="A short conversation")],
        tools=[],
    )


def _payload(frame: str) -> dict:
    data_line = next(line for line in frame.splitlines() if line.startswith("data: "))
    return json.loads(data_line[6:])


def test_context_usage_uses_model_compaction_threshold() -> None:
    payload = context_usage_payload(_request({"max_input_tokens": 200_000}))

    assert payload["compaction_threshold"] == 170_000
    assert payload["remaining_tokens"] == 170_000 - payload["used_tokens"]
    assert 0 <= payload["remaining_percent"] <= 100


def test_context_usage_uses_fallback_without_model_profile() -> None:
    assert compaction_token_limit(SimpleNamespace(profile=None)) == DEFAULT_COMPACTION_TOKEN_LIMIT


@pytest.mark.asyncio
async def test_context_usage_middleware_publishes_before_model_call() -> None:
    writer = MagicMock()
    middleware = ContextUsageMiddleware()

    async def handler(_request: Any) -> ModelResponse:
        return ModelResponse(result=[AIMessage(content="done")])

    with patch(
        "dynamic_agents.services.context_usage.get_stream_writer",
        return_value=writer,
    ):
        response = await middleware.awrap_model_call(_request({"max_input_tokens": 1000}), handler)

    assert response.result[0].content == "done"
    assert writer.call_count == 2
    before_payload = writer.call_args_list[0].args[0]
    after_payload = writer.call_args_list[1].args[0]
    assert before_payload["type"] == "context_usage"
    assert before_payload["compaction_threshold"] == 850
    assert after_payload["used_tokens"] > before_payload["used_tokens"]


def test_agui_encoder_exposes_context_usage_as_custom_event() -> None:
    encoder = AGUIStreamEncoder()
    frames = encoder.on_chunk(
        (
            (),
            "custom",
            {
                "type": "context_usage",
                "used_tokens": 10,
                "compaction_threshold": 100,
                "remaining_tokens": 90,
                "remaining_percent": 90,
            },
        )
    )

    assert len(frames) == 1
    payload = _payload(frames[0])
    assert payload["type"] == "CUSTOM"
    assert payload["name"] == "CONTEXT_USAGE"
    assert payload["value"]["remaining_percent"] == 90
    assert payload["value"]["namespace"] == []


def test_custom_encoder_exposes_context_usage_event() -> None:
    encoder = CustomStreamEncoder()
    frames = encoder._handle_custom(
        {
            "type": "context_usage",
            "used_tokens": 25,
            "compaction_threshold": 100,
            "remaining_tokens": 75,
            "remaining_percent": 75,
        },
        ("helper",),
    )

    assert len(frames) == 1
    assert frames[0].startswith("event: context_usage\n")
    payload = _payload(frames[0])
    assert payload["remaining_percent"] == 75
    assert payload["namespace"] == ["helper"]
