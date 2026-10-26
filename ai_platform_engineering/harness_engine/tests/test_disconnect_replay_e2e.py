from __future__ import annotations

import time

from fastapi.testclient import TestClient

from harness_engine.main import create_app
from harness_engine.repository import InMemoryRunRepository
from tests.conftest import FakeHarnessAdapter, auth_headers, blueprint


def configure_agent(client: TestClient) -> None:
    response = client.put(
        "/api/v1/agents/agent-example",
        headers=auth_headers(),
        json={"blueprint": blueprint()},
    )
    assert response.status_code == 200, response.text


def test_run_continues_without_attached_event_client_and_replays_from_cursor(settings) -> None:
    adapter = FakeHarnessAdapter(chunks=["one", "two", "three"], delay=0.02)
    repository = InMemoryRunRepository()
    app = create_app(settings=settings, repository=repository, adapters=[adapter])

    with TestClient(app) as client:
        configure_agent(client)
        started = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "keep running",
            },
        )
        assert started.status_code == 202
        run_id = started.json()["data"]["run_id"]

        # The service-owned provider task completes with no event client attached.
        time.sleep(0.15)

        first = client.get(f"/api/v1/runs/{run_id}/events?after=0", headers=auth_headers())
        assert first.status_code == 200
        first_page = first.json()["data"]
        assert first_page["run"]["status"] == "completed"
        assert [event["event_type"] for event in first_page["events"]] == [
            "run.started",
            "content.delta",
            "content.delta",
            "content.delta",
            "run.completed",
        ]
        cursor = first_page["events"][2]["sequence"]

        replay = client.get(f"/api/v1/runs/{run_id}/events?after={cursor}", headers=auth_headers()).json()["data"]
        assert [event["data"].get("text") for event in replay["events"]] == ["three", None]
        assert replay["next_cursor"] == first_page["next_cursor"]

        second = client.post(
            "/api/v1/runs",
            headers={
                **auth_headers(),
                "traceparent": "00-11111111111111111111111111111111-2222222222222222-01",
            },
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "continue the same thread",
            },
        )
        assert second.status_code == 202
        assert second.json()["data"]["binding_id"] == started.json()["data"]["binding_id"]
        assert second.json()["data"]["agent_version"] == 1


def test_run_applies_optional_cli_context_without_changing_the_saved_blueprint(settings) -> None:
    adapter = FakeHarnessAdapter(chunks=["done"])
    app = create_app(settings=settings, repository=InMemoryRunRepository(), adapters=[adapter])

    with TestClient(app) as client:
        configure_agent(client)
        started = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "inspect this repository",
                "context": "Repository: example-project\nSkill: code-review",
            },
        )
        assert started.status_code == 202, started.text

        for _ in range(50):
            if adapter.calls:
                break
            time.sleep(0.01)

        assert len(adapter.calls) == 1
        run_context = adapter.calls[0]
        assert run_context.blueprint.prompt.system == "Be helpful to {{audience}}."
        assert run_context.prompt.system == (
            "Be helpful to users.\n\n"
            "<client-system-context>\n"
            "Repository: example-project\nSkill: code-review\n"
            "</client-system-context>"
        )


def test_session_pins_agent_version_across_agent_updates(settings) -> None:
    adapter = FakeHarnessAdapter()
    app = create_app(settings=settings, repository=InMemoryRunRepository(), adapters=[adapter])
    with TestClient(app) as client:
        configure_agent(client)
        first = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "one",
            },
        )
        updated = blueprint()
        updated["description"] = "Second immutable version"
        saved = client.put(
            "/api/v1/agents/agent-example",
            headers=auth_headers(),
            json={"blueprint": updated, "expected_revision": 1},
        )
        assert saved.json()["data"]["version"]["version"] == 2
        continued = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "two",
            },
        )
        assert first.json()["data"]["agent_version"] == 1
        assert continued.json()["data"]["agent_version"] == 1

        cleared = client.post(
            "/api/v1/sessions/clear",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
            },
        )
        assert cleared.status_code == 200
        assert cleared.json()["data"]["cleared"] is True
        assert cleared.json()["data"]["next_epoch"] == 1

        fresh = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "three",
            },
        )
        assert fresh.status_code == 202
        assert fresh.json()["data"]["agent_version"] == 2
        assert fresh.json()["data"]["binding_id"] != first.json()["data"]["binding_id"]
        assert fresh.json()["data"]["provider_session_id"] != (first.json()["data"]["provider_session_id"])


def test_session_clear_is_scoped_to_the_authenticated_owner(settings) -> None:
    app = create_app(
        settings=settings,
        repository=InMemoryRunRepository(),
        adapters=[FakeHarnessAdapter()],
    )
    with TestClient(app) as client:
        configure_agent(client)
        started = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "one",
            },
        )
        clear_other = client.post(
            "/api/v1/sessions/clear",
            headers=auth_headers("different-user"),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
            },
        )
        assert clear_other.status_code == 200
        assert clear_other.json()["data"]["cleared"] is False

        continued = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "two",
            },
        )
        assert continued.json()["data"]["binding_id"] == started.json()["data"]["binding_id"]


def test_session_clear_cancels_an_active_run(settings) -> None:
    app = create_app(
        settings=settings,
        repository=InMemoryRunRepository(),
        adapters=[FakeHarnessAdapter(chunks=["late"], delay=0.2)],
    )
    with TestClient(app) as client:
        configure_agent(client)
        started = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "one",
            },
        )
        run_id = started.json()["data"]["run_id"]

        cleared = client.post(
            "/api/v1/sessions/clear",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
            },
        )
        events = client.get(f"/api/v1/runs/{run_id}/events", headers=auth_headers()).json()["data"]

        assert cleared.json()["data"]["cleared"] is True
        assert events["run"]["status"] == "cancelled"
        assert events["events"][-1]["event_type"] == "run.cancelled"


def test_cancel_active_preserves_the_session_binding(settings) -> None:
    app = create_app(
        settings=settings,
        repository=InMemoryRunRepository(),
        adapters=[FakeHarnessAdapter(chunks=["late"], delay=0.2)],
    )
    with TestClient(app) as client:
        configure_agent(client)
        started = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "one",
            },
        )
        cancelled = client.post(
            "/api/v1/runs/cancel-active",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
            },
        )
        continued = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "two",
            },
        )

        assert cancelled.status_code == 200
        assert cancelled.json()["data"] == {
            "cancelled": True,
            "cancellation_requested": True,
            "run_id": started.json()["data"]["run_id"],
        }
        assert continued.json()["data"]["binding_id"] == started.json()["data"]["binding_id"]


def test_run_is_hidden_from_other_subjects(settings) -> None:
    app = create_app(
        settings=settings,
        repository=InMemoryRunRepository(),
        adapters=[FakeHarnessAdapter()],
    )
    with TestClient(app) as client:
        configure_agent(client)
        run_id = client.post(
            "/api/v1/runs",
            headers=auth_headers(),
            json={
                "agent_id": "agent-example",
                "conversation_id": "conversation-example",
                "message": "hello",
            },
        ).json()["data"]["run_id"]
        response = client.get(f"/api/v1/runs/{run_id}", headers=auth_headers("different-user"))
        assert response.status_code == 404


def test_service_rejects_missing_internal_credential(settings) -> None:
    app = create_app(
        settings=settings,
        repository=InMemoryRunRepository(),
        adapters=[FakeHarnessAdapter()],
    )
    with TestClient(app) as client:
        response = client.get("/api/v1/harnesses", headers={"X-Harness-Engine-Subject": "test-user"})
        assert response.status_code == 401
