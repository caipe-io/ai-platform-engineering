"""The existing chat entry points share ACP admission without changing storage modes."""

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from dynamic_agents.config import Settings
from dynamic_agents.models import ChatRequest, ClientContext, DynamicAgentConfig, InputFile, UserContext
from dynamic_agents.routes import chat
from dynamic_agents.services.stream_encoders import get_encoder


def _agent() -> DynamicAgentConfig:
    return DynamicAgentConfig(
        _id="example-agent", name="Example", owner_id="owner@example.com",
        system_prompt="Assist the caller.", model={"id": "example-model", "provider": "example-provider"},
    )


@pytest.fixture
def admission(monkeypatch):
    events = []

    @asynccontextmanager
    async def lease(mongo, agent_id, session_id):
        events.append("lease")
        try:
            yield
        finally:
            events.append("release")

    @asynccontextmanager
    async def local(agent_id, session_id):
        events.append("local")
        yield

    def bind(mongo, agent, session_id, *, resume=False):
        assert events[-1] == "local"
        events.append(("binding", resume))
        return agent.model_copy(update={"system_prompt": "Saved execution configuration"})

    async def acp(runtime, **kwargs):
        events.append(("acp", kwargs))
        yield "data: preserved\n\n"

    monkeypatch.setattr(chat, "native_session_run", lease)
    monkeypatch.setattr(chat, "native_acp_turn", local)
    monkeypatch.setattr(chat, "resolve_native_binding", bind)
    monkeypatch.setattr(chat, "native_acp_stream", acp)
    monkeypatch.setattr(chat, "require_agent_use_permission", AsyncMock())
    monkeypatch.setattr(chat, "get_settings", lambda: Settings(native_acp_enabled=True))
    return events


@pytest.mark.parametrize("resume", [False, True])
async def test_stream_binds_before_runtime_and_preserves_turn_envelope(monkeypatch, admission, resume):
    agent, user = _agent(), UserContext(email="caller@example.com")
    cache = MagicMock(get_or_create=AsyncMock(return_value=SimpleNamespace()))
    mongo = MagicMock()
    mongo.get_agent_mcp_servers.return_value = []
    monkeypatch.setattr(chat, "get_runtime_cache", lambda: cache)
    files = [InputFile(mime_type="image/png", data="aGVsbG8=", name="example.png")]
    encoder = get_encoder("agui")
    shared = dict(agent_config=agent, mcp_servers=[], session_id="native-thread", user=user,
                  encoder=encoder, trace_id="trace", mongo=mongo)
    if resume:
        stream = chat._generate_resume_sse_events(
            **shared, resume_data='{"type":"tool_approval","decision":"edit"}',
            client_context=ClientContext(source="webui"),
        )
    else:
        stream = chat._generate_sse_events(
            **shared, message="hello", files=files, turn_id="turn", client_context=ClientContext(source="webui"),
        )
    assert [frame async for frame in stream] == ["data: preserved\n\n"]
    assert admission[:3] == ["lease", "local", ("binding", resume)]
    assert admission[-1] == "release"
    selected = cache.get_or_create.await_args.args[0]
    assert selected.system_prompt == "Saved execution configuration"
    assert cache.get_or_create.await_args.args[2] == "native-thread"
    assert cache.get_or_create.await_args.kwargs["client_context"] == ClientContext(source="webui")
    envelope = admission[3][1]
    assert envelope["session_id"] == "native-thread"
    assert envelope["encoder"] is encoder
    assert envelope["user_email"] == user.email
    assert envelope["trace_id"] == "trace"
    if resume:
        assert envelope["resume_data"] == '{"type":"tool_approval","decision":"edit"}'
    else:
        assert envelope["files"] == files and envelope["turn_id"] == "turn"


@pytest.mark.parametrize(("scheduler", "persistent"), [(False, False), (False, True), (True, False)])
async def test_invoke_preserves_persistence_and_uses_acp(monkeypatch, admission, scheduler, persistent):
    monkeypatch.setattr(chat, "get_settings", lambda: Settings(native_acp_enabled=True, invoke_persist_history=persistent))
    runtime = SimpleNamespace(has_pending_interrupt=AsyncMock(return_value=None))

    @asynccontextmanager
    async def managed(*args, **kwargs):
        yield runtime

    cache = MagicMock(get_or_create=AsyncMock(return_value=runtime))
    cache.persistent.side_effect = managed
    cache.ephemeral.side_effect = managed
    monkeypatch.setattr(chat, "get_runtime_cache", lambda: cache)
    agent, mongo = _agent(), MagicMock()
    mongo.get_agent.return_value = agent
    mongo.get_agent_mcp_servers.return_value = []
    response = await chat.chat_invoke(
        ChatRequest(message="hello", agent_id=agent.id, conversation_id="native-thread",
                    client_context=ClientContext(source="scheduler" if scheduler else "webui")),
        UserContext(email="caller@example.com"), mongo,
    )
    assert response["success"] is True
    assert any(isinstance(event, tuple) and event[0] == "acp" for event in admission)
    assert (("binding", False) in admission) == (scheduler or persistent)
    if scheduler:
        cache.persistent.assert_called_once()
        cache.get_or_create.assert_not_awaited()
    elif persistent:
        cache.get_or_create.assert_awaited_once()
    else:
        cache.ephemeral.assert_called_once()
        mongo.get_session_bindings_collection.assert_not_called()
    assert admission[-1] == "release"


async def test_rollback_uses_direct_runtime_without_acp_or_binding(monkeypatch):
    monkeypatch.setattr(chat, "get_settings", lambda: Settings(native_acp_enabled=False))
    acp = MagicMock(side_effect=AssertionError("ACP disabled"))
    monkeypatch.setattr(chat, "native_acp_stream", acp)

    async def stream(*args, **kwargs):
        yield "original frame"

    runtime = SimpleNamespace(stream=stream)
    async with chat._native_turn("example-agent", "thread", MagicMock()):
        frames = [frame async for frame in chat._stream_native(
            runtime, message="hello", session_id="thread", user_email="caller@example.com", encoder=get_encoder(),
        )]
    assert frames == ["original frame"]
    acp.assert_not_called()


async def test_cancel_reaches_remote_owner_without_requiring_agent_use(monkeypatch):
    monkeypatch.setattr(chat, "get_settings", lambda: Settings(native_acp_enabled=True))
    monkeypatch.setattr(chat, "require_agent_use_permission", AsyncMock(side_effect=AssertionError("cancellation denied")))
    monkeypatch.setattr(chat, "cancel_native_acp", lambda *_: False)
    remote = MagicMock(return_value=True)
    monkeypatch.setattr(chat, "request_native_session_cancel", remote)
    cache, mongo = MagicMock(), MagicMock()
    mongo.get_agent.return_value = _agent()
    monkeypatch.setattr(chat, "get_runtime_cache", lambda: cache)
    response = await chat.cancel_stream(
        chat.CancelStreamRequest(agent_id="example-agent", conversation_id="thread"),
        UserContext(email="caller@example.com"), mongo,
    )
    assert response["cancelled"] is True
    remote.assert_called_once_with(mongo, "example-agent", "thread")
    cache.cancel_stream.assert_not_called()
