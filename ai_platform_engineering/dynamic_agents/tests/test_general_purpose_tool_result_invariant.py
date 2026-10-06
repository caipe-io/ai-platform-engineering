"""Regression coverage for the built-in general-purpose subagent."""

from typing import Any

import pytest
from deepagents import create_deep_agent
from deepagents.middleware.subagents import SubAgentMiddleware
from langchain_core.callbacks.manager import CallbackManagerForLLMRun
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatResult
from pydantic import Field

from dynamic_agents.services.agent_runtime import _with_general_purpose_tool_result_recovery
from dynamic_agents.services.middleware import ToolResultInvariantMiddleware
from dynamic_agents.services.tool_call_recovery import ToolCallRecoveryMiddleware


class _CapturingFakeModel(FakeMessagesListChatModel):
    """Record the messages that reach the subagent model."""

    captured_messages: list[list[BaseMessage]] = Field(default_factory=list)

    def bind_tools(
        self,
        tools: Any,
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> "_CapturingFakeModel":
        del tools, tool_choice, kwargs
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        self.captured_messages.append(list(messages))
        return super()._generate(messages, stop, run_manager, **kwargs)


def test_general_purpose_recovery_override_is_applied_last() -> None:
    configured_subagent = {"name": "configured-agent"}
    conflicting_subagent = {"name": "general-purpose", "middleware": []}

    result = _with_general_purpose_tool_result_recovery(
        [configured_subagent, conflicting_subagent],
        model=object(),
        tools=[],
        interrupt_on={},
    )

    assert result[0] is configured_subagent
    assert [subagent["name"] for subagent in result] == ["configured-agent", "general-purpose"]
    assert result[-1]["name"] == "general-purpose"
    assert isinstance(result[-1]["middleware"][0], ToolCallRecoveryMiddleware)
    assert isinstance(result[-1]["middleware"][1], ToolResultInvariantMiddleware)


@pytest.mark.asyncio
async def test_general_purpose_subagent_repairs_content_block_orphan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    processed_subagents: list[dict[str, Any]] = []

    class _CapturingSubAgentMiddleware(SubAgentMiddleware):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            processed_subagents.extend(self._get_subagents())

    monkeypatch.setattr(
        "deepagents.graph.SubAgentMiddleware",
        _CapturingSubAgentMiddleware,
    )
    model = _CapturingFakeModel(responses=[
        AIMessage(content="partial", response_metadata={"stop_reason": "max_tokens"}),
        AIMessage(content="Recovered response"),
    ])
    subagent_specs = _with_general_purpose_tool_result_recovery(
        [],
        model=model,
        tools=[],
        interrupt_on={},
    )
    create_deep_agent(
        model=model,
        tools=[],
        subagents=subagent_specs,
    )

    assert [subagent["name"] for subagent in processed_subagents] == ["general-purpose"]

    result = await processed_subagents[0]["runnable"].ainvoke(
        {
            "messages": [
                AIMessage(
                    content=[
                        {
                            "type": "tool_use",
                            "id": "orphaned-call",
                            "name": "read_file",
                            "input": {"file_path": "history.md"},
                        }
                    ]
                ),
                HumanMessage(content="Continue the interrupted conversation."),
            ]
        }
    )

    assert result["messages"][-1].content == "Recovered response"
    assert len(model.captured_messages) == 2
    assert "No tools from this response" in model.captured_messages[1][-2].content
    captured = model.captured_messages[0]
    tool_result = next(message for message in captured if isinstance(message, ToolMessage))
    orphaned_call = next(message for message in captured if isinstance(message, AIMessage))
    assert tool_result.tool_call_id == "orphaned-call"
    assert captured.index(tool_result) == captured.index(orphaned_call) + 1
    assert tool_result.status == "error"
