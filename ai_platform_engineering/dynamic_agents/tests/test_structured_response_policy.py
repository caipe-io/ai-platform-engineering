"""Structured schema policy remains scoped to each request and the configured root agent."""

import asyncio
import json
from collections.abc import AsyncGenerator
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from dynamic_agents.models import ChatRequest, ClientContext, DynamicAgentConfig, UserContext
from dynamic_agents.routes import chat
from dynamic_agents.services import agent_runtime
from dynamic_agents.services.agent_runtime import AgentRuntime, _with_general_purpose_tool_result_recovery
from dynamic_agents.services.runtime_cache import AgentRuntimeCache, RuntimeCapacityError, RuntimeInitError
from dynamic_agents.services.structured_response import StructuredResponseError


def _agent(enabled: bool = True) -> DynamicAgentConfig:
    return DynamicAgentConfig(
        _id="example-agent", name="Example", owner_id="owner@example.test", system_prompt="Be helpful.",
        model={"id": "example-model", "provider": "example"},
        features={"middleware": [{
            "type": "structured_response", "enabled": enabled,
            "params": {"allowed_schema_ids": "example.allowed"},
        }]},
    )


def _context(schema_id: str = "example.allowed", value_type: str = "string") -> ClientContext:
    return ClientContext(source="webui", response_format={
        "type": "json_schema", "schema_id": schema_id,
        "schema": {"type": "object", "properties": {"value": {"type": value_type}}},
    })


def _cached_runtime(context: ClientContext | None) -> SimpleNamespace:
    return SimpleNamespace(
        _client_context=context.model_copy(deep=True) if context else None,
        _is_streaming=False, is_stale=Mock(return_value=False), idle_seconds=0,
        touch=Mock(), cleanup=AsyncMock(),
    )


async def test_cached_turns_rebuild_when_schema_added_changed_or_removed() -> None:
    cache = AgentRuntimeCache(max_size=2)

    async def create(*args: object) -> SimpleNamespace:
        return _cached_runtime(args[-1])

    cache._create_runtime = AsyncMock(side_effect=create)
    try:
        previous = None
        for context in [None, _context(), _context(value_type="integer"), _context("example.other"), None]:
            current = await cache.get_or_create(_agent(), [], "example-session", client_context=context)
            assert current is not previous
            if previous is not None:
                previous.cleanup.assert_awaited_once()
            # Other request context does not change the graph's schema contract.
            equivalent = context.model_copy(update={"source": "example"}) if context else None
            assert await cache.get_or_create(_agent(), [], "example-session", client_context=equivalent) is current
            previous = current
        assert cache._create_runtime.await_count == 5
    finally:
        await cache.clear()


@pytest.mark.parametrize("initialization_fails", [False, True])
async def test_single_flight_does_not_return_another_requests_schema(initialization_fails: bool) -> None:
    cache = AgentRuntimeCache(max_size=2)
    started = asyncio.Event()
    release = asyncio.Event()

    async def create(*args: object) -> SimpleNamespace:
        started.set()
        await release.wait()
        if initialization_fails and args[-1].response_format["schema_id"] == "example.allowed":
            raise RuntimeInitError("example-agent", StructuredResponseError("Invalid schema"))
        return _cached_runtime(args[-1])

    cache._create_runtime = AsyncMock(side_effect=create)
    first = asyncio.create_task(cache.get_or_create(_agent(), [], "example-session", client_context=_context()))
    second = None
    try:
        await asyncio.wait_for(started.wait(), timeout=5)
        second = asyncio.create_task(cache.get_or_create(
            _agent(), [], "example-session", client_context=_context("example.other"),
        ))
        await asyncio.sleep(0)
        release.set()
        primary, secondary = await asyncio.wait_for(asyncio.gather(first, second, return_exceptions=True), timeout=5)
        assert primary is not secondary
        if initialization_fails:
            assert isinstance(primary, RuntimeInitError)
        else:
            assert primary._client_context.response_format["schema_id"] == "example.allowed"
        assert secondary._client_context.response_format["schema_id"] == "example.other"
        assert cache._pending_response_formats == {}
    finally:
        release.set()
        await asyncio.gather(*[task for task in [first, second] if task is not None], return_exceptions=True)
        await cache.clear()


async def test_schema_change_does_not_clean_up_an_active_stream() -> None:
    cache = AgentRuntimeCache(max_size=2)
    runtime = _cached_runtime(_context())
    runtime._is_streaming = True
    cache._cache["example-agent:example-session"] = runtime
    try:
        with pytest.raises(RuntimeCapacityError):
            await cache.get_or_create(_agent(), [], "example-session", client_context=None)
        runtime.cleanup.assert_not_awaited()
        assert cache._cache["example-agent:example-session"] is runtime
    finally:
        await cache.clear()


def test_runtime_snapshots_the_response_format_before_caller_mutation() -> None:
    context = _context()
    runtime = AgentRuntime(
        config=_agent(), mcp_servers=[], ephemeral=True, client_context=context,
    )
    context.response_format["schema"]["properties"]["value"]["type"] = "integer"
    assert runtime._client_context.response_format["schema"]["properties"]["value"]["type"] == "string"
    assert not AgentRuntimeCache._response_format_matches(runtime, context)


@pytest.mark.parametrize("features", [
    None, {"middleware": []},
    {"middleware": [{"type": "structured_response", "enabled": False}]},
    {"middleware": [{"type": "structured_response", "params": {"allowed_schema_ids": ""}}]},
])
def test_chat_override_cannot_remove_disable_or_widen_schema_policy(features: dict | None) -> None:
    with pytest.raises(HTTPException, match="structured_response") as exc:
        chat.apply_config_override(_agent(), {"features": features})
    assert exc.value.status_code == 400


def test_chat_override_cannot_enable_structured_responses() -> None:
    with pytest.raises(HTTPException, match="structured_response"):
        chat.apply_config_override(_agent(enabled=False), {"features": {"middleware": [{
            "type": "structured_response", "enabled": True,
            "params": {"allowed_schema_ids": "example.allowed"},
        }]}})


def test_other_middleware_overrides_preserve_structured_policy() -> None:
    agent = _agent()
    middleware = agent.features.model_dump()["middleware"]
    middleware.append({"type": "model_retry", "enabled": False})
    overridden = chat.apply_config_override(agent, {"features": {"middleware": middleware}})
    assert overridden.features.middleware[0] == agent.features.middleware[0]
    assert overridden.features.middleware[1].enabled is False
    agent.features = None
    assert chat.apply_config_override(agent, {"features": {"middleware": [{"type": "model_retry"}]}}).features


def test_general_purpose_keeps_regular_tools_but_cannot_submit_root_output() -> None:
    regular = SimpleNamespace(name="example_tool")
    submit = SimpleNamespace(name="submit_structured_response")
    tools = [regular, submit]
    subagent = _with_general_purpose_tool_result_recovery(
        [], model=object(), tools=tools, interrupt_on={"example_tool": True, "submit_structured_response": True},
    )[-1]
    assert subagent["tools"] == [regular]
    assert subagent["interrupt_on"] == {"example_tool": True}
    assert tools == [regular, submit]


async def test_invoke_real_initialization_maps_non_string_dialect_to_422(monkeypatch: pytest.MonkeyPatch) -> None:
    cache = AgentRuntimeCache(max_size=2)
    monkeypatch.setattr(chat, "get_runtime_cache", lambda: cache)
    monkeypatch.setattr(chat, "get_settings", lambda: SimpleNamespace(invoke_persist_history=False))
    monkeypatch.setattr(chat, "_enforce_chat_authz", AsyncMock())
    llm = Mock(side_effect=AssertionError("Invalid schema must fail before model construction"))
    monkeypatch.setattr(agent_runtime, "get_llm", llm)
    agent = _agent()
    context = _context()
    context.response_format["schema"]["$schema"] = 5
    response = await chat.chat_invoke(
        ChatRequest(agent_id=agent.id, conversation_id="example-session", message="Healthy", client_context=context),
        user=UserContext(email="test-user@example.test"),
        mongo=SimpleNamespace(get_agent=lambda _id: agent, get_agent_mcp_servers=lambda _agent: []),
    )
    assert response.status_code == 422
    assert "$schema must be a string" in json.loads(response.body)["error"]
    llm.assert_not_called()


async def test_resume_forwards_schema_when_cache_must_create_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    async def resume(*args: object) -> AsyncGenerator[str, None]:
        yield "example-frame"

    cache = SimpleNamespace(get_or_create=AsyncMock(return_value=SimpleNamespace(resume=resume)))
    monkeypatch.setattr(chat, "get_runtime_cache", lambda: cache)
    context = _context()
    frames = [frame async for frame in chat._generate_resume_sse_events(
        agent_config=_agent(), mcp_servers=[], session_id="example-session",
        user=UserContext(email="test-user@example.test"), resume_data="{}", encoder=Mock(), client_context=context,
    )]
    assert frames == ["example-frame"]
    assert cache.get_or_create.call_args.kwargs["client_context"] is context
