"""Focused coverage for steady-state Dynamic Agents telemetry."""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any

import pytest
from langchain.agents.middleware.types import ModelResponse
from langchain_core.messages import AIMessage

from dynamic_agents.auth.token_context import current_initiator_subject
from dynamic_agents.metrics import metrics
from dynamic_agents.metrics.agent_middleware import MetricsAgentMiddleware, _extract_token_usage
from dynamic_agents.models import UserContext
from dynamic_agents.services.agent_runtime import AgentRuntime, _TurnObservation
from dynamic_agents.services.runtime_cache import AgentRuntimeCache, RuntimeCapacityError


def _counter_value(counter: Any) -> float:
    return float(counter._value.get())


def _histogram_count(histogram: Any) -> float:
    return float(sum(bucket.get() for bucket in histogram._buckets))


def test_extract_token_usage_supports_normalized_and_provider_metadata() -> None:
    normalized = AIMessage(
        content="done",
        usage_metadata={"input_tokens": 12, "output_tokens": 8, "total_tokens": 20},
    )
    provider_fallback = AIMessage(
        content="done",
        response_metadata={"token_usage": {"prompt_tokens": 7, "completion_tokens": 3}},
    )

    assert _extract_token_usage(ModelResponse(result=[normalized, provider_fallback])) == (19, 11)


@pytest.mark.asyncio
async def test_model_middleware_emits_input_and_output_tokens() -> None:
    middleware = MetricsAgentMiddleware("test-primary", "test-model")
    input_counter = metrics.llm_input_tokens_total.labels(
        agent_name="test-primary",
        model_id="test-model",
    )
    output_counter = metrics.llm_output_tokens_total.labels(
        agent_name="test-primary",
        model_id="test-model",
    )
    input_before = _counter_value(input_counter)
    output_before = _counter_value(output_counter)

    async def handler(_request: Any) -> ModelResponse:
        return ModelResponse(
            result=[
                AIMessage(
                    content="done",
                    usage_metadata={"input_tokens": 21, "output_tokens": 13, "total_tokens": 34},
                )
            ]
        )

    await middleware.awrap_model_call(None, handler)  # type: ignore[arg-type]

    assert _counter_value(input_counter) - input_before == 21
    assert _counter_value(output_counter) - output_before == 13


def _runtime_stub() -> AgentRuntime:
    runtime = object.__new__(AgentRuntime)
    runtime.config = SimpleNamespace(
        name="test-primary",
        model=SimpleNamespace(id="test-model"),
    )
    runtime._active_stream_count = 0
    runtime._is_streaming = False
    return runtime


@pytest.mark.asyncio
async def test_turn_wrapper_records_one_success_and_restores_active_streams() -> None:
    runtime = _runtime_stub()
    observation = _TurnObservation(started_at=time.monotonic(), turn_type="stream")
    turn_counter = metrics.turns_total.labels(
        agent_name="test-primary",
        model_id="test-model",
        turn_type="stream",
        status="success",
    )
    turn_before = _counter_value(turn_counter)
    active_before = _counter_value(metrics.active_streams)

    async def implementation():
        yield "frame"

    frames = [frame async for frame in runtime._observe_turn(implementation(), observation)]

    assert frames == ["frame"]
    assert _counter_value(turn_counter) - turn_before == 1
    assert _counter_value(metrics.active_streams) == active_before
    assert runtime._is_streaming is False


@pytest.mark.asyncio
async def test_turn_wrapper_records_thrown_errors() -> None:
    runtime = _runtime_stub()
    observation = _TurnObservation(started_at=time.monotonic(), turn_type="resume")
    error_counter = metrics.turns_total.labels(
        agent_name="test-primary",
        model_id="test-model",
        turn_type="resume",
        status="error",
    )
    error_before = _counter_value(error_counter)

    async def implementation():
        if False:
            yield "unreachable"
        raise RuntimeError("test failure")

    with pytest.raises(RuntimeError, match="test failure"):
        _ = [frame async for frame in runtime._observe_turn(implementation(), observation)]

    assert _counter_value(error_counter) - error_before == 1
    assert observation.status == "error"
    assert runtime._is_streaming is False


@pytest.mark.asyncio
async def test_turn_wrapper_records_consumer_cancellation() -> None:
    runtime = _runtime_stub()
    observation = _TurnObservation(started_at=time.monotonic(), turn_type="stream")
    cancelled_counter = metrics.turns_total.labels(
        agent_name="test-primary",
        model_id="test-model",
        turn_type="stream",
        status="cancelled",
    )
    cancelled_before = _counter_value(cancelled_counter)

    async def implementation():
        yield "frame"
        yield "another frame"

    observed = runtime._observe_turn(implementation(), observation)
    assert await anext(observed) == "frame"
    await observed.aclose()

    assert _counter_value(cancelled_counter) - cancelled_before == 1
    assert observation.status == "cancelled"
    assert runtime._is_streaming is False


def test_first_response_latency_is_recorded_once() -> None:
    runtime = _runtime_stub()
    observation = _TurnObservation(started_at=time.monotonic(), turn_type="stream")
    histogram = metrics.turn_time_to_first_response_seconds.labels(
        agent_name="test-primary",
        model_id="test-model",
        turn_type="stream",
    )
    count_before = _histogram_count(histogram)

    encoder = SimpleNamespace(
        get_thinking_content=lambda: "",
        get_accumulated_content=lambda: "visible response",
    )
    runtime._record_first_response(encoder, 0, observation)
    runtime._record_first_response(encoder, 0, observation)

    assert _histogram_count(histogram) - count_before == 1
    assert observation.first_response_recorded is True


def test_runtime_cache_publishes_entries_capacity_and_pending_initializations() -> None:
    entries_before = _counter_value(metrics.runtime_cache_entries)
    capacity_before = _counter_value(metrics.runtime_cache_capacity)
    pending_before = _counter_value(metrics.runtime_cache_pending_initializations)
    cache = AgentRuntimeCache(ttl_seconds=60, max_size=7)

    try:
        cache._cache["test-primary:test-session"] = SimpleNamespace()
        cache._pending["test-secondary:test-session"] = SimpleNamespace()
        cache._update_metrics()

        assert _counter_value(metrics.runtime_cache_entries) == 1
        assert _counter_value(metrics.runtime_cache_capacity) == 7
        assert _counter_value(metrics.runtime_cache_pending_initializations) == 1
    finally:
        metrics.runtime_cache_entries.set(entries_before)
        metrics.runtime_cache_capacity.set(capacity_before)
        metrics.runtime_cache_pending_initializations.set(pending_before)


def test_runtime_cache_separates_human_initiators_for_service_execution() -> None:
    cache = AgentRuntimeCache(ttl_seconds=60, max_size=7)
    service_user = UserContext(email="automation@example.com", sub="service-subject")

    first_token = current_initiator_subject.set("human-one")
    try:
        first = cache._make_key("agent-example", "conversation-example", service_user)
    finally:
        current_initiator_subject.reset(first_token)

    second_token = current_initiator_subject.set("human-two")
    try:
        second = cache._make_key("agent-example", "conversation-example", service_user)
    finally:
        current_initiator_subject.reset(second_token)

    assert first != second
    assert "human-one" not in first
    assert "human-two" not in second


@pytest.mark.asyncio
async def test_runtime_cache_records_capacity_rejections() -> None:
    entries_before = _counter_value(metrics.runtime_cache_entries)
    capacity_before = _counter_value(metrics.runtime_cache_capacity)
    pending_before = _counter_value(metrics.runtime_cache_pending_initializations)
    cache = AgentRuntimeCache(ttl_seconds=60, max_size=1)
    cache._cache["test-primary:test-session"] = SimpleNamespace(_is_streaming=True)
    rejection_before = _counter_value(metrics.runtime_cache_capacity_rejections_total)

    try:
        with pytest.raises(RuntimeCapacityError):
            await cache._evict_lru()

        assert _counter_value(metrics.runtime_cache_capacity_rejections_total) - rejection_before == 1
    finally:
        metrics.runtime_cache_entries.set(entries_before)
        metrics.runtime_cache_capacity.set(capacity_before)
        metrics.runtime_cache_pending_initializations.set(pending_before)
