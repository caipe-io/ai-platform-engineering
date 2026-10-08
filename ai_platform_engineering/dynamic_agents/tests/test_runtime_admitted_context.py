"""Cached native tools and prompts must match the current admitted request."""

from unittest.mock import AsyncMock

import pytest

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.models import ClientContext, DynamicAgentConfig, UserContext
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.runtime_cache import AgentRuntimeCache, RuntimeCapacityError


def _runtime() -> AgentRuntime:
    runtime = AgentRuntime.__new__(AgentRuntime)
    runtime.config = DynamicAgentConfig(
        _id="example-agent", name="Example", owner_id="owner@example.com", system_prompt="Assist.",
        model={"id": "example-model", "provider": "example-provider"}, allowed_tools={"example-server": ["read"]},
    )
    runtime.mcp_servers = []
    runtime._user = UserContext(email="caller@example.com")
    runtime._client_context = ClientContext(source="webui")
    runtime._auth_bearer = "first-token"
    return runtime


def test_full_admitted_overrides_and_caller_are_compared() -> None:
    runtime = _runtime()
    token = current_user_token.set("first-token")
    try:
        context = dict(user=runtime._user, client_context=runtime._client_context)
        assert not runtime.is_stale(runtime.config, [], **context)
        # No updated_at change accompanies a per-request override.
        changed = runtime.config.model_copy(update={"allowed_tools": {"example-server": False}})
        assert runtime.is_stale(changed, [], **context)
        assert runtime.is_stale(runtime.config, [], user=UserContext(email="another@example.com"),
                                client_context=runtime._client_context)
        assert runtime.is_stale(runtime.config, [], user=runtime._user,
                                client_context=ClientContext(source="workflow"))
        current_user_token.set("refreshed-token")
        assert runtime.is_stale(runtime.config, [], **context)
    finally:
        current_user_token.reset(token)


async def test_changed_caller_cannot_destroy_an_active_runtime() -> None:
    runtime = _runtime()
    runtime._is_streaming = True
    runtime.cleanup = AsyncMock()
    cache = AgentRuntimeCache(max_size=2)
    cache._cache[cache._make_key(runtime.config.id, "thread")] = runtime
    with pytest.raises(RuntimeCapacityError):
        await cache.get_or_create(runtime.config, [], "thread", user=UserContext(email="another@example.com"))
    runtime.cleanup.assert_not_awaited()


async def test_token_refresh_preserves_omitted_resume_presentation_context() -> None:
    runtime = _runtime()
    runtime._is_streaming = False
    runtime.cleanup = AsyncMock()
    cache = AgentRuntimeCache(max_size=2)
    cache._cache[cache._make_key(runtime.config.id, "thread")] = runtime
    replacement = _runtime()
    cache._create_runtime = AsyncMock(return_value=replacement)
    token = current_user_token.set("refreshed-token")
    try:
        assert await cache.get_or_create(runtime.config, [], "thread", user=runtime._user) is replacement
    finally:
        current_user_token.reset(token)
    assert cache._create_runtime.await_args.args[-1] == runtime._client_context
    runtime.cleanup.assert_awaited_once()
