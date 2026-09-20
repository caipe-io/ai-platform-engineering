"""A cached AgentRuntime must not forward a stale trusted-interaction proof.

The runtime cache reuses one AgentRuntime across requests for the same
conversation, but the trusted-interaction token/signature carried in
``client_context`` is minted per request and expires quickly. If a cache hit
does not refresh the runtime's client context, every request after the first
forwards the token/signature captured when the runtime was created.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from dynamic_agents.models import ClientContext
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.runtime_cache import AgentRuntimeCache


def _client_context(token: str) -> ClientContext:
    return ClientContext(
        source="webui",
        _caipe_trusted_interaction=token,
        _caipe_trusted_interaction_signature=f"{token}-signature",
    )


def test_refresh_client_context_updates_trusted_interaction_headers():
    runtime = object.__new__(AgentRuntime)
    runtime._client_context = _client_context("stale")

    runtime.refresh_client_context(_client_context("fresh"))

    headers = runtime._trusted_interaction_headers()
    assert headers == {"token": "fresh", "signature": "fresh-signature"}


@pytest.mark.asyncio
async def test_get_or_create_refreshes_client_context_on_cache_hit():
    agent_config = SimpleNamespace(id="agent-1")
    mcp_servers: list = []

    cached_runtime = MagicMock(spec=AgentRuntime)
    cached_runtime.is_stale.return_value = False
    cached_runtime.idle_seconds = 0

    cache = AgentRuntimeCache()
    cache._cache["agent-1:conv-1"] = cached_runtime

    fresh_context = _client_context("fresh")
    result = await cache.get_or_create(
        agent_config,
        mcp_servers,
        "conv-1",
        client_context=fresh_context,
    )

    assert result is cached_runtime
    cached_runtime.refresh_client_context.assert_called_once_with(fresh_context)


@pytest.mark.asyncio
async def test_get_or_create_refreshes_client_context_for_pending_waiters():
    agent_config = SimpleNamespace(id="agent-1")
    mcp_servers: list = []

    cached_runtime = MagicMock(spec=AgentRuntime)

    cache = AgentRuntimeCache()
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    fut.set_result(cached_runtime)
    cache._pending["agent-1:conv-1"] = fut

    fresh_context = _client_context("fresh")
    result = await cache.get_or_create(
        agent_config,
        mcp_servers,
        "conv-1",
        client_context=fresh_context,
    )

    assert result is cached_runtime
    cached_runtime.refresh_client_context.assert_called_once_with(fresh_context)
