from unittest.mock import AsyncMock, MagicMock, patch

from dynamic_agents.models import DynamicAgentConfig, ModelConfig, UserContext
from dynamic_agents.routes.conversations import get_interrupt_state


class _AsyncRuntimeContext:
    def __init__(self, runtime):
        self.runtime = runtime

    async def __aenter__(self):
        return self.runtime

    async def __aexit__(self, exc_type, exc, tb):
        return False


async def test_interrupt_state_uses_non_cached_runtime() -> None:
    """A proof-less UI probe must not cache a degraded private-MCP runtime."""

    agent = DynamicAgentConfig(
        _id="agent-sre",
        name="SRE Agent",
        owner_id="operator@example.com",
        description="",
        system_prompt="Be useful.",
        model=ModelConfig(id="test-model", provider="test-provider"),
    )
    mongo = MagicMock()
    mongo._client = object()
    mongo._db = MagicMock()
    mongo._db.__getitem__.return_value.find_one.return_value = {
        "_id": "conv-1",
        "user_id": "operator@example.com",
    }
    mongo.get_agent.return_value = agent
    mongo.get_agent_mcp_servers.return_value = []

    runtime = MagicMock()
    runtime._graph = object()
    runtime.has_pending_interrupt = AsyncMock(return_value=None)

    cache = MagicMock()
    cache.get_or_create = AsyncMock()
    cache.reader.return_value = _AsyncRuntimeContext(runtime)

    with (
        patch(
            "dynamic_agents.routes.conversations.can_access_conversation",
            return_value=True,
        ),
        patch(
            "dynamic_agents.routes.conversations.get_runtime_cache",
            return_value=cache,
        ),
    ):
        response = await get_interrupt_state(
            "conv-1",
            agent_id=agent.id,
            user=UserContext(email="operator@example.com"),
            mongo=mongo,
        )

    assert response.has_pending_interrupt is False
    cache.reader.assert_called_once_with(
        agent,
        [],
        "conv-1",
        user=UserContext(email="operator@example.com"),
    )
    cache.get_or_create.assert_not_awaited()
    runtime.has_pending_interrupt.assert_awaited_once_with("conv-1")
