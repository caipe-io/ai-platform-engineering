"""Keep model-output exhaustion actionable at every chat boundary."""

import importlib
import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from dynamic_agents.models import ChatRequest, DynamicAgentConfig, ModelConfig, UserContext
from dynamic_agents.services.agent_execution import AgentExecutionService
from dynamic_agents.services.stream_encoders import get_encoder
from dynamic_agents.services.tool_call_recovery import ToolCallRecoveryError

chat = importlib.import_module("dynamic_agents.routes.chat")
ERROR = "The model reached its output token limit. Stopped after one unsuccessful repair attempt."


async def _failed_stream(*args: Any, **kwargs: Any) -> AsyncGenerator[str, None]:
    raise ToolCallRecoveryError(ERROR)
    yield ""  # Makes this the same async-generator contract as stream/resume.


def _service(monkeypatch: pytest.MonkeyPatch, agent: DynamicAgentConfig) -> AgentExecutionService:
    runtime = SimpleNamespace(config=agent, stream=_failed_stream, resume=_failed_stream)

    @asynccontextmanager
    async def borrow(*args: Any, **kwargs: Any) -> Any:
        yield runtime

    service = AgentExecutionService(None)
    monkeypatch.setattr(service, "_runtime", borrow)
    monkeypatch.setattr(chat, "AgentExecutionService", lambda _: service)
    return service


@pytest.mark.parametrize("protocol", ["custom", "agui"])
@pytest.mark.parametrize("resume", [False, True])
async def test_stream_error_preserves_reason(monkeypatch: pytest.MonkeyPatch, protocol: str, resume: bool) -> None:
    agent = DynamicAgentConfig(
        _id="example-agent",
        name="Example Agent",
        system_prompt="Help",
        owner_id="user@example.com",
        model=ModelConfig(id="test", provider="test"),
    )
    _service(monkeypatch, agent)
    kwargs = dict(
        agent_config=agent,
        session_id="example",
        user=UserContext(email="user@example.com"),
        encoder=get_encoder(protocol),
    )
    frames = (
        chat._generate_sse_events(**kwargs, message=None, resume_data="continue")
        if resume
        else chat._generate_sse_events(**kwargs, message="start")
    )
    wire = "".join([frame async for frame in frames])
    assert ERROR in wire and chat.GENERIC_AGENT_ERROR not in wire


async def test_invoke_returns_actionable_422(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chat, "_enforce_chat_authz", AsyncMock())
    agent = DynamicAgentConfig(
        _id="example-agent",
        name="Example Agent",
        system_prompt="Help",
        owner_id="user@example.com",
        model=ModelConfig(id="test", provider="test"),
    )
    _service(monkeypatch, agent)
    mongo = MagicMock(get_agent=MagicMock(return_value=agent), get_agent_mcp_servers=MagicMock(return_value=[]))
    response = await chat.chat_invoke(
        ChatRequest(message="start", agent_id=agent.id, conversation_id="example"),
        user=UserContext(email="user@example.com"),
        mongo=mongo,
    )
    assert response.status_code == 422
    assert json.loads(response.body)["error"] == ERROR
