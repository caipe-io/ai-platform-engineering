"""Regression coverage for child-graph checkpoint batches."""

from unittest.mock import Mock

import pytest
from langgraph.checkpoint.mongodb.saver import MongoDBSaver
from pymongo import MongoClient
from pymongo.errors import InvalidOperation

from dynamic_agents.services.checkpoint import MongoDBCheckpointSaver

CONFIG = {"configurable": {"thread_id": "thread", "checkpoint_ns": "child", "checkpoint_id": "checkpoint"}}


def _offline_saver(cls: type[MongoDBSaver]) -> MongoDBSaver:
    saver = object.__new__(cls)
    saver.writes_collection = MongoClient(connect=False)["test"]["writes"]
    saver.ttl = None
    return saver


def test_pinned_saver_rejects_an_empty_child_batch() -> None:
    with pytest.raises(InvalidOperation, match="No operations to execute"):
        _offline_saver(MongoDBSaver).put_writes(CONFIG, [], "task")


@pytest.mark.parametrize("asynchronous", [False, True])
async def test_empty_child_batch_completes_without_database_access(asynchronous: bool) -> None:
    saver = _offline_saver(MongoDBCheckpointSaver)
    if asynchronous:
        await saver.aput_writes(CONFIG, [], "task")
    else:
        saver.put_writes(CONFIG, [], "task")


@pytest.mark.parametrize("asynchronous", [False, True])
async def test_nonempty_child_batch_is_persisted(asynchronous: bool) -> None:
    saver = _offline_saver(MongoDBCheckpointSaver)
    saver.writes_collection = Mock()
    if asynchronous:
        await saver.aput_writes(CONFIG, [("messages", "result")], "task", "parent/child")
    else:
        saver.put_writes(CONFIG, [("messages", "result")], "task", "parent/child")
    operations = saver.writes_collection.bulk_write.call_args.args[0]
    assert len(operations) == 1
    assert operations[0]._filter["task_path"] == "parent/child"
    assert operations[0]._filter["task_id"] == "task"
