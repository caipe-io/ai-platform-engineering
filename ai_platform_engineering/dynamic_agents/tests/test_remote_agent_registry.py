"""Remote registry metadata and cache invalidation contracts."""

import asyncio
import threading
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.runtime_cache import AgentRuntimeCache


def test_registry_returns_auth_metadata_to_runtime() -> None:
    entry = {
        "_id": "remote-example",
        "name": "Example Agent",
        "endpoint": "https://agent.example.test",
        "credential_source": {"kind": "secret_ref", "name": "X-API-Key", "secret_ref": "example-secret"},
        "updated_at": "2026-01-01T00:00:00Z",
        "streaming": True,
    }
    collection = Mock()
    collection.find.side_effect = lambda query, projection: [
        {key: value for key, value in entry.items() if projection.get(key)}
    ]
    service = object.__new__(MongoDBService)
    service._get_remote_agents_collection = lambda: collection

    loaded = service.get_remote_agents_by_ids(["remote-example"])
    assert loaded[0]["streaming"] is True
    assert loaded[0]["credential_source"] == entry["credential_source"]
    assert loaded[0]["updated_at"] == entry["updated_at"]


@pytest.mark.parametrize(
    "latest",
    [
        [{"_id": "remote-example", "updated_at": "2026-01-02T00:00:00Z"}],
        [],  # Disabled or deleted endpoint.
    ],
)
def test_remote_auth_change_invalidates_cached_parent_or_subagent_runtime(latest: list[dict]) -> None:
    now = datetime.now(timezone.utc)
    config = SimpleNamespace(updated_at=now, model="example")
    runtime = object.__new__(AgentRuntime)
    runtime.config = config
    runtime._config_updated_at = now
    runtime._mcp_servers_updated_at = datetime.min.replace(tzinfo=timezone.utc)
    runtime._remote_agent_versions = {"remote-example": "2026-01-01T00:00:00Z"}
    getter = Mock(return_value=[{"_id": "remote-example", "updated_at": "2026-01-01T00:00:00Z"}])
    runtime._mongo_service = SimpleNamespace(get_remote_agents_by_ids=getter)

    assert runtime.is_stale(config, []) is False
    getter.return_value = latest
    assert runtime.is_stale(config, []) is True


async def test_registry_initialization_does_not_query_mongo_on_the_event_loop() -> None:
    threads: list[int] = []
    def lookup(ids: list[str]) -> list[dict]:
        threads.append(threading.get_ident())
        return []
    runtime = object.__new__(AgentRuntime)
    runtime.config = SimpleNamespace(allowed_remote_agents=["remote-example"])
    runtime._remote_agent_versions = {}
    runtime._mongo_service = SimpleNamespace(get_remote_agents_by_ids=lookup)
    assert await runtime._build_remote_agent_tools() == []
    assert threads and threads[0] != threading.get_ident()


async def test_cache_validation_is_offloaded_and_single_flight() -> None:
    threads: list[int] = []
    started = threading.Event()
    release = threading.Event()
    def stale(config: object, servers: list) -> bool:
        threads.append(threading.get_ident())
        started.set()
        assert release.wait(timeout=5)
        return False
    runtime = SimpleNamespace(is_stale=stale, idle_seconds=0, touch=Mock(), cleanup=AsyncMock())
    config = SimpleNamespace(id="test-agent")
    cache = AgentRuntimeCache(max_size=2)
    cache._cache["test-agent:test-session"] = runtime
    tasks = [asyncio.create_task(cache.get_or_create(config, [], "test-session")) for _ in range(5)]
    try:
        assert await asyncio.to_thread(started.wait, 2)
        await asyncio.sleep(0)
        assert len(threads) == 1
        release.set()
        assert await asyncio.gather(*tasks) == [runtime] * 5
        assert threads[0] != threading.get_ident()
        assert cache._pending == {}
    finally:
        release.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await cache.clear()
