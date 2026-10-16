"""Bound recovery of truncated model output and incomplete tool calls."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Annotated, Any, NotRequired

from langchain.agents.middleware import AgentMiddleware, AgentState, ModelRequest
from langchain.agents.middleware.types import (
    ExtendedModelResponse,
    ModelCallResult,
    ModelResponse,
    PrivateStateAttr,
    hook_config,
)
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import BaseTool
from langgraph.channels.untracked_value import UntrackedValue
from langgraph.runtime import Runtime
from pydantic import ValidationError
from pydantic.v1 import ValidationError as ValidationErrorV1

_FAILURE_KEY = "tool_call_failure"


class ToolCallRecoveryState(AgentState):
    # Run-local state keeps cached/shared agents and subsequent turns independent.
    tool_call_failure_count: NotRequired[Annotated[int, UntrackedValue, PrivateStateAttr]]


class ToolCallRecoveryError(RuntimeError):
    """The model failed to repair its output within the bounded budget."""


def _failure_reason(message: AIMessage, tools: list[Any]) -> str | None:
    for metadata in (message.response_metadata, message.additional_kwargs):
        for key in ("finish_reason", "stop_reason", "stopReason"):
            reason = metadata.get(key)
            if isinstance(reason, str) and reason in {"length", "max_tokens"}:
                return "The model reached its output token limit."
    if message.invalid_tool_calls:
        return "The model returned invalid tool-call JSON."

    known_tools = {tool.name: tool for tool in tools if isinstance(tool, BaseTool)}
    for call in message.tool_calls:
        tool = known_tools.get(call["name"])
        if tool is None:
            continue  # ToolNode owns unknown-tool errors.
        schema = tool.tool_call_schema  # Excludes injected runtime/state arguments.
        if isinstance(schema, dict):
            missing = sorted(set(schema.get("required", [])) - call["args"].keys())
            if missing:
                return f"Tool {tool.name} is missing required arguments: {', '.join(missing)}."
        else:
            try:
                if hasattr(schema, "model_validate"):
                    schema.model_validate(call["args"])
                else:
                    schema.parse_obj(call["args"])
            except (ValidationError, ValidationErrorV1) as exc:
                fields = sorted({str(error["loc"][0]) for error in exc.errors() if error["loc"]})
                # Never include argument values or raw validation exceptions in feedback.
                return f"Tool {tool.name} has invalid arguments: {', '.join(fields) or 'input'}."
    return None


class ToolCallRecoveryMiddleware(AgentMiddleware[ToolCallRecoveryState]):
    """Reject a defective parallel batch before tools run; allow one model repair."""

    state_schema = ToolCallRecoveryState

    @staticmethod
    def _repair_request(request: ModelRequest) -> ModelRequest:
        last = request.messages[-1] if request.messages else None
        if isinstance(last, AIMessage) and last.additional_kwargs.get(_FAILURE_KEY):
            # Thinking-enabled Anthropic APIs reject assistant prefills. End the
            # repair request with user feedback without persisting a fake user turn.
            return request.override(messages=[*request.messages, HumanMessage(content=last.content)])
        return request

    def _guard(self, response: ModelCallResult, tools: list[Any]) -> ModelCallResult:
        if isinstance(response, ExtendedModelResponse):
            return replace(response, model_response=self._guard(response.model_response, tools))
        messages = [response] if isinstance(response, AIMessage) else response.result
        for message in messages:
            if not isinstance(message, AIMessage):
                continue
            reason = _failure_reason(message, tools)
            if reason is None:
                continue
            # Replace the entire response, including raw provider tool-use blocks,
            # so no call from a rejected parallel batch executes or poisons history.
            notice = AIMessage(
                id=message.id,
                content=(
                    f"{reason} No tools from this response were executed. "
                    "Repair the request with all required arguments. Use smaller "
                    "file edits instead of rewriting a large file in one call."
                ),
                additional_kwargs={_FAILURE_KEY: reason},
                response_metadata=message.response_metadata,
                usage_metadata=message.usage_metadata,
            )
            return notice if isinstance(response, AIMessage) else ModelResponse(result=[notice])
        return response

    def wrap_model_call(
        self, request: ModelRequest, handler: Callable[[ModelRequest], ModelCallResult]
    ) -> ModelCallResult:
        return self._guard(handler(self._repair_request(request)), request.tools)

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelCallResult]],
    ) -> ModelCallResult:
        return self._guard(await handler(self._repair_request(request)), request.tools)

    def before_model(self, state: ToolCallRecoveryState, runtime: Runtime) -> None:
        if state.get("tool_call_failure_count", 0) >= 2:
            reason = state["messages"][-1].additional_kwargs[_FAILURE_KEY]
            raise ToolCallRecoveryError(
                f"{reason} Stopped after one unsuccessful repair attempt. "
                "Rejected tool calls were not executed. Try smaller file edits "
                "or increase the model's output token budget."
            )

    async def abefore_model(self, state: ToolCallRecoveryState, runtime: Runtime) -> None:
        self.before_model(state, runtime)

    @hook_config(can_jump_to=["model"])
    def after_model(self, state: ToolCallRecoveryState, runtime: Runtime) -> dict[str, Any]:
        if state["messages"][-1].additional_kwargs.get(_FAILURE_KEY):
            return {"tool_call_failure_count": state.get("tool_call_failure_count", 0) + 1, "jump_to": "model"}
        return {"tool_call_failure_count": 0}

    @hook_config(can_jump_to=["model"])
    async def aafter_model(self, state: ToolCallRecoveryState, runtime: Runtime) -> dict[str, Any]:
        return self.after_model(state, runtime)
