"""Native inference controls and replay-safe platform retries share agent policy."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException
from langchain_core.tools import ToolException, tool

from dynamic_agents.models import DynamicAgentConfig, FeaturesConfig, MiddlewareEntry
from dynamic_agents.services import harness_tools
from dynamic_agents.services.harness_policy import harness_middleware_params, harness_model_retry_options
from dynamic_agents.services.harness_tools import HarnessResources, HarnessToolError, HarnessToolExecutionFailed
from dynamic_agents.services.sandbox_runtime import _session_options


def _agent(*entries: dict) -> DynamicAgentConfig:
    return DynamicAgentConfig(_id="example-agent", name="Example", owner_id="owner@example.com",
        system_prompt="Approved instructions", model={"id": "example", "provider": "example"},
        features=FeaturesConfig(middleware=[MiddlewareEntry(**entry) for entry in entries]) if entries else None)


def test_model_retries_use_existing_defaults_and_released_native_count_control():
    agent = _agent()
    env, warnings = harness_model_retry_options(agent)
    assert env == {"CLAUDE_CODE_MAX_RETRIES": "5"}
    assert "backoff_factor=2.0" in warnings[0]
    assert "terminal error behavior" in warnings[0]
    assert harness_middleware_params(agent, "model_call_limit")["run_limit"] == 200
    profile = SimpleNamespace(harness="claude-code")
    options = _session_options(agent, "Approved instructions", profile)["claudeCode"]["options"]
    assert options["maxTurns"] == 200
    assert options["env"] == env


def test_disabled_and_explicitly_absent_model_retries_disable_native_retry_budget():
    for entries in (({"type": "model_retry", "enabled": False},), ({"type": "tool_retry"},)):
        env, warnings = harness_model_retry_options(_agent(*entries))
        assert env == {"CLAUDE_CODE_MAX_RETRIES": "0", "CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES": "0"}
        assert warnings == ()


@pytest.mark.parametrize("count", [-1, 1.5, "3", True])
def test_invalid_native_retry_count_is_not_silently_ignored(count):
    with pytest.raises(ValueError, match="nonnegative integer"):
        harness_model_retry_options(_agent({"type": "model_retry", "params": {"max_retries": count}}))


def test_native_retry_metadata_preserves_selected_count_and_explains_policy_boundary():
    agent = _agent({"type": "model_retry", "params": {"max_retries": 2, "backoff_factor": 3, "on_failure": "return_message"}})
    env, warnings = harness_model_retry_options(agent)
    assert env["CLAUDE_CODE_MAX_RETRIES"] == "2"
    assert "backoff_factor=3" in warnings[0] and "on_failure='return_message'" in warnings[0]
    assert "never automatically resends an interrupted prompt" in warnings[0]


def _resources(monkeypatch, function, *, on_failure="continue", count=2):
    agent = _agent({"type": "tool_retry", "params": {"max_retries": count, "initial_delay": 0,
                                                    "jitter": False, "on_failure": on_failure}})
    mongo = SimpleNamespace(get_agent=lambda _identifier: agent, get_agent_mcp_servers=lambda _agent: [])
    resources = object.__new__(HarnessResources)
    resources.run = SimpleNamespace(run_id="example-run", agent_id=agent.id, session_id="example-session")
    resources.repository = SimpleNamespace(mongo=mongo, _active=lambda *_args, **_kwargs: {})
    resources.lease_id, resources.admit_parent = "lease", None
    monkeypatch.setattr(harness_tools, "require_agent_use_permission", AsyncMock())
    return resources, agent, function


@pytest.mark.parametrize("annotation", ["readOnlyHint", "idempotentHint"])
async def test_server_admitted_replay_safe_tool_uses_configured_attempts(monkeypatch, annotation):
    calls = []

    @tool
    async def lookup(query: str) -> str:
        """Read an admitted resource."""
        calls.append(query)
        if len(calls) < 3:
            raise ConnectionError("remote details must remain private")
        return "Result"

    lookup.metadata = {annotation: True}
    resources, agent, function = _resources(monkeypatch, lookup)
    result = await resources._invoke_tool(agent, [], function, {"query": "scope"})
    assert result.content == "Result" and result.status == "success"
    assert calls == ["scope", "scope", "scope"]
    assert harness_tools.require_agent_use_permission.await_count == 3


async def test_uncertain_mutation_is_never_repeated_from_agent_claimed_arguments(monkeypatch):
    calls = []

    @tool
    async def mutate(readOnlyHint: bool) -> str:
        """Change an admitted resource."""
        calls.append(readOnlyHint)
        raise ConnectionError("acknowledgement lost after a side effect")

    resources, agent, function = _resources(monkeypatch, mutate)
    with pytest.raises(ConnectionError):
        await resources._invoke_tool(agent, [], function, {"readOnlyHint": True})
    assert calls == [True]


async def test_exhausted_continue_policy_sanitizes_remote_error(monkeypatch):
    calls = []

    @tool
    async def lookup() -> str:
        """Read an admitted resource."""
        calls.append(True)
        raise ConnectionError("private-credential-marker")

    lookup.metadata = {"readOnlyHint": True}
    resources, agent, function = _resources(monkeypatch, lookup, on_failure="return_message")
    result = await resources._invoke_tool(agent, [], function, {})
    assert len(calls) == 3 and result.status == "error"
    encoded = harness_tools._content(result)
    assert encoded["isError"] is True
    assert "private-credential-marker" not in str(encoded)


async def test_exhausted_stop_policy_terminates_instead_of_reporting_success(monkeypatch):
    calls = []

    @tool
    async def lookup() -> str:
        """Read an admitted resource."""
        calls.append(True)
        raise ConnectionError("private-credential-marker")

    lookup.metadata = {"readOnlyHint": True}
    resources, agent, function = _resources(monkeypatch, lookup, on_failure="error")
    with pytest.raises(HarnessToolExecutionFailed, match="exhausted"):
        await resources._invoke_tool(agent, [], function, {})
    assert len(calls) == 3


async def test_revoked_lease_during_retry_stops_before_second_tool_invocation(monkeypatch):
    calls = []

    @tool
    async def lookup() -> str:
        """Read an admitted resource."""
        calls.append(True)
        raise ConnectionError("transient")

    lookup.metadata = {"readOnlyHint": True}
    resources, agent, function = _resources(monkeypatch, lookup)

    def active(*_args, **_kwargs):
        if calls:
            raise HarnessToolError("lease lost")

    resources.repository._active = active
    with pytest.raises(HarnessToolError, match="lease lost"):
        await resources._invoke_tool(agent, [], function, {})
    assert calls == [True]


async def test_cancellation_is_not_a_retryable_tool_failure(monkeypatch):
    calls = []

    @tool
    async def lookup() -> str:
        """Read an admitted resource."""
        calls.append(True)
        raise asyncio.CancelledError

    lookup.metadata = {"readOnlyHint": True}
    resources, agent, function = _resources(monkeypatch, lookup)
    with pytest.raises(asyncio.CancelledError):
        await resources._invoke_tool(agent, [], function, {})
    assert calls == [True]


async def test_mcp_reported_error_is_retried_only_for_server_admitted_readonly_tool(monkeypatch):
    calls = []

    @tool
    async def lookup() -> str:
        """Read an admitted resource."""
        calls.append(True)
        raise ToolException("private-credential-marker")

    lookup.handle_tool_error = True
    lookup.metadata = {"readOnlyHint": True}
    resources, agent, function = _resources(monkeypatch, lookup)
    result = await resources._invoke_tool(agent, [], function, {})
    assert len(calls) == 3 and result.status == "error"
    assert "private-credential-marker" not in result.content


async def test_revoked_permission_is_not_treated_as_a_transient_tool_failure(monkeypatch):
    calls = []

    @tool
    async def lookup() -> str:
        """Read an admitted resource."""
        calls.append(True)
        raise ConnectionError("transient")

    lookup.metadata = {"readOnlyHint": True}
    resources, agent, function = _resources(monkeypatch, lookup)
    harness_tools.require_agent_use_permission.side_effect = [None, HTTPException(403, "revoked")]
    with pytest.raises(HTTPException):
        await resources._invoke_tool(agent, [], function, {})
    assert calls == [True]


async def test_workspace_import_and_publication_happen_once_around_replay_safe_retries(monkeypatch):
    calls = []

    @tool
    async def lookup() -> str:
        """Read an admitted resource."""
        calls.append(True)
        if len(calls) == 1:
            raise ConnectionError("transient")
        return "Result"

    lookup.metadata = {"readOnlyHint": True}
    resources, agent, function = _resources(monkeypatch, lookup)
    resources.runtime = SimpleNamespace(config=agent, settings=None, _user=None, _client_context=None)
    resources.repository.mongo._client = None
    resources.children, resources.admitted_names = {}, {"lookup"}
    resources.before_tool, resources.after_tool = AsyncMock(), AsyncMock()

    class FreshRuntime:
        def __init__(self, *_args, **_kwargs):
            pass

        async def prepare_platform_resources(self):
            return SimpleNamespace(tools=[function], builtin_tool_names=set())

        def _build_interrupt_config(self, *_args):
            return {}

        async def cleanup(self):
            pass

    monkeypatch.setattr(harness_tools, "AgentRuntime", FreshRuntime)
    result = await resources.execute("lookup", {})
    assert result["isError"] is False and calls == [True, True]
    resources.before_tool.assert_awaited_once()
    resources.after_tool.assert_awaited_once()


async def test_stop_policy_commits_tool_failure_before_failing_the_turn(monkeypatch):
    @tool
    async def lookup() -> str:
        """Read an admitted resource."""
        return "unused"

    resources, _, _ = _resources(monkeypatch, lookup)
    record = {"_id": "request", "params": {"name": "lookup", "arguments": {}}}
    resources.repository.claim = Mock(return_value=record)
    resources.repository.complete = Mock()
    resources.execute = AsyncMock(side_effect=HarnessToolExecutionFailed("stop"))
    with pytest.raises(HarnessToolExecutionFailed):
        await resources._serve()
    resources.repository.complete.assert_called_once()
    assert resources.repository.complete.call_args.args[-1]["isError"] is True


async def test_tool_filter_does_not_apply_stop_or_retry_policy_to_excluded_tool(monkeypatch):
    calls = []

    @tool
    async def lookup() -> str:
        """Read an admitted resource."""
        calls.append(True)
        raise ConnectionError("transient")

    lookup.metadata = {"readOnlyHint": True}
    resources, agent, function = _resources(monkeypatch, lookup, on_failure="error")
    agent.features.middleware[0].params["tools"] = ["other"]
    with pytest.raises(ConnectionError):
        await resources._invoke_tool(agent, [], function, {})
    assert calls == [True]
