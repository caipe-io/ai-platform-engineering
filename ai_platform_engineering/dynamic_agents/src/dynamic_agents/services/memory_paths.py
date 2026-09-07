"""Canonical paths and ownership helpers for deepagents-backed user memory."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING
from urllib.parse import quote

from dynamic_agents.config import Settings, get_settings

if TYPE_CHECKING:
    from dynamic_agents.models import UserContext


MEMORY_ROOT = "/memories"
MEMORY_FILENAME = "AGENTS.md"
MEMORY_STORE_KIND = "memory"
SEED_STUB = "_No memories saved here yet._"
SEED_TEMPLATE = "<!-- caipe-memory:file v=1 scope={scope} -->\n" + SEED_STUB + "\n"

_PROJECT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_STORE_COMPONENT_RE = re.compile(r"^[A-Za-z0-9._@+\-:~]+$")


def memory_owner_key(user: UserContext, settings: Settings | None = None) -> str:
    """Return the immutable Keycloak subject used to own memory.

    Email fallback is intentionally limited to DEBUG mode so production never
    turns mutable PII into a storage namespace.
    """

    subject = (user.sub or "").strip()
    if subject:
        return subject
    resolved_settings = settings or get_settings()
    if resolved_settings.debug and user.email:
        return user.email
    raise ValueError("Authenticated user is missing the immutable 'sub' claim")


def memory_store_ns(subject: str) -> tuple[str, str]:
    """Return the deliberately two-component memory store namespace."""

    return _validate_store_namespace((subject, MEMORY_STORE_KIND))


def global_source() -> str:
    return f"{MEMORY_ROOT}/global/{MEMORY_FILENAME}"


def agent_source(agent_id: str) -> str:
    _validate_path_component(agent_id, "agent_id")
    return f"{MEMORY_ROOT}/agents/{agent_id}/{MEMORY_FILENAME}"


def project_source(project_id: str) -> str:
    validate_project_id(project_id)
    return f"{MEMORY_ROOT}/projects/{project_id}/{MEMORY_FILENAME}"


def validate_project_id(project_id: str) -> str:
    """Validate a generated Project ID and return it unchanged."""

    if not isinstance(project_id, str) or not _PROJECT_ID_RE.fullmatch(project_id):
        raise ValueError(
            "project IDs must be 1-64 lowercase letters, digits, "
            "underscores, or hyphens, and must start with a letter or digit"
        )
    if _UUID_RE.fullmatch(project_id):
        raise ValueError("project IDs must not use the conversation UUID format")
    return project_id


def is_memory_path(path: str) -> bool:
    """Return whether *path* is a canonical memory file path."""

    if path == global_source():
        return True
    parts = path.split("/")
    if len(parts) != 5 or parts[0] or parts[1] != "memories" or parts[4] != MEMORY_FILENAME:
        return False
    if parts[2] == "agents":
        try:
            _validate_path_component(parts[3], "agent_id")
        except ValueError:
            return False
        return True
    if parts[2] == "projects":
        try:
            validate_project_id(parts[3])
        except ValueError:
            return False
        return True
    return False


def memory_scope_from_path(path: str) -> str:
    """Return the logical scope encoded by a canonical memory path."""

    if path == global_source():
        return "global"
    if not is_memory_path(path):
        raise ValueError(f"Invalid memory path: {path}")
    return "agent" if path.startswith(f"{MEMORY_ROOT}/agents/") else "project"


def seed_content(path: str) -> str:
    """Return the visible, canonical seed for a mounted memory file."""

    return SEED_TEMPLATE.format(scope=memory_scope_from_path(path))


def project_seed_content(project_id: str, project_name: str) -> str:
    """Return the canonical create-only Project memory seed."""

    validate_project_id(project_id)
    return (
        "<!-- caipe-memory:file v=1 scope=project "
        f"project_id={project_id} project_name={quote(project_name, safe='')} -->\n"
        f"{SEED_STUB}\n"
    )


def mounted_sources(agent_id: str, project_id: str | None = None) -> list[str]:
    """Return the exact memory files mounted for one conversation."""

    sources = [global_source(), agent_source(agent_id)]
    if project_id is not None:
        sources.append(project_source(project_id))
    return sources


def _validate_path_component(value: str, name: str) -> None:
    if not isinstance(value, str) or not value or value in {".", ".."} or "/" in value or "\\" in value:
        raise ValueError(f"{name} must be a non-empty safe path component")
    _validate_store_namespace((value,))


def _validate_store_namespace(namespace: tuple[str, ...]) -> tuple[str, ...]:
    """Mirror deepagents' namespace contract without importing a private API."""

    if not namespace:
        raise ValueError("Namespace tuple must not be empty")
    for index, component in enumerate(namespace):
        if not isinstance(component, str):
            raise TypeError(f"Namespace component at index {index} must be a string")
        if not component or not _STORE_COMPONENT_RE.fullmatch(component):
            raise ValueError(f"Namespace component at index {index} is unsafe: {component!r}")
    return namespace
