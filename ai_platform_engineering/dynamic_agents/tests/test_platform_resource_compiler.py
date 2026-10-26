from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.config import Settings
from dynamic_agents.models import DynamicAgentConfig, UserContext
from dynamic_agents.services import agent_runtime
from dynamic_agents.services.agent_runtime import AgentRuntime


def config(**updates) -> DynamicAgentConfig:
    return DynamicAgentConfig(
        _id="agent-example", name="Example agent", owner_id="owner@example.test",
        system_prompt="Help {{ user.email }}.", model={"id": "example-model", "provider": "example"}, **updates,
    )


def runtime(monkeypatch: pytest.MonkeyPatch, *, email: str = "owner@example.test", agent=None) -> AgentRuntime:
    monkeypatch.setattr(agent_runtime, "TracingManager", MagicMock())
    return AgentRuntime(agent or config(), [], Settings(), user=UserContext(email=email), session_id="context-example", ephemeral=True)


async def test_preparation_reuses_native_tools_without_instantiating_a_model_or_graph(monkeypatch: pytest.MonkeyPatch) -> None:
    instance = runtime(monkeypatch, agent=config(builtin_tools={"current_datetime": {"enabled": True}}))
    model = MagicMock()
    graph = MagicMock()
    monkeypatch.setattr(agent_runtime, "get_llm", model)
    monkeypatch.setattr(agent_runtime, "create_deep_agent", graph)
    resources = await instance.prepare_platform_resources()
    assert resources.system_prompt == "Help owner@example.test."
    assert "current_datetime" in {tool.name for tool in resources.tools}
    assert await instance.prepare_platform_resources() is resources
    assert not model.called and not graph.called and instance._initialized is False
    await instance.cleanup()
    assert instance._platform_resources is None


async def test_native_initialize_keeps_compiled_tools_prompts_specialists_and_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    instance = runtime(monkeypatch, agent=config(builtin_tools={"current_datetime": {"enabled": True}}))
    resources = await instance.prepare_platform_resources()
    model = object()
    graph = MagicMock(return_value=object())
    middleware = MagicMock(return_value=[])
    children = [{"name": "helper", "description": "Selected specialist", "system_prompt": "Specialist prompt", "tools": []}]
    instance._resolve_subagents = AsyncMock(return_value=children)
    instance._get_attachment_store = lambda: None
    monkeypatch.setattr(agent_runtime, "get_llm", lambda *args: model)
    monkeypatch.setattr(agent_runtime, "create_deep_agent", graph)
    monkeypatch.setattr(agent_runtime, "build_middleware", middleware)
    monkeypatch.setattr(agent_runtime, "_with_general_purpose_tool_result_recovery", lambda subagents, **kwargs: subagents)
    await instance.initialize()
    await instance.initialize()
    assert graph.call_count == 1 and instance._resolve_subagents.await_count == 1
    assert graph.call_args.kwargs["tools"] == resources.tools
    assert graph.call_args.kwargs["system_prompt"] == resources.system_prompt
    assert graph.call_args.kwargs["subagents"] == children
    assert graph.call_args.kwargs["model"] is model
    assert middleware.call_args.args[0] is None
    assert graph.call_args.kwargs["checkpointer"] is instance._checkpointer
    await instance.cleanup()


async def test_concurrent_preparation_keeps_each_owner_and_bearer_in_its_own_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    async def prepare(email: str, bearer: str):
        token = current_user_token.set(bearer)
        try:
            instance = runtime(monkeypatch, email=email, agent=config(builtin_tools={"user_info": {"enabled": True}}))
            await asyncio.sleep(0)
            resources = await instance.prepare_platform_resources()
            return instance, resources
        finally:
            current_user_token.reset(token)

    (first, primary), (second, secondary) = await asyncio.gather(
        prepare("primary@example.test", "primary-bearer-example"), prepare("secondary@example.test", "secondary-bearer-example"),
    )
    assert "primary@example.test" in primary.system_prompt and "secondary@example.test" not in primary.system_prompt
    assert "secondary@example.test" in secondary.system_prompt and "primary@example.test" not in secondary.system_prompt
    assert first._auth_bearer == "primary-bearer-example" and second._auth_bearer == "secondary-bearer-example"
    assert primary is not secondary and primary.tools[0] is not secondary.tools[0]
    await first.cleanup()
    await second.cleanup()


async def test_workflow_auth_keeps_obo_in_header_and_removes_it_from_serialized_trigger_context(monkeypatch: pytest.MonkeyPatch) -> None:
    token = current_user_token.set("delegated-bearer-example")
    try:
        instance = runtime(monkeypatch, agent=config(builtin_tools={"workflows": ["workflow-example"]}))
    finally:
        current_user_token.reset(token)
    instance._user = UserContext(email="owner@example.test", sub="owner-example", access_token="hidden-access-example", obo_jwt="hidden-obo-example")
    collection = SimpleNamespace(find=lambda *args, **kwargs: [{"_id": "workflow-example", "name": "Example workflow", "description": "Test workflow", "steps": []}])
    database = {"workflow_configs": collection}
    instance._mongo_client = {instance.settings.mongodb_database: database}
    captured = {}

    def workflow_tools(client, allowed_config_ids, trigger_context, workflow_labels):
        captured.update(client=client, allowed=allowed_config_ids, trigger=trigger_context, labels=workflow_labels)
        return []

    monkeypatch.setattr(agent_runtime, "create_workflow_tools", workflow_tools)
    resources = await instance.prepare_platform_resources()
    assert "Example workflow" in resources.system_prompt
    assert captured["allowed"] == ["workflow-example"] and captured["labels"] == {"workflow-example": "Example workflow"}
    assert captured["client"]._headers()["Authorization"] == "Bearer delegated-bearer-example"
    assert captured["trigger"]["user_context"]["email"] == "owner@example.test"
    assert "access_token" not in captured["trigger"]["user_context"] and "obo_jwt" not in captured["trigger"]["user_context"]
    await instance.cleanup()
