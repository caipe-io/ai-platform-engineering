"""Exercise recovery through real agent graphs before side effects can run."""

import asyncio
from typing import Annotated, Any

import pytest
from langchain.agents import create_agent
from langchain.agents.middleware import ModelRetryMiddleware
from langchain.agents.middleware.types import ExtendedModelResponse, ModelResponse
from langchain_aws.chat_models.bedrock_converse import _messages_to_bedrock
from langchain_core.callbacks.manager import CallbackManagerForLLMRun
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langchain_core.outputs import ChatResult
from langchain_core.tools import StructuredTool, tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.prebuilt import InjectedState
from langgraph.types import Command
from pydantic import Field

from dynamic_agents.models import FeaturesConfig, MiddlewareEntry
from dynamic_agents.services.middleware import InterruptAwareToolRetryMiddleware, build_middleware
from dynamic_agents.services.tool_call_recovery import (
    ToolCallRecoveryError,
    ToolCallRecoveryMiddleware,
    _failure_reason,
)


class _Model(FakeMessagesListChatModel):
    seen: list[list[BaseMessage]] = Field(default_factory=list)

    def bind_tools(self, tools: Any, **kwargs: Any) -> "_Model":
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        self.seen.append(list(messages))
        return super()._generate(messages, stop, run_manager, **kwargs)


def _call(args: dict[str, Any], **kwargs: Any) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": "write_file", "args": args, "id": "call"}], **kwargs)


def _writer(writes: list[str]) -> StructuredTool:
    @tool
    def write_file(file_path: str, content: str) -> str:
        """Write a file."""
        writes.append(content)
        return "written"

    return write_file


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failed",
    [
        _call({"file_path": "example.md", "content": "truncated"}, response_metadata={"finish_reason": "length"}),
        _call({"file_path": "example.md", "content": "truncated"}, response_metadata={"stop_reason": "max_tokens"}),
        _call({"file_path": "example.md", "content": "truncated"}, response_metadata={"stopReason": "max_tokens"}),
        _call({"file_path": "example.md", "content": "truncated"}, additional_kwargs={"finish_reason": "length"}),
        _call({"file_path": "example.md"}),
        _call({"file_path": "example.md", "content": {"invalid": "type"}}),
        AIMessage(
            content="",
            invalid_tool_calls=[{"name": "write_file", "args": '{"content":', "id": "call", "error": "invalid JSON"}],
        ),
    ],
)
async def test_failed_batch_is_repaired_before_tools_run(failed: AIMessage) -> None:
    writes: list[str] = []
    model = _Model(
        responses=[failed, _call({"file_path": "example.md", "content": "complete"}), AIMessage(content="done")]
    )
    graph = create_agent(model, tools=[_writer(writes)], middleware=[ToolCallRecoveryMiddleware()])
    result = await graph.ainvoke({"messages": [HumanMessage(content="Write the file")]})
    assert writes == ["complete"]
    assert result["messages"][-1].content == "done"
    notice, feedback = model.seen[1][-2:]
    assert isinstance(notice, AIMessage) and not notice.tool_calls and not notice.invalid_tool_calls
    assert isinstance(feedback, HumanMessage) and feedback.content == notice.content


@pytest.mark.asyncio
async def test_entire_parallel_batch_and_raw_blocks_are_rejected() -> None:
    writes: list[str] = []
    failed = AIMessage(
        content=[{"type": "tool_use", "id": "raw", "name": "write_file", "input": {}}],
        tool_calls=[
            {"name": "write_file", "args": {"file_path": "a", "content": "unsafe"}, "id": "a"},
            {"name": "write_file", "args": {"file_path": "b"}, "id": "b"},
        ],
    )
    model = _Model(responses=[failed, AIMessage(content="Please use a smaller edit")])
    graph = create_agent(model, tools=[_writer(writes)], middleware=[ToolCallRecoveryMiddleware()])
    result = await graph.ainvoke({"messages": [HumanMessage(content="Write files")]})
    assert writes == []
    notice = result["messages"][1]
    assert isinstance(notice.content, str) and not notice.tool_calls


@pytest.mark.asyncio
async def test_exhaustion_is_bounded_and_next_turn_can_continue() -> None:
    writes: list[str] = []
    bad = _call({"file_path": "example.md", "content": "truncated"}, response_metadata={"finish_reason": "length"})
    model = _Model(responses=[bad, bad, AIMessage(content="next turn")])
    graph = create_agent(
        model,
        tools=[_writer(writes)],
        checkpointer=InMemorySaver(),
        middleware=[ToolCallRecoveryMiddleware(), ModelRetryMiddleware(max_retries=5)],
    )
    config = {"configurable": {"thread_id": "example"}}
    with pytest.raises(ToolCallRecoveryError, match="one unsuccessful repair"):
        await graph.ainvoke({"messages": [HumanMessage(content="Write file")]}, config)
    assert len(model.seen) == 2 and writes == []
    saved = (await graph.aget_state(config)).values["messages"]
    assert sum(isinstance(message, HumanMessage) for message in saved) == 1
    bedrock_messages, _ = _messages_to_bedrock(saved)
    assert "toolUse" not in str(bedrock_messages)
    assert all(
        not message.tool_calls and not message.invalid_tool_calls for message in saved if isinstance(message, AIMessage)
    )
    result = await graph.ainvoke({"messages": [HumanMessage(content="Continue with a smaller task")]}, config)
    assert result["messages"][-1].content == "next turn"


@pytest.mark.asyncio
async def test_success_resets_consecutive_failure_budget() -> None:
    writes: list[str] = []
    bad = _call({"file_path": "example.md"})
    good = _call({"file_path": "example.md", "content": "complete"})
    good_again = _call({"file_path": "example.md", "content": "complete"})
    good_again.tool_calls[0]["id"] = "second-call"
    model = _Model(responses=[bad, good, _call({"file_path": "example.md"}), good_again, AIMessage(content="done")])
    graph = create_agent(model, tools=[_writer(writes)], middleware=[ToolCallRecoveryMiddleware()])
    await graph.ainvoke({"messages": [HumanMessage(content="Write files")]})
    assert writes == ["complete", "complete"]


def test_sync_graph_has_same_recovery() -> None:
    writes: list[str] = []
    model = _Model(
        responses=[
            _call({"file_path": "example.md"}),
            _call({"file_path": "example.md", "content": "complete"}),
            AIMessage(content="done"),
        ]
    )
    graph = create_agent(model, tools=[_writer(writes)], middleware=[ToolCallRecoveryMiddleware()])
    graph.invoke({"messages": [HumanMessage(content="Write file")]})
    assert writes == ["complete"]
    assert isinstance(model.seen[1][-1], HumanMessage)


def test_schema_validation_omits_injected_fields_and_secret_values() -> None:
    @tool
    def read(value: str, state: Annotated[dict, InjectedState], optional: int = 0) -> str:
        """Read a value."""
        return value

    valid = AIMessage(content="", tool_calls=[{"name": "read", "args": {"value": "ok"}, "id": "r"}])
    assert _failure_reason(valid, [read]) is None
    bad = AIMessage(content="", tool_calls=[{"name": "read", "args": {"value": {"secret": "do-not-leak"}}, "id": "r"}])
    reason = _failure_reason(bad, [read])
    assert "value" in reason and "do-not-leak" not in reason
    remote = StructuredTool(
        name="remote",
        description="Remote tool",
        func=lambda **kwargs: "ok",
        args_schema={"type": "object", "required": ["content"], "properties": {"content": {"type": "string"}}},
    )
    missing = AIMessage(content="", tool_calls=[{"name": "remote", "args": {}, "id": "r"}])
    assert "content" in _failure_reason(missing, [remote])


def test_guard_cannot_be_disabled_by_config_and_valid_response_is_unchanged() -> None:
    features = FeaturesConfig(middleware=[MiddlewareEntry(type="model_retry", enabled=False)])
    assert isinstance(build_middleware(features)[0], ToolCallRecoveryMiddleware)
    good = _call({"file_path": "example.md", "content": "ok"}, response_metadata={"finish_reason": "tool_calls"})
    assert ToolCallRecoveryMiddleware()._guard(good, [_writer([])]) is good


@pytest.mark.asyncio
async def test_child_exhaustion_is_not_retried_as_a_tool_failure() -> None:
    attempts: list[int] = []

    @tool
    def task() -> str:
        """Run a child agent."""
        attempts.append(1)
        raise ToolCallRecoveryError("Child failed to repair output")

    model = _Model(responses=[AIMessage(content="", tool_calls=[{"name": "task", "args": {}, "id": "t"}])])
    graph = create_agent(
        model,
        tools=[task],
        middleware=[ToolCallRecoveryMiddleware(), InterruptAwareToolRetryMiddleware(max_retries=3, initial_delay=0)],
    )
    with pytest.raises(ToolCallRecoveryError):
        await graph.ainvoke({"messages": [HumanMessage(content="Run task")]})
    assert len(attempts) == 1


@pytest.mark.asyncio
async def test_shared_middleware_keeps_concurrent_runs_independent() -> None:
    guard = ToolCallRecoveryMiddleware()

    async def recover(index: int) -> str:
        model = _Model(responses=[_call({"file_path": "example.md"}), AIMessage(content=str(index))])
        graph = create_agent(model, tools=[_writer([])], middleware=[guard])
        result = await graph.ainvoke({"messages": [HumanMessage(content="Write file")]})
        return result["messages"][-1].content

    assert await asyncio.gather(*(recover(index) for index in range(3))) == ["0", "1", "2"]


def test_extended_response_preserves_command_and_usage() -> None:
    bad = AIMessage(
        content="partial",
        response_metadata={"finish_reason": "length"},
        usage_metadata={"input_tokens": 10, "output_tokens": 20, "total_tokens": 30},
    )
    command = Command(update={"example": True})
    response = ExtendedModelResponse(ModelResponse(result=[bad], structured_response={"partial": True}), command)
    guarded = ToolCallRecoveryMiddleware()._guard(response, [])
    assert guarded.command is command
    assert guarded.model_response.structured_response is None
    assert guarded.model_response.result[0].usage_metadata == bad.usage_metadata
