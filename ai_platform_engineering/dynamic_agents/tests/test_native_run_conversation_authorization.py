"""Authorize visible conversations without trusting caller-supplied runtime aliases."""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from pymongo.errors import ConnectionFailure

from dynamic_agents.models import UserContext
from dynamic_agents.routes import chat
from dynamic_agents.services import agent_execution
from dynamic_agents.services.agent_execution import AgentExecutionService
from tests.test_native_acp_mongodb import _service
from tests.test_native_acp_mongodb import native_database as native_database

OPERATIONS = ("latest", "status", "replay")


@pytest.fixture
async def retained(native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[SimpleNamespace]:
    state = native_database
    monkeypatch.setattr(agent_execution, "current_subject_reference", lambda: None)
    state.service = _service(state)
    repository = state.service.coordinator.repository
    await repository.initialize()
    run, created = await repository.create(
        owner_subject=state.service._owner(state.user), agent_id=state.agent.id,
        session_id=state.session_id, turn_id="example-turn", fingerprint="example-request", protocol="agui",
    )
    assert created
    await repository.append_frame(
        run.run_id,
        'event: TEXT_MESSAGE_CONTENT\ndata: {"type":"TEXT_MESSAGE_CONTENT","messageId":"example-answer","delta":"canonical content"}\n\n',
    )
    state.run = await repository.finish(run.run_id, "completed")
    try:
        yield state
    finally:
        await state.service.coordinator.shutdown()


def _client(
    state: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, user: UserContext,
    service: AgentExecutionService | None = None,
) -> httpx.AsyncClient:
    monkeypatch.setattr(chat, "AgentExecutionService", lambda _: service or state.service)
    monkeypatch.setattr(chat, "require_agent_use_permission", AsyncMock())
    app = FastAPI()
    app.include_router(chat.router)
    app.dependency_overrides[chat.get_user_context] = lambda: user
    app.dependency_overrides[chat.get_mongo_service] = lambda: state.mongo
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://example.test")


def _path(state: SimpleNamespace, operation: str) -> str:
    return "/chat/runs" if operation == "latest" else f"/chat/runs/{state.run.run_id}" + (
        "/stream" if operation == "replay" else ""
    )


def _scope(state: SimpleNamespace, visible_id: str | None = None) -> dict[str, str]:
    scope = {"agent_id": state.agent.id, "conversation_id": state.session_id}
    if visible_id is not None:
        scope["authorized_conversation_id"] = visible_id
    return scope


def _save_conversation(state: SimpleNamespace, mapping: str) -> str:
    visible_id = state.session_id if mapping == "interactive" else "visible-conversation"
    conversation: dict[str, Any] = {
        "_id": visible_id, "participants": [{"type": "agent", "id": state.agent.id}],
    }
    if mapping != "interactive":
        conversation["source"] = "autonomous"
        if mapping == "stored-pointer":
            conversation["execution_context_id"] = state.session_id
        else:
            if mapping == "legacy-task":
                conversation["task_id"] = "example-task"
            else:
                conversation["metadata"] = {"task_id": "example-task"}
            now = datetime.now(timezone.utc)
            state.db[state.settings.autonomous_runs_collection].insert_many([
                {"task_id": "example-task", "execution_context_id": "older-runtime", "started_at": now - timedelta(days=1)},
                {"task_id": "example-task", "execution_context_id": state.session_id, "started_at": now},
                {"task_id": "unrelated-task", "execution_context_id": "other-runtime", "started_at": now + timedelta(days=1)},
            ])
    state.db.conversations.insert_one(conversation)
    return visible_id


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("mapping", ("interactive", "stored-pointer", "legacy-task", "legacy-metadata"))
async def test_shared_reader_authorizes_the_stored_visible_conversation_before_reading_its_run(
    retained: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, operation: str, mapping: str,
) -> None:
    state = retained
    visible_id = _save_conversation(state, mapping)
    permission = AsyncMock()
    monkeypatch.setattr(agent_execution, "require_conversation_read_permission", permission)
    async with _client(state, monkeypatch, UserContext(email="reader@example.com")) as client:
        response = await client.get(_path(state, operation), params=_scope(state, visible_id))
    assert response.status_code == 200
    permission.assert_awaited_once_with(visible_id)
    if operation == "replay":
        assert "canonical content" in response.text
        assert response.headers["x-caipe-run-id"] == state.run.run_id
    else:
        assert response.json()["run"]["run_id"] == state.run.run_id


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("caller", ("owner", "reader"))
@pytest.mark.parametrize("forgery", ("different-runtime", "different-agent", "missing-conversation"))
async def test_forged_visible_alias_is_rejected_before_cas_or_replay_even_for_the_run_owner(
    retained: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, operation: str, caller: str, forgery: str,
) -> None:
    state = retained
    visible_id = "forged-visible-conversation"
    if forgery != "missing-conversation":
        state.db.conversations.insert_one({
            "_id": visible_id, "source": "autonomous",
            "agent_id": state.agent.id if forgery == "different-runtime" else "different-agent",
            "execution_context_id": "other-runtime" if forgery == "different-runtime" else state.session_id,
        })
    permission = AsyncMock()
    replay = AsyncMock()
    monkeypatch.setattr(agent_execution, "require_conversation_read_permission", permission)
    monkeypatch.setattr(state.service.coordinator.repository, "replay", replay)
    user = state.user if caller == "owner" else UserContext(email="reader@example.com")
    async with _client(state, monkeypatch, user) as client:
        response = await client.get(_path(state, operation), params=_scope(state, visible_id))
    assert response.status_code == (404 if forgery == "missing-conversation" else 403)
    permission.assert_not_awaited()
    replay.assert_not_awaited()
    assert "canonical content" not in response.text


@pytest.mark.parametrize("operation", OPERATIONS)
async def test_validated_alias_still_requires_cas_read_permission_before_replay(
    retained: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, operation: str,
) -> None:
    state = retained
    visible_id = _save_conversation(state, "stored-pointer")
    permission = AsyncMock(side_effect=HTTPException(status_code=403, detail="Permission denied"))
    replay = AsyncMock()
    monkeypatch.setattr(agent_execution, "require_conversation_read_permission", permission)
    monkeypatch.setattr(state.service.coordinator.repository, "replay", replay)
    async with _client(state, monkeypatch, UserContext(email="reader@example.com")) as client:
        response = await client.get(_path(state, operation), params=_scope(state, visible_id))
    assert response.status_code == 403
    permission.assert_awaited_once_with(visible_id)
    replay.assert_not_awaited()


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("storage_failure", ("no-service", "no-database", "connection-failed"))
async def test_provided_alias_fails_closed_when_its_canonical_mapping_cannot_be_read(
    retained: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, operation: str, storage_failure: str,
) -> None:
    state = retained
    service = state.service
    if storage_failure == "no-service":
        service = AgentExecutionService(None, settings=state.settings, cache=state.service.cache)
    elif storage_failure == "no-database":
        monkeypatch.setattr(state.mongo, "_db", None)
    else:
        class UnavailableDatabase:
            def __getitem__(self, _: str) -> Any:
                raise ConnectionFailure("database unavailable")

        monkeypatch.setattr(state.mongo, "_db", UnavailableDatabase())
    permission = AsyncMock()
    monkeypatch.setattr(agent_execution, "require_conversation_read_permission", permission)
    async with _client(state, monkeypatch, state.user, service) as client:
        response = await client.get(_path(state, operation), params=_scope(state, "visible-conversation"))
    assert response.status_code == 503
    permission.assert_not_awaited()


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("caller", ("owner", "reader"))
async def test_omitting_a_visible_alias_preserves_existing_owner_and_runtime_cas_behavior(
    retained: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, operation: str, caller: str,
) -> None:
    state = retained
    assert state.db.conversations.count_documents({}) == 0
    permission = AsyncMock()
    monkeypatch.setattr(agent_execution, "require_conversation_read_permission", permission)
    user = state.user if caller == "owner" else UserContext(email="reader@example.com")
    async with _client(state, monkeypatch, user) as client:
        response = await client.get(_path(state, operation), params=_scope(state))
    assert response.status_code == 200
    if caller == "owner":
        permission.assert_not_awaited()
    else:
        permission.assert_awaited_once_with(state.session_id)
