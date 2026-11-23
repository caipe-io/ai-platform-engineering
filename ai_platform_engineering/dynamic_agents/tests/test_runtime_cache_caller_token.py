"""Cached MCP connections must follow the authenticated caller across turns."""

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Any
from unittest.mock import AsyncMock

import pytest

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.models import ClientContext, DynamicAgentConfig, MCPServerConfig, UserContext
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.mcp_client import build_mcp_connection_config
from dynamic_agents.services.runtime_cache import AgentRuntimeCache, RuntimeCapacityError


@pytest.fixture
def agent() -> DynamicAgentConfig:
    return DynamicAgentConfig(
        id="example-agent",
        name="Example",
        owner_id="user@example.test",
        system_prompt="Unused by this MCP-only fixture.",
        model={"id": "example-model", "provider": "example"},
    )


@pytest.fixture
def cache(monkeypatch: pytest.MonkeyPatch) -> AgentRuntimeCache:
    pool = AgentRuntimeCache(ttl_seconds=3600, max_size=5)

    async def create(
        key: str,
        config: DynamicAgentConfig,
        servers: list[MCPServerConfig],
        session_id: str,
        user: UserContext | None,
        client_context: ClientContext | None,
    ) -> AgentRuntime:
        # Keep the real constructor and connection builder, without model or DB calls.
        return AgentRuntime(
            config, servers, user=user, client_context=client_context, session_id=session_id, ephemeral=True
        )

    monkeypatch.setattr(pool, "_create_runtime", AsyncMock(side_effect=create))
    return pool


@contextmanager
def gateway() -> Iterator[tuple[str, dict[str, str]]]:
    state = {"accepted": "original-token"}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200 if self.headers.get("Authorization") == f"Bearer {state['accepted']}" else 401)
            self.end_headers()

        def log_message(self, *_args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/mcp", state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


async def probe(connection: dict[str, Any]) -> int:
    async with connection["httpx_client_factory"](headers=connection.get("headers")) as client:
        return (await client.get(connection["url"])).status_code


@pytest.mark.parametrize("cache_scope", [None, "same-explicit-scope"])
async def test_refreshed_caller_gets_working_mcp_connection(
    cache: AgentRuntimeCache,
    agent: DynamicAgentConfig,
    cache_scope: str | None,
) -> None:
    token = current_user_token.set("original-token")
    try:
        with gateway() as (url, state):
            server = MCPServerConfig(id="example-mcp", name="Example", transport="http", endpoint=url)
            original = await cache.get_or_create(agent, [server], "example-chat", cache_scope=cache_scope)
            original_connection = build_mcp_connection_config(server, auth_bearer=original._auth_bearer)
            assert await probe(original_connection) == 200

            # The caller refreshes, but the original connection still rejects requests.
            state["accepted"] = "refreshed-token"
            current_user_token.set("refreshed-token")
            assert await probe(original_connection) == 401

            refreshed = await cache.get_or_create(agent, [server], "example-chat", cache_scope=cache_scope)
            refreshed_connection = build_mcp_connection_config(server, auth_bearer=refreshed._auth_bearer)
            assert await probe(refreshed_connection) == 200
            assert refreshed is not original
            assert await cache.get_or_create(agent, [server], "example-chat", cache_scope=cache_scope) is refreshed
            assert len(cache._cache) == 1
            assert refreshed._session_id == original._session_id == "example-chat"
            assert all("original-token" not in key and "refreshed-token" not in key for key in cache._cache)
    finally:
        current_user_token.reset(token)
        await cache.clear()


@pytest.mark.parametrize("field", ["obo_jwt", "access_token"])
async def test_legacy_user_token_refresh_selects_new_runtime(
    cache: AgentRuntimeCache,
    agent: DynamicAgentConfig,
    field: str,
) -> None:
    token = current_user_token.set(None)
    try:
        original = await cache.get_or_create(
            agent, [], "example-chat", user=UserContext(email="user@example.test", **{field: "original-token"})
        )
        refreshed = await cache.get_or_create(
            agent, [], "example-chat", user=UserContext(email="user@example.test", **{field: "refreshed-token"})
        )
        assert refreshed is not original
        assert refreshed._auth_bearer == "refreshed-token"
    finally:
        current_user_token.reset(token)
        await cache.clear()


async def test_request_token_precedes_legacy_user_fields(cache: AgentRuntimeCache, agent: DynamicAgentConfig) -> None:
    token = current_user_token.set("request-token")
    try:
        first = await cache.get_or_create(
            agent,
            [],
            "example-chat",
            user=UserContext(email="user@example.test", obo_jwt="old-obo", access_token="old-access"),
        )
        same = await cache.get_or_create(
            agent,
            [],
            "example-chat",
            user=UserContext(email="user@example.test", obo_jwt="new-obo", access_token="new-access"),
        )
        assert same is first
        assert same._auth_bearer == "request-token"

        current_user_token.set(None)
        anonymous = await cache.get_or_create(agent, [], "example-chat")
        assert anonymous is not first
        assert anonymous._auth_bearer is None
    finally:
        current_user_token.reset(token)
        await cache.clear()


async def test_pending_initialization_does_not_share_another_callers_token(
    cache: AgentRuntimeCache,
    agent: DynamicAgentConfig,
) -> None:
    started, release = asyncio.Event(), asyncio.Event()
    create = cache._create_runtime.side_effect

    async def delayed(*args: Any) -> AgentRuntime:
        if current_user_token.get() == "original-token":
            started.set()
            await release.wait()
        return await create(*args)

    cache._create_runtime.side_effect = delayed

    async def request(bearer: str) -> AgentRuntime:
        token = current_user_token.set(bearer)
        try:
            return await cache.get_or_create(agent, [], "example-chat")
        finally:
            current_user_token.reset(token)

    original_task = asyncio.create_task(request("original-token"))
    refreshed_task = None
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        refreshed_task = asyncio.create_task(request("refreshed-token"))
        # Let both requests enter the single-flight/cache selection path.
        await asyncio.sleep(0)
        release.set()
        original, refreshed = await asyncio.wait_for(asyncio.gather(original_task, refreshed_task), timeout=2)
        assert original is not refreshed
        assert original._auth_bearer == "original-token"
        assert refreshed._auth_bearer == "refreshed-token"
    finally:
        release.set()
        await asyncio.gather(*[task for task in [original_task, refreshed_task] if task], return_exceptions=True)
        await cache.clear()


async def test_refresh_preserves_active_stream_until_it_finishes(
    cache: AgentRuntimeCache,
    agent: DynamicAgentConfig,
) -> None:
    token = current_user_token.set("original-token")
    runtime = await cache.get_or_create(agent, [], "example-chat")
    try:
        runtime._is_streaming = True
        current_user_token.set("refreshed-token")
        with pytest.raises(RuntimeCapacityError):
            await cache.get_or_create(agent, [], "example-chat")
        assert runtime in cache._cache.values()
        assert runtime._auth_bearer == "original-token"
        runtime._is_streaming = False
        refreshed = await cache.get_or_create(agent, [], "example-chat")
        assert refreshed is not runtime
        assert cache.cancel_stream(agent.id, "example-chat") is True
        assert await cache.invalidate(agent.id, "example-chat") is True
        assert not cache._cache
    finally:
        runtime._is_streaming = False
        current_user_token.reset(token)
        await cache.clear()


@pytest.mark.parametrize("header", ["Authorization", "authorization"])
async def test_explicit_upstream_authorization_is_preserved(header: str) -> None:
    token = current_user_token.set("request-token")
    try:
        with gateway() as (url, state):
            state["accepted"] = "upstream-token"
            server = MCPServerConfig(id="example-mcp", name="Example", transport="http", endpoint=url)
            connection = build_mcp_connection_config(server, auth_bearer="request-token")
            connection["headers"] = {header: "Bearer upstream-token"}
            assert await probe(connection) == 200
    finally:
        current_user_token.reset(token)
