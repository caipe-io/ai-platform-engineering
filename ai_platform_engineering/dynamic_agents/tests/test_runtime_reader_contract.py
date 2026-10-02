"""Regression tests for Dynamic Agents runtime-reader boundaries."""

from __future__ import annotations

from dynamic_agents.routes import agents


def test_dynamic_agents_service_does_not_ship_agent_crud_router() -> None:
    """The BFF owns CRUD; DA only exposes the agent reachability probe."""

    assert len(agents.router.routes) == 1
    probe = agents.router.routes[0]
    assert probe.path == "/agents/{agent_id}/probe"
    assert probe.methods == {"GET"}
