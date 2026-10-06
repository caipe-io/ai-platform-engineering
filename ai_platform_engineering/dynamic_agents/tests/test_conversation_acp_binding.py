"""Conversation routes authorize access before delegating state operations."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from dynamic_agents.models import DynamicAgentConfig, UserContext
from dynamic_agents.routes import conversations
from dynamic_agents.services.agent_execution import ClearResult
from dynamic_agents.services.session_runs import SessionRunBusyError


@pytest.fixture
def environment(monkeypatch):
    agent = DynamicAgentConfig(
        _id="example-agent", name="Example", owner_id="owner@example.com", system_prompt="Assist the caller.",
        model={"id": "example-model", "provider": "example-provider"},
    )
    collection = MagicMock(find_one=MagicMock(return_value={"_id": "example-session", "agent_id": agent.id}))
    mongo = SimpleNamespace(_client=object(), _db={"conversations": collection}, get_agent=MagicMock(return_value=agent))
    service = SimpleNamespace(
        interrupt_state=AsyncMock(return_value={
            "type": "form_input", "interrupt_id": "example-interrupt", "prompt": "Choose", "fields": [],
        }),
        rewind=AsyncMock(return_value="example-checkpoint"),
        clear=AsyncMock(return_value=ClearResult(3, 4, 2)),
    )
    authorized = MagicMock(return_value=True)

    def execution(selected_mongo):
        assert selected_mongo is mongo
        return service

    factory = MagicMock(side_effect=execution)
    monkeypatch.setattr(conversations, "AgentExecutionService", factory)
    monkeypatch.setattr(conversations, "can_access_conversation", authorized)
    return SimpleNamespace(
        mongo=mongo, agent=agent, service=service, factory=factory, collection=collection, authorized=authorized,
        user=UserContext(email="caller@example.com"),
    )


async def test_interrupt_reader_delegates_after_conversation_access(environment):
    env = environment
    response = await conversations.get_interrupt_state("example-session", env.agent.id, env.user, env.mongo)
    assert response.has_pending_interrupt and response.interrupt_data.interrupt_id == "example-interrupt"
    env.authorized.assert_called_once()
    env.service.interrupt_state.assert_awaited_once_with(env.agent, "example-session", env.user)


async def test_missing_conversation_does_not_enter_execution_service(environment):
    env = environment
    env.collection.find_one.return_value = None
    response = await conversations.get_interrupt_state("example-session", env.agent.id, env.user, env.mongo)
    assert not response.has_pending_interrupt
    env.factory.assert_not_called()


@pytest.mark.parametrize("operation", ["interrupt", "rewind"])
async def test_unauthorized_conversation_cannot_enter_execution_service(environment, operation):
    env = environment
    env.authorized.return_value = False
    with pytest.raises(HTTPException) as error:
        if operation == "interrupt":
            await conversations.get_interrupt_state("example-session", env.agent.id, env.user, env.mongo)
        else:
            await conversations.rewind_conversation(
                "example-session", conversations.RewindConversationRequest(
                    agent_id=env.agent.id, turn_id="example-turn", message_content="Hello", content_occurrence=1,
                ), env.user, env.mongo,
            )
    assert error.value.status_code == 403
    env.factory.assert_not_called()


async def test_rewind_preserves_selected_turn_and_checkpoint_response(environment):
    env = environment
    response = await conversations.rewind_conversation(
        "example-session", conversations.RewindConversationRequest(
            agent_id=env.agent.id, turn_id="example-turn", message_content="Hello", content_occurrence=1,
        ), env.user, env.mongo,
    )
    assert response.data["checkpoint_id"] == "example-checkpoint"
    env.service.rewind.assert_awaited_once_with(
        env.agent, "example-session", env.user, turn_id="example-turn", message_content="Hello", content_occurrence=1,
    )


@pytest.mark.parametrize("operation", ["rewind", "clear"])
async def test_checkpoint_mutation_retains_running_turn_conflict(environment, operation):
    env = environment
    getattr(env.service, operation).side_effect = SessionRunBusyError("Example session already active")
    with pytest.raises(HTTPException) as error:
        if operation == "rewind":
            await conversations.rewind_conversation(
                "example-session", conversations.RewindConversationRequest(
                    agent_id=env.agent.id, turn_id="example-turn", message_content="Hello", content_occurrence=1,
                ), env.user, env.mongo,
            )
        else:
            await conversations.clear_conversation_checkpoints(
                "example-session", env.user.model_copy(update={"is_admin": True}), env.mongo,
            )
    assert error.value.status_code == 409


async def test_admin_clear_retains_deletion_counts(environment):
    env = environment
    response = await conversations.clear_conversation_checkpoints(
        "example-session", env.user.model_copy(update={"is_admin": True}), env.mongo,
    )
    env.service.clear.assert_awaited_once_with(env.agent.id, "example-session")
    assert response.data == {
        "conversation_id": "example-session", "checkpoints_deleted": 3, "writes_deleted": 4, "files_deleted": 2,
    }


async def test_non_admin_cannot_enter_clear_service(environment):
    env = environment
    with pytest.raises(HTTPException) as error:
        await conversations.clear_conversation_checkpoints("example-session", env.user, env.mongo)
    assert error.value.status_code == 403
    env.factory.assert_not_called()
