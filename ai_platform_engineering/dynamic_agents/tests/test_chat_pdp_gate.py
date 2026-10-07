"""Route-level tests for Dynamic Agents OpenFGA execution gates."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from dynamic_agents.models import ChatRequest, DynamicAgentConfig, UserContext
from dynamic_agents.routes import chat


def _agent() -> DynamicAgentConfig:
    return DynamicAgentConfig(
        _id="agent-1",
        name="Platform Agent",
        description="Test agent",
        system_prompt="help",
        model={"id": "test-model", "provider": "test-provider"},
        owner_id="owner@example.com",
    )


class _FakeMongo:
    def __init__(self) -> None:
        self.get_agent_calls = 0

    def get_agent(self, agent_id: str) -> DynamicAgentConfig:
        self.get_agent_calls += 1
        return _agent()

    def get_agent_mcp_servers(self, agent: DynamicAgentConfig) -> list:
        raise AssertionError("MCP lookup should not happen before authorization")


class _FakeRuntimeCache:
    def __init__(self) -> None:
        self.cancel_calls: list[tuple[str, str]] = []

    def cancel_stream(self, agent_id: str, conversation_id: str) -> bool:
        self.cancel_calls.append((agent_id, conversation_id))
        return True


async def _deny(agent_id: str, delegated_user_sub: str | None = None) -> None:
    raise HTTPException(
        status_code=403,
        detail={
            "success": False,
            "code": "agent#use",
            "reason": "pdp_denied",
            "action": "contact_admin",
        },
    )


async def _unavailable(agent_id: str, delegated_user_sub: str | None = None) -> None:
    raise HTTPException(
        status_code=503,
        detail={
            "success": False,
            "code": "PDP_UNAVAILABLE",
            "reason": "pdp_unavailable",
            "action": "retry",
        },
    )


async def _missing_bearer(agent_id: str, delegated_user_sub: str | None = None) -> None:
    raise HTTPException(
        status_code=401,
        detail={
            "success": False,
            "code": "missing_bearer",
            "reason": "not_signed_in",
            "action": "sign_in",
        },
    )


async def _invalid_bearer(agent_id: str, delegated_user_sub: str | None = None) -> None:
    raise HTTPException(
        status_code=401,
        detail={
            "success": False,
            "code": "bearer_invalid",
            "reason": "bearer_invalid",
            "action": "sign_in",
        },
    )


def _user() -> UserContext:
    return UserContext(email="alice@example.com")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("handler", "chat_request"),
    [
        (
            chat.chat_start_stream,
            ChatRequest(message="hi", conversation_id="conv-1", agent_id="agent-1"),
        ),
        (
            chat.chat_invoke,
            ChatRequest(message="hi", conversation_id="conv-1", agent_id="agent-1"),
        ),
        (
            chat.chat_resume_stream,
            chat.ResumeStreamRequest(conversation_id="conv-1", agent_id="agent-1", resume_data="{}"),
        ),
    ],
)
async def test_protected_routes_stop_before_runtime_work(monkeypatch, handler, chat_request):
    monkeypatch.setattr(chat, "require_agent_use_permission", _deny, raising=False)
    mongo = _FakeMongo()

    with pytest.raises(HTTPException) as exc:
        await handler(chat_request, _user(), mongo)

    assert exc.value.status_code == 403
    assert exc.value.detail["reason"] == "pdp_denied"
    assert mongo.get_agent_calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("authz", "status", "code", "reason", "action"),
    [
        (_deny, 403, "agent#use", "pdp_denied", "contact_admin"),
        (_unavailable, 503, "PDP_UNAVAILABLE", "pdp_unavailable", "retry"),
        (_missing_bearer, 401, "missing_bearer", "not_signed_in", "sign_in"),
        (_invalid_bearer, 401, "bearer_invalid", "bearer_invalid", "sign_in"),
    ],
)
async def test_start_route_preserves_authz_failure_shape(monkeypatch, authz, status, code, reason, action):
    monkeypatch.setattr(chat, "require_agent_use_permission", authz, raising=False)

    with pytest.raises(HTTPException) as exc:
        await chat.chat_start_stream(
            ChatRequest(message="hi", conversation_id="conv-1", agent_id="agent-1"),
            _user(),
            _FakeMongo(),
        )

    assert exc.value.status_code == status
    assert exc.value.detail["code"] == code
    assert exc.value.detail["reason"] == reason
    assert exc.value.detail["action"] == action


@pytest.mark.asyncio
async def test_cancel_stream_remains_openfga_ungated(monkeypatch):
    async def fail_if_called(agent_id: str, delegated_user_sub: str | None = None) -> None:
        raise AssertionError("cancel must not be OpenFGA gated")

    cache = _FakeRuntimeCache()
    monkeypatch.setattr(chat, "require_agent_use_permission", fail_if_called, raising=False)
    monkeypatch.setattr(chat, "get_runtime_cache", lambda: cache)
    mongo = _FakeMongo()

    result = await chat.cancel_stream(
        chat.CancelStreamRequest(conversation_id="conv-1", agent_id="agent-1"),
        _user(),
        mongo,
    )

    assert result["success"] is True
    assert result["cancelled"] is True
    assert cache.cancel_calls == [("agent-1", "conv-1")]
