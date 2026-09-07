import pytest
from fastapi import HTTPException

from dynamic_agents.models import UserContext
from dynamic_agents.routes.files import _require_namespace_owner, _resolve_conversation_namespace


class _Conversations:
    def __init__(self, conversation: dict | None) -> None:
        self.conversation = conversation

    def find_one(self, query: dict, projection: dict) -> dict | None:
        return self.conversation


class _Database:
    def __init__(self, conversation: dict | None) -> None:
        self.conversations = _Conversations(conversation)

    def __getitem__(self, key: str) -> _Conversations:
        assert key == "conversations"
        return self.conversations


def test_subject_owner_is_authoritative_over_matching_legacy_email() -> None:
    user = UserContext(email="same@example.test", sub="subject-b")
    db = _Database({"owner_subject": "subject-a", "owner_id": "same@example.test"})

    with pytest.raises(HTTPException) as exc_info:
        _require_namespace_owner(("agent", "conversation", "filesystem"), user, db)  # type: ignore[arg-type]
    assert exc_info.value.status_code == 403


def test_legacy_conversation_uses_email_only_when_subject_was_not_persisted() -> None:
    user = UserContext(email="owner@example.test", sub="subject-b")
    db = _Database({"owner_id": "OWNER@example.test"})

    _require_namespace_owner(("agent", "conversation", "filesystem"), user, db)  # type: ignore[arg-type]


def test_conversation_file_namespace_uses_project_when_selected(monkeypatch) -> None:
    monkeypatch.setattr("dynamic_agents.routes.files.projects_enabled", lambda *_args: True)
    monkeypatch.setattr("dynamic_agents.routes.files.get_settings", lambda: object())
    user = UserContext(email="owner@example.test", sub="subject-a")
    db = _Database(
        {
            "owner_subject": "subject-a",
            "owner_id": "owner@example.test",
            "participants": [{"type": "agent", "id": "agent-a"}],
            "metadata": {"project_id": "project_a"},
        }
    )

    assert _resolve_conversation_namespace("conversation-a", "agent-a", user, db) == (
        "agent-a",
        "project_a",
        "filesystem",
    )


def test_conversation_file_namespace_remains_conversation_scoped_without_project(monkeypatch) -> None:
    monkeypatch.setattr("dynamic_agents.routes.files.projects_enabled", lambda *_args: True)
    monkeypatch.setattr("dynamic_agents.routes.files.get_settings", lambda: object())
    user = UserContext(email="owner@example.test", sub="subject-a")
    db = _Database(
        {
            "owner_subject": "subject-a",
            "participants": [{"type": "agent", "id": "agent-a"}],
            "metadata": {},
        }
    )

    assert _resolve_conversation_namespace("conversation-a", "agent-a", user, db) == (
        "agent-a",
        "conversation-a",
        "filesystem",
    )


def test_disabled_projects_restore_conversation_file_namespace(monkeypatch) -> None:
    monkeypatch.setattr("dynamic_agents.routes.files.projects_enabled", lambda *_args: False)
    monkeypatch.setattr("dynamic_agents.routes.files.get_settings", lambda: object())
    user = UserContext(email="owner@example.test", sub="subject-a")
    db = _Database(
        {
            "owner_subject": "subject-a",
            "participants": [{"type": "agent", "id": "agent-a"}],
            "metadata": {"project_id": "project_a"},
        }
    )

    assert _resolve_conversation_namespace("conversation-a", "agent-a", user, db) == (
        "agent-a",
        "conversation-a",
        "filesystem",
    )
