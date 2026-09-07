"""Owner-scoped Projects backed by canonical Project memory files."""

from __future__ import annotations

import re
from dataclasses import dataclass

from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.memory_codec import parse
from dynamic_agents.services.memory_paths import (
    memory_store_ns,
    project_seed_content,
    project_source,
    validate_project_id,
)

_PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9 _-]+$")


class InvalidProjectNameError(ValueError):
    """Raised when a supplied Project name cannot form a safe ID."""


class ProjectAlreadyExistsError(ValueError):
    """Raised when create-only Project creation finds the generated ID."""

    def __init__(self, project: "Project") -> None:
        self.project = project
        super().__init__(f'A project named "{project.name}" already exists')


@dataclass(frozen=True, slots=True)
class Project:
    id: str
    name: str

    def as_dict(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name}


def normalize_project_name(value: str) -> Project:
    """Normalize a display name and derive its immutable Project ID."""

    if not isinstance(value, str):
        raise InvalidProjectNameError("Project name must be a string")
    name = " ".join(value.split())
    if not name:
        raise InvalidProjectNameError("Project name must not be blank")
    if not _PROJECT_NAME_RE.fullmatch(name):
        raise InvalidProjectNameError(
            "Project name may contain only letters, numbers, spaces, underscores, and hyphens"
        )
    project_id = re.sub(r"_+", "_", name.lower().replace(" ", "_"))
    try:
        validate_project_id(project_id)
    except ValueError as exc:
        raise InvalidProjectNameError(str(exc)) from exc
    return Project(id=project_id, name=name)


def _project_from_item(key: str, value: dict) -> Project | None:
    path = f"/memories{key}"
    parts = path.split("/")
    if len(parts) != 5 or parts[1:3] != ["memories", "projects"] or parts[4] != "AGENTS.md":
        return None
    project_id = parts[3]
    try:
        validate_project_id(project_id)
    except ValueError:
        return None
    content = value.get("content", "")
    text = "\n".join(content) if isinstance(content, list) else str(content)
    memory_file = parse(text, default_scope="project")
    marker_id = memory_file.extra.get("project_id")
    name = memory_file.extra.get("project_name")
    if marker_id != project_id or not name:
        return None
    try:
        expected = normalize_project_name(name)
    except InvalidProjectNameError:
        return None
    if expected.id != project_id:
        return None
    return Project(id=project_id, name=name)


def list_projects(store: MongoDBGridFSStore, owner_subject: str) -> list[Project]:
    """List immutable Project metadata without returning memory contents."""

    namespace = memory_store_ns(owner_subject)
    projects = [
        project
        for item in store.search(namespace, limit=1000)
        if (project := _project_from_item(str(item.key), item.value)) is not None
    ]
    return sorted(projects, key=lambda item: (item.name.casefold(), item.id))


def get_project(
    store: MongoDBGridFSStore,
    owner_subject: str,
    project_id: str,
) -> Project | None:
    """Return one owned Project from its authoritative memory file."""

    validate_project_id(project_id)
    key = project_source(project_id).removeprefix("/memories")
    item = store.get(memory_store_ns(owner_subject), key)
    return _project_from_item(key, item.value) if item else None


def create_project(
    store: MongoDBGridFSStore,
    owner_subject: str,
    supplied_name: str,
) -> Project:
    """Atomically create a Project, rejecting rather than overwriting duplicates."""

    project = normalize_project_name(supplied_name)
    namespace = memory_store_ns(owner_subject)
    key = project_source(project.id).removeprefix("/memories")
    created = store.put_if_absent(
        namespace,
        key,
        {"content": project_seed_content(project.id, project.name), "encoding": "utf-8"},
    )
    if not created:
        existing = get_project(store, owner_subject, project.id) or project
        raise ProjectAlreadyExistsError(existing)
    return project
