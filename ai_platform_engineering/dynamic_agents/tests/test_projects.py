from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from dynamic_agents.models import DynamicAgentConfig
from dynamic_agents.routes.chat import apply_config_override
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.builtin_tools import get_builtin_tool_definitions
from dynamic_agents.services.platform_projects import projects_enabled
from dynamic_agents.services.project_tools import create_project_tools
from dynamic_agents.services.projects import (
    InvalidProjectNameError,
    ProjectAlreadyExistsError,
    create_project,
    list_projects,
    normalize_project_name,
)


class FakeStore:
    def __init__(self) -> None:
        self.items: dict[tuple[tuple[str, ...], str], dict] = {}

    def put_if_absent(self, namespace: tuple[str, ...], key: str, value: dict) -> bool:
        identity = (namespace, key)
        if identity in self.items:
            return False
        self.items[identity] = value
        return True

    def get(self, namespace: tuple[str, ...], key: str):
        value = self.items.get((namespace, key))
        return SimpleNamespace(value=value) if value is not None else None

    def search(self, namespace: tuple[str, ...], limit: int = 1000):
        return [
            SimpleNamespace(key=key, value=value)
            for (item_namespace, key), value in self.items.items()
            if item_namespace == namespace
        ][:limit]


@pytest.mark.parametrize(
    ("supplied", "name", "project_id"),
    [
        ("Project A", "Project A", "project_a"),
        (" project   a ", "project a", "project_a"),
        ("PROJECT_A", "PROJECT_A", "project_a"),
    ],
)
def test_project_name_normalization(supplied: str, name: str, project_id: str) -> None:
    project = normalize_project_name(supplied)
    assert (project.name, project.id) == (name, project_id)


@pytest.mark.parametrize("name", ["", "bad/name", "punctuation!", "x" * 65])
def test_invalid_project_names_are_rejected(name: str) -> None:
    with pytest.raises(InvalidProjectNameError):
        normalize_project_name(name)


def test_create_is_create_only_and_project_file_is_catalog() -> None:
    store = FakeStore()
    created = create_project(store, "owner-sub", "Project A")
    assert created.id == "project_a"
    assert list_projects(store, "owner-sub") == [created]
    with pytest.raises(ProjectAlreadyExistsError):
        create_project(store, "owner-sub", " project a ")
    assert list_projects(store, "owner-sub") == [created]


def test_project_runtime_uses_shared_non_expiring_filesystem() -> None:
    runtime = object.__new__(AgentRuntime)
    runtime.config = SimpleNamespace(id="agent-a", name="Agent A", backend=None)
    runtime._session_id = "conversation-a"
    runtime._project_id = "project_a"
    runtime.settings = SimpleNamespace(default_fs_ttl_seconds=21600, max_fs_ttl_seconds=0)

    assert runtime._resolve_fs_namespace() == ("agent-a", "project_a", "filesystem")
    assert runtime._resolve_fs_ttl() == 0


def test_unscoped_runtime_keeps_conversation_filesystem_and_default_ttl() -> None:
    runtime = object.__new__(AgentRuntime)
    runtime.config = SimpleNamespace(id="agent-a", name="Agent A", backend=None)
    runtime._session_id = "conversation-a"
    runtime._project_id = None
    runtime.settings = SimpleNamespace(default_fs_ttl_seconds=21600, max_fs_ttl_seconds=0)

    assert runtime._resolve_fs_namespace() == ("agent-a", "conversation-a", "filesystem")
    assert runtime._resolve_fs_ttl() == 21600


def _agent_with_memory(*, enabled: bool = True) -> DynamicAgentConfig:
    return DynamicAgentConfig.model_validate(
        {
            "_id": "agent-1",
            "name": "Memory agent",
            "system_prompt": "Help the user.",
            "model": {"id": "test", "provider": "test"},
            "owner_id": "owner@example.com",
            "builtin_tools": {"memory": {"enabled": enabled}},
        }
    )


def test_config_override_can_disable_memory() -> None:
    overridden = apply_config_override(
        _agent_with_memory(),
        {"builtin_tools": {"memory": {"enabled": False}}},
    )
    assert overridden.builtin_tools is not None
    assert overridden.builtin_tools.memory is not None
    assert overridden.builtin_tools.memory.enabled is False


def test_config_override_cannot_enable_memory() -> None:
    agent = _agent_with_memory(enabled=False)
    with pytest.raises(HTTPException) as exc_info:
        apply_config_override(agent, {"builtin_tools": {"memory": {"enabled": True}}})
    assert exc_info.value.status_code == 400


def test_legacy_memory_projects_flag_is_ignored() -> None:
    agent = DynamicAgentConfig.model_validate(
        {
            "_id": "agent-1",
            "name": "Memory agent",
            "system_prompt": "Help the user.",
            "model": {"id": "test", "provider": "test"},
            "owner_id": "owner@example.com",
            "builtin_tools": {"memory": {"enabled": True, "projects_enabled": True}},
        }
    )
    assert agent.builtin_tools is not None
    assert agent.builtin_tools.memory is not None
    assert agent.builtin_tools.memory.model_dump() == {"enabled": True}


def test_project_creation_is_the_only_per_agent_project_tool() -> None:
    disabled = create_project_tools(
        store=FakeStore(),  # type: ignore[arg-type]
        owner_subject="owner-sub",
        db=SimpleNamespace(),  # type: ignore[arg-type]
        project_id=None,
        allow_create=False,
    )
    enabled = create_project_tools(
        store=FakeStore(),  # type: ignore[arg-type]
        owner_subject="owner-sub",
        db=SimpleNamespace(),  # type: ignore[arg-type]
        project_id=None,
        allow_create=True,
    )
    assert [item.name for item in disabled] == ["list_projects"]
    assert [item.name for item in enabled] == ["list_projects", "create_project"]


def test_builtin_catalog_describes_project_creation_separately_from_memory() -> None:
    definitions = {item.id: item for item in get_builtin_tool_definitions()}
    assert "Project memory is automatic" in definitions["memory"].description
    assert definitions["create_project"].name == "Create Project"
    assert definitions["create_project"].description == "Allows this agent to call create_project from a chat."
    assert definitions["create_project"].enabled_by_default is False


def test_legacy_projects_capability_migrates_to_create_project() -> None:
    agent = DynamicAgentConfig.model_validate(
        {
            "_id": "agent-1",
            "name": "Project creator",
            "system_prompt": "Help the user.",
            "model": {"id": "test", "provider": "test"},
            "owner_id": "owner@example.com",
            "builtin_tools": {"projects": {"enabled": True}},
        }
    )
    assert agent.builtin_tools is not None
    assert agent.builtin_tools.create_project is not None
    assert agent.builtin_tools.create_project.enabled is True
    assert "projects" not in agent.builtin_tools.model_dump()


def test_config_override_cannot_grant_project_creation() -> None:
    with pytest.raises(HTTPException) as exc_info:
        apply_config_override(
            _agent_with_memory(),
            {"builtin_tools": {"create_project": {"enabled": True}}},
        )
    assert exc_info.value.status_code == 400


class _PlatformConfigCollection:
    def __init__(self, document: dict | None) -> None:
        self.document = document

    def find_one(self, *_args, **_kwargs):
        return self.document


class _PlatformDatabase:
    def __init__(self, document: dict | None) -> None:
        self.collection = _PlatformConfigCollection(document)

    def __getitem__(self, name: str):
        assert name == "platform_config"
        return self.collection


def test_platform_projects_admin_override_precedes_deployment_default() -> None:
    settings = SimpleNamespace(projects_enabled=False)
    assert projects_enabled(_PlatformDatabase({"projects": {"enabled": True}}), settings) is True  # type: ignore[arg-type]
    assert projects_enabled(_PlatformDatabase({"projects": {"enabled": False}}), SimpleNamespace(projects_enabled=True)) is False  # type: ignore[arg-type]
    assert projects_enabled(_PlatformDatabase(None), SimpleNamespace(projects_enabled=True)) is True  # type: ignore[arg-type]
