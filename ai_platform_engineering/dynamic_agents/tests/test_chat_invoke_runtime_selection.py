"""Invocation routes retain the context used to select runtime lifetime."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from dynamic_agents.models import ChatRequest, ClientContext, DynamicAgentConfig, UserContext
from dynamic_agents.routes import chat
from dynamic_agents.services.agent_execution import InvocationResult


@pytest.mark.parametrize("source", ["scheduler", "webui"])
async def test_invoke_forwards_runtime_selection_context(monkeypatch, source):
    agent = DynamicAgentConfig(
        _id="example-agent", name="Example", owner_id="owner@example.com",
        system_prompt="Assist the caller.", model={"id": "example-model", "provider": "example-provider"},
    )
    service = SimpleNamespace(invoke=AsyncMock(return_value=InvocationResult("answer", None, None)))
    monkeypatch.setattr(chat, "AgentExecutionService", lambda _: service)
    monkeypatch.setattr(chat, "require_agent_use_permission", AsyncMock())
    context = ClientContext(source=source)
    response = await chat.chat_invoke(
        ChatRequest(message="hello", conversation_id="example-session", agent_id=agent.id, client_context=context),
        UserContext(email="caller@example.com"), MagicMock(get_agent=MagicMock(return_value=agent)),
    )
    assert response["success"] is True
    assert service.invoke.await_args.args[0].client_context == context
