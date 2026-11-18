"""A2A probes use CAS decisions, independently of gateway flags and debug mode."""

import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from a2a.types import AgentCapabilities, AgentCard
from fastapi import FastAPI

from dynamic_agents.auth import authz
from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.routes import remote_agents


@pytest.mark.parametrize("decision,status", [(True, 200), (False, 403), (RuntimeError("offline"), 503)])
@pytest.mark.parametrize("debug", [True, False])
@pytest.mark.parametrize("operation", ["probe", "discovery", "discover"])
async def test_probe_uses_cas_instead_of_context_flags(
    monkeypatch: pytest.MonkeyPatch, decision: bool | RuntimeError, status: int, debug: bool, operation: str
) -> None:
    monkeypatch.setenv("CAIPE_ORG_KEY", "example")
    monkeypatch.setattr(remote_agents, "get_settings", lambda: SimpleNamespace(
        debug=debug, remote_a2a_allowed_http_origins=[], remote_a2a_max_response_bytes=1024, credential_api_url="https://credentials.example.test",
        credential_service_audience="example", remote_a2a_discovery_namespaces=[],
    ))
    decide = AsyncMock(side_effect=decision) if isinstance(decision, Exception) else AsyncMock(return_value=decision)
    monkeypatch.setattr(authz, "_decide_action", decide)
    card = AgentCard(name="Example", description="Example agent", capabilities=AgentCapabilities(streaming=True))
    resolver = Mock(return_value=SimpleNamespace(get_agent_card=AsyncMock(return_value=card)))
    monkeypatch.setattr(remote_agents, "A2ACardResolver", resolver)
    monkeypatch.setattr(remote_agents, "resolve_remote_agent_auth_headers", AsyncMock(return_value={}))
    app = FastAPI()
    app.include_router(remote_agents.router)
    body = base64.urlsafe_b64encode(json.dumps({"sub": "test-user"}).encode()).rstrip(b"=").decode()
    bearer = f"e30.{body}."
    token_ref = current_user_token.set(bearer)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.request("GET" if operation == "discovery" else "POST", f"/remote-agents/{operation}", json={"endpoint": "https://agent.example.test", "source": "urls", "urls": ["https://agent.example.test"]},
                                         headers={"X-User-Context": base64.b64encode(b'{"email":"test-user@example.test","is_admin":true}').decode()})
    finally:
        current_user_token.reset(token_ref)
    assert response.status_code == status
    decide.assert_awaited_once_with("user", "test-user", "organization", "example", bearer, "manage")
    assert resolver.call_count == (1 if status == 200 and operation != "discovery" else 0)


@pytest.mark.parametrize("operation", ["probe", "discovery", "discover"])
async def test_probe_requires_bearer_even_with_debug_and_admin_context(monkeypatch: pytest.MonkeyPatch, operation: str) -> None:
    monkeypatch.setenv("DEBUG", "true")
    decide = AsyncMock(return_value=True)
    monkeypatch.setattr(authz, "_decide_action", decide)
    app = FastAPI()
    app.include_router(remote_agents.router)
    token_ref = current_user_token.set(None)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.request("GET" if operation == "discovery" else "POST", f"/remote-agents/{operation}", json={"endpoint": "https://agent.example.test", "source": "urls", "urls": ["https://agent.example.test"]},
                                         headers={"X-User-Context": base64.b64encode(b'{"email":"test-user@example.test","is_admin":true}').decode()})
    finally:
        current_user_token.reset(token_ref)
    assert response.status_code == 401
    decide.assert_not_awaited()
