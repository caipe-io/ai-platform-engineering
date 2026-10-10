"""Credential destination policy shared by SDK calls and the discovery probe."""

from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException

from dynamic_agents.models import UserContext
from dynamic_agents.routes.remote_agents import RemoteAgentProbeRequest, probe_remote_agent
from dynamic_agents.services.a2a_destination import A2ADestinationPolicy


@pytest.mark.parametrize("endpoint", ["http://example.test", "https://user:secret@example.test", "ftp://example.test", "https://example.test/#fragment"])
def test_unsafe_destination_is_rejected(endpoint: str) -> None:
    with pytest.raises(ValueError):
        A2ADestinationPolicy(endpoint, [])


async def test_https_request_is_authorized_on_the_same_origin_only() -> None:
    policy = A2ADestinationPolicy("https://agent.example.test/base", [])
    hook = policy.request_hook({"X-Agent-Key": "test-secret"})
    request = httpx.Request("POST", "https://agent.example.test:443/message")
    await hook(request)
    assert request.headers["X-Agent-Key"] == "test-secret"
    for url in ["http://agent.example.test/message", "https://agent.example.test:8443/message", "https://other.example.test/message"]:
        request = httpx.Request("POST", url)
        with pytest.raises(ValueError, match="untrusted origin"):
            await hook(request)
        assert "X-Agent-Key" not in request.headers


async def test_redirect_cannot_forward_custom_credentials() -> None:
    policy = A2ADestinationPolicy("https://agent.example.test", [])
    requests: list[httpx.Request] = []
    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(302, headers={"Location": "https://other.example.test"})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond), follow_redirects=True,
                                 event_hooks={"request": [policy.request_hook({"X-Agent-Key": "test-secret"})]}) as client:
        with pytest.raises(ValueError, match="untrusted origin"):
            await client.get("https://agent.example.test")
    assert len(requests) == 1


async def test_probe_rejects_http_before_resolving_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    resolver = AsyncMock()
    monkeypatch.setattr("dynamic_agents.routes.remote_agents.resolve_remote_agent_auth_headers", resolver)
    with pytest.raises(HTTPException) as error:
        await probe_remote_agent(RemoteAgentProbeRequest(endpoint="http://agent.example.test"),
                                 UserContext(email="test-user@example.test", is_admin=True))
    assert error.value.status_code == 400
    resolver.assert_not_awaited()
