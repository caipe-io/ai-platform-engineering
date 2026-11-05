from __future__ import annotations

import time
from datetime import timedelta

import mongomock
import pytest
from fastapi.testclient import TestClient

from harness_engine.config import Settings
from harness_engine.main import create_app
from harness_engine.models import RunRecord
from harness_engine.repository import InMemoryRunRepository, MongoRunRepository
from tests.conftest import FakeHarnessAdapter, auth_headers
from tests.test_disconnect_replay_e2e import configure_agent


def reader_headers(**overrides: str) -> dict[str, str]:
    return {
        **auth_headers("viewer"),
        "X-Harness-Read-Conversation": "conversation-example",
        "X-Harness-Read-Agent": "agent-example",
        **overrides,
    }


def test_shared_subscriber_replays_completion_without_execution_access(settings: Settings) -> None:
    adapter = FakeHarnessAdapter(chunks=["first", "last"], delay=0.02)
    repository = InMemoryRunRepository()
    app = create_app(settings=settings, repository=repository, adapters=[adapter])
    with TestClient(app) as client:
        configure_agent(client)
        run = client.post("/api/v1/runs", headers=auth_headers(), json={
            "agent_id": "agent-example", "conversation_id": "conversation-example", "message": "hello",
        }).json()["data"]
        run_id = run["run_id"]
        for _ in range(100):
            if client.get(f"/api/v1/runs/{run_id}", headers=auth_headers()).json()["data"]["status"] == "completed":
                break
            time.sleep(0.01)
        else:
            pytest.fail("Run did not complete")

        # A viewer cannot supply a subject alone to cross the owner boundary.
        assert client.get(f"/api/v1/runs/{run_id}", headers=auth_headers("viewer")).status_code == 404
        for suffix in ["", "/events", "/events/stream"]:
            assert client.get(f"/api/v1/runs/{run_id}{suffix}", headers=reader_headers()).status_code == 200
            assert client.get(f"/api/v1/runs/{run_id}{suffix}", headers=reader_headers(**{
                "X-Harness-Read-Agent": "agent-other",
            })).status_code == 404
        replay = client.get(f"/api/v1/runs/{run_id}/events?after=1", headers=reader_headers()).json()["data"]
        assert replay["run"]["status"] == "completed"
        assert [event["event_type"] for event in replay["events"]] == ["content.delta", "content.delta", "run.completed"]
        lookup = client.post("/api/v1/sessions/lookup", headers=reader_headers(), json={
            "agent_id": "agent-example", "conversation_id": "conversation-example",
        }).json()["data"]
        assert lookup["last_run"]["run_id"] == run_id
        assert lookup["active_run"] is None
        assert len(adapter.calls) == 1

        # Read delegation cannot be repurposed for admission, cancellation, or session mutation.
        for path, body in [
            ("/api/v1/runs", {"agent_id": "agent-example", "conversation_id": "conversation-example", "message": "again"}),
            ("/api/v1/sessions/clear", {"agent_id": "agent-example", "conversation_id": "conversation-example"}),
        ]:
            assert client.post(path, headers=reader_headers(), json=body).status_code == 403
        assert client.delete(f"/api/v1/runs/{run_id}", headers=reader_headers()).status_code == 403
        assert client.post("/api/v1/sessions/lookup", headers=reader_headers(), json={
            "agent_id": "agent-other", "conversation_id": "conversation-example",
        }).status_code == 404
        assert client.get(f"/api/v1/runs/{run_id}", headers=reader_headers(Authorization="Bearer invalid")).status_code == 401
        assert len(repository._sessions) == 1


@pytest.mark.parametrize("backend", ["memory", "mongo"])
async def test_latest_conversation_run_is_scoped_and_includes_other_senders(backend: str, monkeypatch: pytest.MonkeyPatch) -> None:
    if backend == "mongo":
        client = mongomock.MongoClient(tz_aware=True)
        monkeypatch.setattr("harness_engine.repository.MongoClient", lambda *args, **kwargs: client)
        repository = MongoRunRepository("mongodb://example.test", "test", 3600)
    else:
        repository = InMemoryRunRepository()
    await repository.initialize()
    first = RunRecord(run_id="run-first", owner_subject="owner", agent_id="agent-example", agent_version=1,
                      conversation_id="conversation-example", binding_id="binding-owner", harness_id="agentcore", profile_id="primary")
    await repository.create_run(first)
    second = first.model_copy(update={"run_id": "run-second", "owner_subject": "other-sender", "binding_id": "binding-other",
                                      "created_at": first.created_at + timedelta(seconds=1)})
    await repository.create_run(second)
    unrelated = second.model_copy(update={"run_id": "run-private", "conversation_id": "private-conversation",
                                         "created_at": first.created_at + timedelta(seconds=2)})
    await repository.create_run(unrelated)
    latest = await repository.get_latest_conversation_run("agent-example", "conversation-example")
    assert latest and latest.run_id == second.run_id
    assert await repository.get_latest_conversation_run("agent-other", "conversation-example") is None
    await repository.close()
