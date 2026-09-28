"""Real MongoDB copy/cleanup races (set FOLLOW_UP_TEST_MONGODB_URI to run).

Each test owns a randomly named database; no application database is used.
"""

import asyncio
import os
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Event
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from deepagents.graph import DeepAgentState
from fastapi import HTTPException
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.mongodb.saver import MongoDBSaver
from langgraph.graph import END, START, StateGraph
from pymongo import MongoClient
from pymongo.collection import Collection
from pymongo.errors import AutoReconnect

from dynamic_agents.config import Settings
from dynamic_agents.models import DynamicAgentConfig, ModelConfig, UserContext
from dynamic_agents.services import autonomous_follow_up as service
from dynamic_agents.services import autonomous_follow_up_cleanup as cleanup
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore


@pytest.fixture
def copied_run() -> Iterator[SimpleNamespace]:
    uri = os.environ.get("FOLLOW_UP_TEST_MONGODB_URI")
    if not uri:
        pytest.skip("Set FOLLOW_UP_TEST_MONGODB_URI for isolated real-MongoDB tests")
    client = MongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=5000)
    db = client[f"follow_up_security_test_{uuid4().hex}"]
    settings = Settings.model_construct(mongodb_database=db.name)
    saver = MongoDBSaver(client, db_name=db.name, checkpoint_collection_name=settings.checkpoint_collection,
                         writes_collection_name=settings.checkpoint_writes_collection)
    graph_builder = StateGraph(DeepAgentState)
    graph_builder.add_node("answer", lambda state: {"messages": [AIMessage(content="Private result")]})
    graph_builder.add_edge(START, "answer")
    graph_builder.add_edge("answer", END)
    graph = graph_builder.compile(checkpointer=saver)
    graph.invoke({"messages": [HumanMessage(content="Private prompt")]}, {"configurable": {"thread_id": "source"}})
    checkpoint = saver.get_tuple({"configurable": {"thread_id": "source"}})
    store = MongoDBGridFSStore(db=db, bucket_name=settings.gridfs_bucket_name)
    store.put(("agent", "source", "filesystem"), "/private.txt", {"content": "private" * 80000})
    agent = DynamicAgentConfig(_id="agent", name="Example", system_prompt="Help", owner_id="owner@example.com",
                               model=ModelConfig(id="test", provider="openai"))
    task = {"_id": "task", "owner_id": "owner@example.com", "trigger": {"type": "webhook"}}
    run = {"run_id": "run", "task_id": "task", "task_name": "Example", "owner_id": "owner@example.com",
           "execution_context_id": "source", "started_at": datetime.now(timezone.utc),
           "finished_at": checkpoint.checkpoint["ts"], "request_prompt": "Private prompt", "response_full": "Private result"}
    mongo = SimpleNamespace(_db=db, _client=client)
    artifact_collections = [settings.checkpoint_collection, settings.checkpoint_writes_collection,
                            "messages", "conversations", "agent_files.files", "agent_files.chunks"]

    def snapshot() -> dict:
        return {name: list(db[name].find({}).sort("_id", 1)) for name in artifact_collections}

    def create() -> dict:
        return service.create_follow_up_chat(mongo, settings, task, run, agent, UserContext(email="owner@example.com"))

    state = SimpleNamespace(db=db, mongo=mongo, settings=settings, task=task, run=run, saver=saver,
                            store=store, graph=graph, create=create, snapshot=snapshot)
    state.before = snapshot()
    try:
        yield state
    finally:
        client.drop_database(db.name)
        client.close()


def expire_attempt(s: SimpleNamespace) -> dict:
    old = datetime.now(timezone.utc) - timedelta(minutes=1)
    s.db["autonomous_follow_up_chats"].update_many({"state": "creating"}, {"$set": {"lease_until": old}})
    s.db[cleanup.ATTEMPTS_COLLECTION].update_many({}, {"$set": {"cleanup_after": old}})
    return s.db[cleanup.ATTEMPTS_COLLECTION].find_one()


@pytest.mark.parametrize("trigger", ["webhook", "cron", "interval"])
def test_copy_reopen_and_continue_preserve_source(copied_run: SimpleNamespace, trigger: str) -> None:
    s = copied_run
    s.task["trigger"]["type"] = trigger
    result = s.create()
    destination = result["conversation_id"]
    assert s.create() == result
    assert s.db[cleanup.ATTEMPTS_COLLECTION].count_documents({}) == 0
    assert s.db["messages"].count_documents({"conversation_id": destination}) == 2
    assert s.store.get(("agent", destination, "filesystem"), "/private.txt").value == s.store.get(("agent", "source", "filesystem"), "/private.txt").value
    s.graph.invoke({"messages": [HumanMessage(content="Manual follow-up")]}, {"configurable": {"thread_id": destination}})
    assert len(s.graph.get_state({"configurable": {"thread_id": destination}}).values["messages"]) == 4
    assert len(s.graph.get_state({"configurable": {"thread_id": "source"}}).values["messages"]) == 2
    cleanup.reap_copy_attempts(s.mongo)
    assert s.db["conversations"].find_one({"_id": destination})["sharing"]["is_public"] is False


@pytest.mark.parametrize("phase", ["checkpoint", "file", "message", "journal"])
def test_partial_failure_cleans_all_artifacts_and_retry_works(
    copied_run: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, phase: str,
) -> None:
    s = copied_run
    original_copy = service.copy_run_checkpoint
    original_put = MongoDBGridFSStore.put_with_id
    original_insert = Collection.insert_one

    def copy(*args: object) -> str:
        result = original_copy(*args)
        if phase == "checkpoint":
            raise RuntimeError("injected checkpoint failure")
        return result

    def put(*args: object) -> None:
        original_put(*args)
        if phase == "file":
            raise RuntimeError("injected file failure")

    def insert(collection: Collection, document: dict, **kwargs: object) -> object:
        result = original_insert(collection, document, **kwargs)
        if (phase == "message" and collection.name == "messages") or (phase == "journal" and collection.name == cleanup.ATTEMPTS_COLLECTION):
            raise AutoReconnect("injected lost write response")
        return result

    with monkeypatch.context() as patch:
        patch.setattr(service, "copy_run_checkpoint", copy)
        patch.setattr(MongoDBGridFSStore, "put_with_id", put)
        patch.setattr(Collection, "insert_one", insert)
        with pytest.raises((RuntimeError, AutoReconnect)):
            s.create()
    assert s.snapshot() == s.before
    assert s.db["autonomous_follow_up_chats"].find_one()["state"] == "failed"
    # Lost database responses may still have server-side writes in flight.
    assert s.db[cleanup.ATTEMPTS_COLLECTION].count_documents({}) == int(phase in {"message", "journal"})
    assert s.create()["conversation_id"]


@pytest.mark.parametrize("phase", ["ready", "before_publication", "after_publication"])
def test_uncertain_publication_never_deletes_a_ready_copy(
    copied_run: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, phase: str,
) -> None:
    s = copied_run
    original_cas = Collection.find_one_and_update
    original_update = Collection.update_one

    def cas(collection: Collection, query: dict, update: dict, **kwargs: object) -> object:
        result = original_cas(collection, query, update, **kwargs)
        if phase == "ready" and update.get("$set", {}).get("state") == "ready":
            raise AutoReconnect("ready was stored, response lost")
        return result

    def update(collection: Collection, *args: object, **kwargs: object) -> object:
        if collection.name == "conversations" and phase == "before_publication":
            raise AutoReconnect("publication unavailable")
        result = original_update(collection, *args, **kwargs)
        if collection.name == "conversations" and phase == "after_publication":
            raise AutoReconnect("publication response lost")
        return result

    with monkeypatch.context() as patch:
        patch.setattr(Collection, "find_one_and_update", cas)
        patch.setattr(Collection, "update_one", update)
        with pytest.raises(AutoReconnect):
            s.create()
    record = s.db["autonomous_follow_up_chats"].find_one()
    assert record["state"] == "ready"
    destination = record["conversation"]["_id"]
    assert s.saver.get_tuple({"configurable": {"thread_id": destination}})
    copy = MagicMock(side_effect=AssertionError("must reopen without copying"))
    monkeypatch.setattr(service, "copy_run_checkpoint", copy)
    assert s.create()["conversation_id"] == destination
    assert s.db["messages"].count_documents({"conversation_id": destination}) == 2
    copy.assert_not_called()


def test_cleanup_outage_is_retried_from_journal(copied_run: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    s = copied_run
    original_copy = service.copy_run_checkpoint
    original_delete = Collection.delete_many

    def copy(*args: object) -> str:
        original_copy(*args)
        raise RuntimeError("copy failed")

    def delete(collection: Collection, *args: object, **kwargs: object) -> object:
        if collection.name == s.settings.checkpoint_collection:
            raise AutoReconnect("cleanup unavailable")
        return original_delete(collection, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(service, "copy_run_checkpoint", copy)
        patch.setattr(Collection, "delete_many", delete)
        with pytest.raises(RuntimeError, match="copy failed"):
            s.create()
    assert s.db[cleanup.ATTEMPTS_COLLECTION].find_one()["writer_stopped"] is True
    expire_attempt(s)
    cleanup.reap_copy_attempts(s.mongo)
    assert s.snapshot() == s.before
    assert s.db[cleanup.ATTEMPTS_COLLECTION].count_documents({}) == 0


def test_restart_cleanup_includes_incomplete_gridfs_uploads_and_late_writes(
    copied_run: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    s = copied_run
    original_copy = service.copy_run_checkpoint

    def crash(*args: object) -> str:
        original_copy(*args)
        raise SystemExit("process interrupted before finally")

    with monkeypatch.context() as patch:
        patch.setattr(service, "copy_run_checkpoint", crash)
        # A killed process cannot run its finally block.
        patch.setattr(service, "finish_copy_attempt", lambda *_args, **_kwargs: None)
        with pytest.raises(SystemExit):
            s.create()
    attempt = expire_attempt(s)
    destination = attempt["_id"]
    # GridFS may have chunks but no files document when an upload is killed.
    s.db["agent_files.chunks"].insert_one({"files_id": destination + ":interrupted", "n": 0, "data": b"private"})
    cleanup.reap_copy_attempts(s.mongo)
    assert s.snapshot() == s.before
    assert s.db[cleanup.ATTEMPTS_COLLECTION].find_one()  # retain recovery tombstone
    original_copy(s.saver, "source", destination, s.run["finished_at"])
    s.db["agent_files.chunks"].insert_one({"files_id": destination + ":late", "n": 0, "data": b"late private write"})
    expire_attempt(s)
    cleanup.reap_copy_attempts(s.mongo)
    assert s.snapshot() == s.before


def test_expired_writer_cannot_delete_or_replace_concurrent_success(
    copied_run: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    s = copied_run
    started, resume = Event(), Event()
    original_copy = service.copy_run_checkpoint
    destinations = []

    def delayed_copy(*args: object) -> str:
        destinations.append(args[2])
        result = original_copy(*args)
        if len(destinations) == 1:
            started.set()
            assert resume.wait(10)
            # An already-issued write can finish after cleanup/lease revocation.
            original_copy(*args)
        return result

    monkeypatch.setattr(service, "copy_run_checkpoint", delayed_copy)
    with ThreadPoolExecutor(max_workers=1) as executor:
        stale = executor.submit(s.create)
        try:
            assert started.wait(10)
            with pytest.raises(HTTPException) as busy:
                s.create()
            assert busy.value.status_code == 409
            # An active lease must survive a sweep.
            attempt = s.db[cleanup.ATTEMPTS_COLLECTION].find_one()
            cleanup.cleanup_copy_attempt(s.db, attempt)
            assert s.saver.get_tuple({"configurable": {"thread_id": destinations[0]}})
            expire_attempt(s)
            cleanup.reap_copy_attempts(s.mongo)
            winner = s.create()
            winner_snapshot = s.snapshot()
        finally:
            resume.set()
        with pytest.raises(HTTPException) as lost:
            stale.result(timeout=10)
        assert lost.value.status_code == 409
    assert s.snapshot() == winner_snapshot
    assert s.create() == winner
    assert s.db[cleanup.ATTEMPTS_COLLECTION].count_documents({}) == 0


def test_lease_expiry_before_publication_is_rejected(copied_run: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    s = copied_run
    original_insert = Collection.insert_one

    def insert(collection: Collection, document: dict, **kwargs: object) -> object:
        result = original_insert(collection, document, **kwargs)
        if collection.name == "messages" and document["role"] == "assistant":
            expire_attempt(s)
        return result

    monkeypatch.setattr(Collection, "insert_one", insert)
    with pytest.raises(HTTPException) as error:
        s.create()
    assert error.value.status_code == 409
    assert s.snapshot() == s.before


@pytest.mark.asyncio
async def test_startup_sweep_publishes_ready_copy_without_user_retry(
    copied_run: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    s = copied_run
    with monkeypatch.context() as patch:
        patch.setattr(service, "publish_follow_up_chat", MagicMock(side_effect=SystemExit("process interrupted")))
        patch.setattr(service, "finish_copy_attempt", lambda *_args, **_kwargs: None)
        with pytest.raises(SystemExit):
            s.create()
    attempt = expire_attempt(s)
    assert s.db["conversations"].count_documents({}) == 0
    # Exercise the same startup/periodic loop used by the application lifespan.
    monkeypatch.setattr(cleanup.asyncio, "sleep", AsyncMock(side_effect=asyncio.CancelledError))
    with pytest.raises(asyncio.CancelledError):
        await cleanup.run_copy_cleanup(s.mongo)
    assert s.db["conversations"].find_one({"_id": attempt["_id"]})
    assert s.saver.get_tuple({"configurable": {"thread_id": attempt["_id"]}})
    assert s.db[cleanup.ATTEMPTS_COLLECTION].count_documents({}) == 0


def test_custom_checkpoint_collections_clean_using_journal_coordinates(
    copied_run: SimpleNamespace,
) -> None:
    s = copied_run
    # Recovery must not depend on a later edit to agent/default configuration.
    destination = str(uuid4())
    attempt = {"_id": destination, "registry_id": "custom-attempt", "checkpoint_collection": "custom_snapshots",
               "writes_collection": "custom_writes", "gridfs_bucket": "custom_files", "writer_stopped": True,
               "cleanup_after": datetime.now(timezone.utc)}
    s.db[cleanup.ATTEMPTS_COLLECTION].insert_one(attempt)
    s.db["custom_snapshots"].insert_one({"thread_id": destination, "private": True})
    s.db["custom_writes"].insert_one({"thread_id": destination, "private": True})
    s.db["custom_files.chunks"].insert_one({"files_id": destination + ":upload", "n": 0, "data": b"private"})
    cleanup.reap_copy_attempts(s.mongo)
    assert all(s.db[name].count_documents({}) == 0 for name in ("custom_snapshots", "custom_writes", "custom_files.chunks"))
    assert s.snapshot() == s.before


def test_ambiguous_write_committing_after_local_cleanup_is_reaped(
    copied_run: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    s = copied_run
    original_copy = service.copy_run_checkpoint

    def disconnected(*args: object) -> str:
        # The command has been sent; its final server-side outcome is unknown.
        raise AutoReconnect("lost connection while checkpoint write was pending")

    with monkeypatch.context() as patch:
        patch.setattr(service, "copy_run_checkpoint", disconnected)
        with pytest.raises(AutoReconnect):
            s.create()
    assert s.snapshot() == s.before
    attempt = expire_attempt(s)
    assert attempt["writer_stopped"] is False
    # The server completes that old write AFTER local cleanup has returned.
    original_copy(s.saver, "source", attempt["_id"], s.run["finished_at"])
    cleanup.reap_copy_attempts(s.mongo)
    assert s.snapshot() == s.before
