from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pymongo.errors import PyMongoError

from harness_engine.brokers import DefaultPromptCompiler
from harness_engine.coordinator import RunCoordinator
from harness_engine.history import MongoRunHistoryProjector, history_message_ids
from harness_engine.main import create_app
from harness_engine.models import (
    AgentBlueprint,
    CanonicalEventDraft,
    ProviderTurnOutcome,
    RunContext,
    RunRecord,
    RunStatus,
)
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import MongoRunRepository, RunAdmissionConflict
from harness_engine.sessions import CAIPEAgentSessionManager
from tests.conftest import FakeHarnessAdapter, auth_headers, blueprint
from tests.test_durable_run_admission import request_turn
from tests.test_legacy_run_migration import migration_repository as migration_repository
from tests.test_provider_lifecycle import OutcomeAdapter


class GatedHistoryAdapter(OutcomeAdapter):
    def __init__(self) -> None:
        super().__init__([])
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | ProviderTurnOutcome]:
        self.calls.append(context)
        yield CanonicalEventDraft(event_type="content.delta", data={"text": "Visible "})
        self.started.set()
        await self.release.wait()
        yield CanonicalEventDraft(event_type="tool.started", data={
            "tool_call_id": "tool-example", "tool_name": "lookup", "arguments": {"query": "example"}, "namespace": ["helper"],
        })
        yield CanonicalEventDraft(event_type="content.delta", data={"text": "Child detail", "namespace": ["helper"]})
        yield CanonicalEventDraft(event_type="tool.completed", data={"tool_call_id": "tool-example", "result": "found", "namespace": ["helper"]})
        yield CanonicalEventDraft(event_type="content.delta", data={"text": "answer"})
        yield ProviderTurnOutcome(status="completed")


async def setup_history(
    repository: MongoRunRepository, adapter: OutcomeAdapter, *, server_history: bool = True,
) -> tuple[RunCoordinator, MongoRunHistoryProjector]:
    adapter.server_history = server_history
    registry = HarnessRegistry([adapter])
    await repository.save_agent(AgentBlueprint.model_validate(blueprint()), "fingerprint", registry.catalog_revision, None)
    db = repository.provider_database
    await asyncio.to_thread(db.conversations.insert_one, {
        "_id": "conversation-example", "owner_id": "owner@example.test", "owner_subject": "test-user",
        "participants": [{"type": "agent", "id": "agent-example"}], "source": "web", "metadata": {"total_messages": 0},
    })
    # Validate the canonical scope fields rather than depending on a gateway
    # hash format, which is an implementation detail of the BFF.
    await asyncio.to_thread(db.harness_gateway_bindings.insert_one, {
        "_id": "gateway-example", "owner_subject": "test-user", "agent_id": "agent-example",
        "conversation_id": "conversation-example", "harness_id": "agentcore",
    })
    projector = MongoRunHistoryProjector(repository)
    await projector.initialize()
    coordinator = RunCoordinator(
        repository, registry, CAIPEAgentSessionManager(repository, registry, b"test-key"), DefaultPromptCompiler(),
        lease_seconds=2, history_projector=projector,
    )
    return coordinator, projector


async def finish(coordinator: RunCoordinator, run: RunRecord) -> None:
    if task := coordinator._tasks.get(run.run_id):
        await asyncio.wait_for(asyncio.shield(task), 2)


async def rows(repository: MongoRunRepository) -> list[dict[str, Any]]:
    return await asyncio.to_thread(lambda: list(repository.provider_database.messages.find({}).sort("created_at", 1)))


async def test_visible_history_finishes_without_any_browser_subscription(migration_repository: MongoRunRepository) -> None:
    adapter = GatedHistoryAdapter()
    coordinator, projector = await setup_history(migration_repository, adapter)
    run = await coordinator.start_run(request_turn(visible_conversation_id="conversation-example"), "test-user")
    await asyncio.wait_for(adapter.started.wait(), 2)
    initial = await rows(migration_repository)
    ids = history_message_ids(run.run_id)
    assert [(item["role"], item["message_id"]) for item in initial] == [("user", ids.user_message_id), ("assistant", ids.assistant_message_id)]
    assert initial[0]["content"] == "test question" and initial[1]["metadata"]["is_final"] is False
    # No HTTP/SSE reader exists. The coordinator alone owns provider completion.
    adapter.release.set()
    await finish(coordinator, run)
    await asyncio.gather(*(projector.reconcile_once() for _ in range(4)))
    final = await rows(migration_repository)
    assert len(final) == 2
    assistant = final[1]
    assert assistant["content"] == "Visible answer"
    assert assistant["metadata"]["is_final"] is True and assistant["metadata"]["turn_status"] == "completed"
    assert assistant["metadata"]["history_owner"] == "harness_engine"
    child_events = [event for event in assistant["stream_events"] if event["namespace"] == ["helper"]]
    assert [event["type"] for event in child_events] == ["tool_start", "content", "tool_end"]
    conversation = await asyncio.to_thread(migration_repository.provider_database.conversations.find_one, {"_id": run.visible_conversation_id})
    assert conversation["metadata"]["total_messages"] == 2
    projection = await asyncio.to_thread(migration_repository.provider_database.harness_history_projections.find_one, {"_id": run.run_id})
    assert projection["state"] == "complete" and "input" not in projection


@pytest.mark.parametrize("mutation", [
    {"participants": [{"type": "agent", "id": "another-agent"}]},
    {"deleted_at": "deleted"},
    {"app_binding": {}},
    {"source": "autonomous", "execution_context_id": "runtime-other"},
])
async def test_wrong_or_unavailable_visible_target_prevents_dispatch(
    migration_repository: MongoRunRepository, mutation: dict[str, Any],
) -> None:
    adapter = OutcomeAdapter([ProviderTurnOutcome(status="completed")])
    coordinator, _ = await setup_history(migration_repository, adapter)
    await asyncio.to_thread(migration_repository.provider_database.conversations.update_one, {"_id": "conversation-example"}, {"$set": mutation})
    with pytest.raises(RunAdmissionConflict):
        await coordinator.start_run(request_turn(visible_conversation_id="conversation-example"), "test-user")
    assert adapter.calls == [] and await rows(migration_repository) == []


async def test_arbitrary_visible_alias_and_gateway_owner_cannot_redirect_history(migration_repository: MongoRunRepository) -> None:
    adapter = OutcomeAdapter([ProviderTurnOutcome(status="completed")])
    coordinator, _ = await setup_history(migration_repository, adapter)
    await asyncio.to_thread(migration_repository.provider_database.conversations.insert_one, {
        "_id": "visible-other", "owner_id": "other@example.test", "participants": [{"type": "agent", "id": "agent-example"}],
    })
    with pytest.raises(RunAdmissionConflict, match="history"):
        await coordinator.start_run(request_turn(visible_conversation_id="visible-other"), "test-user")
    await asyncio.to_thread(migration_repository.provider_database.harness_gateway_bindings.update_one, {"_id": "gateway-example"}, {"$set": {"owner_subject": "other-user"}})
    with pytest.raises(RunAdmissionConflict, match="history"):
        await coordinator.start_run(request_turn("turn-second", visible_conversation_id="conversation-example"), "test-user")
    assert adapter.calls == [] and await rows(migration_repository) == []


async def test_terminal_projection_failure_is_recovered_from_the_durable_outbox(
    migration_repository: MongoRunRepository, monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = GatedHistoryAdapter()
    coordinator, projector = await setup_history(migration_repository, adapter)
    run = await coordinator.start_run(request_turn(visible_conversation_id="conversation-example"), "test-user")
    await asyncio.wait_for(adapter.started.wait(), 2)
    original = projector.finalized

    async def unavailable(run: RunRecord) -> None:
        raise PyMongoError("temporary projection outage")

    monkeypatch.setattr(projector, "finalized", unavailable)
    adapter.release.set()
    await finish(coordinator, run)
    stored = await migration_repository.get_run(run.run_id)
    assert stored and stored.status == RunStatus.COMPLETED
    assert (await rows(migration_repository))[1]["metadata"]["is_final"] is False
    # A fresh service instance has no browser state or provider task to replay.
    recovered = MongoRunHistoryProjector(migration_repository)
    await recovered.reconcile_once()
    assistant = (await rows(migration_repository))[1]
    assert assistant["content"] == "Visible answer" and assistant["metadata"]["is_final"] is True
    monkeypatch.setattr(projector, "finalized", original)


async def test_duplicate_admission_and_reconciliation_never_duplicate_rows(migration_repository: MongoRunRepository) -> None:
    adapter = GatedHistoryAdapter()
    coordinator, projector = await setup_history(migration_repository, adapter)
    request = request_turn(visible_conversation_id="conversation-example")
    accepted = await asyncio.gather(*(coordinator.start_run(request, "test-user") for _ in range(5)))
    assert len({run.run_id for run in accepted}) == 1
    assert len(await rows(migration_repository)) == 2
    adapter.release.set()
    await finish(coordinator, accepted[0])
    stored = await migration_repository.get_run(accepted[0].run_id)
    assert stored is not None
    await asyncio.gather(*(projector.finalized(stored) for _ in range(3)))
    assert len(await rows(migration_repository)) == 2 and len(adapter.calls) == 1


async def test_existing_sdk_style_turn_without_projection_target_keeps_history_untouched(migration_repository: MongoRunRepository) -> None:
    adapter = OutcomeAdapter([ProviderTurnOutcome(status="completed")])
    coordinator, _ = await setup_history(migration_repository, adapter, server_history=False)
    run = await coordinator.start_run(request_turn(visible_conversation_id="conversation-example"), "test-user")
    await finish(coordinator, run)
    assert len(adapter.calls) == 1 and await rows(migration_repository) == []
    assert await asyncio.to_thread(migration_repository.provider_database.harness_history_projections.count_documents, {}) == 0


async def test_history_status_uses_durable_registration_after_catalog_changes(
    migration_repository: MongoRunRepository, settings,
) -> None:
    adapter = OutcomeAdapter([ProviderTurnOutcome(status="completed")])
    coordinator, _ = await setup_history(migration_repository, adapter)
    run = await coordinator.start_run(request_turn(visible_conversation_id="conversation-example"), "test-user")
    await finish(coordinator, run)
    app = create_app(settings=settings, repository=migration_repository, adapters=[FakeHarnessAdapter()])
    # No lifespan is needed: the fixture initialized this canonical database.
    # Closing an application lifespan would also close the fixture's client.
    client = TestClient(app)
    try:
        latest = client.get("/api/v1/runs/latest", params={"agent_id": run.agent_id, "conversation_id": run.conversation_id}, headers=auth_headers())
        assert latest.status_code == 200 and latest.headers["X-Harness-History-Owner"] == "server"
        assert latest.json()["data"]["contract_version"] == 2
        assert latest.json()["data"]["capabilities"]["history.server_owned"]["level"] == "emulated"
        events = client.get(f"/api/v1/runs/{run.run_id}/events", headers=auth_headers())
        assert events.json()["history"] == latest.json()["history"]
        assert events.headers["X-Harness-Assistant-Message-ID"] == f"message-{run.run_id}"
        await asyncio.to_thread(migration_repository.provider_database.harness_history_projections.delete_many, {})
        unregistered = client.get("/api/v1/runs/latest", params={"agent_id": run.agent_id, "conversation_id": run.conversation_id}, headers=auth_headers())
        assert "history" not in unregistered.json() and "X-Harness-History-Owner" not in unregistered.headers
    finally:
        client.close()


async def test_deletion_during_registration_does_not_restore_message_rows(
    migration_repository: MongoRunRepository, monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = OutcomeAdapter([ProviderTurnOutcome(status="completed")])
    coordinator, _ = await setup_history(migration_repository, adapter)
    db = migration_repository.provider_database
    collection_type = type(db.messages)
    original = collection_type.update_one
    deleted = False

    def concurrent_delete(collection: Any, query: dict[str, Any], update: dict[str, Any], **kwargs: Any) -> Any:
        nonlocal deleted
        if collection.full_name == f"{db.name}.messages" and update.get("$setOnInsert", {}).get("role") == "assistant" and not deleted:
            deleted = True
            db.harness_deleted_contexts.insert_one({"_id": "conversation-example"})
            db.messages.delete_many({"conversation_id": "conversation-example"})
            db.conversations.delete_one({"_id": "conversation-example"})
        return original(collection, query, update, **kwargs)

    monkeypatch.setattr(collection_type, "update_one", concurrent_delete)
    with pytest.raises(RunAdmissionConflict, match="history"):
        await coordinator.start_run(request_turn(visible_conversation_id="conversation-example"), "test-user")
    await coordinator.shutdown()
    assert deleted and adapter.calls == [] and await rows(migration_repository) == []
    projection = await asyncio.to_thread(db.harness_history_projections.find_one, {})
    assert projection["state"] == "abandoned" and "input" not in projection


@pytest.mark.parametrize("status", ["cancelled", "interrupted"])
async def test_partial_final_history_preserves_explicit_noncompletion(
    migration_repository: MongoRunRepository, status: str,
) -> None:
    adapter = OutcomeAdapter([
        CanonicalEventDraft(event_type="content.delta", data={"text": "Partial answer"}), ProviderTurnOutcome(status=status),
    ])
    coordinator, _ = await setup_history(migration_repository, adapter)
    run = await coordinator.start_run(request_turn(visible_conversation_id="conversation-example"), "test-user")
    await finish(coordinator, run)
    assistant = (await rows(migration_repository))[1]
    assert assistant["content"] == "Partial answer"
    assert assistant["metadata"]["is_final"] is True and assistant["metadata"]["turn_status"] == status
    assert assistant["metadata"]["is_interrupted"] is True


def test_accepted_response_exposes_server_owned_message_identity(settings) -> None:
    class Projector:
        async def admitted(self, run, request) -> None:
            return None

        async def finalized(self, run) -> None:
            return None

    adapter = OutcomeAdapter([ProviderTurnOutcome(status="completed")], server_history=True)
    app = create_app(settings=settings, adapters=[adapter], history_projector=Projector())
    with TestClient(app) as client:
        response = client.put("/api/v1/agents/agent-example", json={"blueprint": blueprint()}, headers=auth_headers())
        assert response.status_code == 200
        accepted = client.post("/api/v1/runs", json=request_turn(visible_conversation_id="conversation-example").model_dump(mode="json"), headers=auth_headers())
        assert accepted.status_code == 202
        run_id = accepted.json()["data"]["run_id"]
        assert accepted.headers["X-Harness-History-Owner"] == "server"
        assert accepted.headers["X-Harness-User-Message-ID"] == f"user-{run_id}"
        assert accepted.headers["X-Harness-Assistant-Message-ID"] == f"message-{run_id}"
        assert accepted.json()["history"] == {"owner": "server", "user_message_id": f"user-{run_id}", "assistant_message_id": f"message-{run_id}"}
