"""Destructive sandbox lifecycle uses the real lease and canonical binding."""

import hashlib
from copy import deepcopy
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException
from pymongo.collection import Collection

from dynamic_agents.models import AgentExecutionConfig
from dynamic_agents.routes import conversations
from dynamic_agents.services import sandbox_client, sandbox_lifecycle
from dynamic_agents.services.agent_execution import AgentExecutionService
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.runtime_storage import resolve_runtime_storage
from dynamic_agents.services.sandbox_client import SandboxAllocation, SandboxClient, SandboxError
from dynamic_agents.services.session_bindings import (
    SessionBindingError,
    get_sandbox_binding,
    reset_sandbox_binding,
    resolve_native_binding,
    save_sandbox_binding,
)
from dynamic_agents.services.session_runs import SessionRunBusyError, native_session_run
from tests.test_native_acp_mongodb import native_database as native_database


@pytest.fixture
def sandbox_state(native_database, monkeypatch):
    state = native_database
    state.settings.sandbox_service_url = "https://portal.example.test/control"
    state.agent = state.agent.model_copy(update={"execution": AgentExecutionConfig(kind="sandbox", profile_id="qualified")}, deep=True)
    resolve_native_binding(state.mongo, state.agent, state.session_id)
    state.profile = {"id": "qualified", "name": "Qualified runtime", "harness": "codex", "revision": "retired-revision", "capabilities": {}}
    state.allocation = {
        "id": "example-sandbox", "uid": "original-generation", "namespace": "example-namespace",
        "conversation_id": SandboxClient.conversation_reference(state.agent.id, state.session_id),
        "profile_id": "qualified", "revision": "retired-revision", "cwd": "/workspace", "state": "Running", "resource_version": "old",
    }
    state.binding = {"profile": state.profile, "allocation": state.allocation, "provider_session_id": "original-provider-session",
                     "owner_subject": "user:example-owner", "connection_version": hashlib.sha256(state.settings.sandbox_service_url.encode()).hexdigest()}
    save_sandbox_binding(state.mongo, state.agent.id, state.session_id, state.binding)
    state.calls = []
    state.status = 204
    state.current = {**state.allocation, "resource_version": "current"}
    original = httpx.AsyncClient

    def handler(request):
        state.calls.append(request)
        assert state.mongo.get_session_runs_collection().find_one({"session_id": state.session_id, "lease_id": {"$exists": True}})
        if request.method == "GET":
            return httpx.Response(200, json=state.current)
        assert request.method == "DELETE"
        assert b'"resource_version":"current"' in request.content
        assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) == state.binding
        return httpx.Response(state.status)

    monkeypatch.setattr(sandbox_client.httpx, "AsyncClient", lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(sandbox_lifecycle, "current_subject_reference", lambda: "user:example-owner")
    monkeypatch.setattr(sandbox_client, "current_user_token", type("Token", (), {"get": lambda self: "fixture-bearer"})())
    state.storage = resolve_runtime_storage(state.agent, state.session_id, state.settings)
    state.db[state.storage.checkpoint_collection].insert_one({"thread_id": state.session_id})
    state.db[state.storage.checkpoint_writes_collection].insert_one({"thread_id": state.session_id})
    state.store = MongoDBGridFSStore(db=state.db, bucket_name=state.storage.gridfs_bucket_name)
    state.store.put(state.storage.fs_namespace, "/report.txt", {"content": "original"})
    state.store.put(("other", "other-session", "filesystem"), "/report.txt", {"content": "retain"})
    return state


async def test_clear_deletes_exact_allocation_before_binding_and_local_state(sandbox_state):
    state = sandbox_state
    result = await AgentExecutionService(state.mongo, settings=state.settings).clear(state.agent.id, state.session_id)
    assert [request.method for request in state.calls] == ["GET", "DELETE"]
    assert all("profiles" not in request.url.path for request in state.calls)
    assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) is None
    assert (result.checkpoints_deleted, result.writes_deleted, result.files_deleted) == (1, 1, 1)
    assert state.store.get(("other", "other-session", "filesystem"), "/report.txt") is not None


@pytest.mark.parametrize("succeeds", [True, False])
async def test_clear_fences_ui_rewind_receipts_only_after_cleanup_and_before_releasing_lease(sandbox_state, monkeypatch, succeeds):
    state = sandbox_state
    state.db["conversations"].insert_one({"_id": state.session_id, "owner_subject": "example-owner",
        "native_rewind_epoch": 7, "native_rewind": {"operation_id": "old-ui-edit"}})
    update = Collection.update_one
    observed = []

    def verify_admission(collection, query, changes, **kwargs):
        if collection.name == "conversations" and "native_rewind_epoch" in changes.get("$inc", {}):
            assert state.mongo.get_session_runs_collection().find_one({"session_id": state.session_id,
                "lease_id": {"$exists": True}})
            assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) is None
            observed.append(True)
        return update(collection, query, changes, **kwargs)

    monkeypatch.setattr(Collection, "update_one", verify_admission)
    service = AgentExecutionService(state.mongo, settings=state.settings)
    if succeeds:
        result = await service.clear(state.agent.id, state.session_id)
        assert (result.checkpoints_deleted, result.writes_deleted, result.files_deleted) == (1, 1, 1)
    else:
        state.status = 503
        with pytest.raises(SandboxError):
            await service.clear(state.agent.id, state.session_id)
    conversation = state.db["conversations"].find_one({"_id": state.session_id})
    assert conversation["owner_subject"] == "example-owner"
    assert conversation["native_rewind_epoch"] == (8 if succeeds else 7)
    assert ("native_rewind" in conversation) is not succeeds
    assert observed == ([True] if succeeds else [])


async def test_sandbox_clear_preserves_shared_workflow_artifacts(sandbox_state):
    state = sandbox_state
    backend = state.agent.backend.model_copy(deep=True)
    backend.config.fs_namespace = ["workflow", "shared-workflow-run", "filesystem"]
    state.agent = state.agent.model_copy(update={"backend": backend}, deep=True)
    state.mongo.get_session_bindings_collection().delete_one({"agent_id": state.agent.id, "session_id": state.session_id})
    state.db[state.storage.checkpoint_collection].delete_many({"thread_id": state.session_id})
    resolve_native_binding(state.mongo, state.agent, state.session_id)
    save_sandbox_binding(state.mongo, state.agent.id, state.session_id, state.binding)
    namespace = tuple(backend.config.fs_namespace)
    state.store.put(namespace, "/shared.txt", {"content": "Another workflow step needs this"})
    result = await AgentExecutionService(state.mongo, settings=state.settings).clear(state.agent.id, state.session_id)
    assert result.files_deleted == 0
    assert state.store.get(namespace, "/shared.txt") is not None
    assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) is None


@pytest.mark.parametrize("status", [403, 409, 503])
async def test_failed_remote_delete_keeps_binding_and_canonical_state(sandbox_state, status):
    state = sandbox_state
    state.status = status
    with pytest.raises(SandboxError):
        await AgentExecutionService(state.mongo, settings=state.settings).clear(state.agent.id, state.session_id)
    assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) == state.binding
    assert state.db[state.storage.checkpoint_collection].count_documents({"thread_id": state.session_id}) == 1
    assert state.store.get(state.storage.fs_namespace, "/report.txt") is not None


@pytest.mark.parametrize("field", ["uid", "cwd", "namespace"])
async def test_replaced_allocation_never_deleted_or_reset(sandbox_state, field):
    state = sandbox_state
    state.current[field] = "/replacement" if field == "cwd" else "replacement"
    with pytest.raises(SandboxError):
        await AgentExecutionService(state.mongo, settings=state.settings).clear(state.agent.id, state.session_id)
    assert [request.method for request in state.calls] == ["GET"]
    assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) == state.binding


@pytest.mark.parametrize("field", ["owner_subject", "connection_version"])
async def test_cleanup_rejects_changed_caller_or_control_plane_before_io(sandbox_state, field):
    state = sandbox_state
    state.mongo.get_session_bindings_collection().update_one({"session_id": state.session_id}, {"$set": {f"sandbox.{field}": "replacement"}})
    with pytest.raises(SandboxError):
        await AgentExecutionService(state.mongo, settings=state.settings).clear(state.agent.id, state.session_id)
    assert not state.calls


async def test_active_native_lease_prevents_remote_or_local_clear(sandbox_state):
    state = sandbox_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id):
        with pytest.raises(SessionRunBusyError):
            await AgentExecutionService(state.mongo, settings=state.settings).clear(state.agent.id, state.session_id)
    assert not state.calls


@pytest.mark.parametrize("accepted", [False, True])
async def test_provision_intent_is_looked_up_before_reset_without_reprovisioning(sandbox_state, monkeypatch, accepted):
    state = sandbox_state
    state.binding["allocation"] = None
    state.binding["provider_session_id"] = None
    state.mongo.get_session_bindings_collection().update_one({"session_id": state.session_id}, {"$set": {"sandbox": state.binding}})
    lookup = AsyncMock(return_value=SandboxAllocation.model_validate(state.current) if accepted else None)
    monkeypatch.setattr(SandboxClient, "lookup", lookup)
    result = await AgentExecutionService(state.mongo, settings=state.settings).clear(state.agent.id, state.session_id)
    lookup.assert_awaited_once()
    assert [request.method for request in state.calls] == (["GET", "DELETE"] if accepted else [])
    assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) is None
    assert result.checkpoints_deleted == 1


async def test_permanent_cleanup_fences_new_turns_before_remote_delete(sandbox_state):
    state = sandbox_state
    state.status = 503
    with pytest.raises(SandboxError):
        await AgentExecutionService(state.mongo, settings=state.settings).clear(state.agent.id, state.session_id, permanent=True)
    assert state.db["native_acp_deleted_sessions"].find_one({"_id": state.session_id})
    assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) == state.binding


def test_reset_rejects_stale_binding_and_preserves_new_state(sandbox_state):
    state = sandbox_state
    changed = deepcopy(state.binding)
    changed["provider_session_id"] = "new-provider-session"
    state.mongo.get_session_bindings_collection().update_one({"session_id": state.session_id}, {"$set": {"sandbox": changed}})
    with pytest.raises(SessionBindingError):
        reset_sandbox_binding(state.mongo, state.agent.id, state.session_id, state.binding)
    assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) == changed


async def test_legacy_sandbox_requires_retained_rewind_history_but_can_reconnect(sandbox_state, monkeypatch):
    state = sandbox_state
    monkeypatch.setattr("dynamic_agents.services.agent_execution.current_subject_reference", lambda: "user:example-owner")
    service = AgentExecutionService(state.mongo, settings=state.settings)
    with pytest.raises(ValueError, match="Unable to match"):
        await service.rewind(state.agent, state.session_id, state.user, turn_id="example-turn", message_content="message", content_occurrence=1)
    assert await service.restart(state.agent.id, state.session_id)
    assert not state.calls
    assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) == state.binding


async def test_cleanup_route_authorizes_parent_then_uses_only_canonical_execution_pointer(sandbox_state, monkeypatch):
    state = sandbox_state
    state.db["conversations"].insert_one({"_id": "parent-conversation", "source": "autonomous", "execution_context_id": state.session_id,
        "participants": [{"type": "agent", "id": state.agent.id}]})
    authorize = AsyncMock()
    clear = AsyncMock()
    monkeypatch.setattr(conversations, "require_conversation_delete_permission", authorize)
    monkeypatch.setattr(AgentExecutionService, "clear", clear)
    result = await conversations.cleanup_conversation_runtime("parent-conversation", state.user, state.mongo)
    authorize.assert_awaited_once_with("parent-conversation")
    assert {call.args for call in clear.await_args_list} == {(state.agent.id, "parent-conversation"), (state.agent.id, state.session_id)}
    assert all(call.kwargs == {"permanent": True} for call in clear.await_args_list)
    assert set(result.data["session_ids"]) == {"parent-conversation", state.session_id}


async def test_cleanup_route_denial_precedes_any_state_mutation(sandbox_state, monkeypatch):
    state = sandbox_state
    state.db["conversations"].insert_one({"_id": state.session_id, "participants": [{"type": "agent", "id": state.agent.id}]})
    monkeypatch.setattr(conversations, "require_conversation_delete_permission", AsyncMock(side_effect=HTTPException(403)))
    clear = AsyncMock()
    monkeypatch.setattr(AgentExecutionService, "clear", clear)
    with pytest.raises(HTTPException) as denied:
        await conversations.cleanup_conversation_runtime(state.session_id, state.user, state.mongo)
    assert denied.value.status_code == 403
    clear.assert_not_awaited()
