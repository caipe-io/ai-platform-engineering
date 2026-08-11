from unittest.mock import AsyncMock, call

import pytest
from fastapi import HTTPException

from dynamic_agents.models import UserContext
from dynamic_agents.routes import files


class _Collection:
    def __init__(self, document: dict | None) -> None:
        self._document = document

    def find_one(self, query: dict) -> dict | None:
        if self._document and self._document.get("_id") == query.get("_id"):
            return self._document
        return None


class _Database:
    def __init__(self, *, conversation: dict | None = None, workflow_run: dict | None = None) -> None:
        self._collections = {
            "conversations": _Collection(conversation),
            "workflow_runs": _Collection(workflow_run),
        }

    def __getitem__(self, name: str) -> _Collection:
        return self._collections[name]


@pytest.mark.asyncio
async def test_namespace_must_match_conversation_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    authorize = AsyncMock()
    monkeypatch.setattr(files, "require_file_resource_permission", authorize)
    db = _Database(
        conversation={
            "_id": "conversation-primary",
            "owner_id": "owner@example.com",
            "participants": [{"type": "agent", "id": "agent-primary"}],
        }
    )

    with pytest.raises(HTTPException) as exc_info:
        await files._authorize_namespace(
            ("agent-secondary", "conversation-primary", "filesystem"),
            UserContext(email="owner@example.com"),
            db,
            write=False,
        )

    assert exc_info.value.status_code == 403
    authorize.assert_not_awaited()


@pytest.mark.asyncio
async def test_conversation_namespace_checks_agent_and_shared_reader(monkeypatch: pytest.MonkeyPatch) -> None:
    authorize = AsyncMock()
    monkeypatch.setattr(files, "require_file_resource_permission", authorize)
    db = _Database(
        conversation={
            "_id": "conversation-primary",
            "owner_id": "owner@example.com",
            "participants": [{"type": "agent", "id": "agent-primary"}],
        }
    )

    await files._authorize_namespace(
        ("agent-primary", "conversation-primary", "filesystem"),
        UserContext(email="reader@example.com"),
        db,
        write=False,
    )

    assert authorize.await_args_list == [
        call("agent", "agent-primary", "can_use"),
        call("conversation", "conversation-primary", "can_read"),
    ]


@pytest.mark.asyncio
async def test_workflow_namespace_checks_stored_config_and_write_permission(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    authorize = AsyncMock()
    monkeypatch.setattr(files, "require_file_resource_permission", authorize)
    db = _Database(
        workflow_run={
            "_id": "run-primary",
            "workflow_config_id": "workflow-primary",
        }
    )

    await files._authorize_namespace(
        ("workflow-primary", "run-primary", "filesystem"),
        UserContext(email="operator@example.com"),
        db,
        write=True,
    )

    authorize.assert_awaited_once_with("task", "workflow-primary", "can_write")


@pytest.mark.asyncio
async def test_workflow_namespace_rejects_a_different_run_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(files, "current_bearer_principal", lambda: ("user", "user-secondary"))
    authorize = AsyncMock()
    monkeypatch.setattr(files, "require_file_resource_permission", authorize)
    db = _Database(
        workflow_run={
            "_id": "run-primary",
            "workflow_config_id": "workflow-primary",
            "owner_subject": {"type": "user", "id": "user-primary"},
            "shared_with": "private",
        }
    )

    with pytest.raises(HTTPException) as exc_info:
        await files._authorize_namespace(
            ("workflow-primary", "run-primary", "filesystem"),
            UserContext(email="operator@example.com"),
            db,
            write=False,
        )

    assert exc_info.value.status_code == 403
    authorize.assert_not_awaited()
