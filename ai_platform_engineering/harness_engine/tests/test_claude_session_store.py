from __future__ import annotations

import asyncio
import json
import os
import threading
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any
from uuid import uuid4

import pytest
from claude_agent_sdk import AssistantMessage, SessionKey, SessionStoreEntry, TextBlock

from harness_engine.adapters.claude_sdk import ClaudeSDKAdapter
from harness_engine.brokers import DefaultPromptCompiler
from harness_engine.claude_session_store import MongoClaudeSessionStore
from harness_engine.coordinator import RunCoordinator
from harness_engine.models import CreateRunRequest, utc_now
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import MongoRunRepository, RunAdmissionConflict, RunFencedError
from harness_engine.sessions import CAIPEAgentSessionManager
from tests.test_claude_sdk_adapter import sdk_context


@pytest.fixture
async def transcript_store() -> AsyncIterator[MongoClaudeSessionStore]:
    uri = os.environ.get("HARNESS_ENGINE_TEST_MONGODB_URI")
    if not uri:
        pytest.skip("Set HARNESS_ENGINE_TEST_MONGODB_URI to test SDK transcript fencing against MongoDB")
    database = "claude_transcript_test_" + uuid4().hex
    store = MongoClaudeSessionStore(uri, database)
    try:
        await store._ensure_indexes()
        yield store
    finally:
        await asyncio.to_thread(store._client.drop_database, database)
        store._client.close()


def admit(store: MongoClaudeSessionStore, *, provider_session_id: str | None = None):
    context = sdk_context(provider_session_id=provider_session_id)
    store._db.harness_sessions.insert_one(
        {
            **context.binding.model_dump(mode="python"),
            "_active_run_id": context.turn.run_id,
            "_producer_id": context.producer_token,
            "_lease_expires_at": utc_now() + timedelta(minutes=1),
        }
    )
    store._db.harness_runs.insert_one(
        {
            "run_id": context.turn.run_id,
            "binding_id": context.binding.binding_id,
            "owner_subject": context.binding.owner_subject,
            "agent_id": context.binding.agent_id,
            "conversation_id": context.binding.conversation_id,
            "_owner_token": context.producer_token,
            "_producer_id": context.producer_token,
            "cancellation_requested": False,
            "_producer_stopped": False,
            "status": "running",
        }
    )
    return context


KEY: SessionKey = {"project_key": "example-project", "session_id": "session-example"}
ENTRIES: list[SessionStoreEntry] = [
    {"uuid": "entry-one", "type": "user", "message": {"role": "user", "content": "example"}},
    {"uuid": "entry-two", "type": "assistant", "message": {"role": "assistant", "content": "answer"}},
]


async def test_partial_transcripts_are_bound_before_provider_identity_and_delete_is_bounded(transcript_store) -> None:
    context = admit(transcript_store)
    scope = transcript_store.for_run(context)
    await scope.ready()
    await scope.append(KEY, ENTRIES)
    await scope.append(KEY, ENTRIES)
    await scope.close()
    documents = list(transcript_store._collection.find({"binding_id": context.binding.binding_id}))
    assert len(documents) == 2
    assert {document["run_id"] for document in documents} == {context.turn.run_id}
    assert [json.loads(document["entry_json"]) for document in documents] == ENTRIES
    assert context.binding.provider_session_id is None
    unrelated = {"binding_id": "binding-secondary", "session_id": "session-secondary", "entry_json": "{}"}
    transcript_store._collection.insert_one(unrelated)
    transcript_store._db.harness_sessions.update_one(
        {"binding_id": context.binding.binding_id}, {"$set": {"status": "closed"}}
    )

    await transcript_store.purge_for_binding(context.binding)
    await transcript_store.purge_for_binding(context.binding)

    assert transcript_store._collection.count_documents({"binding_id": context.binding.binding_id}) == 0
    assert transcript_store._collection.count_documents({"binding_id": "binding-secondary"}) == 1
    with pytest.raises(RunFencedError, match="closed"):
        await scope.append(KEY, ENTRIES)


async def test_owned_transcript_resumes_with_original_json_and_subkeys(transcript_store) -> None:
    context = admit(transcript_store, provider_session_id=KEY["session_id"])
    scope = transcript_store.for_run(context)
    await scope.append(KEY, ENTRIES)
    subkey = {**KEY, "subpath": "subagents/agent-example"}
    await scope.append(subkey, [ENTRIES[1]])

    assert await scope.load(KEY) == ENTRIES
    assert await scope.list_subkeys(KEY) == ["subagents/agent-example"]
    assert await scope.load(subkey) == [ENTRIES[1]]
    await scope.close()


async def test_another_replica_restores_owned_transcript_for_a_new_admitted_run(transcript_store) -> None:
    context = admit(transcript_store, provider_session_id=KEY["session_id"])
    first = transcript_store.for_run(context)
    await first.append(KEY, ENTRIES)
    await first.close()
    next_context = context.model_copy(
        update={
            "producer_token": "producer-next",
            "turn": context.turn.model_copy(update={"run_id": "run-next"}),
        }
    )
    transcript_store._db.harness_runs.update_one(
        {"run_id": context.turn.run_id},
        {"$set": {"status": "completed", "_producer_stopped": True}, "$unset": {"_producer_id": ""}},
    )
    transcript_store._db.harness_sessions.update_one(
        {"binding_id": context.binding.binding_id},
        {"$set": {"_active_run_id": "run-next", "_producer_id": "producer-next"}},
    )
    transcript_store._db.harness_runs.insert_one(
        {
            "run_id": "run-next",
            "binding_id": context.binding.binding_id,
            "owner_subject": context.binding.owner_subject,
            "agent_id": context.binding.agent_id,
            "conversation_id": context.binding.conversation_id,
            "_owner_token": "producer-next",
            "_producer_id": "producer-next",
            "status": "running",
        }
    )
    other_replica = MongoClaudeSessionStore(os.environ["HARNESS_ENGINE_TEST_MONGODB_URI"], transcript_store._db.name)
    try:
        resumed = other_replica.for_run(next_context)
        await resumed.ready()
        assert await resumed.load(KEY) == ENTRIES
        await resumed.close()
        with pytest.raises(RunFencedError):
            await first.append(KEY, ENTRIES)
    finally:
        other_replica._client.close()


@pytest.mark.parametrize(
    "change",
    [
        {"status": "closed"},
        {"_active_run_id": "run-secondary"},
        {"_producer_id": "producer-secondary"},
        {"_lease_expires_at": utc_now() - timedelta(minutes=1)},
    ],
)
async def test_closed_or_stale_binding_cannot_write(transcript_store, change: dict[str, Any]) -> None:
    context = admit(transcript_store)
    transcript_store._db.harness_sessions.update_one({"binding_id": context.binding.binding_id}, {"$set": change})
    scope = transcript_store.for_run(context)
    with pytest.raises(RunFencedError):
        await scope.append(KEY, ENTRIES)
    assert transcript_store._collection.count_documents({}) == 0
    await scope.close()


@pytest.mark.parametrize(
    "change",
    [
        {"status": "cancelled"},
        {"_producer_stopped": True},
        {"_owner_token": "producer-secondary"},
        {"_producer_id": "producer-secondary"},
    ],
)
async def test_cancelled_or_forged_run_cannot_write(transcript_store, change: dict[str, Any]) -> None:
    context = admit(transcript_store)
    transcript_store._db.harness_runs.update_one({"run_id": context.turn.run_id}, {"$set": change})
    with pytest.raises(RunFencedError):
        await transcript_store.for_run(context).append(KEY, ENTRIES)
    assert transcript_store._collection.count_documents({}) == 0


async def test_pending_cancellation_keeps_mirroring_the_admitted_provider_until_drain(transcript_store) -> None:
    context = admit(transcript_store, provider_session_id=KEY["session_id"])
    transcript_store._db.harness_runs.update_one(
        {"run_id": context.turn.run_id}, {"$set": {"cancellation_requested": True}}
    )
    scope = transcript_store.for_run(context)
    await scope.ready()
    await scope.append(KEY, ENTRIES)
    assert await scope.load(KEY) == ENTRIES
    await scope.close()
    assert transcript_store._collection.count_documents({"binding_id": context.binding.binding_id}) == len(ENTRIES)


async def test_tombstone_fences_ready_and_writes_even_with_otherwise_live_claim(transcript_store) -> None:
    context = admit(transcript_store)
    transcript_store._db.harness_deleted_contexts.insert_one({"_id": context.binding.conversation_id})
    scope = transcript_store.for_run(context)
    with pytest.raises(RunFencedError):
        await scope.ready()
    with pytest.raises(RunFencedError):
        await scope.append(KEY, ENTRIES)
    assert transcript_store._collection.count_documents({}) == 0


async def test_cancelled_mirror_thread_is_drained_and_cannot_recreate_deleted_transcript(
    transcript_store,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = admit(transcript_store)
    scope = transcript_store.for_run(context)
    write_entered = threading.Event()
    allow_write = threading.Event()
    bulk_write = transcript_store._collection.bulk_write

    def delayed_write(*args: Any, **kwargs: Any) -> Any:
        write_entered.set()
        if not allow_write.wait(5):
            raise TimeoutError("test did not release delayed write")
        return bulk_write(*args, **kwargs)

    monkeypatch.setattr(transcript_store._collection, "bulk_write", delayed_write)
    append = asyncio.create_task(scope.append(KEY, ENTRIES))
    try:
        assert await asyncio.to_thread(write_entered.wait, 2)
        transcript_store._db.harness_deleted_contexts.insert_one({"_id": context.binding.conversation_id})
        transcript_store._db.harness_sessions.update_one(
            {"binding_id": context.binding.binding_id}, {"$set": {"status": "closed"}}
        )
        append.cancel()
        with pytest.raises(asyncio.CancelledError):
            await append
        close = asyncio.create_task(scope.close())
        await asyncio.sleep(0)
        assert not close.done(), "producer shutdown must wait for the blocking mirror write"
        allow_write.set()
        await asyncio.wait_for(close, 2)
        await transcript_store.purge_for_binding(context.binding)
        assert transcript_store._collection.count_documents({}) == 0
        with pytest.raises(RunFencedError):
            await scope.append(KEY, ENTRIES)
        assert transcript_store._collection.count_documents({}) == 0
    finally:
        allow_write.set()
        await scope.close()


def legacy_document() -> dict[str, Any]:
    return {
        **KEY,
        "subpath": None,
        "entry_json": json.dumps(ENTRIES[0]),
        "stored_at": utc_now(),
        "batch_id": "legacy",
        "position": 0,
    }


async def test_unique_legacy_binding_can_resume_without_changing_transcript_json(transcript_store) -> None:
    context = admit(transcript_store, provider_session_id=KEY["session_id"])
    transcript_store._collection.insert_one(legacy_document())
    scope = transcript_store.for_run(context)

    assert await scope.load(KEY) == [ENTRIES[0]]

    row = transcript_store._collection.find_one({"session_id": KEY["session_id"]})
    assert row["binding_id"] == context.binding.binding_id
    assert row["legacy_adopted"] is True
    assert json.loads(row["entry_json"]) == ENTRIES[0]
    await scope.close()


@pytest.mark.parametrize("legacy_state", ["unknown", "other-binding", "unresolved-producer"])
async def test_legacy_ownership_is_not_guessed(transcript_store, legacy_state: str) -> None:
    context = admit(transcript_store, provider_session_id=None if legacy_state == "unknown" else KEY["session_id"])
    transcript_store._collection.insert_one(legacy_document())
    if legacy_state == "other-binding":
        transcript_store._db.harness_sessions.insert_one(
            {
                **context.binding.model_dump(mode="python"),
                "binding_id": "binding-secondary",
                "owner_subject": "secondary-user",
            }
        )
    elif legacy_state == "unresolved-producer":
        transcript_store._db.harness_runs.insert_one(
            {
                "run_id": "run-legacy",
                "binding_id": context.binding.binding_id,
                "status": "running",
                "_producer_id": "producer-legacy",
            }
        )
    scope = transcript_store.for_run(context)
    with pytest.raises(RunFencedError, match="reconciliation"):
        await scope.load(KEY)
    assert transcript_store._collection.count_documents({"binding_id": {"$exists": False}}) == 1
    await scope.close()


async def test_other_binding_tag_is_not_adopted_or_removed(transcript_store) -> None:
    context = admit(transcript_store, provider_session_id=KEY["session_id"])
    transcript_store._collection.insert_one({**legacy_document(), "binding_id": "binding-secondary"})
    scope = transcript_store.for_run(context)
    with pytest.raises(RunFencedError):
        await scope.load(KEY)
    with pytest.raises(RunFencedError):
        await scope.append(KEY, ENTRIES)
    transcript_store._db.harness_sessions.update_one(
        {"binding_id": context.binding.binding_id}, {"$set": {"status": "closed"}}
    )
    await transcript_store.purge_for_binding(context.binding)
    assert transcript_store._collection.count_documents({"binding_id": "binding-secondary"}) == 1
    await scope.close()


async def test_missing_owned_mirror_fails_instead_of_falling_back_to_disk(transcript_store) -> None:
    context = admit(transcript_store, provider_session_id=KEY["session_id"])
    scope = transcript_store.for_run(context)
    with pytest.raises(RunFencedError, match="owned transcript is unavailable"):
        await scope.load(KEY)
    await scope.close()


@pytest.mark.parametrize("collision", [False, True])
async def test_legacy_delete_requires_unique_canonical_provider_reference(transcript_store, collision: bool) -> None:
    context = admit(transcript_store, provider_session_id=KEY["session_id"])
    transcript_store._collection.insert_one(legacy_document())
    transcript_store._db.harness_sessions.update_one(
        {"binding_id": context.binding.binding_id}, {"$set": {"status": "closed"}}
    )
    if collision:
        transcript_store._db.harness_sessions.insert_one(
            {
                **context.binding.model_dump(mode="python"),
                "binding_id": "binding-secondary",
                "owner_subject": "secondary-user",
            }
        )
        with pytest.raises(RunFencedError, match="ambiguous"):
            await transcript_store.purge_for_binding(context.binding)
        assert transcript_store._collection.count_documents({}) == 1
    else:
        await transcript_store.purge_for_binding(context.binding)
        assert transcript_store._collection.count_documents({}) == 0


async def test_open_binding_cannot_purge_transcripts(transcript_store) -> None:
    context = admit(transcript_store)
    with pytest.raises(RunFencedError, match="closed canonical binding"):
        await transcript_store.purge_for_binding(context.binding)


def test_missing_producer_token_cannot_create_scoped_store() -> None:
    store = MongoClaudeSessionStore("mongodb://127.0.0.1:1", "example")
    try:
        with pytest.raises(RunFencedError, match="admitted producer"):
            store.for_run(sdk_context().model_copy(update={"producer_token": None}))
    finally:
        store._client.close()


async def test_engine_delete_cleans_sdk_partial_mirror_without_final_provider_id(transcript_store, settings) -> None:
    stored = asyncio.Event()
    waiting = asyncio.Event()
    release = asyncio.Event()
    scopes = []

    async def fake_query(**kwargs: Any) -> AsyncIterator[Any]:
        scope = kwargs["options"].session_store
        scopes.append(scope)
        await scope.append(KEY, ENTRIES)
        stored.set()
        yield AssistantMessage(content=[TextBlock(text="partial")], model="claude-example")
        waiting.set()
        await release.wait()

    adapter = ClaudeSDKAdapter(settings, query_fn=fake_query, transcript_store=transcript_store)
    registry = HarnessRegistry([adapter])
    repository = MongoRunRepository(os.environ["HARNESS_ENGINE_TEST_MONGODB_URI"], transcript_store._db.name, 3600)
    await repository.initialize()
    definition = sdk_context().blueprint
    await repository.save_agent(definition, "fingerprint-example", registry.catalog_revision, None)
    coordinator = RunCoordinator(
        repository, registry, CAIPEAgentSessionManager(repository, registry, b"test-key"), DefaultPromptCompiler()
    )
    try:
        run = await coordinator.start_run(
            CreateRunRequest(agent_id=definition.id, conversation_id="conversation-example", message="example"),
            "test-user",
        )
        await asyncio.wait_for(stored.wait(), 2)
        await asyncio.wait_for(waiting.wait(), 2)
        producer = coordinator._tasks[run.run_id]
        binding = await repository.get_session(run.binding_id)
        assert binding is not None and binding.provider_session_id is None
        assert transcript_store._collection.count_documents({"binding_id": binding.binding_id}) == 2
        transcript_store._db.harness_deleted_contexts.insert_one({"_id": "conversation-example"})

        with pytest.raises(RunAdmissionConflict, match="waiting"):
            await coordinator.delete_session("test-user", definition.id, "conversation-example")
        assert await repository.get_session(run.binding_id) is not None
        assert transcript_store._db.harness_runs.count_documents({"run_id": run.run_id}) == 1
        assert transcript_store._db.harness_events.count_documents({"run_id": run.run_id}) > 0
        assert transcript_store._collection.count_documents({"binding_id": binding.binding_id}) == 2
        release.set()
        await asyncio.wait_for(asyncio.gather(producer, return_exceptions=True), 2)
        await coordinator.delete_session("test-user", definition.id, "conversation-example")

        assert await repository.get_session(run.binding_id) is None
        assert await repository.get_run(run.run_id) is None
        assert transcript_store._db.harness_runs.count_documents({"run_id": run.run_id}) == 0
        assert transcript_store._db.harness_events.count_documents({"run_id": run.run_id}) == 0
        assert transcript_store._collection.count_documents({}) == 0
        with pytest.raises(RunFencedError):
            await scopes[0].append(KEY, ENTRIES)
        assert transcript_store._collection.count_documents({}) == 0
    finally:
        release.set()
        await coordinator.shutdown()
        await repository.close()
