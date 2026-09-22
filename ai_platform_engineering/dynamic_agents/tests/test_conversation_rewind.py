"""Conversation rewind behavior backed by LangGraph checkpoint history."""

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from dynamic_agents.services.agent_runtime import AgentRuntime


class FakeGraph:
    def __init__(self, snapshots: list[SimpleNamespace]) -> None:
        self.snapshots = snapshots
        for index, state in enumerate(snapshots):
            state.parent_config = (
                snapshots[index + 1].config
                if index + 1 < len(snapshots)
                else None
            )
        self.aupdate_state = AsyncMock(
            return_value={"configurable": {"checkpoint_id": "forked-checkpoint"}}
        )

    async def aget_state(
        self,
        config: dict[str, Any],
    ) -> SimpleNamespace:
        checkpoint_id = config.get("configurable", {}).get("checkpoint_id")
        if checkpoint_id is None:
            return self.snapshots[0]
        return next(
            state
            for state in self.snapshots
            if state.config["configurable"]["checkpoint_id"] == checkpoint_id
        )


def snapshot(checkpoint_id: str, messages: list[dict]) -> SimpleNamespace:
    return SimpleNamespace(
        config={
            "configurable": {
                "thread_id": "conversation-1",
                "checkpoint_id": checkpoint_id,
            }
        },
        values={"messages": messages},
    )


def runtime_with_graph(graph: FakeGraph) -> AgentRuntime:
    runtime = AgentRuntime.__new__(AgentRuntime)
    runtime._initialized = True
    runtime._is_streaming = False
    runtime._graph = graph
    return runtime


def build_graph() -> Any:
    def respond(_state: MessagesState) -> dict[str, list[AIMessage]]:
        return {"messages": [AIMessage(content="response")]}

    builder = StateGraph(MessagesState)
    builder.add_node("respond", respond)
    builder.add_edge(START, "respond")
    builder.add_edge("respond", END)
    return builder.compile(checkpointer=InMemorySaver())


@pytest.mark.asyncio
async def test_rewind_forks_checkpoint_before_correlated_turn() -> None:
    first_turn = {"role": "user", "content": "first", "id": "turn-1"}
    second_turn = {"role": "user", "content": "second", "id": "turn-2"}
    graph = FakeGraph(
        [
            snapshot("latest", [first_turn, second_turn]),
            snapshot("second-input", [first_turn, second_turn]),
            snapshot("before-second", [first_turn]),
            snapshot("initial", []),
        ]
    )
    runtime = runtime_with_graph(graph)

    checkpoint_id = await runtime.rewind_before_turn(
        "conversation-1",
        "turn-2",
        "second",
        1,
    )

    assert checkpoint_id == "forked-checkpoint"
    graph.aupdate_state.assert_awaited_once_with(
        graph.snapshots[2].config,
        None,
        as_node="__copy__",
    )


@pytest.mark.asyncio
async def test_rewind_matches_legacy_turn_by_content_occurrence() -> None:
    first_duplicate = {"role": "user", "content": "repeat", "id": "generated-1"}
    second_duplicate = {"role": "user", "content": "repeat", "id": "generated-2"}
    graph = FakeGraph(
        [
            snapshot("latest", [first_duplicate, second_duplicate]),
            snapshot("before-second", [first_duplicate]),
            snapshot("initial", []),
        ]
    )
    runtime = runtime_with_graph(graph)

    await runtime.rewind_before_turn(
        "conversation-1",
        "legacy-ui-turn",
        "repeat",
        2,
    )

    graph.aupdate_state.assert_awaited_once_with(
        graph.snapshots[1].config,
        None,
        as_node="__copy__",
    )


@pytest.mark.asyncio
async def test_rewind_first_turn_forks_initial_checkpoint() -> None:
    first_turn = {"role": "user", "content": "first", "id": "turn-1"}
    graph = FakeGraph(
        [
            snapshot("latest", [first_turn]),
            snapshot("initial", []),
        ]
    )
    runtime = runtime_with_graph(graph)

    await runtime.rewind_before_turn(
        "conversation-1",
        "turn-1",
        "first",
        1,
    )

    graph.aupdate_state.assert_awaited_once_with(
        graph.snapshots[1].config,
        None,
        as_node="__copy__",
    )


@pytest.mark.asyncio
async def test_rewind_uses_langgraph_checkpoint_fork() -> None:
    graph = build_graph()
    config = {"configurable": {"thread_id": "conversation-1"}}
    await graph.ainvoke(
        {"messages": [{"role": "user", "content": "first", "id": "turn-1"}]},
        config,
    )
    await graph.ainvoke(
        {"messages": [{"role": "user", "content": "second", "id": "turn-2"}]},
        config,
    )
    runtime = runtime_with_graph(graph)

    await runtime.rewind_before_turn(
        "conversation-1",
        "turn-2",
        "second",
        1,
    )

    state = await graph.aget_state(config)
    human_messages = [
        message for message in state.values["messages"] if message.type == "human"
    ]
    assert [message.id for message in human_messages] == ["turn-1"]


@pytest.mark.asyncio
async def test_rewind_rejects_active_stream() -> None:
    graph = FakeGraph([snapshot("latest", [])])
    runtime = runtime_with_graph(graph)
    runtime._is_streaming = True

    with pytest.raises(RuntimeError, match="while it is streaming"):
        await runtime.rewind_before_turn(
            "conversation-1",
            "turn-1",
            "first",
            1,
        )

    graph.aupdate_state.assert_not_awaited()
