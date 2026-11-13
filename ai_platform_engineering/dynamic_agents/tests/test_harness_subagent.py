"""Preserve execution boundaries and nested child tool presentation."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import mongomock
import pytest

from dynamic_agents.models import DynamicAgentConfig, SubAgentRef
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.stream_encoders.agui_sse import AGUIStreamEncoder
from dynamic_agents.services.stream_encoders.custom_sse import CustomStreamEncoder
from dynamic_agents.services.subagent_dispatch import subagent_factory


async def test_harness_reference_requires_owner_dispatch_and_never_rebuilds_a_model() -> None:
    config = DynamicAgentConfig(_id="agent-child", name="Child", owner_id="owner@example.test", system_prompt="Child policy",
        model={"id": "child-model", "provider": "example"}, execution_harness_id="claude_code_cli_acp")
    runtime = object.__new__(AgentRuntime)
    runtime.config = SimpleNamespace(id="agent-parent", name="Parent")
    runtime._mongo_service = SimpleNamespace(get_agent=lambda _: pytest.fail("Harness documents have no LangChain model"),
        get_agent_execution=lambda _: {"enabled": True, "execution_harness_id": "claude_code_cli_acp"})
    runtime._build_subagent_tools = AsyncMock(side_effect=AssertionError("Must not reconstruct child tools"))
    ref = SubAgentRef(agent_id=config.id, name="child", description="Specialist")
    with pytest.raises(ValueError, match="Harness Engine"):
        await runtime._resolve_subagents([ref])
    factory = AsyncMock(return_value={"name": config.id, "description": "Specialist", "runnable": "compiled-child"})
    scope = subagent_factory.set(factory)
    try:
        resolved = await runtime._resolve_subagents([ref])
    finally:
        subagent_factory.reset(scope)
    assert resolved[0]["runnable"] == "compiled-child"
    factory.assert_awaited_once_with(ref)
    runtime._build_subagent_tools.assert_not_awaited()


@pytest.mark.parametrize("encoder,started,completed", [(CustomStreamEncoder, "tool_start", "tool_end"), (AGUIStreamEncoder, "TOOL_CALL_START", "TOOL_CALL_RESULT")])
def test_harness_child_tools_reuse_correlated_stream_contract(encoder: type, started: str, completed: str) -> None:
    stream = encoder(frame_builder=lambda name, data: (name, data))
    namespace = ("agent-child:task-id",)
    event = {"type": "harness_subagent", "event_type": "tool.started", "data": {
        "tool_call_id": "run-child:lookup", "tool_name": "lookup", "args": {"value": "example"},
    }}
    frames = stream.on_chunk((namespace, "custom", event))
    assert any(name == started for name, _ in frames)
    assert "run-child:lookup" in repr(frames)
    event.update(event_type="tool.completed", data={"tool_call_id": "run-child:lookup", "result": "found"})
    frames = stream.on_chunk((namespace, "custom", event))
    assert any(name == completed for name, _ in frames)
    assert "found" in repr(frames)
    assert stream._helper.get_accumulated_content() == ""


def test_provider_child_without_model_never_contributes_parent_mcp_configs() -> None:
    mongo = object.__new__(MongoDBService)
    mongo.settings = SimpleNamespace(dynamic_agents_collection="dynamic_agents")
    mongo._db = mongomock.MongoClient().example
    mongo._db.dynamic_agents.insert_one({"_id": "agent-child", "enabled": True, "execution_harness_id": "claude_code_cli_acp"})
    parent = DynamicAgentConfig(_id="agent-parent", name="Parent", owner_id="owner@example.test", system_prompt="Delegate",
        model={"id": "parent-model", "provider": "example"}, subagents=[{"agent_id": "agent-child", "name": "child", "description": "Coding"}])
    assert mongo.get_agent_execution("agent-child")["execution_harness_id"] == "claude_code_cli_acp"
    assert mongo.get_agent_mcp_servers(parent) == []
