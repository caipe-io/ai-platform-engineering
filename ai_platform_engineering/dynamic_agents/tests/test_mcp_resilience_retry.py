"""Bounded transient-retry behavior for ``get_tools_with_resilience``.

Pins the self-heal contract (spec 2026-06-02-mcp-authz-resilience, US2):
- transient first attempt that later succeeds ⇒ server available, attempts>1
- permanent error ⇒ fail fast (single attempt), classified permanent
- success ⇒ single attempt (no retry, no added latency)
- genuine denial (clean 403) ⇒ NOT retried, classified denied
- transient that never recovers ⇒ exhausts the bounded budget, classified transient
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from dynamic_agents.services import mcp_client
from dynamic_agents.services.mcp_client import get_tools_with_resilience


class _FakeTool:
    def __init__(self, name: str) -> None:
        self.name = name


def _install_fake_client(monkeypatch, behaviors: list) -> dict:
    """Patch ``MultiServerMCPClient`` so each ``get_tools()`` call consumes the
    next entry in ``behaviors`` (an Exception is raised; a list is returned).

    A fresh client is constructed per attempt, so the call counter is shared
    via the returned ``state`` dict.
    """
    state = {"calls": 0}

    class _FakeClient:
        def __init__(self, connections, tool_name_prefix: bool = True) -> None:
            self._connections = connections

        async def get_tools(self):
            i = state["calls"]
            state["calls"] += 1
            behavior = behaviors[min(i, len(behaviors) - 1)]
            if isinstance(behavior, BaseException):
                raise behavior
            return behavior

    monkeypatch.setattr(mcp_client, "MultiServerMCPClient", _FakeClient)
    return state


async def test_transient_then_success(monkeypatch):
    state = _install_fake_client(
        monkeypatch, [TimeoutError("read timeout"), [_FakeTool("srv_do_thing")]]
    )

    tools, failed, errors, status = await get_tools_with_resilience(
        {"srv": {"url": "http://x"}}, max_attempts=3, base_backoff_s=0
    )

    assert [t.name for t in tools] == ["srv_do_thing"]
    assert failed == []
    assert status == {}
    assert state["calls"] == 2  # retried once, then succeeded


async def test_permanent_fails_fast(monkeypatch):
    state = _install_fake_client(monkeypatch, [ConnectionError("Connection refused")])

    tools, failed, errors, status = await get_tools_with_resilience(
        {"srv": {"url": "http://x"}}, max_attempts=3, base_backoff_s=0
    )

    assert tools == []
    assert failed == ["srv"]
    assert status["srv"] == "permanent"
    assert state["calls"] == 1  # no retry on permanent


async def test_success_no_retry(monkeypatch):
    state = _install_fake_client(monkeypatch, [[_FakeTool("srv_a")]])

    tools, failed, errors, status = await get_tools_with_resilience(
        {"srv": {"url": "http://x"}}, max_attempts=3, base_backoff_s=0
    )

    assert [t.name for t in tools] == ["srv_a"]
    assert failed == []
    assert state["calls"] == 1  # zero retries on the success path


async def test_denial_not_retried(monkeypatch):
    state = _install_fake_client(
        monkeypatch, [PermissionError("HTTP 403 Forbidden from http://x")]
    )

    tools, failed, errors, status = await get_tools_with_resilience(
        {"srv": {"url": "http://x"}}, max_attempts=3, base_backoff_s=0
    )

    assert failed == ["srv"]
    assert status["srv"] == "denied"
    assert state["calls"] == 1  # a denial is never retried


async def test_transient_exhausts_budget(monkeypatch):
    state = _install_fake_client(monkeypatch, [TimeoutError("timed out")])

    tools, failed, errors, status = await get_tools_with_resilience(
        {"srv": {"url": "http://x"}}, max_attempts=3, base_backoff_s=0
    )

    assert failed == ["srv"]
    assert status["srv"] == "transient"
    assert state["calls"] == 3  # bounded by max_attempts


async def test_default_budget_covers_gateway_upstream_readiness(monkeypatch: pytest.MonkeyPatch) -> None:
    state = _install_fake_client(
        monkeypatch,
        [
            RuntimeError("HTTP 503 Service Unavailable from http://example.test/mcp"),
            RuntimeError("HTTP 503 Service Unavailable from http://example.test/mcp"),
            RuntimeError("HTTP 503 Service Unavailable from http://example.test/mcp"),
            RuntimeError("HTTP 503 Service Unavailable from http://example.test/mcp"),
            [_FakeTool("srv_do_thing")],
        ],
    )
    sleep = AsyncMock()
    monkeypatch.setattr(mcp_client.asyncio, "sleep", sleep)

    tools, failed, errors, status = await get_tools_with_resilience(
        {"srv": {"url": "http://example.test/mcp"}}
    )

    assert [tool.name for tool in tools] == ["srv_do_thing"]
    assert failed == []
    assert errors == {}
    assert status == {}
    assert state["calls"] == 5
    assert sleep.await_count == 4
