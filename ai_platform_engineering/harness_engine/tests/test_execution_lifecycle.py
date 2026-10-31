from __future__ import annotations

import time
from collections.abc import AsyncIterator

import mongomock
import pytest
from fastapi.testclient import TestClient

from harness_engine.adapters.deep_agents import DeepAgentsSessionManager
from harness_engine.main import create_app
from harness_engine.models import CanonicalEventDraft, CapabilityLevel, CapabilityResult, RunContext, TurnOutcome
from harness_engine.repository import MongoRunRepository
from harness_engine.sessions import ProviderSessionContext
from tests.conftest import FakeHarnessAdapter, auth_headers, blueprint


class PausingAdapter(FakeHarnessAdapter):
    async def cancel_run(self, run_id: str) -> bool:
        return True

    @property
    def descriptor(self):
        descriptor = super().descriptor
        return descriptor.model_copy(
            update={
                "contract_version": 2,
                "capabilities": {
                    **descriptor.capabilities,
                    "human_input.resume": CapabilityResult(level=CapabilityLevel.NATIVE),
                },
            }
        )

    async def execute(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | TurnOutcome]:
        self.calls.append(context)
        if context.turn.command == "start":
            yield CanonicalEventDraft(event_type="content.delta", data={"text": "Choose a value"})
            yield TurnOutcome(
                status="paused",
                interrupt={
                    "interrupt_id": "approval-example",
                    "interrupt_type": "form_input",
                    "fields": [{"field_name": "value", "required": True}],
                },
            )
        else:
            yield TurnOutcome(status="completed", result={"content": context.turn.resume_data["values"]["value"]})


def wait_for_run(client: TestClient, run_id: str) -> dict:
    for _ in range(200):
        run = client.get(f"/api/v1/runs/{run_id}", headers=auth_headers()).json()["data"]
        if run["status"] not in {"queued", "running"}:
            return run
        time.sleep(0.01)
    pytest.fail("Run did not terminate")


@pytest.mark.parametrize("durable", [False, True])
def test_pause_resume_replay_and_approval_deduplication(settings, monkeypatch, durable: bool) -> None:
    mongo = mongomock.MongoClient(tz_aware=True)
    monkeypatch.setattr("harness_engine.repository.MongoClient", lambda *args, **kwargs: mongo)
    repository = MongoRunRepository("mongodb://example.test", "example", 3600) if durable else None
    adapter = PausingAdapter()
    app = create_app(settings=settings, repository=repository, adapters=[adapter])
    with TestClient(app) as client:
        assert (
            client.put(
                "/api/v1/agents/agent-example", headers=auth_headers(), json={"blueprint": blueprint()}
            ).status_code
            == 200
        )
        started = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "Ask me",
                "turn_id": "turn-example",
                "client_request_id": "start-example",
            },
        ).json()["data"]
        assert started["turn_id"] == "turn-example"
        paused = wait_for_run(client, started["run_id"])
        assert paused["status"] == "paused"
        events = client.get(f"/api/v1/runs/{paused['run_id']}/events", headers=auth_headers()).json()["data"]["events"]
        assert events[-1]["event_type"] == "run.paused"
        assert not any(event["event_type"] == "run.completed" for event in events)
        assert (
            client.post(
                "/api/v1/runs",
                headers=auth_headers(),
                json={
                    "agent_id": "agent-example",
                    "conversation_id": "conversation-example",
                    "message": "Unrelated start",
                },
            ).status_code
            == 409
        )
        resume = {
            "agent_id": "agent-example",
            "conversation_id": "conversation-example",
            "command": "resume",
            "resumes_run_id": paused["run_id"],
            "interrupt_id": "approval-example",
            "client_request_id": "resume-example",
            "resume_data": {"type": "form_input", "values": {"value": "selected"}},
        }
        rejected = client.post(
            "/api/v1/runs", headers=auth_headers(), json={**resume, "interrupt_id": "other-interrupt"}
        )
        assert rejected.status_code == 409
        resumed = client.post("/api/v1/runs", headers=auth_headers(), json=resume).json()["data"]
        assert wait_for_run(client, resumed["run_id"])["status"] == "completed"
        replayed = client.post("/api/v1/runs", headers=auth_headers(), json=resume).json()["data"]
        assert replayed["run_id"] == resumed["run_id"]
        assert len(adapter.calls) == 2
        # A second key cannot replay a consumed approval, even after completion.
        assert (
            client.post(
                "/api/v1/runs", headers=auth_headers(), json={**resume, "client_request_id": "replayed-approval"}
            ).status_code
            == 409
        )
        assert (
            client.get(
                f"/api/v1/runs/{resumed['run_id']}",
                headers={**auth_headers(), "X-Harness-Engine-Subject": "another-user"},
            ).status_code
            == 404
        )
        assert client.get(f"/api/v1/runs/{paused['run_id']}/events/stream", headers=auth_headers()).text.endswith(
            "\n\n"
        )


@pytest.mark.asyncio
async def test_deep_agents_adopts_native_thread_and_rotates_only_after_clear() -> None:
    manager = DeepAgentsSessionManager()
    first = await manager.open(
        ProviderSessionContext("binding-example", "agent-example", 1, "legacy-thread", "existing", 0)
    )
    second = await manager.open(
        ProviderSessionContext("binding-next", "agent-example", 2, "legacy-thread", "existing", 1)
    )
    assert first.provider_session_id == "legacy-thread"
    assert second.provider_session_id != first.provider_session_id
    assert first.checkpoint_strategy == second.checkpoint_strategy == "langgraph"


def test_invalid_blueprint_returns_serializable_validation_details(settings) -> None:
    app = create_app(settings=settings, adapters=[FakeHarnessAdapter()])
    with TestClient(app) as client:
        invalid = blueprint()
        invalid["memory"] = {"enabled": True}
        response = client.put("/api/v1/agents/agent-example", headers=auth_headers(), json={"blueprint": invalid})
        assert response.status_code == 422
        assert response.json()["detail"]["issues"][0]["severity"] == "error"
