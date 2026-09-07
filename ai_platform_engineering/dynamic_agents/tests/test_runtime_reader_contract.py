"""Regression tests for Dynamic Agents runtime-reader boundaries."""

from __future__ import annotations

from dynamic_agents.routes.agents import router
from dynamic_agents.routes.projects import router as projects_router


def test_dynamic_agents_service_does_not_ship_agent_crud_router() -> None:
    """The BFF owns agent writes; DA only serves runtime-safe helper routes."""

    agent_routes = {
        (method, route.path)
        for route in router.routes
        for method in (route.methods or set())
    }
    project_routes = {
        (method, route.path)
        for route in projects_router.routes
        for method in (route.methods or set())
    }

    assert agent_routes == {("GET", "/agents/{agent_id}/probe")}
    assert project_routes == {("GET", "/projects"), ("POST", "/projects")}
