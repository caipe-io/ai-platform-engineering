"""Accepted requests survive the UUID-to-deterministic admission upgrade."""
from __future__ import annotations

import asyncio
import hashlib
import os
from collections.abc import AsyncIterator
from typing import Any
from uuid import uuid4

import mongomock
import pytest

from harness_engine.brokers import DefaultPromptCompiler
from harness_engine.coordinator import RunCoordinator
from harness_engine.models import AgentBlueprint, CreateRunRequest, RunEvent, RunRecord, RunStatus
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import MongoRunRepository, RunAdmissionConflict
from harness_engine.sessions import CAIPEAgentSessionManager
from tests.conftest import FakeHarnessAdapter, blueprint


@pytest.fixture(params=["mock", "standalone"])
async def migration_repository(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[MongoRunRepository]:
    database = "engine_migration_test_" + uuid4().hex
    if request.param == "mock":
        client = mongomock.MongoClient(tz_aware=True)
        monkeypatch.setattr("harness_engine.repository.MongoClient", lambda *args, **kwargs: client)
        uri = "mongodb://example.test"
    else:
        uri = os.environ.get("HARNESS_ENGINE_TEST_MONGODB_URI")
        if not uri:
            pytest.skip("Set HARNESS_ENGINE_TEST_MONGODB_URI for standalone migration tests")
    repository = MongoRunRepository(uri, database, 3600)
    await repository.initialize()
    try:
        yield repository
    finally:
        await asyncio.to_thread(repository._client.drop_database, database)
        await repository.close()


async def legacy_exchange(
    repository: MongoRunRepository, status: RunStatus = RunStatus.COMPLETED,
) -> tuple[RunCoordinator, FakeHarnessAdapter, CreateRunRequest, dict[str, Any]]:
    adapter = FakeHarnessAdapter()
    registry = HarnessRegistry([adapter])
    definition = AgentBlueprint.model_validate(blueprint())
    await repository.save_agent(definition, "definition", registry.catalog_revision, None)
    manager = CAIPEAgentSessionManager(repository, registry, b"test-key")
    binding, version = await manager.resolve("test-user", definition.id, "conversation-example")
    coordinator = RunCoordinator(repository, registry, manager, DefaultPromptCompiler())
    request = CreateRunRequest(
        agent_id=definition.id, conversation_id=binding.conversation_id,
        message="A bounded example with unicode café", client_request_id="accepted-request",
    )
    old_fingerprint = hashlib.sha256(
        request.model_dump_json(include={"agent_id", "conversation_id", "message", "context", "client_request_id"}).encode()
    ).hexdigest()
    run = RunRecord(
        run_id="run-" + uuid4().hex, owner_subject="test-user", agent_id=definition.id,
        agent_version=version.version, conversation_id=binding.conversation_id,
        binding_id=binding.binding_id, harness_id=binding.harness_id, profile_id=binding.profile_id,
        provider_session_id=binding.provider_session_id, status=status, client_request_id=request.client_request_id,
        last_sequence=1 if status == RunStatus.COMPLETED else 0,
    ).model_dump(mode="python", exclude={"protocol", "visible_conversation_id"})
    run["request_fingerprint"] = old_fingerprint
    if status == RunStatus.COMPLETED:
        # The previous release published the head together with pending payload;
        # process loss before event insertion must not lose that terminal event.
        run["pending_event"] = RunEvent(
            run_id=run["run_id"], sequence=1, event_type="run.completed", data={},
        ).model_dump(mode="python")
    await asyncio.to_thread(repository._db.harness_runs.insert_one, run)
    return coordinator, adapter, request, run


async def test_prior_uuid_request_returns_original_and_recovers_pending_without_provider(
    migration_repository: MongoRunRepository,
) -> None:
    coordinator, adapter, request, old = await legacy_exchange(migration_repository)
    # Original accepted tuple is resolved even if the definition was removed.
    await migration_repository.delete_agent(request.agent_id)
    for _ in range(2):
        accepted = await coordinator.start_run(request, "test-user")
        assert accepted.run_id == old["run_id"]
        assert accepted.status == RunStatus.COMPLETED
    assert adapter.calls == []
    assert coordinator._tasks == {}
    assert await asyncio.to_thread(migration_repository._db.harness_runs.count_documents, {}) == 1
    stored = await migration_repository._read_run(old["run_id"])
    assert stored and "request_fingerprint" not in stored and "pending_event" not in stored
    events = await migration_repository.list_events(old["run_id"], 0)
    assert [(event.sequence, event.event_type) for event in events] == [(1, "run.completed")]
    # Definition deletion retains execution ownership for later authorized purge.
    assert await migration_repository.context_sessions("test-user", request.agent_id, request.conversation_id)


@pytest.mark.parametrize("change", [{"message": "changed"}, {"protocol": "custom"}])
async def test_prior_request_changed_input_rejected_without_new_run(
    migration_repository: MongoRunRepository, change: dict[str, Any],
) -> None:
    coordinator, adapter, request, _ = await legacy_exchange(migration_repository)
    with pytest.raises(RunAdmissionConflict, match="different input"):
        await coordinator.start_run(request.model_copy(update=change), "test-user")
    assert adapter.calls == []
    assert await asyncio.to_thread(migration_repository._db.harness_runs.count_documents, {}) == 1


async def test_unfenced_prior_active_request_requires_migration_and_never_replays(
    migration_repository: MongoRunRepository,
) -> None:
    coordinator, adapter, request, old = await legacy_exchange(migration_repository, RunStatus.RUNNING)
    with pytest.raises(RunAdmissionConflict, match="migration"):
        await coordinator.start_run(request, "test-user")
    assert adapter.calls == []
    assert coordinator._tasks == {}
    assert (await migration_repository._read_run(old["run_id"]))["status"] == "running"


async def test_prior_binding_snapshot_blocks_new_turn_when_run_insert_was_lost(
    migration_repository: MongoRunRepository,
) -> None:
    coordinator, adapter, request, old = await legacy_exchange(migration_repository, RunStatus.RUNNING)
    await asyncio.to_thread(migration_repository._db.harness_runs.delete_one, {"run_id": old["run_id"]})
    await asyncio.to_thread(
        migration_repository._db.harness_sessions.update_one, {"binding_id": old["binding_id"]},
        {"$set": {"active_run": {key: value for key, value in old.items() if key != "_id"}, "dispatch_started": True}},
    )
    with pytest.raises(RunAdmissionConflict, match="migration"):
        await coordinator.start_run(request.model_copy(update={"client_request_id": "new-turn"}), "test-user")
    assert adapter.calls == []
    assert await asyncio.to_thread(migration_repository._db.harness_runs.count_documents, {}) == 0


async def test_inactive_prior_binding_remains_compatible(migration_repository: MongoRunRepository) -> None:
    coordinator, adapter, request, old = await legacy_exchange(migration_repository)
    await asyncio.to_thread(
        migration_repository._db.harness_sessions.update_one, {"binding_id": old["binding_id"]},
        {"$set": {"active_run": None, "dispatch_started": False}},
    )
    run = await coordinator.start_run(request.model_copy(update={"client_request_id": "new-turn"}), "test-user")
    await asyncio.wait_for(coordinator._tasks[run.run_id], 2)
    assert len(adapter.calls) == 1
    assert (await migration_repository.get_run(run.run_id)).status == RunStatus.COMPLETED


async def test_orphaned_prior_runs_do_not_falsely_report_provider_cleanup_complete(
    migration_repository: MongoRunRepository,
) -> None:
    coordinator, _, request, old = await legacy_exchange(migration_repository)
    await asyncio.to_thread(migration_repository._db.harness_sessions.delete_one, {"binding_id": old["binding_id"]})
    await asyncio.to_thread(
        migration_repository._db.harness_deleted_contexts.insert_one, {"_id": request.conversation_id},
    )
    with pytest.raises(RunAdmissionConflict, match="no binding.*reconciliation"):
        await coordinator.delete_session("test-user", request.agent_id, request.conversation_id)
    assert await migration_repository._read_run(old["run_id"])


async def test_prior_request_without_input_proof_requires_migration_without_resend(
    migration_repository: MongoRunRepository,
) -> None:
    coordinator, adapter, request, old = await legacy_exchange(migration_repository)
    await asyncio.to_thread(
        migration_repository._db.harness_runs.update_one, {"run_id": old["run_id"]},
        {"$set": {"request_fingerprint": None}},
    )
    with pytest.raises(RunAdmissionConflict, match="migration"):
        await coordinator.start_run(request, "test-user")
    assert adapter.calls == []
    assert coordinator._tasks == {}
