"""Conversation state operations retain admitted native storage coordinates."""

import asyncio
import threading
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from dynamic_agents.config import Settings
from dynamic_agents.models import AgentBackend, AgentBackendConfig, DynamicAgentConfig, UserContext
from dynamic_agents.routes import conversations
from dynamic_agents.services.session_runs import SessionRunBusyError


def _agent(*, saved: bool = False) -> DynamicAgentConfig:
    return DynamicAgentConfig(
        _id="example-agent", name="Example", owner_id="owner@example.com", system_prompt="Assist the caller.",
        model={"id": "example-model", "provider": "example-provider"},
        backend=AgentBackend(type="store", config=AgentBackendConfig(
            checkpoint_collection="saved_checkpoints", fs_namespace=["shared", "example-run", "filesystem"],
        )) if saved else None,
    )


@pytest.fixture
def environment(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    current, saved = _agent(), _agent(saved=True)
    events: list[str] = []
    collections = {
        name: MagicMock() for name in ["conversations", "saved_checkpoints", "saved_checkpoints_writes", "checkpoints", "writes"]
    }
    collections["conversations"].find_one.return_value = {"_id": "example-session", "agent_id": current.id}
    mongo = SimpleNamespace(
        _client=object(), _db=collections,
        get_agent=MagicMock(return_value=current), get_agent_mcp_servers=MagicMock(return_value=[]),
    )
    runtime = SimpleNamespace(
        _graph=object(), has_pending_interrupt=AsyncMock(return_value={
            "type": "form_input", "interrupt_id": "example-interrupt", "prompt": "Choose", "fields": [],
        }),
        rewind_before_turn=AsyncMock(return_value="example-checkpoint"),
    )

    async def cached(*args, **kwargs):
        events.append("cache")
        return runtime

    cache = MagicMock(get_or_create=AsyncMock(side_effect=cached))

    def binding(*args):
        events.append("binding")
        return saved

    def authorized(*args):
        events.append("auth")
        return True

    @asynccontextmanager
    async def lease(*args):
        events.append("lease")
        try:
            yield
        finally:
            events.append("release")

    lookup = MagicMock(side_effect=binding)
    settings = Settings(native_acp_enabled=True, checkpoint_collection="checkpoints", checkpoint_writes_collection="writes")
    monkeypatch.setattr(conversations, "get_settings", lambda: settings)
    monkeypatch.setattr(conversations, "get_native_binding", lookup)
    monkeypatch.setattr(conversations, "get_runtime_cache", lambda: cache)
    monkeypatch.setattr(conversations, "can_access_conversation", authorized)
    monkeypatch.setattr(conversations, "native_session_run", lease)
    store = MagicMock(delete_by_namespace=MagicMock(return_value=2))
    monkeypatch.setattr(conversations, "_get_gridfs_store", lambda db: store)
    return SimpleNamespace(
        mongo=mongo, saved=saved, current=current, events=events, cache=cache, runtime=runtime,
        collections=collections, lookup=lookup, settings=settings, store=store,
        user=UserContext(email="caller@example.com"),
    )


async def test_interrupt_reader_preserves_saved_backend_after_access(environment):
    env = environment
    response = await conversations.get_interrupt_state("example-session", env.current.id, env.user, env.mongo)
    assert response.has_pending_interrupt
    assert env.events == ["auth", "binding", "cache"]
    env.lookup.assert_called_once_with(env.mongo, env.current.id, "example-session")
    assert env.cache.get_or_create.await_args.args[0].backend == env.saved.backend
    env.mongo.get_agent_mcp_servers.assert_called_once_with(env.saved)
    env.runtime.has_pending_interrupt.assert_awaited_once_with("example-session")


async def test_missing_conversation_does_not_read_or_create_binding(environment):
    env = environment
    env.collections["conversations"].find_one.return_value = None
    response = await conversations.get_interrupt_state("example-session", env.current.id, env.user, env.mongo)
    assert not response.has_pending_interrupt
    env.lookup.assert_not_called()
    env.cache.get_or_create.assert_not_awaited()


async def test_unauthorized_conversation_cannot_read_binding(environment, monkeypatch):
    env = environment
    monkeypatch.setattr(conversations, "can_access_conversation", lambda *_: False)
    with pytest.raises(HTTPException) as error:
        await conversations.get_interrupt_state("example-session", env.current.id, env.user, env.mongo)
    assert error.value.status_code == 403
    env.lookup.assert_not_called()


async def test_unbound_legacy_reader_uses_current_agent_without_admission(environment):
    env = environment
    env.lookup.side_effect = lambda *_: None
    await conversations.get_interrupt_state("example-session", env.current.id, env.user, env.mongo)
    assert env.cache.get_or_create.await_args.args[0] == env.current
    env.lookup.assert_called_once()


async def test_rewind_reserves_turn_before_cache_and_uses_saved_backend(environment):
    env = environment
    response = await conversations.rewind_conversation(
        "example-session", conversations.RewindConversationRequest(
            agent_id=env.current.id, turn_id="example-turn", message_content="Hello", content_occurrence=1,
        ), env.user, env.mongo,
    )
    assert response.data["checkpoint_id"] == "example-checkpoint"
    assert env.events == ["auth", "lease", "binding", "cache", "release"]
    assert env.cache.get_or_create.await_args.args[0].backend == env.saved.backend
    env.runtime.rewind_before_turn.assert_awaited_once_with("example-session", "example-turn", "Hello", 1)


@pytest.mark.parametrize("operation", ["rewind", "clear"])
async def test_checkpoint_mutation_rejects_running_turn(environment, monkeypatch, operation):
    env = environment

    @asynccontextmanager
    async def busy(*args):
        raise SessionRunBusyError("Example session already active")
        yield

    monkeypatch.setattr(conversations, "native_session_run", busy)
    with pytest.raises(HTTPException) as error:
        if operation == "rewind":
            await conversations.rewind_conversation(
                "example-session", conversations.RewindConversationRequest(
                    agent_id=env.current.id, turn_id="example-turn", message_content="Hello", content_occurrence=1,
                ), env.user, env.mongo,
            )
        else:
            await conversations.clear_conversation_checkpoints(
                "example-session", env.user.model_copy(update={"is_admin": True}), env.mongo,
            )
    assert error.value.status_code == 409
    env.lookup.assert_not_called()
    env.cache.get_or_create.assert_not_awaited()
    env.collections["saved_checkpoints"].delete_many.assert_not_called()


async def test_admin_clear_uses_saved_checkpoint_collection_and_filesystem_namespace(environment):
    env = environment
    env.collections["saved_checkpoints"].delete_many.return_value.deleted_count = 3
    env.collections["saved_checkpoints_writes"].delete_many.return_value.deleted_count = 4
    response = await conversations.clear_conversation_checkpoints(
        "example-session", env.user.model_copy(update={"is_admin": True}), env.mongo,
    )
    env.collections["saved_checkpoints"].delete_many.assert_called_once_with({"thread_id": "example-session"})
    env.collections["saved_checkpoints_writes"].delete_many.assert_called_once_with({"thread_id": "example-session"})
    env.collections["checkpoints"].delete_many.assert_not_called()
    env.collections["writes"].delete_many.assert_not_called()
    env.store.delete_by_namespace.assert_called_once_with(("shared", "example-run", "filesystem"))
    assert response.data["checkpoints_deleted"] == 3
    assert response.data["writes_deleted"] == 4
    assert response.data["files_deleted"] == 2
    assert env.events == ["lease", "binding", "release"]


async def test_non_admin_cannot_look_up_clear_binding(environment):
    env = environment
    with pytest.raises(HTTPException) as error:
        await conversations.clear_conversation_checkpoints("example-session", env.user, env.mongo)
    assert error.value.status_code == 403
    env.lookup.assert_not_called()


async def test_disabled_acp_reader_does_not_use_binding_or_lease(environment):
    env = environment
    env.settings.native_acp_enabled = False
    await conversations.get_interrupt_state("example-session", env.current.id, env.user, env.mongo)
    assert env.events == ["auth", "cache"]
    env.lookup.assert_not_called()
    assert env.cache.get_or_create.await_args.args[0] == env.current


async def test_clear_does_not_release_lease_before_cancelled_thread_finishes(environment):
    env = environment
    started = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()

    def delete(query):
        loop.call_soon_threadsafe(started.set)
        if not release.wait(timeout=5):
            raise RuntimeError("Example delete was not released")
        env.events.append("delete-finished")
        return SimpleNamespace(deleted_count=1)

    env.collections["saved_checkpoints"].delete_many.side_effect = delete
    task = asyncio.create_task(conversations.clear_conversation_checkpoints(
        "example-session", env.user.model_copy(update={"is_admin": True}), env.mongo,
    ))
    try:
        await started.wait()
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        assert "release" not in env.events
    finally:
        release.set()
    result = await asyncio.gather(task, return_exceptions=True)
    assert isinstance(result[0], asyncio.CancelledError)
    assert env.events[-2:] == ["delete-finished", "release"]
    env.collections["saved_checkpoints_writes"].delete_many.assert_not_called()
