import pytest
from fastapi import HTTPException

from dynamic_agents.routes.files import _parse_namespace
from dynamic_agents.services.memory_paths import (
    agent_source,
    global_source,
    is_memory_path,
    memory_store_ns,
    mounted_sources,
    project_source,
    validate_project_id,
)


def test_memory_store_namespace_is_structurally_unreachable_from_files_api() -> None:
    namespace = memory_store_ns("8d74e124-3100-4c92-a3ec-62e5ac7bbc76")

    assert namespace == ("8d74e124-3100-4c92-a3ec-62e5ac7bbc76", "memory")
    with pytest.raises(HTTPException) as exc_info:
        _parse_namespace('["8d74e124-3100-4c92-a3ec-62e5ac7bbc76", "memory"]')
    assert exc_info.value.status_code == 400


@pytest.mark.parametrize("key", ["..", "a/b", "-leading", "A", "a" * 65, "with space"])
def test_project_id_rejects_unsafe_or_noncanonical_values(key: str) -> None:
    with pytest.raises(ValueError):
        validate_project_id(key)


def test_mounted_sources_are_exact_and_paths_are_canonical() -> None:
    assert mounted_sources("agent-a") == [global_source(), agent_source("agent-a")]
    assert mounted_sources("agent-a", "project-a") == [
        global_source(),
        agent_source("agent-a"),
        project_source("project-a"),
    ]
    assert all(is_memory_path(path) for path in mounted_sources("agent-a", "project-a"))
    assert not is_memory_path("/memories/projects/project-b/notes.md")
