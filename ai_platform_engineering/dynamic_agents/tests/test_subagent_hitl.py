"""Regression tests for human-in-the-loop configuration on subagents."""

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from deepagents import create_deep_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from dynamic_agents.models import (
    BuiltinToolsConfig,
    DynamicAgentConfig,
    ModelConfig,
    RequestUserInputToolConfig,
    SubAgentRef,
)
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.builtin_tools import create_request_user_input_tool
from dynamic_agents.services.middleware import InterruptAwareToolRetryMiddleware


class _ToolCallingFakeModel(FakeMessagesListChatModel):
    """Deterministic model that accepts the tool binding used by create_agent."""

    def bind_tools(
        self,
        tools: Any,
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> "_ToolCallingFakeModel":
        del tools, tool_choice, kwargs
        return self


def _agent_config(
    agent_id: str,
    name: str,
    *,
    interrupt_enabled: bool,
    subagents: list[SubAgentRef] | None = None,
) -> DynamicAgentConfig:
    return DynamicAgentConfig(
        _id=agent_id,
        name=name,
        system_prompt=f"You are {name}.",
        owner_id="owner@example.com",
        model=ModelConfig(id="test-model", provider="openai"),
        builtin_tools=BuiltinToolsConfig(
            request_user_input=RequestUserInputToolConfig(enabled=True),
        ),
        interrupt_on={"builtin": {"request_user_input": interrupt_enabled}},
        subagents=subagents or [],
    )


def test_resolved_subagent_includes_its_request_user_input_interrupt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Custom subagents must install HITL from their own config."""
    subagent_ref = SubAgentRef(
        agent_id="child-agent",
        name="child",
        description="Collect deployment details from the user.",
    )
    parent_config = _agent_config(
        "parent-agent",
        "Parent",
        interrupt_enabled=False,
        subagents=[subagent_ref],
    )
    child_config = _agent_config(
        "child-agent",
        "Child",
        interrupt_enabled=True,
    )

    runtime = object.__new__(AgentRuntime)
    runtime.config = parent_config
    runtime._session_id = "conversation-1"
    runtime._subagent_models = {}
    runtime._mongo_service = MagicMock()
    runtime._mongo_service.get_agent.return_value = child_config

    request_input_tool = MagicMock()
    request_input_tool.name = "request_user_input"
    runtime._build_subagent_tools = AsyncMock(
        return_value=([request_input_tool], {"request_user_input"}),
    )

    monkeypatch.setattr(
        "dynamic_agents.services.agent_runtime.get_llm",
        lambda *_args, **_kwargs: MagicMock(),
    )
    monkeypatch.setattr(
        "dynamic_agents.services.agent_runtime.build_middleware",
        lambda *_args, **_kwargs: [],
    )

    resolved = asyncio.run(runtime._resolve_subagents([subagent_ref]))

    assert len(resolved) == 1
    assert resolved[0]["interrupt_on"] == {"request_user_input": True}


def test_build_interrupt_config_uses_supplied_agent_config() -> None:
    """The helper must not substitute the parent agent's HITL policy."""
    runtime = object.__new__(AgentRuntime)
    runtime.config = _agent_config(
        "parent-agent",
        "Parent",
        interrupt_enabled=False,
    )
    child_config = _agent_config(
        "child-agent",
        "Child",
        interrupt_enabled=True,
    )
    request_input_tool = MagicMock()
    request_input_tool.name = "request_user_input"

    result = runtime._build_interrupt_config(
        [request_input_tool],
        {"request_user_input"},
        agent_config=child_config,
    )

    assert result == {"request_user_input": True}


def test_parent_tool_retry_preserves_nested_subagent_interrupt_and_resume() -> None:
    """A subagent GraphInterrupt must checkpoint instead of retrying `task`."""
    parent_model = _ToolCallingFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "task",
                        "args": {
                            "description": "Ask the user for a project name.",
                            "subagent_type": "child",
                        },
                        "id": "task-1",
                    }
                ],
            ),
            AIMessage(content="Parent received the child result."),
        ]
    )
    child_model = _ToolCallingFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "request_user_input",
                        "args": {
                            "prompt": "Choose a project name",
                            "fields": [
                                {
                                    "field_name": "project_name",
                                    "field_label": "Project name",
                                    "field_type": "text",
                                    "required": True,
                                }
                            ],
                        },
                        "id": "input-1",
                    }
                ],
            ),
            AIMessage(content="Child received the project name."),
        ]
    )
    graph = create_deep_agent(
        model=parent_model,
        tools=[],
        checkpointer=MemorySaver(),
        middleware=[
            InterruptAwareToolRetryMiddleware(
                max_retries=3,
                initial_delay=0,
                backoff_factor=0,
                jitter=False,
                on_failure="continue",
            )
        ],
        subagents=[
            {
                "name": "child",
                "description": "Collects a project name.",
                "system_prompt": "Ask for a project name using request_user_input.",
                "model": child_model,
                "tools": [create_request_user_input_tool()],
                "interrupt_on": {"request_user_input": True},
            }
        ],
    )
    config = {"configurable": {"thread_id": "subagent-hitl-thread"}}

    graph.invoke({"messages": [HumanMessage(content="Start")]}, config=config)

    state = graph.get_state(config)
    assert len(state.interrupts) == 1
    assert child_model.i == 1
    action = state.interrupts[0].value["action_requests"][0]
    assert action["name"] == "request_user_input"

    result = graph.invoke(
        Command(
            resume={
                "decisions": [
                    {
                        "type": "edit",
                        "edited_action": {
                            "name": "request_user_input",
                            "args": {
                                "prompt": action["args"]["prompt"],
                                "fields": [
                                    {
                                        **action["args"]["fields"][0],
                                        "value": "alpha",
                                    }
                                ],
                            },
                        },
                    }
                ]
            }
        ),
        config=config,
    )

    assert not graph.get_state(config).interrupts
    assert result["messages"][-1].content == "Parent received the child result."
