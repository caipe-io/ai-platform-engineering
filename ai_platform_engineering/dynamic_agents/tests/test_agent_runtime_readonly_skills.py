"""Regression: a read-only AgentRuntime must never mutate the shared
StoreBackend skill-file namespace.

A read-only runtime (used by the interrupt-state probe via
``RuntimeCache.reader()``) shares its default filesystem namespace
``(agent_id, session_id, "filesystem")`` with any real, cached chat runtime
for the same conversation. Before this fix, ``initialize()`` unconditionally
cleared and reseeded that namespace for StoreBackend agents, which would
delete a live conversation's skill files as a side effect of a read-only
probe. See the review on PR for the full trace.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest


def _patch_initialize_dependencies(monkeypatch: pytest.MonkeyPatch) -> None:
    from dynamic_agents.services import mcp_client

    monkeypatch.setattr(
        "dynamic_agents.services.agent_runtime.get_tools_with_resilience",
        lambda _connections: ([], [], {}, {}),
    )
    monkeypatch.setattr(
        "dynamic_agents.services.agent_runtime.build_mcp_connections",
        lambda *args, **kwargs: {},
    )
    monkeypatch.setattr(
        "dynamic_agents.services.agent_runtime.resolve_mcp_connections_credential_refs",
        lambda *args, **kwargs: mcp_client.McpCredentialResolutionResult(connections={}),
    )
    monkeypatch.setattr(
        "dynamic_agents.services.agent_runtime.get_llm",
        lambda *_args, **_kwargs: MagicMock(),
    )
    monkeypatch.setattr(
        "dynamic_agents.services.agent_runtime.create_deep_agent",
        lambda **_kwargs: MagicMock(),
    )
    # Fully control the skills pipeline so the test doesn't depend on real
    # skill-catalog/Mongo lookups: one skill with one file is enough to
    # reach the seeding step this test is verifying.
    monkeypatch.setattr(
        "dynamic_agents.services.agent_runtime.load_skills",
        lambda *_args, **_kwargs: ["fake-skill"],
    )
    monkeypatch.setattr(
        "dynamic_agents.services.agent_runtime.detect_missing_skills",
        lambda *_args, **_kwargs: ([], ""),
    )
    monkeypatch.setattr(
        "dynamic_agents.services.agent_runtime.build_skills_files",
        lambda *_args, **_kwargs: ({"SKILL.md": "content"}, ["fake-source"]),
    )


def _build_runtime(*, readonly: bool):
    from dynamic_agents.models import AgentBackend, DynamicAgentConfig, ModelConfig, UserContext
    from dynamic_agents.services.agent_runtime import AgentRuntime

    runtime = AgentRuntime(
        config=DynamicAgentConfig(
            _id="agent-sre",
            name="SRE Agent",
            system_prompt="You are an SRE assistant.",
            owner_id="operator@example.com",
            model=ModelConfig(id="test-model", provider="test-provider"),
            backend=AgentBackend(type="store"),
            skills=["skill-a"],
        ),
        mcp_servers=[],
        user=UserContext(email="operator@example.com"),
        session_id="conv-1",
        ephemeral=True,
        readonly=readonly,
    )
    # `ephemeral=True` gives a real (but in-memory) store that doesn't
    # implement the GridFS-specific delete_by_key_prefix/put contract this
    # test exercises. Swap in a spy so the guard's effect is observable.
    runtime._store = MagicMock()
    return runtime


async def test_readonly_runtime_does_not_delete_or_reseed_skill_files(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_initialize_dependencies(monkeypatch)
    runtime = _build_runtime(readonly=True)

    await runtime.initialize()

    runtime._store.delete_by_key_prefix.assert_not_called()
    runtime._store.put.assert_not_called()


async def test_normal_runtime_still_clears_and_reseeds_skill_files(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Control case: confirms the guard is specific to readonly, not a no-op everywhere."""
    _patch_initialize_dependencies(monkeypatch)
    runtime = _build_runtime(readonly=False)

    await runtime.initialize()

    runtime._store.delete_by_key_prefix.assert_called_once()
    runtime._store.put.assert_called_once_with(runtime._resolve_fs_namespace(), "SKILL.md", "content")
