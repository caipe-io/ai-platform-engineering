"""HTTP chat contracts delegate execution through the canonical service."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from dynamic_agents.models import ChatRequest, ClientContext, DynamicAgentConfig, InputFile, UserContext
from dynamic_agents.routes import chat
from dynamic_agents.services.agent_execution import InvocationResult
from dynamic_agents.services.session_runs import SessionRunBusyError


def _agent() -> DynamicAgentConfig:
    return DynamicAgentConfig(
        _id="example-agent", name="Example", owner_id="owner@example.com",
        system_prompt="Assist the caller.", model={"id": "example-model", "provider": "example-provider"},
    )


@pytest.mark.parametrize("resume", [False, True])
@pytest.mark.parametrize("protocol", ["custom", "agui"])
async def test_stream_routes_preserve_turn_envelope(monkeypatch, resume, protocol):
    agent, user = _agent(), UserContext(email="caller@example.com")
    mongo = MagicMock(get_agent=MagicMock(return_value=agent))
    files = [InputFile(mime_type="image/png", data="aGVsbG8=", name="example.png")]
    context = ClientContext(source="webui")
    calls = []

    async def stream(turn, encoder):
        calls.append((turn, encoder))
        yield "data: preserved\n\n"

    service = SimpleNamespace(stream=stream)
    factory = MagicMock(return_value=service)
    monkeypatch.setattr(chat, "AgentExecutionService", factory)
    monkeypatch.setattr(chat, "require_agent_use_permission", AsyncMock())
    if resume:
        request = chat.ResumeStreamRequest(
            agent_id=agent.id, conversation_id="native-thread", protocol=protocol,
            resume_data='{"type":"tool_approval","decision":"edit"}',
            client_context=context, trace_id="trace",
        )
        response = await chat.chat_resume_stream(request, user, mongo)
    else:
        request = ChatRequest(
            agent_id=agent.id, conversation_id="native-thread", protocol=protocol,
            message="hello", files=files, turn_id="turn", client_context=context, trace_id="trace",
        )
        response = await chat.chat_start_stream(request, user, mongo)
    assert [frame async for frame in response.body_iterator] == ["data: preserved\n\n"]
    factory.assert_called_once_with(mongo)
    turn, encoder = calls[0]
    assert turn.agent == agent and turn.user == user
    assert turn.session_id == "native-thread" and turn.trace_id == "trace"
    assert turn.client_context == context
    assert encoder.__class__ is chat.get_encoder(protocol).__class__
    if resume:
        assert turn.resume_data == request.resume_data and turn.message is None
    else:
        assert turn.message == "hello" and turn.files == files and turn.turn_id == "turn"


async def test_invoke_preserves_result_and_turn_metadata(monkeypatch):
    agent, user = _agent(), UserContext(email="caller@example.com")
    mongo = MagicMock(get_agent=MagicMock(return_value=agent))
    service = SimpleNamespace(invoke=AsyncMock(return_value=InvocationResult("answer", "reasoning", None)))
    monkeypatch.setattr(chat, "AgentExecutionService", lambda _: service)
    monkeypatch.setattr(chat, "require_agent_use_permission", AsyncMock())
    response = await chat.chat_invoke(
        ChatRequest(message="hello", agent_id=agent.id, conversation_id="native-thread", trace_id="trace", turn_id="turn"),
        user, mongo,
    )
    assert response == {
        "success": True, "content": "answer", "thinking": "reasoning", "agent_id": agent.id,
        "conversation_id": "native-thread", "trace_id": "trace",
    }
    turn = service.invoke.await_args.args[0]
    assert turn.agent == agent and turn.user == user and turn.turn_id == "turn"


@pytest.mark.parametrize("interrupt", [None, {"type": "tool_approval"}])
async def test_invoke_retains_human_input_response_contract(monkeypatch, interrupt):
    agent = _agent()
    service = SimpleNamespace(invoke=AsyncMock(return_value=InvocationResult("answer", None, interrupt)))
    monkeypatch.setattr(chat, "AgentExecutionService", lambda _: service)
    monkeypatch.setattr(chat, "require_agent_use_permission", AsyncMock())
    response = await chat.chat_invoke(
        ChatRequest(message="hello", agent_id=agent.id, conversation_id="native-thread"),
        UserContext(email="caller@example.com"), MagicMock(get_agent=MagicMock(return_value=agent)),
    )
    if interrupt:
        assert response.status_code == 400
        assert json.loads(response.body)["interrupt_type"] == "tool_approval"
    else:
        assert response["success"] is True


async def test_invoke_retains_busy_response_contract(monkeypatch):
    agent = _agent()
    service = SimpleNamespace(invoke=AsyncMock(side_effect=SessionRunBusyError("active turn")))
    monkeypatch.setattr(chat, "AgentExecutionService", lambda _: service)
    monkeypatch.setattr(chat, "require_agent_use_permission", AsyncMock())
    response = await chat.chat_invoke(
        ChatRequest(message="hello", agent_id=agent.id, conversation_id="native-thread"),
        UserContext(email="caller@example.com"), MagicMock(get_agent=MagicMock(return_value=agent)),
    )
    assert response.status_code == 503
    assert json.loads(response.body)["success"] is False
