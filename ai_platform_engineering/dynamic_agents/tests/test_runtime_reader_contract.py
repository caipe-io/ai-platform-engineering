"""Regression tests for Dynamic Agents runtime-reader boundaries."""

from __future__ import annotations

from dynamic_agents.routes.agents import router


def test_dynamic_agents_agent_routes_are_probe_only() -> None:
    """The BFF owns configuration CRUD; the runtime exposes only a probe."""
    assert [(route.path, route.methods) for route in router.routes] == [
        ("/agents/{agent_id}/probe", {"GET"}),
    ]
