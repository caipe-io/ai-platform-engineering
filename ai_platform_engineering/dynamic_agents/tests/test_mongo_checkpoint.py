"""Regress empty local-subgraph acknowledgements without a database server."""

from unittest.mock import MagicMock

import pytest
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.mongodb.saver import MongoDBSaver as UpstreamMongoDBSaver
from pymongo import MongoClient
from pymongo.errors import InvalidOperation, OperationFailure

from dynamic_agents.services.mongo_checkpoint import MongoDBSaver

CONFIG = {"configurable": {"thread_id": "example-thread", "checkpoint_ns": "child", "checkpoint_id": "example-checkpoint"}}


def saver_with_collection(collection):
    saver = MongoDBSaver.__new__(MongoDBSaver)
    BaseCheckpointSaver.__init__(saver)
    saver.ttl = None
    saver.writes_collection = collection
    return saver


def test_pinned_upstream_reproduces_empty_bulk_failure_without_connecting():
    with MongoClient(connect=False, serverSelectionTimeoutMS=50) as client:
        saver = saver_with_collection(client["example"]["writes"])
        with pytest.raises(InvalidOperation, match="No operations to execute"):
            UpstreamMongoDBSaver.put_writes(saver, CONFIG, [], "task")


@pytest.mark.parametrize("writes", [[], ()])
@pytest.mark.parametrize("asynchronous", [False, True])
async def test_empty_checkpoint_acknowledgements_do_not_dispatch_io(writes, asynchronous):
    collection = MagicMock()
    saver = saver_with_collection(collection)
    if asynchronous:
        await saver.aput_writes(CONFIG, writes, "task", "parent/child")
    else:
        saver.put_writes(CONFIG, writes, "task", "parent/child")
    collection.bulk_write.assert_not_called()


@pytest.mark.parametrize("asynchronous", [False, True])
async def test_nonempty_writes_retain_upstream_serialization_and_scope(asynchronous):
    collection = MagicMock()
    saver = saver_with_collection(collection)
    writes = [("messages", {"content": "source-backed result"})]
    if asynchronous:
        await saver.aput_writes(CONFIG, writes, "task", "parent/child")
    else:
        saver.put_writes(CONFIG, writes, "task", "parent/child")
    operations = collection.bulk_write.call_args.args[0]
    assert len(operations) == 1
    assert operations[0]._filter == {
        "thread_id": "example-thread", "checkpoint_ns": "child", "checkpoint_id": "example-checkpoint",
        "task_id": "task", "task_path": "parent/child", "idx": 0,
    }
    document = operations[0]._doc["$setOnInsert"]
    assert document["channel"] == "messages"
    assert saver.serde.loads_typed((document["type"], document["value"])) == writes[0][1]


async def test_real_write_failures_are_not_suppressed():
    collection = MagicMock()
    failure = OperationFailure("write rejected", code=13)
    collection.bulk_write.side_effect = failure
    saver = saver_with_collection(collection)
    with pytest.raises(OperationFailure) as raised:
        await saver.aput_writes(CONFIG, [("messages", "result")], "task")
    assert raised.value is failure
