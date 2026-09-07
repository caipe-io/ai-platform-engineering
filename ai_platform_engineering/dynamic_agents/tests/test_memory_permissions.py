from deepagents.backends.composite import CompositeBackend
from deepagents.backends.state import StateBackend
from deepagents.middleware.filesystem import _check_fs_permission, supports_execution

from dynamic_agents.services.agent_runtime import (
    _memory_deny_permissions,
    _memory_permissions,
)
from dynamic_agents.services.memory_paths import mounted_sources, project_source


def test_only_active_memory_sources_are_readable_and_writable() -> None:
    sources = mounted_sources("agent-a", "active-pod")
    permissions = _memory_permissions(sources)

    for source in sources:
        assert _check_fs_permission(permissions, "read", source) == "allow"
        assert _check_fs_permission(permissions, "write", source) == "allow"

    inactive = project_source("secret-project")
    other_agent = "/memories/agents/agent-b/AGENTS.md"
    for path in (inactive, other_agent):
        assert _check_fs_permission(permissions, "read", path) == "deny"
        assert _check_fs_permission(permissions, "write", path) == "deny"


def test_subagent_memory_deny_is_read_write_complete() -> None:
    permissions = _memory_deny_permissions()

    assert _check_fs_permission(permissions, "read", "/memories/global/AGENTS.md") == "deny"
    assert _check_fs_permission(permissions, "write", "/memories/global/AGENTS.md") == "deny"


def test_composite_memory_backend_is_not_execution_capable() -> None:
    backend = CompositeBackend(
        default=StateBackend(),
        routes={"/memories/": StateBackend()},
    )

    assert supports_execution(backend) is False
