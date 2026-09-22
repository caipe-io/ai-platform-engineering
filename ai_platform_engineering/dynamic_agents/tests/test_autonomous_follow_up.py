"""A manual branch must never advance or reset its automated source context."""

from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Annotated, Any, TypedDict
from unittest.mock import AsyncMock, MagicMock

import pytest
from deepagents import create_deep_agent
from deepagents.graph import DeepAgentState
from deepagents.middleware.filesystem import FilesystemState
from fastapi import HTTPException
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.serde.types import _DeltaSnapshot
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from pymongo.errors import DuplicateKeyError

from dynamic_agents.config import Settings
from dynamic_agents.models import DynamicAgentConfig, ModelConfig, UserContext
from dynamic_agents.routes import autonomous_follow_up as routes
from dynamic_agents.services import autonomous_follow_up as service


class ChatState(TypedDict):
    messages: Annotated[list, add_messages]


class DeltaChatState(FilesystemState, DeepAgentState):
    """Use the same message/file channels as the production Deep Agents graph."""


class MongoHistoryMemorySaver(MemorySaver):
    """Exercise the parent-chain replay implementation used by MongoDBSaver."""

    get_delta_channel_history = BaseCheckpointSaver.get_delta_channel_history


class ToolBindingFakeModel(FakeMessagesListChatModel):
    def bind_tools(self, tools: Any, **kwargs: Any) -> "ToolBindingFakeModel":
        return self


@pytest.mark.parametrize("saver_class", [MemorySaver, MongoHistoryMemorySaver])
@pytest.mark.parametrize("snapshot_frequency", [1, 50])
def test_branch_reconstructs_delta_messages_and_files_without_later_replies(
    saver_class: type[MemorySaver], snapshot_frequency: int,
) -> None:
    saver = saver_class()
    builder = StateGraph(DeltaChatState)
    for name in ("messages", "files"):
        builder.channels[name] = builder.channels[name].copy()
        builder.channels[name].snapshot_frequency = snapshot_frequency
    builder.add_node("answer", lambda state: {
        "messages": [AIMessage(id=f"answer:{state['messages'][-1].id}", content=f"Answer: {state['messages'][-1].content}")],
        "files": {"/result.txt": {"content": [state["messages"][-1].content]}},
    })
    builder.add_edge(START, "answer")
    builder.add_edge("answer", END)
    graph = builder.compile(checkpointer=saver)
    source = {"configurable": {"thread_id": "automated", "checkpoint_ns": ""}}
    branch = {"configurable": {"thread_id": "manual", "checkpoint_ns": ""}}
    graph.invoke({"messages": [HumanMessage(id="original", content="original run")]}, source)
    original = saver.get_tuple(source)
    if snapshot_frequency == 50:
        assert "messages" not in original.checkpoint["channel_values"]
        assert "files" not in original.checkpoint["channel_values"]
    else:
        assert isinstance(original.checkpoint["channel_values"]["messages"], _DeltaSnapshot)
        assert isinstance(original.checkpoint["channel_values"]["files"], _DeltaSnapshot)
    graph.invoke({"messages": [HumanMessage(id="later", content="later reply")]}, source)
    source_before = graph.get_state(source).values

    checkpoint_id = service.copy_run_checkpoint(saver, "automated", "manual", original.checkpoint["ts"])

    assert checkpoint_id == original.checkpoint["id"]
    copied = graph.get_state(branch).values
    assert [message.content for message in copied["messages"]] == ["original run", "Answer: original run"]
    assert copied["files"]["/result.txt"]["content"] == ["original run"]
    assert saver.get_tuple(branch).parent_config is None
    # The fork must remain readable even after the source history expires.
    saver.delete_thread("automated")
    graph.invoke({"messages": [HumanMessage(id="manual", content="manual reply")]}, branch)
    assert [message.content for message in graph.get_state(branch).values["messages"]] == [
        "original run", "Answer: original run", "manual reply", "Answer: manual reply",
    ]
    assert [message.content for message in source_before["messages"]][-2:] == [
        "later reply", "Answer: later reply",
    ]


def test_real_deep_agent_can_continue_a_copied_run_with_tool_history_and_files() -> None:
    saver = MongoHistoryMemorySaver()
    model = ToolBindingFakeModel(responses=[
        AIMessage(content="", tool_calls=[{
            "id": "write-result", "name": "write_file",
            "args": {"file_path": "/result.txt", "content": "Saved result"},
        }]),
        AIMessage(content="Original result"),
        AIMessage(content="Follow-up result"),
    ])
    graph = create_deep_agent(model=model, checkpointer=saver)
    source = {"configurable": {"thread_id": "automated", "checkpoint_ns": ""}}
    branch = {"configurable": {"thread_id": "manual", "checkpoint_ns": ""}}
    graph.invoke({"messages": [HumanMessage(content="Write the result to a file")]}, source)
    original = saver.get_tuple(source)
    source_before = graph.get_state(source).values
    assert "messages" not in original.checkpoint["channel_values"]

    service.copy_run_checkpoint(saver, "automated", "manual", original.checkpoint["ts"])
    assert graph.get_state(branch).values["files"]["/result.txt"]["content"] == "Saved result"
    graph.invoke({"messages": [HumanMessage(content="Explain that result")]}, branch)

    messages = graph.get_state(branch).values["messages"]
    assert [message.type for message in messages] == ["human", "ai", "tool", "ai", "human", "ai"]
    assert [message.content for message in messages][-3:] == [
        "Original result", "Explain that result", "Follow-up result",
    ]
    assert graph.get_state(source).values == source_before


def test_branch_copies_completed_run_and_excludes_later_replies() -> None:
    saver = MemorySaver()
    builder = StateGraph(ChatState)
    builder.add_node("answer", lambda state: {"messages": [AIMessage(content=f"Answer: {state['messages'][-1].content}")]})
    builder.add_edge(START, "answer")
    builder.add_edge("answer", END)
    graph = builder.compile(checkpointer=saver)
    source = {"configurable": {"thread_id": "automated", "checkpoint_ns": ""}}
    branch = {"configurable": {"thread_id": "manual", "checkpoint_ns": ""}}
    graph.invoke({"messages": [HumanMessage(content="original run")]}, source)
    original = saver.get_tuple(source)
    cutoff = original.checkpoint["ts"]
    graph.invoke({"messages": [HumanMessage(content="later legacy follow-up")]}, source)
    source_before = graph.get_state(source).values

    checkpoint_id = service.copy_run_checkpoint(saver, "automated", "manual", cutoff)
    # An older inline-message checkpoint is continued by today's delta runtime.
    branch_builder = StateGraph(DeepAgentState)
    branch_builder.add_node("answer", lambda state: {"messages": [AIMessage(content=f"Answer: {state['messages'][-1].content}")]})
    branch_builder.add_edge(START, "answer")
    branch_builder.add_edge("answer", END)
    branch_graph = branch_builder.compile(checkpointer=saver)
    assert checkpoint_id == original.checkpoint["id"]
    assert [m.content for m in branch_graph.get_state(branch).values["messages"]] == ["original run", "Answer: original run"]
    branch_graph.invoke({"messages": [HumanMessage(content="manual reply")]}, branch)
    assert graph.get_state(source).values == source_before
    assert [m.content for m in branch_graph.get_state(branch).values["messages"]][-2:] == ["manual reply", "Answer: manual reply"]
    assert saver.get_tuple(branch).config["configurable"]["thread_id"] != "automated"


def test_missing_checkpoint_fails_without_creating_empty_branch() -> None:
    saver = MemorySaver()
    with pytest.raises(HTTPException, match="no longer available"):
        service.copy_run_checkpoint(saver, "missing", "manual", datetime.now(timezone.utc))
    assert saver.get_tuple({"configurable": {"thread_id": "manual", "checkpoint_ns": ""}}) is None


def test_pending_tool_calls_are_not_replayed() -> None:
    saver = MagicMock()
    entry = MagicMock()
    entry.checkpoint = {
        "ts": "2026-09-01T10:00:00Z",
        "channel_values": {"messages": [AIMessage(content="", tool_calls=[{"id": "call", "name": "write", "args": {}}])]},
    }
    saver.list.return_value = [entry]
    with pytest.raises(HTTPException, match="tool execution"):
        service.copy_run_checkpoint(saver, "source", "manual", "2026-09-01T10:01:00Z")
    saver.put.assert_not_called()


def test_delta_backed_unfinished_tool_call_cannot_be_continued() -> None:
    saver = MongoHistoryMemorySaver()
    builder = StateGraph(DeepAgentState)
    builder.add_node("call_tool", lambda state: {"messages": [
        AIMessage(content="", tool_calls=[{"id": "call", "name": "write", "args": {}}]),
    ]})
    builder.add_edge(START, "call_tool")
    builder.add_edge("call_tool", END)
    graph = builder.compile(checkpointer=saver)
    source = {"configurable": {"thread_id": "source", "checkpoint_ns": ""}}
    graph.invoke({"messages": [HumanMessage(content="Write a result")]}, source)
    checkpoint = saver.get_tuple(source).checkpoint
    assert "messages" not in checkpoint["channel_values"]

    with pytest.raises(HTTPException, match="tool execution"):
        service.copy_run_checkpoint(saver, "source", "manual", checkpoint["ts"])

    assert saver.get_tuple({"configurable": {"thread_id": "manual", "checkpoint_ns": ""}}) is None


def test_millisecond_precision_of_run_finish_keeps_final_snapshot() -> None:
    saver = MagicMock()
    entry = SimpleNamespace(
        checkpoint={
            "id": "final", "ts": "2026-09-01T10:00:00.123456Z", "channel_versions": {},
            "channel_values": {"messages": [AIMessage(content="Complete")]},
        }, metadata={"step": 1},
    )
    saver.list.return_value = [entry]
    assert service.copy_run_checkpoint(saver, "source", "manual", "2026-09-01T10:00:00.123Z") == "final"
    saver.put.assert_called_once()


@pytest.fixture
def branch_setup(monkeypatch: pytest.MonkeyPatch) -> tuple:
    monkeypatch.setenv("DEBUG", "false")
    monkeypatch.setattr(routes, "get_settings", lambda: Settings.model_construct())
    task = {"_id": "task", "owner_id": "owner@example.com", "dynamic_agent_id": "agent", "trigger": {"type": "webhook"}}
    run = {
        "run_id": "run", "task_id": "task", "task_name": "Example task", "owner_id": "owner@example.com",
        "status": "success", "execution_context_id": "source-context",
        "started_at": datetime(2026, 9, 1, 10, tzinfo=timezone.utc),
        "finished_at": datetime(2026, 9, 1, 10, 1, tzinfo=timezone.utc),
        "request_prompt": "Original prompt", "response_full": "Original result",
    }
    db = {name: MagicMock() for name in ("autonomous_tasks", "autonomous_runs", "autonomous_follow_up_chats", "conversations", "messages")}
    db["autonomous_tasks"].find_one.return_value = task
    db["autonomous_runs"].find_one.return_value = run
    db["conversations"].find_one.return_value = None
    db["autonomous_follow_up_chats"].find_one.return_value = None
    record: dict = {}

    def claim(_query: dict, update: dict, **_kwargs: object) -> dict:
        record.update(update["$set"])
        return dict(record)

    db["autonomous_follow_up_chats"].find_one_and_update.side_effect = claim
    agent = DynamicAgentConfig(_id="agent", name="Example agent", system_prompt="Help", owner_id="owner@example.com", model=ModelConfig(id="test", provider="openai"))
    mongo = MagicMock(_db=db)
    mongo.get_agent.return_value = agent
    user = UserContext(email="owner@example.com")
    monkeypatch.setattr(service, "MongoDBSaver", MagicMock())
    store = MagicMock()
    store.search.return_value = []
    monkeypatch.setattr(service, "MongoDBGridFSStore", lambda **_kwargs: store)
    copy = MagicMock(return_value="source-checkpoint")
    monkeypatch.setattr(service, "copy_run_checkpoint", copy)
    monkeypatch.setattr(routes, "require_autonomous_permission", AsyncMock())
    monkeypatch.setattr(routes, "require_agent_use_permission", AsyncMock())
    return mongo, task, run, agent, user, copy, record


def test_create_and_reopen_do_not_reinitialize_context(branch_setup: tuple) -> None:
    mongo, task, run, agent, user, copy, record = branch_setup
    result = service.create_follow_up_chat(mongo, Settings(), task, run, agent, user)
    assert result["conversation_id"] != run["execution_context_id"]
    copy.assert_called_once()
    created = record["conversation"]
    assert created["source"] == "web"
    assert created["title"].startswith("[Manual Follow-up] Example task")
    assert "execution_context_id" not in created
    assert "task_id" not in created  # ordinary sidebar conversation
    assert created["manual_follow_up"]["source_checkpoint_id"] == "source-checkpoint"
    assert created["sharing"]["shared_with"] == []
    assert mongo._db["messages"].insert_one.call_count == 2
    assert all(call.args[0]["conversation_id"] == result["conversation_id"] for call in mongo._db["messages"].insert_one.call_args_list)
    mongo._db["autonomous_follow_up_chats"].find_one.return_value = record
    assert service.create_follow_up_chat(mongo, Settings(), task, run, agent, user) == result
    copy.assert_called_once()


def test_concurrent_creation_returns_retry_instead_of_resetting_branch(branch_setup: tuple) -> None:
    mongo, task, run, agent, user, copy, _record = branch_setup
    mongo._db["autonomous_follow_up_chats"].find_one_and_update.side_effect = DuplicateKeyError("busy")
    with pytest.raises(HTTPException) as error:
        service.create_follow_up_chat(mongo, Settings(), task, run, agent, user)
    assert error.value.status_code == 409
    copy.assert_not_called()
    mongo._db["messages"].insert_one.assert_not_called()


def test_copy_failure_does_not_publish_chat_and_allows_retry(branch_setup: tuple) -> None:
    mongo, task, run, agent, user, copy, _record = branch_setup
    copy.side_effect = HTTPException(409, "Missing snapshot")
    with pytest.raises(HTTPException):
        service.create_follow_up_chat(mongo, Settings(), task, run, agent, user)
    mongo._db["conversations"].update_one.assert_not_called()
    mongo._db["autonomous_follow_up_chats"].update_one.assert_called_once()


def test_files_are_copied_into_manual_namespace(branch_setup: tuple, monkeypatch: pytest.MonkeyPatch) -> None:
    mongo, task, run, agent, user, _copy, _record = branch_setup
    store = MagicMock()
    file = SimpleNamespace(key="/result.txt", value={"content": ["Result"]})
    store.search.side_effect = [[file], []]
    monkeypatch.setattr(service, "MongoDBGridFSStore", lambda **_kwargs: store)
    result = service.create_follow_up_chat(mongo, Settings(), task, run, agent, user)
    store.search.assert_any_call((agent.id, run["execution_context_id"], "filesystem"), limit=100, offset=0)
    store.put.assert_called_once_with((agent.id, result["conversation_id"], "filesystem"), file.key, file.value)
    assert store.put.call_args.args[2] is not file.value


@pytest.mark.asyncio
async def test_route_authorizes_owner_and_agent_before_copy(branch_setup: tuple, monkeypatch: pytest.MonkeyPatch) -> None:
    mongo, _task, _run, _agent, user, _copy, _record = branch_setup
    create = MagicMock(return_value={"conversation_id": "manual"})
    monkeypatch.setattr(routes, "create_follow_up_chat", create)
    assert await routes.open_follow_up_chat("task", "run", user, mongo) == {"conversation_id": "manual"}
    routes.require_autonomous_permission.assert_awaited_once()
    routes.require_agent_use_permission.assert_awaited_once_with("agent")
    create.assert_called_once()
    mongo._db["autonomous_runs"].find_one.assert_called_once_with({"_id": "run", "task_id": "task"})


@pytest.mark.asyncio
async def test_route_rejects_foreign_task(branch_setup: tuple) -> None:
    mongo, _task, _run, _agent, _user, copy, _record = branch_setup
    with pytest.raises(HTTPException) as error:
        await routes.open_follow_up_chat("task", "run", UserContext(email="other@example.com"), mongo)
    assert error.value.status_code == 403
    copy.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("change,status", [({"status": "running"}, 409), ({"execution_context_id": None}, 409), ({"owner_id": "other@example.com"}, 403)])
async def test_route_rejects_unavailable_or_foreign_run(branch_setup: tuple, change: dict, status: int) -> None:
    mongo, _task, run, _agent, user, copy, _record = branch_setup
    run.update(change)
    with pytest.raises(HTTPException) as error:
        await routes.open_follow_up_chat("task", "run", user, mongo)
    assert error.value.status_code == status
    copy.assert_not_called()


@pytest.mark.asyncio
async def test_links_are_scoped_to_current_caller(branch_setup: tuple) -> None:
    mongo, _task, _run, _agent, user, _copy, _record = branch_setup
    mongo._db["autonomous_follow_up_chats"].find.return_value = [{"run_id": "run", "conversation": {"_id": "manual"}}]
    mongo._db["conversations"].find.return_value = [{"_id": "manual"}]
    assert await routes.list_follow_up_chats("task", user, mongo) == {"run": "manual"}
    mongo._db["autonomous_follow_up_chats"].find.assert_called_once_with({"task_id": "task", "owner_id": user.email, "state": "ready"})


@pytest.mark.asyncio
async def test_unpublished_chat_is_not_linked_until_creation_retried(branch_setup: tuple) -> None:
    mongo, _task, _run, _agent, user, _copy, _record = branch_setup
    mongo._db["autonomous_follow_up_chats"].find.return_value = [{"run_id": "run", "conversation": {"_id": "manual"}}]
    mongo._db["conversations"].find.return_value = []
    assert await routes.list_follow_up_chats("task", user, mongo) == {}


def test_deleted_follow_up_is_not_reset_or_recreated(branch_setup: tuple) -> None:
    mongo, task, run, agent, user, copy, record = branch_setup
    service.create_follow_up_chat(mongo, Settings(), task, run, agent, user)
    mongo._db["autonomous_follow_up_chats"].find_one.return_value = record
    mongo._db["conversations"].find_one.return_value = {"deleted_at": datetime.now(timezone.utc)}
    mongo._db["conversations"].update_one.reset_mock()
    with pytest.raises(HTTPException, match="Restore it"):
        service.create_follow_up_chat(mongo, Settings(), task, run, agent, user)
    copy.assert_called_once()
    mongo._db["conversations"].update_one.assert_not_called()
