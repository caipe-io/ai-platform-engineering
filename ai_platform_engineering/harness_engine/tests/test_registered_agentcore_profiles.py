from __future__ import annotations

from fastapi.testclient import TestClient
from pymongo.errors import PyMongoError

from harness_engine.adapters import AgentCoreAdapter
from harness_engine.config import Settings
from harness_engine.main import create_app
from harness_engine.models import RegisteredAgentCoreProfile
from harness_engine.repository import InMemoryRunRepository
from tests.conftest import FakeHarnessAdapter, auth_headers


def test_registered_profiles_refresh_across_replicas_without_replacing_targets(settings: Settings) -> None:
    repository = InMemoryRunRepository()
    first_app = create_app(settings=settings, repository=repository, adapters=[AgentCoreAdapter(settings)])
    second_app = create_app(settings=settings, repository=repository, adapters=[AgentCoreAdapter(settings)])
    profile = {
        "profile_id": "existing-example",
        "arn": "arn:aws:bedrock-agentcore:us-east-2:111122223333:runtime/example",
        "region": "us-east-2",
    }
    with TestClient(first_app) as first, TestClient(second_app) as second:
        initial = second.get("/api/v1/harnesses", headers=auth_headers())
        assert {item["id"] for item in initial.json()["data"]["harnesses"][0]["profiles"]} == {"primary"}
        assert first.post("/api/v1/admin/agentcore-connections", headers=auth_headers(), json=profile).status_code == 403
        headers = {**auth_headers(), "X-Harness-Engine-Admin": "true"}
        assert first.post("/api/v1/admin/agentcore-connections", headers=headers, json=profile).status_code == 201
        # The second replica started before the connection was registered.
        response = second.get("/api/v1/harnesses", headers=auth_headers())
        assert response.status_code == 200
        assert {item["id"] for item in response.json()["data"]["harnesses"][0]["profiles"]} == {
            "primary", "existing-example",
        }
        assert second.post("/api/v1/admin/agentcore-connections", headers=headers, json=profile).status_code == 201
        changed = {**profile, "arn": profile["arn"] + "-different"}
        assert second.post("/api/v1/admin/agentcore-connections", headers=headers, json=changed).status_code == 409


def test_storage_binding_is_checked_before_registry_refresh_and_replay_is_independent(settings: Settings) -> None:
    class UnavailableProfilesRepository(InMemoryRunRepository):
        unavailable = False
        reads = 0

        async def list_agentcore_profiles(self) -> list[RegisteredAgentCoreProfile]:
            self.reads += 1
            if self.unavailable:
                raise PyMongoError("registry unavailable")
            return await super().list_agentcore_profiles()

    repository = UnavailableProfilesRepository()
    configured = settings.model_copy(update={"storage_backend": "mongodb"})
    app = create_app(settings=configured, repository=repository, adapters=[FakeHarnessAdapter()])
    with TestClient(app) as client:
        initial_reads = repository.reads
        repository.unavailable = True
        mismatched = {**auth_headers(), "X-Harness-Engine-Storage-Binding": "0" * 64}
        response = client.get("/api/v1/harnesses", headers=mismatched)
        assert response.status_code == 503
        assert response.json()["detail"] == "Harness Engine and CAIPE must use the same canonical MongoDB"
        assert repository.reads == initial_reads

        matched = {**auth_headers(), "X-Harness-Engine-Storage-Binding": configured.storage_binding}
        response = client.get("/api/v1/harnesses", headers=matched)
        assert response.status_code == 503
        assert response.json()["detail"] == "AgentCore connections could not be loaded"
        assert repository.reads == initial_reads + 1

        # An unavailable catalog must not prevent retained run lookup/replay.
        response = client.get("/api/v1/runs/missing-run/events", headers=matched)
        assert response.status_code == 404
        assert repository.reads == initial_reads + 1
