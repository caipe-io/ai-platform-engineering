"""Resolve existing middleware controls for the sandbox execution placement."""

from __future__ import annotations

from typing import Any

from dynamic_agents.models import DynamicAgentConfig
from dynamic_agents.services.middleware import MIDDLEWARE_REGISTRY, get_default_middleware_entries


def harness_middleware_entries(agent: DynamicAgentConfig, kind: str) -> list[dict[str, Any]]:
    """Use the same defaults and first-enabled singleton rule as native agents."""
    entries = (agent.features.middleware if agent.features and agent.features.middleware else
               get_default_middleware_entries())
    result = []
    for entry in entries:
        value = entry.model_dump() if hasattr(entry, "model_dump") else entry
        if value["type"] == kind and value.get("enabled", True):
            result.append({**MIDDLEWARE_REGISTRY[kind].default_params, **value.get("params", {})})
            if not MIDDLEWARE_REGISTRY[kind].allow_multiple:
                break
    return result


def harness_middleware_params(agent: DynamicAgentConfig, kind: str) -> dict[str, Any] | None:
    entries = harness_middleware_entries(agent, kind)
    return entries[0] if entries else None


def harness_model_retry_options(agent: DynamicAgentConfig) -> tuple[dict[str, str], tuple[str, ...]]:
    """Configure inference retries inside Claude; never replay an ACP prompt."""
    params = harness_middleware_params(agent, "model_retry")
    count = params.get("max_retries", 5) if params is not None else 0
    if type(count) is not int or count < 0:
        raise ValueError("Model retry max_retries must be a nonnegative integer")
    env = {"CLAUDE_CODE_MAX_RETRIES": str(count)}
    if count == 0:
        # The CLI has a separate non-streaming timeout recovery budget.
        env["CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES"] = "0"
    if params is None:
        return env, ()
    native = {key: value for key, value in params.items() if key != "max_retries"}
    details = ", ".join(f"{key}={value!r}" for key, value in native.items())
    warning = (
        f"Claude Code applies model_retry.max_retries={count} within native inference requests. "
        "Its native retry classification, delays and terminal error behavior apply; "
        f"CAIPE middleware settings ({details}) do not override those internals. "
        "CAIPE never automatically resends an interrupted prompt."
    )
    return env, (warning,)
