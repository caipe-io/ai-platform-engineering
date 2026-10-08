"""Pool-owned initialization and expiry never destroy another caller's runtime."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from dynamic_agents.config import Settings
from dynamic_agents.models import DynamicAgentConfig, UserContext
from dynamic_agents.services.runtime_cache import AgentRuntimeCache, RuntimeCapacityError, RuntimeInitError


def _agent() -> DynamicAgentConfig:
    return DynamicAgentConfig(
        _id="primary", name="Primary", owner_id="owner@example.com", system_prompt="Assist.",
        model={"id": "example-model", "provider": "example-provider"},
    )


def _runtime(agent: DynamicAgentConfig, user: UserContext | None = None) -> SimpleNamespace:
    admitted_user = user
    return SimpleNamespace(
        config=agent, _user=user, _client_context=None, _is_streaming=False, idle_seconds=0,
        settings=Settings(),
        cleanup=AsyncMock(), touch=lambda: None,
        is_stale=lambda config, servers, *, user, client_context: config != agent or user != admitted_user,
    )


async def test_ttl_lookup_and_sweep_preserve_active_runtime() -> None:
    agent, cache = _agent(), AgentRuntimeCache(ttl_seconds=10)
    runtime = _runtime(agent)
    runtime.idle_seconds, runtime._is_streaming = 20, True
    cache._cache[cache._make_key(agent.id, "thread-1")] = runtime

    assert await cache.get_or_create(agent, [], "thread-1") is runtime
    await cache._cleanup_expired()

    assert cache._cache[cache._make_key(agent.id, "thread-1")] is runtime
    runtime.cleanup.assert_not_awaited()


async def test_borrow_protects_runtime_before_prompt_from_expiry_eviction_and_refresh() -> None:
    agent, cache = _agent(), AgentRuntimeCache(ttl_seconds=10, max_size=1)
    runtime = _runtime(agent)
    cache._create_runtime = AsyncMock(return_value=runtime)

    async with cache.borrow(agent, [], "thread-1") as admitted:
        assert admitted is runtime and not runtime._is_streaming
        runtime.idle_seconds = 20
        await cache._cleanup_expired()
        with pytest.raises(RuntimeCapacityError):
            await cache.get_or_create(agent, [], "thread-2")
        with pytest.raises(RuntimeCapacityError):
            await cache.get_or_create(agent, [], "thread-1", user=UserContext(email="next@example.com"))
        with pytest.raises(RuntimeCapacityError):
            await cache.invalidate(agent.id, "thread-1")
        runtime.cleanup.assert_not_awaited()

    assert cache._borrowers == {}
    await cache._cleanup_expired()
    runtime.cleanup.assert_awaited_once()


async def test_authorized_read_only_borrow_reuses_active_storage_without_refreshing_tools() -> None:
    agent, cache = _agent(), AgentRuntimeCache()
    first_user, next_user = UserContext(email="first@example.com"), UserContext(email="next@example.com")
    runtime = _runtime(agent, first_user)
    cache._create_runtime = AsyncMock(return_value=runtime)

    async with cache.borrow(agent, [], "thread-1", user=first_user):
        edited = agent.model_copy(update={"system_prompt": "Updated request."})
        async with cache.borrow(edited, [], "thread-1", user=next_user, read_only=True) as reader:
            assert reader is runtime
            assert reader._user == first_user and reader.config == agent
        with pytest.raises(RuntimeCapacityError):
            async with cache.borrow(agent, [], "thread-1", user=first_user):
                pytest.fail("An executing borrow must remain exclusive")
        other_storage = DynamicAgentConfig.model_validate({
            **agent.model_dump(), "backend": {"type": "store", "config": {"checkpoint_collection": "other"}},
        })
        with pytest.raises(RuntimeCapacityError):
            async with cache.borrow(other_storage, [], "thread-1", user=next_user, read_only=True):
                pytest.fail("State readers must not cross persistence coordinates")
    assert cache._borrowers == {}
    runtime.cleanup.assert_not_awaited()


async def test_sweep_rechecks_candidates_that_become_active_during_cleanup() -> None:
    agent, cache = _agent(), AgentRuntimeCache(ttl_seconds=10)
    first, next_runtime = _runtime(agent), _runtime(agent)
    first.idle_seconds = next_runtime.idle_seconds = 20

    async def cleanup_first() -> None:
        next_runtime._is_streaming = True

    first.cleanup.side_effect = cleanup_first
    cache._cache[cache._make_key(agent.id, "first")] = first
    cache._cache[cache._make_key(agent.id, "next")] = next_runtime

    await cache._cleanup_expired()

    first.cleanup.assert_awaited_once()
    next_runtime.cleanup.assert_not_awaited()
    assert list(cache._cache.values()) == [next_runtime]


@pytest.mark.parametrize("cancel_initiator", [False, True])
async def test_cancelled_caller_does_not_cancel_shared_initialization(cancel_initiator: bool) -> None:
    agent, cache = _agent(), AgentRuntimeCache()
    entered, finish = asyncio.Event(), asyncio.Event()
    runtime = _runtime(agent)

    async def create(*args: object) -> SimpleNamespace:
        entered.set()
        await finish.wait()
        return runtime

    cache._create_runtime = AsyncMock(side_effect=create)
    initiator = asyncio.create_task(cache.get_or_create(agent, [], "thread-1"))
    await entered.wait()
    waiter = asyncio.create_task(cache.get_or_create(agent, [], "thread-1"))
    await asyncio.sleep(0)
    cancelled, remaining = (initiator, waiter) if cancel_initiator else (waiter, initiator)
    cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled
    finish.set()

    assert await asyncio.wait_for(remaining, timeout=2) is runtime
    cache._create_runtime.assert_awaited_once()
    assert cache._pending == {}
    runtime.cleanup.assert_not_awaited()


async def test_waiter_revalidates_configuration_and_caller_after_initialization() -> None:
    agent, cache = _agent(), AgentRuntimeCache()
    first_user, next_user = UserContext(email="first@example.com"), UserContext(email="next@example.com")
    entered, finish = asyncio.Event(), asyncio.Event()
    created: list[SimpleNamespace] = []

    async def create(key: str, config: DynamicAgentConfig, servers: list, session: str,
                     user: UserContext | None, client_context: object) -> SimpleNamespace:
        runtime = _runtime(config, user)
        created.append(runtime)
        if len(created) == 1:
            entered.set()
            await finish.wait()
        return runtime

    cache._create_runtime = AsyncMock(side_effect=create)
    initiator = asyncio.create_task(cache.get_or_create(agent, [], "thread-1", user=first_user))
    await entered.wait()
    edited = agent.model_copy(update={"system_prompt": "Updated request."})
    waiter = asyncio.create_task(cache.get_or_create(edited, [], "thread-1", user=next_user))
    await asyncio.sleep(0)
    finish.set()

    assert await initiator is created[0]
    selected = await asyncio.wait_for(waiter, timeout=2)
    assert selected is created[1]
    assert selected.config == edited and selected._user == next_user
    created[0].cleanup.assert_awaited_once()


async def test_clear_cancels_pool_owned_initialization_and_unblocks_waiters() -> None:
    agent, cache = _agent(), AgentRuntimeCache()
    entered, closed = asyncio.Event(), asyncio.Event()

    async def create(*args: object) -> SimpleNamespace:
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            closed.set()

    cache._create_runtime = AsyncMock(side_effect=create)
    requester = asyncio.create_task(cache.get_or_create(agent, [], "thread-1"))
    await entered.wait()
    await cache.clear()

    with pytest.raises(asyncio.CancelledError):
        await requester
    assert closed.is_set()
    assert cache._pending == {} and cache._cache == {}


async def test_pending_initializations_reserve_cache_capacity() -> None:
    agent, cache = _agent(), AgentRuntimeCache(max_size=1)
    entered, finish = asyncio.Event(), asyncio.Event()
    runtime = _runtime(agent)

    async def create(*args: object) -> SimpleNamespace:
        entered.set()
        await finish.wait()
        return runtime

    cache._create_runtime = AsyncMock(side_effect=create)
    first = asyncio.create_task(cache.get_or_create(agent, [], "first"))
    await entered.wait()
    try:
        with pytest.raises(RuntimeCapacityError):
            await cache.get_or_create(agent, [], "next")
        cache._create_runtime.assert_awaited_once()
    finally:
        finish.set()
        await first
    assert len(cache._cache) == 1 and cache._pending == {}


async def test_invalidate_drains_pending_initializer_before_next_admission() -> None:
    agent, cache = _agent(), AgentRuntimeCache()
    entered, closed = asyncio.Event(), asyncio.Event()
    first, next_runtime = _runtime(agent), _runtime(agent)
    calls = 0

    async def create(*args: object) -> SimpleNamespace:
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                # Even an initializer that finishes after cancellation cannot
                # repopulate the cache after invalidate returns.
                closed.set()
                return first
        return next_runtime

    cache._create_runtime = AsyncMock(side_effect=create)
    requester = asyncio.create_task(cache.get_or_create(agent, [], "thread-1"))
    await entered.wait()

    assert await cache.invalidate(agent.id, "thread-1")
    await requester
    assert closed.is_set()
    assert cache._cache == {} and cache._pending == {}
    first.cleanup.assert_awaited_once()
    assert await cache.get_or_create(agent, [], "thread-1") is next_runtime


@pytest.mark.parametrize("cancelled", [False, True])
async def test_failed_partial_initialization_releases_resources(cancelled: bool) -> None:
    agent, cache = _agent(), AgentRuntimeCache()
    runtime = _runtime(agent)
    runtime.initialize = AsyncMock(side_effect=asyncio.CancelledError() if cancelled else ValueError("provider unavailable"))

    with pytest.raises(asyncio.CancelledError if cancelled else RuntimeInitError):
        await cache._initialize_runtime(runtime)
    runtime.cleanup.assert_awaited_once()
