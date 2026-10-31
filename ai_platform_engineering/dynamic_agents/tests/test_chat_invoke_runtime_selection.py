from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from dynamic_agents.models import (
    ChatRequest,
    ClientContext,
    DynamicAgentConfig,
    ModelConfig,
    UserContext,
)
from dynamic_agents.routes.chat import _validate_allowed_tools_subset, chat_invoke
from dynamic_agents.services.execution_lease import NativeThreadBusyError


class _AsyncRuntimeContext:
    def __init__(self, runtime):
        self.runtime = runtime

    async def __aenter__(self):
        return self.runtime

    async def __aexit__(self, exc_type, exc, tb):
        return False


def _agent() -> DynamicAgentConfig:
    return DynamicAgentConfig(
        _id="agent-scheduled",
        name="Scheduled Agent",
        owner_id="operator@example.com",
        description="",
        system_prompt="Be useful.",
        model=ModelConfig(id="test-model", provider="test-provider"),
    )


def _mongo(agent: DynamicAgentConfig):
    mongo = MagicMock()
    mongo.get_agent.return_value = agent
    mongo.get_agent_mcp_servers.return_value = []
    return mongo


def _runtime():
    async def stream(*_args, **_kwargs):
        if False:
            yield ""

    runtime = MagicMock()
    runtime.stream = stream
    runtime.has_pending_interrupt = AsyncMock(return_value=None)
    return runtime


async def test_scheduler_invoke_uses_persistent_one_shot_runtime() -> None:
    agent = _agent()
    runtime = _runtime()
    cache = MagicMock()
    cache.get_or_create = AsyncMock(return_value=runtime)
    cache.persistent.return_value = _AsyncRuntimeContext(runtime)

    request = ChatRequest(
        message="scheduled prep",
        conversation_id="conv-1",
        agent_id=agent.id,
        client_context=ClientContext(source="scheduler"),
    )

    with (
        patch("dynamic_agents.routes.chat.get_runtime_cache", return_value=cache),
        patch(
            "dynamic_agents.routes.chat.require_agent_use_permission",
            new=AsyncMock(),
        ),
        patch(
            "dynamic_agents.routes.chat.get_settings",
            return_value=MagicMock(invoke_persist_history=False),
        ),
    ):
        response = await chat_invoke(
            request,
            user=UserContext(email="operator@example.com"),
            mongo=_mongo(agent),
        )

    assert response["success"] is True
    cache.persistent.assert_called_once()
    cache.get_or_create.assert_not_awaited()
    cache.ephemeral.assert_not_called()


async def test_regular_invoke_stays_ephemeral() -> None:
    agent = _agent()
    runtime = _runtime()
    cache = MagicMock()
    cache.get_or_create = AsyncMock()
    cache.ephemeral.return_value = _AsyncRuntimeContext(runtime)

    request = ChatRequest(
        message="one shot",
        conversation_id="conv-1",
        agent_id=agent.id,
        client_context=ClientContext(source="webui"),
    )

    with (
        patch("dynamic_agents.routes.chat.get_runtime_cache", return_value=cache),
        patch(
            "dynamic_agents.routes.chat.require_agent_use_permission",
            new=AsyncMock(),
        ),
        patch(
            "dynamic_agents.routes.chat.get_settings",
            return_value=MagicMock(invoke_persist_history=False),
        ),
    ):
        response = await chat_invoke(
            request,
            user=UserContext(email="operator@example.com"),
            mongo=_mongo(agent),
        )

    assert response["success"] is True
    cache.get_or_create.assert_not_awaited()
    cache.ephemeral.assert_called_once()


@pytest.mark.parametrize("persistent", [False, True])
async def test_only_persistent_invoke_contends_for_native_lease(persistent: bool) -> None:
    agent = _agent()
    cache = MagicMock()
    cache.ephemeral.return_value = _AsyncRuntimeContext(_runtime())
    class BusyLease:
        async def __aenter__(self) -> None:
            raise NativeThreadBusyError("busy")

        async def __aexit__(self, *args: object) -> bool:
            return False

    with (
        patch("dynamic_agents.routes.chat.get_runtime_cache", return_value=cache),
        patch("dynamic_agents.routes.chat.require_agent_use_permission", new=AsyncMock()),
        patch("dynamic_agents.routes.chat.get_settings", return_value=MagicMock(invoke_persist_history=persistent)),
        patch("dynamic_agents.routes.chat.reserve_native_thread", return_value=BusyLease()) as reserve,
    ):
        response = await chat_invoke(ChatRequest(message="example", conversation_id="example", agent_id=agent.id),
                                     user=UserContext(email="user@example.test"), mongo=_mongo(agent))
    if persistent:
        assert response.status_code == 409
        reserve.assert_called_once()
    else:
        assert response["success"] is True
        reserve.assert_not_called()


def test_per_turn_tools_cannot_widen_a_saved_tool_list() -> None:
    with pytest.raises(HTTPException, match="widen"):
        _validate_allowed_tools_subset({"example": ["read"]}, {"example": True})
    _validate_allowed_tools_subset({"example": ["read", "list"]}, {"example": ["read"]})


def test_empty_tool_list_cannot_widen_a_saved_specific_allowlist() -> None:
    with pytest.raises(HTTPException, match="widen"):
        _validate_allowed_tools_subset({"example": ["read"]}, {"example": []})
    _validate_allowed_tools_subset({"example": []}, {"example": True})
    _validate_allowed_tools_subset({"example": True}, {"example": []})
    _validate_allowed_tools_subset({"example": []}, {"example": ["read"]})
