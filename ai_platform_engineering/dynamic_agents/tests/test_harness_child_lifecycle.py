"""Parent deletion owns every persistent native child created by its broker."""

import hashlib
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock
from uuid import NAMESPACE_URL, uuid5

import httpx
import jwt
import pytest

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.models import AgentBackend, AgentBackendConfig, AgentExecutionConfig, DynamicAgentConfig
from dynamic_agents.services import agent_execution, sandbox_client
from dynamic_agents.services.agent_execution import AgentExecutionService, ExecutionTurn
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.harness_tools import HARNESS_TOOL_REQUESTS_COLLECTION
from dynamic_agents.services.native_run_repository import NativeRunRepository
from dynamic_agents.services.native_state_protocol import STATE_CONTRACT
from dynamic_agents.services.runtime_storage import resolve_runtime_storage
from dynamic_agents.services.sandbox_client import SandboxError
from dynamic_agents.services.session_bindings import (
    SessionBindingError,
    get_delegated_sessions,
    get_native_binding,
    link_delegated_session,
    resolve_native_binding,
    save_sandbox_binding,
)
from dynamic_agents.services.session_runs import SessionRunBusyError, native_session_run
from tests.test_native_acp_mongodb import _graph
from tests.test_native_acp_mongodb import native_database as native_database
from tests.test_stream_cancellation_cleanup import _runtime


class ChildCache:
    def __init__(self, state):
        self.state = state
        self.calls = 0

    def set_mongo_service(self, mongo):
        assert mongo is self.state.mongo

    @asynccontextmanager
    async def persistent(self, agent, _servers, session_id, **_context):
        # The lifecycle link must exist before graph/checkpoint creation.
        assert get_delegated_sessions(self.state.mongo, self.state.parent.agent.id,
            self.state.parent.session_id, self.state.owner) == [self.state.pointer]
        assert session_id == self.state.session_id
        self.calls += 1
        runtime = _runtime(_graph(self.state, agent))
        runtime.config = agent
        yield runtime


@pytest.fixture
async def delegated_state(native_database, monkeypatch):
    state = native_database
    state.parent = ExecutionTurn(agent=DynamicAgentConfig(_id="external-parent", name="External parent", owner_id="owner@example.com",
        system_prompt="Delegate approved work.", execution=AgentExecutionConfig(kind="sandbox", profile_id="qualified")),
        session_id="parent-conversation", user=state.user)
    state.session_id = str(uuid5(NAMESPACE_URL, "caipe-child:parent-conversation:native-child"))
    state.agent = DynamicAgentConfig(_id="native-child", name="Native child", owner_id="owner@example.com", system_prompt="Assist.",
        model={"id": "qualified-model", "provider": "qualified-provider"},
        backend=AgentBackend(type="store", config=AgentBackendConfig(checkpoint_collection="child_checkpoints")))
    state.mongo._get_agents_collection().insert_one(state.agent.model_dump(by_alias=True))
    state.settings.sandbox_service_url = "https://portal.example.test/control"
    state.pointer = {"agent_id": state.agent.id, "session_id": state.session_id}
    token = current_user_token.set(jwt.encode({"sub": "fixture-owner", "email": state.user.email},
        "fixture-signing-key-with-at-least-32-bytes", algorithm="HS256"))
    state.cache = ChildCache(state)
    state.service = AgentExecutionService(state.mongo, settings=state.settings, cache=state.cache)
    state.owner = state.service._owner(state.user)
    resolve_native_binding(state.mongo, state.parent.agent, state.parent.session_id)
    save_sandbox_binding(state.mongo, state.parent.agent.id, state.parent.session_id, {
        "owner_subject": state.owner,
        "connection_version": hashlib.sha256(state.settings.sandbox_service_url.encode()).hexdigest(),
        "profile": {"id": "qualified", "name": "Qualified runtime", "harness": "claude-code", "revision": "revision-1",
            "state_contract": STATE_CONTRACT},
        "allocation": None, "provider_session_id": None,
    })
    monkeypatch.setattr(agent_execution, "require_agent_use_permission", AsyncMock())
    original = httpx.AsyncClient

    def control(request):
        assert request.method == "GET" and request.url.path == "/control/api/caipe/sandboxes"
        assert state.mongo.get_session_runs_collection().find_one({"agent_id": state.parent.agent.id,
            "session_id": state.parent.session_id, "lease_id": {"$exists": True}})
        return httpx.Response(404)

    monkeypatch.setattr(sandbox_client.httpx, "AsyncClient",
        lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(control)))
    try:
        yield state
    finally:
        current_user_token.reset(token)


async def _invoke(state):
    async with native_session_run(state.mongo, state.parent.agent.id, state.parent.session_id):
        return await state.service._invoke_harness_child(state.parent, state.agent, state.session_id, "Inspect this resource", None)


def _links(state):
    return state.mongo.get_session_bindings_collection().find_one({"agent_id": state.parent.agent.id,
        "session_id": state.parent.session_id}).get("delegated_sessions", [])


async def test_permanent_parent_cleanup_erases_real_child_checkpoints_files_and_replay(delegated_state):
    state = delegated_state
    assert (await _invoke(state)).content == "Remembered 1 messages"
    storage = resolve_runtime_storage(get_native_binding(state.mongo, state.agent.id, state.session_id), state.session_id, state.settings)
    assert state.db[storage.checkpoint_collection].count_documents({"thread_id": state.session_id}) > 0
    store = MongoDBGridFSStore(db=state.db, bucket_name=storage.gridfs_bucket_name)
    store.put(storage.fs_namespace, "/report.txt", {"content": "Retained child output"})
    store.put(("unrelated", "unrelated-session", "filesystem"), "/report.txt", {"content": "Preserve"})
    repository = NativeRunRepository(state.mongo)
    run, _ = await repository.create(owner_subject=state.owner, agent_id=state.agent.id, session_id=state.session_id,
        turn_id="child-turn", fingerprint="fixture", protocol="custom")
    await repository.append_frame(run.run_id, 'data: {"fixture":true}\n\n')
    await repository.finish(run.run_id, "completed")
    state.db[HARNESS_TOOL_REQUESTS_COLLECTION].insert_one({"run_id": run.run_id, "session_id": state.session_id})
    result = await state.service.clear(state.parent.agent.id, state.parent.session_id, permanent=True)
    assert result.checkpoints_deleted > 0 and result.files_deleted == 1
    assert state.db[storage.checkpoint_collection].count_documents({"thread_id": state.session_id}) == 0
    assert state.db[storage.checkpoint_writes_collection].count_documents({"thread_id": state.session_id}) == 0
    assert get_native_binding(state.mongo, state.agent.id, state.session_id) is None
    for collection in ("native_acp_execution_runs", "native_acp_execution_events", HARNESS_TOOL_REQUESTS_COLLECTION):
        assert state.db[collection].count_documents({"session_id": state.session_id}) == 0
    assert store.get(storage.fs_namespace, "/report.txt") is None
    assert store.get(("unrelated", "unrelated-session", "filesystem"), "/report.txt") is not None
    assert state.db["native_acp_deleted_sessions"].find_one({"_id": state.session_id})
    assert _links(state) == []


async def test_link_survives_failure_before_child_binding_and_cleanup_is_idempotent(delegated_state, monkeypatch):
    state = delegated_state
    monkeypatch.setattr(state.service, "invoke", AsyncMock(side_effect=RuntimeError("Worker setup interrupted")))
    with pytest.raises(RuntimeError):
        await _invoke(state)
    assert _links(state) == [state.pointer]
    assert get_native_binding(state.mongo, state.agent.id, state.session_id) is None
    await state.service.clear(state.parent.agent.id, state.parent.session_id, permanent=True)
    assert _links(state) == []
    assert state.db["native_acp_deleted_sessions"].find_one({"_id": state.session_id})
    await state.service.clear(state.parent.agent.id, state.parent.session_id, permanent=True)


async def test_partial_child_cleanup_keeps_parent_links_until_retry_confirms_all_state(delegated_state, monkeypatch):
    state = delegated_state
    await _invoke(state)
    purge = state.service._purge_delegated_state
    monkeypatch.setattr(state.service, "_purge_delegated_state", AsyncMock(side_effect=RuntimeError("Storage unavailable")))
    with pytest.raises(RuntimeError):
        await state.service.clear(state.parent.agent.id, state.parent.session_id, permanent=True)
    assert _links(state) == [state.pointer]
    assert get_native_binding(state.mongo, state.agent.id, state.session_id) is not None
    monkeypatch.setattr(state.service, "_purge_delegated_state", purge)
    await state.service.clear(state.parent.agent.id, state.parent.session_id, permanent=True)
    assert _links(state) == []
    assert get_native_binding(state.mongo, state.agent.id, state.session_id) is None


async def test_active_child_lease_blocks_cleanup_without_losing_parent_link(delegated_state):
    state = delegated_state
    await _invoke(state)
    async with native_session_run(state.mongo, state.agent.id, state.session_id):
        with pytest.raises(SessionRunBusyError):
            await state.service.clear(state.parent.agent.id, state.parent.session_id, permanent=True)
    assert _links(state) == [state.pointer]
    await state.service.clear(state.parent.agent.id, state.parent.session_id, permanent=True)
    assert _links(state) == []


async def test_original_owner_is_checked_before_descendant_state_mutation(delegated_state, monkeypatch):
    state = delegated_state
    await _invoke(state)
    monkeypatch.setattr(agent_execution, "current_subject_reference", lambda: "user:other-owner")
    with pytest.raises(SessionBindingError, match="original sandbox owner"):
        await state.service.clear(state.parent.agent.id, state.parent.session_id, permanent=True)
    assert get_native_binding(state.mongo, state.agent.id, state.session_id) is not None
    assert not state.db["native_acp_deleted_sessions"].find_one({"_id": state.session_id})
    assert _links(state) == [state.pointer]


async def test_forged_lifecycle_coordinate_never_deletes_an_unrelated_session(delegated_state):
    state = delegated_state
    await _invoke(state)
    state.mongo.get_session_bindings_collection().update_one({"agent_id": state.parent.agent.id}, {
        "$set": {"delegated_sessions": [{"agent_id": state.agent.id, "session_id": "unrelated-session"}]}})
    with pytest.raises(SessionBindingError, match="lifecycle binding"):
        await state.service.clear(state.parent.agent.id, state.parent.session_id, permanent=True)
    assert get_native_binding(state.mongo, state.agent.id, state.session_id) is not None
    assert not state.db["native_acp_deleted_sessions"].find_one({"_id": "unrelated-session"})


async def test_link_requires_live_parent_admission_and_original_owner(delegated_state):
    state = delegated_state
    args = (state.mongo, state.parent.agent.id, state.parent.session_id, state.agent.id, state.session_id)
    with pytest.raises(SessionBindingError, match="active parent admission"):
        link_delegated_session(*args, state.owner)
    async with native_session_run(state.mongo, state.parent.agent.id, state.parent.session_id):
        with pytest.raises(SessionBindingError, match="active parent admission"):
            link_delegated_session(*args, "user:other-owner")
        with pytest.raises(SessionBindingError, match="does not match"):
            link_delegated_session(state.mongo, state.parent.agent.id, state.parent.session_id,
                state.agent.id, "unrelated-session", state.owner)
        link_delegated_session(*args, state.owner)
        link_delegated_session(*args, state.owner)
    assert _links(state) == [state.pointer]


async def test_clear_without_permanent_delete_allows_fresh_child_history(delegated_state):
    state = delegated_state
    await _invoke(state)
    await state.service.clear(state.parent.agent.id, state.parent.session_id)
    assert not state.db["native_acp_deleted_sessions"].find_one({"_id": state.session_id})
    # A fresh sandbox admission retains the parent's execution choice.
    save_sandbox_binding(state.mongo, state.parent.agent.id, state.parent.session_id, {"owner_subject": state.owner})
    assert (await _invoke(state)).content == "Remembered 1 messages"
    assert state.cache.calls == 2


async def test_parent_lifecycle_links_have_a_bounded_unique_child_limit(delegated_state):
    state = delegated_state
    async with native_session_run(state.mongo, state.parent.agent.id, state.parent.session_id):
        for index in range(64):
            agent_id = f"child-{index}"
            session_id = str(uuid5(NAMESPACE_URL, f"caipe-child:{state.parent.session_id}:{agent_id}"))
            link_delegated_session(state.mongo, state.parent.agent.id, state.parent.session_id, agent_id, session_id, state.owner)
        with pytest.raises(SessionBindingError, match="limit"):
            link_delegated_session(state.mongo, state.parent.agent.id, state.parent.session_id,
                state.agent.id, state.session_id, state.owner)
    assert len(_links(state)) == 64


async def test_permanent_parent_fence_rejects_a_late_delegation_before_child_setup(delegated_state):
    state = delegated_state
    await _invoke(state)
    await state.service.clear(state.parent.agent.id, state.parent.session_id, permanent=True)
    with pytest.raises(SessionBindingError, match="active parent admission"):
        await _invoke(state)
    assert state.cache.calls == 1
    assert get_native_binding(state.mongo, state.agent.id, state.session_id) is None


async def test_child_cleanup_rejects_a_changed_shared_storage_alias(delegated_state):
    state = delegated_state
    await _invoke(state)
    state.mongo.get_session_bindings_collection().delete_one({"agent_id": state.agent.id, "session_id": state.session_id})
    changed = state.agent.model_copy(update={"backend": AgentBackend(type="store", config=AgentBackendConfig(
        fs_namespace=["unrelated", "unrelated-session", "filesystem"]))})
    resolve_native_binding(state.mongo, changed, state.session_id)
    store = MongoDBGridFSStore(db=state.db, bucket_name=state.settings.gridfs_bucket_name)
    store.put(("unrelated", "unrelated-session", "filesystem"), "/private.txt", {"content": "Preserve"})
    with pytest.raises(SandboxError, match="own native session and workspace"):
        await state.service.clear(state.parent.agent.id, state.parent.session_id, permanent=True)
    assert store.get(("unrelated", "unrelated-session", "filesystem"), "/private.txt") is not None
    assert _links(state) == [state.pointer]
