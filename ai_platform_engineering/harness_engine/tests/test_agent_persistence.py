from __future__ import annotations

import mongomock
import pytest
from fastapi.testclient import TestClient

from harness_engine.config import Settings
from harness_engine.main import create_app
from harness_engine.repository import MongoRunRepository
from tests.conftest import FakeHarnessAdapter, auth_headers, blueprint


@pytest.mark.parametrize("expected_revision", [None, 1])
def test_existing_mongo_agent_can_be_edited_without_exposing_storage_id(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, expected_revision: int | None
) -> None:
    mongo = mongomock.MongoClient(tz_aware=True)
    monkeypatch.setattr("harness_engine.repository.MongoClient", lambda *args, **kwargs: mongo)
    repository = MongoRunRepository("mongodb://example.test", "test", 3600)
    app = create_app(settings=settings, repository=repository, adapters=[FakeHarnessAdapter()])
    original_blueprint = blueprint()

    with TestClient(app) as client:
        created = client.put(
            "/api/v1/agents/agent-example", headers=auth_headers(), json={"blueprint": original_blueprint}
        )
        assert created.status_code == 200
        original_record = client.get("/api/v1/agents/agent-example", headers=auth_headers()).json()["data"]["record"]
        assert original_record["revision"] == 1
        assert "_id" in mongo.test.harness_agents.find_one({"agent_id": "agent-example"})
        mongo.test.harness_agents.update_one({"agent_id": "agent-example"}, {"$set": {"enabled": False}})

        edited_blueprint = {**original_blueprint, "prompt": {"system": "Updated example prompt"}}
        updated = client.put(
            "/api/v1/agents/agent-example",
            headers=auth_headers(),
            json={"blueprint": edited_blueprint, "expected_revision": expected_revision},
        )
        assert updated.status_code == 200
        record = updated.json()["data"]["record"]
        assert record["revision"] == record["current_version"] == 2
        assert record["created_at"] == original_record["created_at"]
        assert record["enabled"] is False
        assert "_id" not in record
        version = updated.json()["data"]["version"]
        assert version["version"] == 2
        assert version["blueprint"]["prompt"]["system"] == "Updated example prompt"
        assert "_id" not in version

        loaded = client.get("/api/v1/agents/agent-example", headers=auth_headers())
        assert loaded.status_code == 200
        assert loaded.json()["data"]["record"]["revision"] == 2
        assert loaded.json()["data"]["version"]["blueprint"] == version["blueprint"]
        historical = mongo.test.harness_agent_versions.find_one({"agent_id": "agent-example", "version": 1})
        assert historical["blueprint"]["prompt"]["system"] == original_blueprint["prompt"]["system"]

        stale = client.put(
            "/api/v1/agents/agent-example",
            headers=auth_headers(),
            json={"blueprint": original_blueprint, "expected_revision": 1},
        )
        assert stale.status_code == 409
        assert mongo.test.harness_agent_versions.count_documents({"agent_id": "agent-example"}) == 2
        assert client.get("/api/v1/agents/agent-example", headers=auth_headers()).json() == loaded.json()
