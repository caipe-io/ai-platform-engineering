"""Canonical execution preserves admission, lifetime, state and rollback contracts."""

import asyncio
import threading
from contextlib import asynccontextmanager
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from pymongo import ReturnDocument

from dynamic_agents.config import Settings
from dynamic_agents.models import (
    AgentBackend,
    AgentBackendConfig,
    ClientContext,
    DynamicAgentConfig,
    InputFile,
    UserContext,
)
from dynamic_agents.services import agent_execution as execution
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.session_bindings import (
    SESSION_BINDINGS_COLLECTION,
    SessionBindingError,
    get_native_binding,
    resolve_native_binding,
)
from dynamic_agents.services.session_runs import SessionRunBusyError
from dynamic_agents.services.stream_encoders import get_encoder


def _agent(**updates):
    return DynamicAgentConfig(
        _id="example-agent", name="Example", owner_id="owner@example.com", system_prompt="Assist the caller.",
        model={"id": "example-model", "provider": "example-provider"},
    ).model_copy(update=updates, deep=True)


class _BindingCollection:
    """Atomic collection sufficient for the actual durable binding repository."""

    def __init__(self):
        self.rows = {}
        self.lock = threading.Lock()

    def find_one(self, query):
        with self.lock:
            return deepcopy(self.rows.get((query["agent_id"], query["session_id"])))

    def find_one_and_update(self, query, update, *, upsert=False, return_document):
        assert return_document == ReturnDocument.AFTER
        key = (query["agent_id"], query["session_id"])
        with self.lock:
            row = self.rows.get(key)
            if row is None and upsert:
                row = deepcopy(update["$setOnInsert"])
                self.rows[key] = row
            if row is None or any(row.get(field) != value for field, value in query.items()):
                return None
            row.update(deepcopy(update.get("$set", {})))
            for field, increment in update.get("$inc", {}).items():
                row[field] += increment
            return deepcopy(row)


def _cached_borrow(cache, state):
    @asynccontextmanager
    async def borrow(*args, read_only=False, **kwargs):
        state.borrowed += 1
        try:
            yield await cache.get_or_create(*args, **kwargs)
        finally:
            state.borrowed -= 1

    return borrow


@pytest.fixture
def environment(monkeypatch):
    settings = Settings(native_acp_enabled=True)
    state = SimpleNamespace(leased=False, borrowed=0, acquisitions=0, calls=[], acp_calls=[])

    @asynccontextmanager
    async def lease(*args):
        assert not state.leased
        state.leased = True
        state.acquisitions += 1
        try:
            yield
        finally:
            assert state.borrowed == 0
            state.leased = False

    @asynccontextmanager
    async def local(*args):
        yield

    async def stream(*args, **kwargs):
        state.calls.append(("stream", args, kwargs))
        yield "preserved frame"

    async def resume(*args, **kwargs):
        state.calls.append(("resume", args, kwargs))
        yield "preserved frame"

    async def acp(runtime, **kwargs):
        state.acp_calls.append((runtime, kwargs))
        yield "preserved frame"

    runtime = SimpleNamespace(
        stream=stream, resume=resume, _graph=object(),
        has_pending_interrupt=AsyncMock(return_value=None), rewind_before_turn=AsyncMock(return_value="checkpoint"),
    )

    @asynccontextmanager
    async def managed(*args, **kwargs):
        yield runtime

    cache = MagicMock(get_or_create=AsyncMock(return_value=runtime), invalidate=AsyncMock(return_value=True))
    cache.borrow.side_effect = _cached_borrow(cache, state)
    cache.persistent.side_effect = managed
    cache.ephemeral.side_effect = managed
    mongo = MagicMock(get_agent_mcp_servers=MagicMock(return_value=[]))
    saved = MagicMock(return_value=None)
    admit = MagicMock(side_effect=lambda mongo, agent, session, **kwargs: agent)
    monkeypatch.setattr(execution, "native_session_run", lease)
    monkeypatch.setattr(execution, "native_acp_turn", local)
    monkeypatch.setattr(execution, "native_acp_stream", acp)
    monkeypatch.setattr(execution, "get_native_binding", saved)
    monkeypatch.setattr(execution, "resolve_native_binding", admit)
    return SimpleNamespace(
        settings=settings, state=state, cache=cache, mongo=mongo, runtime=runtime, saved=saved, admit=admit,
        service=execution.AgentExecutionService(mongo, settings=settings, cache=cache),
        user=UserContext(email="caller@example.com"),
    )


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("resume", [False, True])
async def test_stream_preserves_turn_and_transport_contract(environment, enabled, resume):
    env = environment
    env.settings.native_acp_enabled = enabled
    files = [InputFile(mime_type="image/png", data="aGVsbG8=", name="example.png")]
    context = ClientContext(source="webui")
    turn = execution.ExecutionTurn(
        agent=_agent(), session_id="original-thread", user=env.user, message=None if resume else "hello",
        files=files, client_context=context, trace_id="trace", turn_id="turn",
        resume_data='{"type":"tool_approval","decision":"edit"}' if resume else None,
    )
    encoder = get_encoder("agui")
    assert [frame async for frame in env.service.stream(turn, encoder)] == ["preserved frame"]
    args, kwargs = env.cache.get_or_create.await_args
    assert args[2] == "original-thread" and kwargs == {"user": env.user, "client_context": context}
    assert not env.state.leased and env.state.acquisitions == 1
    if enabled:
        _, envelope = env.state.acp_calls[0]
        assert envelope == {
            "message": turn.message, "session_id": turn.session_id, "user_email": env.user.email,
            "encoder": encoder, "trace_id": "trace", "files": files, "turn_id": "turn", "resume_data": turn.resume_data,
        }
        assert env.state.calls == []
        assert env.admit.call_args.kwargs["resume"] is resume
    else:
        env.admit.assert_not_called()
        assert not env.state.acp_calls
        kind, args, kwargs = env.state.calls[0]
        assert kind == ("resume" if resume else "stream")
        assert "original-thread" in args and env.user.email in args
        if not resume:
            assert kwargs == {"files": files, "turn_id": "turn"}


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("scheduler", [False, True])
@pytest.mark.parametrize("persist_history", [False, True])
async def test_invoke_keeps_native_runtime_lifetime(environment, enabled, scheduler, persist_history):
    env = environment
    env.settings.native_acp_enabled, env.settings.invoke_persist_history = enabled, persist_history
    interrupt = {"type": "tool_approval", "interrupt_id": "approval"}
    env.runtime.has_pending_interrupt.return_value = interrupt
    turn = execution.ExecutionTurn(
        agent=_agent(), session_id="original-thread", user=env.user, message="hello",
        client_context=ClientContext(source="scheduler" if scheduler else "webui"),
    )
    result = await env.service.invoke(turn)
    assert result.interrupt == interrupt
    env.runtime.has_pending_interrupt.assert_awaited_once_with("original-thread")
    if scheduler:
        env.cache.persistent.assert_called_once()
        env.cache.get_or_create.assert_not_awaited()
        env.cache.ephemeral.assert_not_called()
    elif persist_history:
        env.cache.get_or_create.assert_awaited_once()
        env.cache.persistent.assert_not_called()
        env.cache.ephemeral.assert_not_called()
    else:
        env.cache.ephemeral.assert_called_once()
        env.cache.get_or_create.assert_not_awaited()
        env.saved.assert_not_called()
    assert env.admit.called is (enabled and (scheduler or persist_history))
    assert bool(env.state.acp_calls) is enabled
    assert not env.state.leased and env.state.acquisitions == 1


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("failure", [SessionRunBusyError("active turn"), SessionBindingError("storage unavailable")])
async def test_failed_admission_cannot_construct_or_execute_runtime(environment, monkeypatch, failure, enabled):
    env = environment
    env.settings.native_acp_enabled = enabled
    if isinstance(failure, SessionRunBusyError):
        @asynccontextmanager
        async def busy(*args):
            raise failure
            yield
        monkeypatch.setattr(execution, "native_session_run", busy)
    elif enabled:
        env.admit.side_effect = failure
    else:
        env.saved.side_effect = failure
    turn = execution.ExecutionTurn(agent=_agent(), session_id="thread", user=env.user, message="hello")
    with pytest.raises(type(failure)):
        _ = [frame async for frame in env.service.stream(turn, get_encoder())]
    env.cache.get_or_create.assert_not_awaited()
    env.mongo.get_agent_mcp_servers.assert_not_called()
    assert not env.state.acp_calls and not env.state.calls and not env.state.leased


async def test_rollback_preserves_real_admitted_storage_and_resume_snapshot(environment, monkeypatch):
    env = environment
    settings = Settings(
        native_acp_enabled=True, mongodb_database="example", checkpoint_collection="checkpoints",
        checkpoint_writes_collection="writes", gridfs_bucket_name="files",
    )
    collection = _BindingCollection()
    checkpoints = MagicMock(delete_many=MagicMock(return_value=SimpleNamespace(deleted_count=3)))
    writes = MagicMock(delete_many=MagicMock(return_value=SimpleNamespace(deleted_count=4)))
    mongo = MongoDBService(settings)
    mongo._db = {
        SESSION_BINDINGS_COLLECTION: collection, "workflow_checkpoints": checkpoints, "workflow_checkpoints_writes": writes,
    }
    mongo.get_agent_mcp_servers = MagicMock(return_value=[])
    monkeypatch.setattr(execution, "get_native_binding", get_native_binding)
    monkeypatch.setattr(execution, "resolve_native_binding", resolve_native_binding)
    store = MagicMock(delete_by_namespace=MagicMock(return_value=2))
    monkeypatch.setattr(execution, "MongoDBGridFSStore", lambda **kwargs: store)
    backend = AgentBackend(type="store", config=AgentBackendConfig(
        checkpoint_collection="workflow_checkpoints", fs_namespace=["workflow", "run", "filesystem"],
    ))
    original = _agent(system_prompt="Workflow instructions", backend=backend)
    initial = execution.AgentExecutionService(mongo, settings=settings, cache=env.cache)
    turn = execution.ExecutionTurn(agent=original, session_id="original-thread", user=env.user, message="hello")
    assert [frame async for frame in initial.stream(turn, get_encoder())] == ["preserved frame"]
    admitted = get_native_binding(mongo, original.id, "original-thread")
    before = deepcopy(collection.rows)
    rollback_cache = MagicMock(get_or_create=AsyncMock(return_value=env.runtime))
    rollback_cache.borrow.side_effect = _cached_borrow(rollback_cache, env.state)
    env.state.acp_calls.clear()
    env.settings.native_acp_enabled = settings.native_acp_enabled = False
    # A new service/cache represents a restarted pod; the current definition no
    # longer contains the workflow's storage override or prompt.
    replacement = _agent(system_prompt="New base definition", backend=AgentBackend(type="state"))
    rollback = execution.AgentExecutionService(mongo, settings=settings, cache=rollback_cache)
    resume = execution.ExecutionTurn(
        agent=replacement, session_id="original-thread", user=env.user, resume_data='{"type":"form_input","values":{}}',
    )
    assert [frame async for frame in rollback.stream(resume, get_encoder())] == ["preserved frame"]
    assert rollback_cache.get_or_create.await_args.args[0] == admitted
    assert env.state.calls[-1][0] == "resume" and env.state.calls[-1][1][0] == "original-thread"
    env.runtime.has_pending_interrupt.return_value = {"type": "form_input"}
    assert await rollback.interrupt_state(replacement, "original-thread", env.user) == {"type": "form_input"}
    assert await rollback.rewind(
        replacement, "original-thread", env.user, turn_id="turn", message_content="hello", content_occurrence=1,
    ) == "checkpoint"
    cleared = await rollback.clear(original.id, "original-thread")
    assert (cleared.checkpoints_deleted, cleared.writes_deleted, cleared.files_deleted) == (3, 4, 2)
    checkpoints.delete_many.assert_called_once_with({"thread_id": "original-thread"})
    writes.delete_many.assert_called_once_with({"thread_id": "original-thread"})
    store.delete_by_namespace.assert_called_once_with(("workflow", "run", "filesystem"))
    assert all(call.args[0] == admitted for call in rollback_cache.get_or_create.await_args_list)
    assert collection.rows == before and not env.state.acp_calls and not env.state.leased


async def test_disconnect_drains_runtime_cleanup_before_releasing_admission(environment, monkeypatch):
    env = environment
    entered, cleanup_started, cleanup_release, cleaned = (asyncio.Event() for _ in range(4))

    async def blocking(runtime, **kwargs):
        try:
            entered.set()
            await asyncio.Event().wait()
            yield
        finally:
            cleanup_started.set()
            assert env.state.leased and env.state.borrowed == 1
            await cleanup_release.wait()
            assert env.state.leased and env.state.borrowed == 1
            cleaned.set()

    monkeypatch.setattr(execution, "native_acp_stream", blocking)
    turn = execution.ExecutionTurn(agent=_agent(), session_id="thread", user=env.user, message="hello")

    async def consume():
        async for _ in env.service.stream(turn, get_encoder()):
            pass

    owner = asyncio.create_task(consume())
    try:
        await asyncio.wait_for(entered.wait(), 2)
        owner.cancel()
        await asyncio.wait_for(cleanup_started.wait(), 2)
        assert not owner.done() and env.state.leased and env.state.borrowed == 1
        cleanup_release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(owner, 2)
        assert cleaned.is_set() and not env.state.leased and env.state.borrowed == 0
    finally:
        cleanup_release.set()
        if not owner.done():
            owner.cancel()
        await asyncio.gather(owner, return_exceptions=True)


@pytest.mark.parametrize("remote_cancelled", [False, True])
async def test_cancellation_contacts_remote_owner_before_cache_fallback(environment, monkeypatch, remote_cancelled):
    env = environment
    monkeypatch.setattr(execution, "cancel_native_acp", lambda *_: False)
    remote = MagicMock(return_value=remote_cancelled)
    monkeypatch.setattr(execution, "request_native_session_cancel", remote)
    env.cache.cancel_stream.return_value = True
    assert await env.service.cancel("example-agent", "original-thread") is True
    remote.assert_called_once_with(env.mongo, "example-agent", "original-thread")
    if remote_cancelled:
        env.cache.cancel_stream.assert_not_called()
    else:
        env.cache.cancel_stream.assert_called_once_with("example-agent", "original-thread")


async def test_cancelled_checkpoint_delete_keeps_admission_until_thread_finishes(environment, monkeypatch):
    env = environment
    env.saved.return_value = _agent(backend=AgentBackend(type="store", config=AgentBackendConfig(
        checkpoint_collection="saved_checkpoints", fs_namespace=["shared", "run", "filesystem"],
    )))
    started, finished = asyncio.Event(), asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()

    def delete(query):
        loop.call_soon_threadsafe(started.set)
        if not release.wait(timeout=5):
            raise RuntimeError("Delete was not released")
        assert env.state.leased
        loop.call_soon_threadsafe(finished.set)
        return SimpleNamespace(deleted_count=1)

    checkpoint = MagicMock(delete_many=MagicMock(side_effect=delete))
    writes = MagicMock()
    env.mongo._db = {"saved_checkpoints": checkpoint, "saved_checkpoints_writes": writes}
    task = asyncio.create_task(env.service.clear("example-agent", "thread"))
    try:
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done() and env.state.leased
    finally:
        release.set()
    result = await asyncio.gather(task, return_exceptions=True)
    assert isinstance(result[0], asyncio.CancelledError)
    assert finished.is_set() and not env.state.leased
    writes.delete_many.assert_not_called()


async def test_direct_rollout_reads_bound_state_only_after_turn_ownership(environment):
    env = environment
    env.settings.native_acp_enabled = False

    def saved(*args):
        assert env.state.leased
        return None

    env.saved.side_effect = saved
    turn = execution.ExecutionTurn(agent=_agent(), session_id="thread", user=env.user, message="hello")
    assert [frame async for frame in env.service.stream(turn, get_encoder())] == ["preserved frame"]
    env.admit.assert_not_called()
    assert env.state.acquisitions == 1 and not env.state.leased


async def test_interrupt_poll_borrows_read_only_without_reserving_an_execution_turn(environment):
    env = environment

    async def pending(session_id):
        assert session_id == "thread" and env.state.borrowed == 1
        assert not env.state.leased
        return {"type": "form_input"}

    env.runtime.has_pending_interrupt.side_effect = pending
    assert await env.service.interrupt_state(_agent(), "thread", env.user) == {"type": "form_input"}
    assert env.cache.borrow.call_args.kwargs["read_only"] is True
    assert env.state.borrowed == 0 and env.state.acquisitions == 0


async def test_rewind_keeps_runtime_borrow_and_write_ownership_for_the_operation(environment):
    env = environment

    async def rewind(*args):
        assert env.state.leased and env.state.borrowed == 1
        return "checkpoint"

    env.runtime.rewind_before_turn.side_effect = rewind
    assert await env.service.rewind(
        _agent(), "thread", env.user, turn_id="turn", message_content="hello", content_occurrence=1,
    ) == "checkpoint"
    assert env.cache.borrow.call_args.kwargs["read_only"] is False
    assert not env.state.leased and env.state.borrowed == 0
