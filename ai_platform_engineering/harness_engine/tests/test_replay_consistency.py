from __future__ import annotations

import asyncio
import time
from typing import Any

import mongomock
import pytest
from fastapi.testclient import TestClient

from harness_engine.main import create_app
from harness_engine.models import RunRecord, RunStatus
from harness_engine.repository import InMemoryRunRepository, MongoRunRepository, ReplayGapError
from tests.conftest import FakeHarnessAdapter, auth_headers, blueprint


@pytest.fixture
async def mongo_repository(monkeypatch: pytest.MonkeyPatch) -> MongoRunRepository:
    client = mongomock.MongoClient(tz_aware=True)
    monkeypatch.setattr("harness_engine.repository.MongoClient", lambda *args, **kwargs: client)
    repository = MongoRunRepository("mongodb://example.test", "test", 3600)
    await repository.initialize()
    await repository.create_run(
        RunRecord(
            run_id="run-example",
            owner_subject="test-user",
            agent_id="agent-example",
            agent_version=1,
            conversation_id="conversation-example",
            binding_id="binding-example",
            harness_id="agentcore",
            profile_id="primary",
        )
    )
    return repository


@pytest.mark.parametrize("inserted_before_crash", [False, True])
async def test_terminal_append_recovers_after_either_materialization_write(
    mongo_repository: MongoRunRepository, monkeypatch: pytest.MonkeyPatch, inserted_before_crash: bool
) -> None:
    collection = mongo_repository._db.harness_events
    original = collection.update_one

    def fail(*args: Any, **kwargs: Any) -> None:
        if inserted_before_crash:
            original(*args, **kwargs)
        raise RuntimeError("injected process loss")

    with monkeypatch.context() as fault:
        fault.setattr(collection, "update_one", fail)
        with pytest.raises(RuntimeError, match="injected process loss"):
            await mongo_repository.append_event("run-example", "run.completed", {}, RunStatus.COMPLETED)
    # A new repository instance uses the durable pending payload to reconcile.
    reader = MongoRunRepository("mongodb://example.test", "test", 3600)
    run = await reader.get_run("run-example")
    assert run and run.status == RunStatus.COMPLETED and run.last_sequence == 1
    events = await reader.list_events("run-example", 0)
    assert [(event.sequence, event.event_type) for event in events] == [(1, "run.completed")]
    assert await reader.list_events("run-example", 1) == []
    assert collection.count_documents({"run_id": "run-example"}) == 1
    assert "pending_event" not in reader._db.harness_runs.find_one({"run_id": "run-example"})


async def test_expired_terminal_tail_is_bounded(mongo_repository: MongoRunRepository) -> None:
    await mongo_repository.append_event("run-example", "run.completed", {}, RunStatus.COMPLETED)
    mongo_repository._db.harness_events.delete_many({"run_id": "run-example"})
    with pytest.raises(ReplayGapError):
        await mongo_repository.wait_for_events("run-example", 0, 0.01)


def test_missing_terminal_tail_returns_an_error_for_polling_and_sse(settings) -> None:
    repository = InMemoryRunRepository()
    app = create_app(settings=settings, repository=repository, adapters=[FakeHarnessAdapter()])
    with TestClient(app) as client:
        saved = client.put("/api/v1/agents/agent-example", headers=auth_headers(), json={"blueprint": blueprint()})
        assert saved.status_code == 200
        started = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "hello",
            },
        )
        run_id = started.json()["data"]["run_id"]
        for _ in range(100):
            if repository._runs[run_id].status == RunStatus.COMPLETED:
                break
            time.sleep(0.01)
        assert repository._runs[run_id].status == RunStatus.COMPLETED
        repository._events[run_id].pop()
        for suffix in ["events", "events/stream"]:
            response = client.get(f"/api/v1/runs/{run_id}/{suffix}", headers=auth_headers())
            assert response.status_code == 409
            assert response.json()["code"] == "replay_unavailable"


def test_session_lookup_uses_the_authenticated_owner_and_clear_releases_the_backend(settings) -> None:
    app = create_app(settings=settings, repository=InMemoryRunRepository(), adapters=[FakeHarnessAdapter()])
    body = {"agent_id": "agent-example", "conversation_id": "conversation-example"}
    with TestClient(app) as client:
        client.put("/api/v1/agents/agent-example", headers=auth_headers(), json={"blueprint": blueprint()})
        assert client.post("/api/v1/runs", headers=auth_headers(), json={**body, "message": "hello"}).status_code == 202
        lookup = client.post("/api/v1/sessions/lookup", headers=auth_headers(), json=body)
        assert lookup.json()["data"]["harness_id"] == "agentcore"
        other = client.post("/api/v1/sessions/lookup", headers=auth_headers("another-user"), json=body)
        assert other.json()["data"]["harness_id"] is None
        assert client.post("/api/v1/sessions/clear", headers=auth_headers(), json=body).status_code == 200
        lookup = client.post("/api/v1/sessions/lookup", headers=auth_headers(), json=body)
        assert lookup.json()["data"]["harness_id"] is None


async def test_concurrent_appends_keep_a_contiguous_replay_head(mongo_repository: MongoRunRepository) -> None:
    await asyncio.gather(
        *(mongo_repository.append_event("run-example", "content.delta", {"text": str(number)}) for number in range(16))
    )
    await mongo_repository.append_event("run-example", "run.completed", {}, RunStatus.COMPLETED)
    events = await mongo_repository.list_events("run-example", 0)
    assert [event.sequence for event in events] == list(range(1, 18))
    assert {event.data["text"] for event in events[:-1]} == {str(number) for number in range(16)}
    assert events[-1].event_type == "run.completed"
