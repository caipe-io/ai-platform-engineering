"""Scope is opt-in and never replaces the application's global tracer provider."""

from agent_telemetry.scope import current_scope_run, scope_session

__all__ = ["current_scope_run", "scope_session"]
