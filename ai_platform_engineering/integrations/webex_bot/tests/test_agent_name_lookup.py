from __future__ import annotations

import asyncio

import httpx
import pytest

from ai_platform_engineering.integrations.webex_bot import a2a_client


def test_name_lookup_cancels_a_response_at_the_overall_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    cancelled = False

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal cancelled
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled = True
            raise
        return httpx.Response(200, json={"data": {"name": "Example Agent"}})

    async_client = httpx.AsyncClient
    monkeypatch.setattr(a2a_client, "_AGENT_NAME_LOOKUP_DEADLINE_SECONDS", 0.01)
    monkeypatch.setattr(a2a_client.httpx, "AsyncClient", lambda **kwargs: async_client(
        transport=httpx.MockTransport(handler), **kwargs,
    ))

    client = a2a_client.WebexSSEClient("https://example.test")
    assert client.get_agent_name(agent_id="example-agent", bearer_token="example-token") is None
    assert cancelled


def test_name_lookup_preserves_the_callers_authorization(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer example-token"
        assert request.url.path == "/api/dynamic-agents/agents/example-agent"
        return httpx.Response(200, json={"data": {"name": "Example Agent"}})

    async_client = httpx.AsyncClient
    monkeypatch.setattr(a2a_client.httpx, "AsyncClient", lambda **kwargs: async_client(
        transport=httpx.MockTransport(handler), **kwargs,
    ))
    client = a2a_client.WebexSSEClient("https://example.test")
    assert client.get_agent_name(agent_id="example-agent", bearer_token="example-token") == "Example Agent"
