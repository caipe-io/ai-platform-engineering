"""Explicit policy mappings for the optional external coding provider."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from dynamic_agents.models import DynamicAgentConfig, MiddlewareEntry
from dynamic_agents.services.middleware import (
    MIDDLEWARE_REGISTRY,
    InterruptAwareToolRetryMiddleware,
    get_default_middleware_entries,
)


def execution_policy(agent: DynamicAgentConfig) -> dict[str, Any]:
    if agent.app_context_prompt is not None:
        raise HTTPException(409, "App context projection is not supported by the coding provider")
    entries = agent.features.middleware if agent.features and agent.features.middleware else get_default_middleware_entries()
    resolved: dict[str, list[dict[str, Any]]] = {}
    supported = {"model_retry", "model_call_limit", "tool_retry", "tool_call_limit", "context_editing"}
    for entry in entries:
        if isinstance(entry, dict):
            entry = MiddlewareEntry.model_validate(entry)
        if not entry.enabled:
            continue
        if entry.type not in supported:
            raise HTTPException(409, f"The coding provider cannot enforce required middleware: {entry.type}")
        spec = MIDDLEWARE_REGISTRY[entry.type]
        if entry.type in resolved and not spec.allow_multiple:
            continue
        params = {**spec.default_params, **entry.params}
        if entry.type == "model_retry":
            if set(params) - {"max_retries", "backoff_factor", "on_failure"} or any(
                params.get(name) != value for name, value in spec.default_params.items() if name != "max_retries"
            ):
                raise HTTPException(409, "Custom model retry delays, classification, and failure handling are unsupported")
            if type(params["max_retries"]) is not int or not 0 <= params["max_retries"] <= 100:
                raise HTTPException(409, "Model retry count must be a bounded nonnegative integer")
        elif entry.type == "model_call_limit":
            if set(params) - {"run_limit", "exit_behavior"} or params.get("exit_behavior") != "end" or type(params.get("run_limit")) is not int or not 1 <= params["run_limit"] <= 10000:
                raise HTTPException(409, "Model call limits require a bounded run limit and end behavior")
        elif entry.type == "context_editing":
            if params != spec.default_params:
                raise HTTPException(409, "Custom context editing cannot be enforced by provider-native compaction")
        elif entry.type == "tool_call_limit":
            if params.get("thread_limit") is not None or set(params) - {"run_limit", "tool_name", "thread_limit", "exit_behavior"}:
                raise HTTPException(409, "The coding tool service supports run limits only")
            if type(params.get("run_limit")) is not int or not 0 <= params["run_limit"] <= 10000 or params.get("exit_behavior") not in {"continue", "error", "end"}:
                raise HTTPException(409, "Tool call limits require a bounded run limit and supported failure behavior")
            if params.get("tool_name") is not None and not isinstance(params["tool_name"], str):
                raise HTTPException(409, "A per-tool limit requires a tool name")
        elif entry.type == "tool_retry":
            try:
                InterruptAwareToolRetryMiddleware(**params)
            except (TypeError, ValueError) as exc:
                raise HTTPException(409, "The tool retry policy is unsupported") from exc
        resolved.setdefault(entry.type, []).append(params)
    return {
        "model_retry": next(iter(resolved.get("model_retry", [])), None),
        "model_call_limit": next(iter(resolved.get("model_call_limit", [])), None),
        "tool_retry": next(iter(resolved.get("tool_retry", [])), None),
        "tool_call_limits": resolved.get("tool_call_limit", []),
        "context_management": "provider_native",
    }
