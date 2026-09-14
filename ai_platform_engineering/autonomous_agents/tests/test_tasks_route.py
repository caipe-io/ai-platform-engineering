"""Tests for ``autonomous_agents.routes.tasks``.

Covers CRUD endpoints (via FastAPI ``TestClient``), the run-history
endpoints (called as plain awaitables), and the dynamic-agent
routing branch in ``_run_preflight_and_persist`` and
``_serialize_task``. Production persistence is MongoDB-only;
in-file fakes satisfy the ``TaskStore`` / ``RunStore`` Protocols so
failures point at the router rather than at Mongo semantics.
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone
from typing import cast
from unittest.mock import AsyncMock, patch

import pytest
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from autonomous_agents.models import (
    Acknowledgement,
    CronTrigger,
    TaskDefinition,
    TaskRun,
    TaskStatus,
    WebhookTrigger,
)
from autonomous_agents.routes import tasks as tasks_route
from autonomous_agents.routes.tasks import (
    _MAX_TASK_RUNS,
    _serialize_task,
    get_task_runs,
    list_all_runs,
)
from autonomous_agents.services import task_lifecycle, webhook_runtime
from autonomous_agents.services.chat_history import conversation_id_for_task
from autonomous_agents.services.mongo import (
    TaskAlreadyExistsError,
    TaskNotFoundError,
    TaskStore,
)
from autonomous_agents.services.scheduler import get_scheduler
from autonomous_agents.services.task_lifecycle import (
    _run_preflight_and_persist,
    set_task_store,
)


class _DictTaskStore:
    """In-file ``TaskStore`` Protocol fake backed by a plain dict."""

    def __init__(self) -> None:
        self._tasks: dict[str, TaskDefinition] = {}

    async def list_all(self) -> list[TaskDefinition]:
        return list(self._tasks.values())

    async def list_by_owner(self, owner_id: str) -> list[TaskDefinition]:
        return [t for t in self._tasks.values() if t.owner_id == owner_id]

    async def get(self, task_id: str) -> TaskDefinition | None:
        return self._tasks.get(task_id)

    async def create(self, task: TaskDefinition) -> TaskDefinition:
        if task.id in self._tasks:
            raise TaskAlreadyExistsError(task.id)
        self._tasks[task.id] = task
        return task

    async def update(
        self, task_id: str, task: TaskDefinition
    ) -> TaskDefinition:
        if task_id not in self._tasks:
            raise TaskNotFoundError(task_id)
        self._tasks[task_id] = task
        return task

    async def delete(self, task_id: str) -> None:
        if task_id not in self._tasks:
            raise TaskNotFoundError(task_id)
        del self._tasks[task_id]


class _RecordingStore:
    """RunStore stub that captures each ``limit`` it was invoked with."""

    def __init__(self, runs: list[TaskRun] | None = None) -> None:
        self._runs = runs or []
        self.list_by_task_calls: list[tuple[str, int]] = []
        self.list_all_calls: list[int] = []

    async def record(self, run: TaskRun) -> None:  # pragma: no cover -- unused
        self._runs.append(run)

    async def list_by_task(self, task_id: str, limit: int = 100) -> list[TaskRun]:
        self.list_by_task_calls.append((task_id, limit))
        matching = [r for r in self._runs if r.task_id == task_id]
        return matching[:limit]

    async def list_all(self, limit: int = 500) -> list[TaskRun]:
        self.list_all_calls.append(limit)
        return self._runs[:limit]


def _make_run(
    run_id: str,
    task_id: str = "t1",
    owner_id: str | None = None,
    conversation_id: str | None = None,
) -> TaskRun:
    return TaskRun(
        run_id=run_id,
        task_id=task_id,
        task_name=f"task {task_id}",
        status=TaskStatus.SUCCESS,
        started_at=datetime.now(timezone.utc),
        owner_id=owner_id,
        conversation_id=conversation_id,
    )


def _fake_request(headers: dict[str, str] | None = None) -> Request:
    """Build a minimal Starlette ``Request`` for direct route-function calls.

    The run-history handlers read caller identity from
    ``X-Authenticated-User-*`` headers via ``_get_caller``; tests that
    invoke them as plain awaitables (rather than through ``TestClient``)
    need a request object carrying those headers.
    """
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "query_string": b"",
            "headers": raw,
        }
    )


def _make_task(task_id: str = "t1") -> TaskDefinition:
    return TaskDefinition(
        id=task_id,
        name=f"task {task_id}",
        dynamic_agent_id="agent-x",
        prompt="x",
        trigger=CronTrigger(schedule="0 9 * * *"),
    )


def _cron_task(task_id: str = "t1", *, enabled: bool = True) -> dict:
    return {
        "id": task_id,
        "name": f"Task {task_id}",
        "dynamic_agent_id": "agent-x",
        "prompt": "do the thing",
        "trigger": {"type": "cron", "schedule": "0 9 * * *"},
        "enabled": enabled,
    }


def _interval_task(task_id: str = "t1", *, seconds: int = 30) -> dict:
    return {
        "id": task_id,
        "name": f"Task {task_id}",
        "dynamic_agent_id": "agent-x",
        "prompt": "do the thing",
        "trigger": {"type": "interval", "seconds": seconds},
        "enabled": True,
    }


def _webhook_task(
    task_id: str = "hook1",
    *,
    secret: str | None = None,
    provider: str = "github",
) -> dict:
    payload = {
        "id": task_id,
        "name": f"Webhook {task_id}",
        "dynamic_agent_id": "agent-x",
        "prompt": "respond",
        "trigger": {"type": "webhook", "provider": provider},
        "enabled": True,
    }
    if secret is not None:
        payload["trigger"]["secret"] = secret
    return payload


def _create_task(
    client: TestClient, payload: dict, headers: dict | None = None
) -> str:
    """POST a task and return the id the SERVER assigned.

    Tests must never assume the posted id survives: ids are server-generated
    (spec 2026-07-29) and the ``id`` key in the payload helpers is ignored.
    """
    response = client.post("/api/v1/tasks", json=payload, headers=headers or {})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _ok_ack() -> Acknowledgement:
    return Acknowledgement(
        ack_status="ok",
        ack_detail="Dynamic agent reachable.",
        routed_to="agent-x",
        tools=[],
        available_agents=[],
        credentials_status={},
        dry_run_summary="Will route to dynamic agent 'My Agent'.",
        ack_at=datetime.now(timezone.utc),
    )


@pytest.fixture(autouse=True)
def _reset_router_state():
    """Reset module-level singletons between tests so state doesn't bleed."""
    yield
    # Reach into ``task_lifecycle`` because it owns the TaskStore
    # singleton used by the route handlers.
    task_lifecycle._task_store = None


@pytest.fixture
def _swap_run_store(monkeypatch):
    """Patch ``get_run_store`` for the route module without touching scheduler globals."""

    def _apply(store):
        monkeypatch.setattr(tasks_route, "get_run_store", lambda: store)
        return store

    return _apply


async def _seed_tasks(tasks: list[TaskDefinition]) -> None:
    """Replace the router's TaskStore with a fresh fake pre-populated with ``tasks``."""
    store = _DictTaskStore()
    for t in tasks:
        await store.create(t)
    set_task_store(store)


@pytest.fixture
def client():
    """FastAPI app with only the /tasks router and an in-file fake store + paused BackgroundScheduler."""
    import autonomous_agents.services.scheduler as scheduler_mod

    scheduler_mod._scheduler = BackgroundScheduler(timezone="UTC")
    scheduler_mod._scheduler.start(paused=True)
    scheduler_mod._run_store = None
    # Install the in-file fake via the public accessor. The singleton
    # lives on ``task_lifecycle`` after PR3; calling ``set_task_store``
    # (rather than reassigning ``tasks_route._task_store``) goes through
    # the owning module and avoids the same stale-binding hazard
    # documented in ``_reset_router_state``.
    set_task_store(_DictTaskStore())
    # ``.clear()`` (not reassignment) preserves any references held by
    # route modules while emptying the service-owned registry.
    webhook_runtime._webhook_tasks.clear()

    app = FastAPI()
    app.include_router(tasks_route.router, prefix="/api/v1")

    with TestClient(app) as tc:
        yield tc

    if scheduler_mod._scheduler is not None and scheduler_mod._scheduler.running:
        scheduler_mod._scheduler.shutdown(wait=False)
    scheduler_mod._scheduler = None
    # Same module-ownership rationale as ``_reset_router_state``.
    task_lifecycle._task_store = None
    webhook_runtime._webhook_tasks.clear()


class TestListAndGet:
    """``GET /tasks`` and ``GET /tasks/{id}``."""

    def test_settings_exposes_schedule_frequency_floor(self, client: TestClient):
        response = client.get("/api/v1/settings")

        assert response.status_code == 200
        assert response.json() == {"minimum_schedule_interval_seconds": 1800}

    def test_list_tasks_initially_empty(self, client: TestClient):
        """Empty store returns an empty list."""
        response = client.get("/api/v1/tasks")
        assert response.status_code == 200
        assert response.json() == []

    def test_get_task_404_for_unknown_id(self, client: TestClient):
        """Unknown id returns 404."""
        response = client.get("/api/v1/tasks/ghost")
        assert response.status_code == 404


class TestCreate:
    """``POST /tasks`` validation, persistence, and runtime side effects."""

    def test_returns_201_and_serialized_payload(self, client: TestClient):
        """201 + serialized payload includes every field the UI edit dialog needs."""
        response = client.post("/api/v1/tasks", json=_cron_task("cron-1"))

        assert response.status_code == 201
        body = response.json()
        assert body["id"]  # server-generated; shape is asserted in TestTaskIdGeneration
        assert body["name"] == "Task cron-1"
        assert body["trigger"]["type"] == "cron"
        assert body["enabled"] is True
        for required in ("agent", "prompt", "llm_provider"):
            assert required in body
        assert "timeout_seconds" not in body
        assert "max_retries" not in body

    def test_registers_with_scheduler(self, client: TestClient):
        """A freshly-created cron task lands as an APScheduler job."""
        tid = _create_task(client, _cron_task("cron-1"))

        job_ids = [j.id for j in get_scheduler().get_jobs()]
        assert job_ids == [tid]

    def test_with_webhook_trigger_registers_in_webhook_table(self, client: TestClient):
        """Webhook tasks land in the webhook registry, not in APScheduler."""
        tid = _create_task(client, _webhook_task("hook1"))

        assert tid in webhook_runtime._webhook_tasks
        assert get_scheduler().get_jobs() == []

    def test_with_disabled_flag_skips_scheduler(self, client: TestClient):
        """Disabled tasks persist but are not scheduled."""
        tid = _create_task(client, _cron_task("dis-1", enabled=False))
        assert get_scheduler().get_jobs() == []
        listed = client.get("/api/v1/tasks").json()
        assert [t["id"] for t in listed] == [tid]

    def test_ignores_a_client_supplied_id(self, client: TestClient):
        """The server owns the id; a body id is discarded."""
        # _cron_task("please-use-me") posts id="please-use-me" and
        # name="Task please-use-me", so the generated id derives from the NAME.
        tid = _create_task(client, _cron_task("please-use-me"))
        assert tid != "please-use-me"
        assert tid.startswith("task-please-use-me-")
        assert client.get("/api/v1/tasks/please-use-me").status_code == 404

    def test_generated_id_derives_from_the_name(self, client: TestClient):
        payload = {**_cron_task("ignored"), "name": "Daily Incident Summary"}
        tid = _create_task(client, payload)
        assert re.match(r"^daily-incident-summary-[0-9a-f]{4}$", tid)

    def test_two_users_can_create_the_same_name(self, client: TestClient):
        """The regression this change exists for: no 409, two distinct ids."""
        payload = {**_cron_task("x"), "name": "Daily report"}
        first = _create_task(client, payload)
        second = _create_task(client, payload)
        assert first != second
        listed = client.get("/api/v1/tasks").json()
        assert len(listed) == 2

    def test_non_ascii_name_falls_back_to_the_task_prefix(self, client: TestClient):
        payload = {**_cron_task("x"), "name": "日次レポート"}
        tid = _create_task(client, payload)
        assert re.match(r"^task-[0-9a-f]{4}$", tid)

    def test_retries_on_id_collision(self, client: TestClient, monkeypatch):
        """A collision retries with a fresh id -- it must never surface as 409."""
        import autonomous_agents.routes.tasks as tasks_route

        first = _create_task(client, {**_cron_task("x"), "name": "Report"})
        # Force the next generation to collide once, then succeed.
        ids = iter([first, "report-beef"])
        monkeypatch.setattr(tasks_route, "generate_task_id", lambda name: next(ids))

        second = _create_task(client, {**_cron_task("x"), "name": "Report"})
        assert second == "report-beef"

    def test_returns_422_for_unknown_trigger_type(self, client: TestClient):
        """Discriminated-union validation rejects unknown trigger types at the edge."""
        bad = _cron_task("t1")
        bad["trigger"] = {"type": "smoke-signal"}
        response = client.post("/api/v1/tasks", json=bad)
        assert response.status_code == 422

    def test_returns_422_for_missing_required_field(self, client: TestClient):
        """Missing ``prompt`` returns 422."""
        bad = _cron_task("t1")
        del bad["prompt"]
        response = client.post("/api/v1/tasks", json=bad)
        assert response.status_code == 422

    def test_requires_dynamic_agent_id(self, client: TestClient):
        """Creating a task without ``dynamic_agent_id`` is rejected with 400.

        Every autonomous task must target a dynamic agent (the dynamic-agents
        runtime is the only execution backend), so a definition without one
        can never run and is refused at creation.
        """
        body = _cron_task("t-no-agent")
        del body["dynamic_agent_id"]
        response = client.post("/api/v1/tasks", json=body)
        assert response.status_code == 400
        assert "dynamic_agent_id is required" in response.json()["detail"]

    def test_rolls_back_when_scheduler_sync_fails(self, client: TestClient):
        """Malformed cron expression rolls back the persisted row so retry works."""
        bad = _cron_task("bad-cron")
        bad["trigger"]["schedule"] = "this is not a cron expression"

        response = client.post("/api/v1/tasks", json=bad)
        assert response.status_code == 400
        assert "could not be scheduled" in response.json()["detail"]

        listed = client.get("/api/v1/tasks").json()
        assert listed == []
        assert get_scheduler().get_jobs() == []

        fixed = _cron_task("bad-cron")
        retry = client.post("/api/v1/tasks", json=fixed)
        assert retry.status_code == 201, "rollback must clear the way for retry"

    @pytest.mark.parametrize(
        "trigger",
        [
            {"type": "cron", "schedule": "*/5 * * * *"},
            {"type": "interval", "minutes": 29},
        ],
    )
    def test_rejects_schedules_faster_than_configured_minimum(
        self, client: TestClient, trigger: dict
    ):
        payload = _cron_task("too-fast")
        payload["trigger"] = trigger

        response = client.post("/api/v1/tasks", json=payload)

        assert response.status_code == 400
        assert "configured minimum" in response.json()["detail"]
        assert client.get("/api/v1/tasks").json() == []


class TestUpdate:
    """``PUT /tasks/{id}`` re-syncs the scheduler / webhook registry."""

    def test_replaces_definition_and_re_syncs_scheduler(self, client: TestClient):
        """PUT swaps both the persisted definition and the live trigger spec."""
        tid = _create_task(client, _cron_task("t1"))

        updated_payload = _cron_task("t1")
        updated_payload["name"] = "Task renamed"
        updated_payload["trigger"]["schedule"] = "0 18 * * *"
        response = client.put(f"/api/v1/tasks/{tid}", json=updated_payload)

        assert response.status_code == 200
        assert response.json()["name"] == "Task renamed"
        job = get_scheduler().get_job(tid)
        assert job is not None
        assert "hour='18'" in str(job.trigger)

    def test_rejects_malformed_cron_update_without_persisting(self, client: TestClient):
        """PUT validates runtime trigger fields before replacing the stored row."""
        tid = _create_task(client, _cron_task("t1"))

        bad_payload = _cron_task("t1")
        bad_payload["name"] = "Bad cron"
        bad_payload["trigger"]["schedule"] = "not a cron expression"
        response = client.put(f"/api/v1/tasks/{tid}", json=bad_payload)

        assert response.status_code == 400
        persisted = client.get(f"/api/v1/tasks/{tid}").json()
        assert persisted["name"] == "Task t1"
        assert persisted["trigger"]["schedule"] == "0 9 * * *"
        job = get_scheduler().get_job(tid)
        assert job is not None
        assert "hour='9'" in str(job.trigger)

    def test_swap_from_cron_to_webhook_detaches_old_runtime(self, client: TestClient):
        """Cron => webhook swap removes the prior APScheduler job."""
        tid = _create_task(client, _cron_task("t1"))
        assert [j.id for j in get_scheduler().get_jobs()] == [tid]

        swap = _webhook_task("t1")
        response = client.put(f"/api/v1/tasks/{tid}", json=swap)
        assert response.status_code == 200

        assert get_scheduler().get_jobs() == []
        assert tid in webhook_runtime._webhook_tasks

    def test_swap_from_webhook_to_cron_detaches_webhook(self, client: TestClient):
        """Webhook => cron swap removes the prior webhook registration."""
        tid = _create_task(client, _webhook_task("t1"))
        assert tid in webhook_runtime._webhook_tasks

        swap = _cron_task("t1")
        response = client.put(f"/api/v1/tasks/{tid}", json=swap)
        assert response.status_code == 200

        assert tid not in webhook_runtime._webhook_tasks
        assert [j.id for j in get_scheduler().get_jobs()] == [tid]

    def test_404_for_unknown_id(self, client: TestClient):
        """PUT on unknown id returns 404."""
        response = client.put("/api/v1/tasks/ghost", json=_cron_task("ghost"))
        assert response.status_code == 404

    def test_coerces_id_to_path(self, client: TestClient):
        """Path id wins over body id."""
        tid = _create_task(client, _cron_task("t1"))

        body = _cron_task("t1")
        body["id"] = "different"
        response = client.put(f"/api/v1/tasks/{tid}", json=body)
        assert response.status_code == 200
        assert response.json()["id"] == tid

        listed = client.get("/api/v1/tasks").json()
        assert [t["id"] for t in listed] == [tid]

    def test_disable_removes_scheduler_job(self, client: TestClient):
        """Toggling enabled=true => false pulls the APScheduler entry."""
        tid = _create_task(client, _cron_task("t1"))
        assert [j.id for j in get_scheduler().get_jobs()] == [tid]

        disabled = _cron_task("t1", enabled=False)
        response = client.put(f"/api/v1/tasks/{tid}", json=disabled)
        assert response.status_code == 200

        assert get_scheduler().get_job(tid) is None
        listed = client.get("/api/v1/tasks").json()
        assert [t["id"] for t in listed] == [tid]
        assert listed[0]["enabled"] is False

    def test_re_enable_re_attaches_scheduler_job(self, client: TestClient):
        """Toggling enabled=false => true re-creates the APScheduler job."""
        tid = _create_task(client, _cron_task("t1"))
        client.put(f"/api/v1/tasks/{tid}", json=_cron_task("t1", enabled=False))
        assert get_scheduler().get_job(tid) is None

        response = client.put(f"/api/v1/tasks/{tid}", json=_cron_task("t1", enabled=True))
        assert response.status_code == 200
        assert [j.id for j in get_scheduler().get_jobs()] == [tid]


class TestWebhookSecretRedaction:
    """The HMAC ``secret`` is redacted on every read path."""

    def test_create_response_returns_server_generated_secret_once(
        self, client: TestClient, monkeypatch
    ):
        """POST ignores client credentials and returns its generated key once."""
        monkeypatch.setattr(
            tasks_route, "_generate_webhook_secret", lambda: "server-generated-secret"
        )
        response = client.post(
            "/api/v1/tasks", json=_webhook_task("hook1", secret="super-secret")
        )
        assert response.status_code == 201
        trigger = response.json()["trigger"]
        assert "secret" not in trigger
        assert trigger["has_secret"] is True
        assert response.json()["webhook_setup"] == {
            "secret": "server-generated-secret"
        }

        stored = task_lifecycle._task_store
        assert stored is not None
        task = asyncio.run(stored.get(response.json()["id"]))
        assert task is not None
        assert task.trigger.secret == "server-generated-secret"

    def test_list_and_get_never_echo_secret(self, client: TestClient):
        """List and get both redact the secret on every webhook task."""
        tid = _create_task(client, _webhook_task("hook1", secret="s"))

        listed = client.get("/api/v1/tasks").json()
        assert "webhook_setup" not in listed[0]
        assert "secret" not in listed[0]["trigger"]
        assert listed[0]["trigger"]["has_secret"] is True

        fetched = client.get(f"/api/v1/tasks/{tid}").json()
        assert "webhook_setup" not in fetched
        assert "secret" not in fetched["trigger"]
        assert fetched["trigger"]["has_secret"] is True

    def test_create_without_secret_still_generates_one(self, client: TestClient):
        """Webhook creation can never produce an unsigned task."""
        tid = _create_task(client, _webhook_task("hook1"))
        fetched = client.get(f"/api/v1/tasks/{tid}").json()
        assert fetched["trigger"]["has_secret"] is True

    @pytest.mark.parametrize("provider", ["slack", "pagerduty"])
    def test_provider_issued_secret_is_not_exposed(
        self, client: TestClient, provider: str
    ):
        """Slack/PagerDuty get a temporary key, never a misleading copy value."""
        response = client.post(
            "/api/v1/tasks", json=_webhook_task("hook1", provider=provider)
        )
        assert response.status_code == 201
        assert response.json()["trigger"]["has_secret"] is True
        assert response.json()["webhook_setup"] == {}


class TestWebhookSecretPreservationOnPut:
    """A PUT with no secret means ``keep what's there``, not ``wipe``."""

    def test_preserves_existing_secret_when_omitted(
        self, client: TestClient, monkeypatch
    ):
        """PUT with secret omitted preserves the stored secret."""
        monkeypatch.setattr(
            tasks_route, "_generate_webhook_secret", lambda: "original-secret"
        )
        tid = _create_task(client, _webhook_task("hook1", secret="original-secret"))

        update = _webhook_task("hook1")
        response = client.put(f"/api/v1/tasks/{tid}", json=update)
        assert response.status_code == 200
        assert response.json()["trigger"]["has_secret"] is True

        # ``get_task_store()`` raises on None; reading the owning module's
        # underscore singleton directly preserves the typing guard below.
        stored = task_lifecycle._task_store
        assert stored is not None

        task = asyncio.run(stored.get(tid))
        assert task is not None
        assert task.trigger.secret == "original-secret"

    def test_can_explicitly_replace_secret(self, client: TestClient):
        """PUT with a new secret value rotates the stored secret."""
        tid = _create_task(client, _webhook_task("hook1", secret="old"))

        update = _webhook_task("hook1", secret="new-secret")
        response = client.put(f"/api/v1/tasks/{tid}", json=update)
        assert response.status_code == 200

        # Same module-ownership rationale as the sibling test above.
        stored = task_lifecycle._task_store
        assert stored is not None

        task = asyncio.run(stored.get(tid))
        assert task is not None
        assert task.trigger.secret == "new-secret"

    def test_switch_to_webhook_generates_and_returns_secret_once(
        self, client: TestClient, monkeypatch
    ):
        """A cron -> webhook edit cannot leave an unsigned endpoint."""
        tid = _create_task(client, _cron_task("t1"))
        monkeypatch.setattr(
            tasks_route, "_generate_webhook_secret", lambda: "transition-secret"
        )

        response = client.put(f"/api/v1/tasks/{tid}", json=_webhook_task("t1"))

        assert response.status_code == 200
        assert response.json()["webhook_setup"] == {"secret": "transition-secret"}
        fetched = client.get(f"/api/v1/tasks/{tid}").json()
        assert fetched["trigger"]["has_secret"] is True
        assert "webhook_setup" not in fetched

    def test_switch_to_provider_issued_secret_returns_setup_marker(
        self, client: TestClient
    ):
        """Slack/PagerDuty transition continues into provider-secret setup."""
        tid = _create_task(client, _cron_task("t1"))

        response = client.put(
            f"/api/v1/tasks/{tid}",
            json=_webhook_task("t1", provider="pagerduty"),
        )

        assert response.status_code == 200
        assert response.json()["webhook_setup"] == {}


class TestDelete:
    """``DELETE /tasks/{id}`` removes the task from store and runtime registries."""

    def test_removes_from_store_and_scheduler(self, client: TestClient):
        """DELETE removes both store and APScheduler entries."""
        tid = _create_task(client, _cron_task("t1"))

        response = client.delete(f"/api/v1/tasks/{tid}")
        assert response.status_code == 204

        assert client.get("/api/v1/tasks").json() == []
        assert get_scheduler().get_jobs() == []

    def test_removes_webhook_registration(self, client: TestClient):
        """DELETE removes the webhook registry entry."""
        tid = _create_task(client, _webhook_task("hook1"))
        assert tid in webhook_runtime._webhook_tasks

        response = client.delete(f"/api/v1/tasks/{tid}")
        assert response.status_code == 204
        assert tid not in webhook_runtime._webhook_tasks

    def test_404_for_unknown_id(self, client: TestClient):
        """DELETE on unknown id returns 404."""
        response = client.delete("/api/v1/tasks/ghost")
        assert response.status_code == 404

    def test_round_trip_create_get_update_delete(self, client: TestClient):
        """Sanity smoke covering the full UI flow in one shot."""
        tid = _create_task(client, _interval_task("t1", seconds=1800))

        got = client.get(f"/api/v1/tasks/{tid}")
        assert got.status_code == 200
        assert got.json()["trigger"]["seconds"] == 1800

        updated_payload = _interval_task("t1", seconds=3600)
        updated = client.put(f"/api/v1/tasks/{tid}", json=updated_payload)
        assert updated.status_code == 200
        assert updated.json()["trigger"]["seconds"] == 3600

        deleted = client.delete(f"/api/v1/tasks/{tid}")
        assert deleted.status_code == 204

        assert client.get(f"/api/v1/tasks/{tid}").status_code == 404


class TestRunHistory:
    """``GET /tasks/{id}/runs`` and ``GET /runs`` pass the right ``limit`` to the RunStore."""

    async def test_get_task_runs_passes_max_task_runs_limit(self, _swap_run_store):
        """Router passes an explicit ``_MAX_TASK_RUNS`` limit, not the protocol default."""
        store = _swap_run_store(_RecordingStore([_make_run(f"r{i}") for i in range(120)]))
        await _seed_tasks([_make_task("t1")])

        runs = await get_task_runs("t1", _fake_request())

        assert store.list_by_task_calls == [("t1", _MAX_TASK_RUNS)]
        assert _MAX_TASK_RUNS >= 500, "raise this guard if the cap shrinks"
        assert len(runs) == 120

    async def test_get_task_runs_404_when_unknown_task_and_no_history(self, _swap_run_store):
        """Unknown task with no history returns 404."""
        from fastapi import HTTPException

        _swap_run_store(_RecordingStore())
        await _seed_tasks([])

        with pytest.raises(HTTPException) as exc:
            await get_task_runs("ghost", _fake_request())
        assert exc.value.status_code == 404

    async def test_get_task_runs_returns_history_for_removed_tasks(self, _swap_run_store):
        """A task removed from the store still surfaces its historical runs."""
        store = _swap_run_store(_RecordingStore([_make_run("old", task_id="removed")]))
        await _seed_tasks([])

        runs = await get_task_runs("removed", _fake_request())

        assert len(runs) == 1
        assert store.list_by_task_calls == [("removed", _MAX_TASK_RUNS)]

    async def test_list_all_runs_uses_default_limit(self, _swap_run_store):
        """``/runs`` relies on the RunStore protocol default of 500."""
        store = _swap_run_store(_RecordingStore([_make_run("r1")]))
        await _seed_tasks([])

        runs = await list_all_runs(_fake_request())

        assert len(runs) == 1
        assert store.list_all_calls == [500]

    async def test_run_history_hides_stale_chat_links_when_publishing_is_disabled(
        self, _swap_run_store
    ):
        """Previously stored ids must not keep rendering broken chat links."""
        stored = _make_run("r1", conversation_id="11111111-1111-1111-1111-111111111111")
        _swap_run_store(_RecordingStore([stored]))
        await _seed_tasks([_make_task("t1")])

        with patch.object(
            tasks_route, "task_chat_history_publishing_enabled", return_value=False
        ):
            runs = await get_task_runs("t1", _fake_request())

        assert runs[0].conversation_id is None
        assert stored.conversation_id == "11111111-1111-1111-1111-111111111111"

    async def test_run_history_keeps_chat_links_when_publishing_is_enabled(
        self, _swap_run_store
    ):
        """Published conversations retain their links in run-history responses."""
        conversation_id = "11111111-1111-1111-1111-111111111111"
        _swap_run_store(
            _RecordingStore([_make_run("r1", conversation_id=conversation_id)])
        )
        await _seed_tasks([_make_task("t1")])

        with patch.object(
            tasks_route, "chat_history_publishing_enabled", return_value=True
        ):
            runs = await get_task_runs("t1", _fake_request())

        assert runs[0].conversation_id == conversation_id


class TestWebhookRunFollowUp:
    """Authenticated UI continuation stays bound to an explicit webhook run."""

    def test_queues_follow_up_for_selected_run(
        self, client: TestClient, _swap_run_store, monkeypatch
    ):
        owner = "owner@example.com"
        headers = _user_headers(owner)
        task_id = _create_task(client, _webhook_task("hook1"), headers=headers)
        _swap_run_store(
            _RecordingStore(
                [_make_run("run-parent", task_id=task_id, owner_id=owner)]
            )
        )
        dispatch = AsyncMock(
            return_value=webhook_runtime.DispatchOutcome(
                status_code=202,
                run_id="run-follow-up",
                claimed=True,
                trigger_instance_id=None,
                dedup_strategy="none",
            )
        )
        monkeypatch.setattr(tasks_route, "dispatch_webhook_run", dispatch)

        response = client.post(
            f"/api/v1/tasks/{task_id}/runs/run-parent/follow-up",
            json={"user_text": "Please investigate the failed check."},
            headers=headers,
        )

        assert response.status_code == 202
        assert response.json() == {
            "status": "accepted",
            "task_id": task_id,
            "run_id": "run-follow-up",
            "parent_run_id": "run-parent",
        }
        follow_up = dispatch.await_args.kwargs["follow_up"]
        assert follow_up.parent_run_id == "run-parent"
        assert follow_up.user_text == "Please investigate the failed check."
        assert follow_up.user_ref == owner
        assert follow_up.transport == "webui"

    def test_rejects_unknown_parent_run(
        self, client: TestClient, _swap_run_store, monkeypatch
    ):
        task_id = _create_task(client, _webhook_task("hook1"))
        _swap_run_store(_RecordingStore())
        dispatch = AsyncMock()
        monkeypatch.setattr(tasks_route, "dispatch_webhook_run", dispatch)

        response = client.post(
            f"/api/v1/tasks/{task_id}/runs/missing/follow-up",
            json={"user_text": "Continue"},
        )

        assert response.status_code == 404
        dispatch.assert_not_awaited()

    def test_rejects_non_webhook_task(
        self, client: TestClient, _swap_run_store, monkeypatch
    ):
        task_id = _create_task(client, _cron_task("scheduled"))
        _swap_run_store(_RecordingStore([_make_run("run-parent", task_id=task_id)]))
        dispatch = AsyncMock()
        monkeypatch.setattr(tasks_route, "dispatch_webhook_run", dispatch)

        response = client.post(
            f"/api/v1/tasks/{task_id}/runs/run-parent/follow-up",
            json={"user_text": "Continue"},
        )

        assert response.status_code == 400
        dispatch.assert_not_awaited()


class TestRunHistoryOwnership:
    """Codex P1: run-history reads are scoped by task ownership.

    Without these gates any authenticated user could read another user's
    prompts, response previews, errors and captured events by guessing a
    task id (``/tasks/{id}/runs``) or by hitting the cross-task
    ``/runs`` endpoint.
    """

    async def test_list_all_runs_filters_to_caller_for_non_admin(self, _swap_run_store):
        """``/runs`` returns only the non-admin caller's own runs."""
        _swap_run_store(
            _RecordingStore(
                [
                    _make_run("r-alice", task_id="t-alice", owner_id="alice@example.com"),
                    _make_run("r-bob", task_id="t-bob", owner_id="bob@example.com"),
                    _make_run("r-orphan", task_id="t-old", owner_id=None),
                ]
            )
        )
        await _seed_tasks([])

        runs = await list_all_runs(_fake_request(_user_headers("bob@example.com")))

        assert [r.run_id for r in runs] == ["r-bob"]

    async def test_list_all_runs_returns_everything_for_admin(self, _swap_run_store):
        """Admins audit every task's runs, including orphaned ones."""
        _swap_run_store(
            _RecordingStore(
                [
                    _make_run("r-alice", task_id="t-alice", owner_id="alice@example.com"),
                    _make_run("r-bob", task_id="t-bob", owner_id="bob@example.com"),
                    _make_run("r-orphan", task_id="t-old", owner_id=None),
                ]
            )
        )
        await _seed_tasks([])

        runs = await list_all_runs(_fake_request(_admin_headers()))

        assert {r.run_id for r in runs} == {"r-alice", "r-bob", "r-orphan"}

    async def test_list_all_runs_unfiltered_without_gateway_header(self, _swap_run_store):
        """A direct service call (no gateway header) is treated as trusted/compat."""
        _swap_run_store(
            _RecordingStore(
                [
                    _make_run("r-alice", task_id="t-alice", owner_id="alice@example.com"),
                    _make_run("r-bob", task_id="t-bob", owner_id="bob@example.com"),
                ]
            )
        )
        await _seed_tasks([])

        runs = await list_all_runs(_fake_request())

        assert {r.run_id for r in runs} == {"r-alice", "r-bob"}

    async def test_get_task_runs_403_when_task_owned_by_other(self, _swap_run_store):
        """A non-owner gets 403 for an existing task's run history."""
        from fastapi import HTTPException

        _swap_run_store(
            _RecordingStore([_make_run("r1", task_id="t1", owner_id="alice@example.com")])
        )
        alice_task = _make_task("t1")
        alice_task = alice_task.model_copy(update={"owner_id": "alice@example.com"})
        await _seed_tasks([alice_task])

        with pytest.raises(HTTPException) as exc:
            await get_task_runs("t1", _fake_request(_user_headers("bob@example.com")))
        assert exc.value.status_code == 403

    async def test_get_task_runs_for_removed_task_filters_to_caller(self, _swap_run_store):
        """Deleted-task history is filtered to the caller's own runs."""
        _swap_run_store(
            _RecordingStore(
                [
                    _make_run("r-alice", task_id="gone", owner_id="alice@example.com"),
                    _make_run("r-bob", task_id="gone", owner_id="bob@example.com"),
                ]
            )
        )
        await _seed_tasks([])  # task "gone" no longer exists

        runs = await get_task_runs("gone", _fake_request(_user_headers("bob@example.com")))

        assert [r.run_id for r in runs] == ["r-bob"]


class TestDynamicAgentRouting:
    """Tasks with ``dynamic_agent_id`` route through the dynamic-agents preflight, not the supervisor's."""

    async def test_routes_dynamic_agent_to_dynamic_preflight(self):
        """``dynamic_agent_id`` set => the dynamic-agents preflight runs."""
        store = _DictTaskStore()
        set_task_store(store)
        await store.create(
            TaskDefinition(
                id="custom-task",
                name="Custom Task",
                dynamic_agent_id="agent-x",
                prompt="run the custom thing",
                trigger=CronTrigger(schedule="0 9 * * *"),
            )
        )

        da_preflight = AsyncMock(return_value=_ok_ack())

        # ``_run_preflight_and_persist`` lives in ``services.task_lifecycle``;
        # that module owns the ``preflight_dynamic_agent`` import so the patch
        # target follows the function.
        with patch(
            "autonomous_agents.services.task_lifecycle.preflight_dynamic_agent",
            new=da_preflight,
        ):
            await _run_preflight_and_persist("custom-task")

        da_preflight.assert_awaited_once()
        assert da_preflight.await_args.kwargs["agent_id"] == "agent-x"

        refreshed = await store.get("custom-task")
        assert refreshed is not None
        assert refreshed.last_ack is not None
        assert refreshed.last_ack.ack_status == "ok"

    async def test_task_without_dynamic_agent_id_acks_failed(self):
        """A legacy task with no ``dynamic_agent_id`` gets a failed ack without a backend call."""
        store = _DictTaskStore()
        set_task_store(store)
        # Bypass the create route (which now rejects this) to simulate a row
        # persisted before the dynamic-only routing model.
        await store.create(
            TaskDefinition(
                id="legacy-task",
                name="Legacy Task",
                agent="github",
                prompt="open a PR",
                trigger=CronTrigger(schedule="0 9 * * *"),
            )
        )

        da_preflight = AsyncMock(return_value=_ok_ack())
        with patch(
            "autonomous_agents.services.task_lifecycle.preflight_dynamic_agent",
            new=da_preflight,
        ):
            await _run_preflight_and_persist("legacy-task")

        # No dynamic_agent_id => we never call the backend; the ack is a
        # clear application failure telling the operator to pick an agent.
        da_preflight.assert_not_awaited()
        refreshed = await store.get("legacy-task")
        assert refreshed is not None
        assert refreshed.last_ack is not None
        assert refreshed.last_ack.ack_status == "failed"

    def test_serialize_task_round_trips_dynamic_agent_id(self):
        """``_serialize_task`` echoes ``dynamic_agent_id`` for the UI label."""
        task = TaskDefinition(
            id="custom-task",
            name="Custom Task",
            dynamic_agent_id="agent-x",
            prompt="run the custom thing",
            trigger=CronTrigger(schedule="0 9 * * *"),
        )
        serialized = _serialize_task(task, next_run_iso=None)
        assert serialized["dynamic_agent_id"] == "agent-x"
        assert serialized["agent"] is None

    def test_serialize_task_keeps_dynamic_agent_id_null_for_supervisor_tasks(self):
        """Supervisor tasks serialise ``dynamic_agent_id=null`` and ``agent=<name>``."""
        task = TaskDefinition(
            id="supervisor-task",
            name="Supervisor Task",
            agent="github",
            prompt="open a PR",
            trigger=CronTrigger(schedule="0 9 * * *"),
        )
        serialized = _serialize_task(task, next_run_iso=None)
        assert serialized["dynamic_agent_id"] is None
        assert serialized["agent"] == "github"

    def test_serialize_task_hides_chat_link_when_publishing_is_disabled(self):
        """Tasks must not advertise a conversation that is never created."""
        task = TaskDefinition(
            id="no-chat-task",
            name="No Chat Task",
            dynamic_agent_id="agent-x",
            prompt="run the custom thing",
            trigger=CronTrigger(schedule="0 9 * * *"),
        )

        with patch.object(
            tasks_route, "task_chat_history_publishing_enabled", return_value=False
        ):
            serialized = _serialize_task(task, next_run_iso=None)

        assert serialized["chat_conversation_id"] is None

    def test_serialize_task_exposes_chat_link_when_publishing_is_enabled(self):
        """Tasks expose their deterministic thread only for an active publisher."""
        task = TaskDefinition(
            id="chat-task",
            name="Chat Task",
            dynamic_agent_id="agent-x",
            prompt="run the custom thing",
            trigger=CronTrigger(schedule="0 9 * * *"),
        )

        with patch.object(
            tasks_route, "task_chat_history_publishing_enabled", return_value=True
        ):
            serialized = _serialize_task(task, next_run_iso=None)

        assert serialized["chat_conversation_id"] == conversation_id_for_task(task.id)

    def test_serialize_webhook_task_never_exposes_chat_link(self):
        task = TaskDefinition(
            id="webhook-task",
            name="Webhook Task",
            dynamic_agent_id="agent-x",
            prompt="handle event",
            trigger=WebhookTrigger(),
        )

        serialized = _serialize_task(task, next_run_iso=None)

        assert serialized["chat_conversation_id"] is None

    async def test_webhook_task_lifecycle_never_publishes_chat_messages(self):
        task = TaskDefinition(
            id="webhook-task",
            name="Webhook Task",
            dynamic_agent_id="agent-x",
            prompt="handle event",
            trigger=WebhookTrigger(),
        )
        publisher = AsyncMock()

        with patch.object(
            task_lifecycle,
            "get_chat_history_publisher",
            return_value=publisher,
        ):
            await task_lifecycle.publish_creation_intent_safely(task)
            await task_lifecycle._safe_publish_preflight_ack(task, _ok_ack())

        publisher.publish_creation_intent.assert_not_awaited()
        publisher.publish_preflight_ack.assert_not_awaited()


def test_task_route_uses_lifecycle_task_store() -> None:
    """Task routes resolve the TaskStore through the lifecycle module."""
    prior = task_lifecycle._task_store
    sentinel = cast(TaskStore, object())
    task_lifecycle._task_store = sentinel
    try:
        assert tasks_route.get_task_store() is sentinel
        assert task_lifecycle.get_task_store() is sentinel
    finally:
        task_lifecycle._task_store = prior


def _admin_headers() -> dict:
    return {
        "X-Authenticated-User-Email": "alice@example.com",
        "X-Authenticated-User-Is-Admin": "true",
    }


def _user_headers(email: str = "bob@example.com") -> dict:
    return {
        "X-Authenticated-User-Email": email,
        "X-Authenticated-User-Is-Admin": "false",
    }


class TestTaskOwnership:
    """Test per-user task ownership stamping and access control."""

    def test_create_stamps_owner_id_from_header(self, client: TestClient):
        """POST /tasks stamps owner_id from X-Authenticated-User-Email header."""
        resp = client.post(
            "/api/v1/tasks",
            json=_cron_task("t1"),
            headers=_user_headers("alice@example.com"),
        )
        assert resp.status_code == 201
        listed = client.get("/api/v1/tasks", headers=_admin_headers()).json()
        assert listed[0]["owner_id"] == "alice@example.com"

    def test_create_without_header_leaves_owner_id_none(self, client: TestClient):
        """POST /tasks without header does not set owner_id (backward compat)."""
        resp = client.post("/api/v1/tasks", json=_cron_task("t1"))
        assert resp.status_code == 201
        listed = client.get("/api/v1/tasks", headers=_admin_headers()).json()
        assert listed[0]["owner_id"] is None

    def test_non_admin_cannot_spoof_owner_id_on_create(self, client: TestClient):
        """Codex P2: a non-admin POSTing another user's owner_id is overridden.

        Ownership is the authorization boundary, so a client-supplied
        owner_id must never let a non-admin file a task under someone
        else's account. The trusted header wins.
        """
        body = _cron_task("t1")
        body["owner_id"] = "victim@example.com"
        resp = client.post(
            "/api/v1/tasks", json=body, headers=_user_headers("attacker@example.com")
        )
        assert resp.status_code == 201
        assert resp.json()["owner_id"] == "attacker@example.com"
        listed = client.get("/api/v1/tasks", headers=_admin_headers()).json()
        assert listed[0]["owner_id"] == "attacker@example.com"

    def test_admin_can_set_owner_id_on_create(self, client: TestClient):
        """An admin may deliberately create a task on behalf of another user."""
        body = _cron_task("t1")
        body["owner_id"] = "carol@example.com"
        resp = client.post("/api/v1/tasks", json=body, headers=_admin_headers())
        assert resp.status_code == 201
        assert resp.json()["owner_id"] == "carol@example.com"

    def test_admin_create_without_owner_id_defaults_to_self(self, client: TestClient):
        """An admin who omits owner_id is recorded as the owner."""
        resp = client.post(
            "/api/v1/tasks",
            json=_cron_task("t1"),
            headers={
                "X-Authenticated-User-Email": "admin@example.com",
                "X-Authenticated-User-Is-Admin": "true",
            },
        )
        assert resp.status_code == 201
        assert resp.json()["owner_id"] == "admin@example.com"

    def test_create_stamps_owner_sub_from_header(self, client: TestClient):
        """POST /tasks stamps owner_sub from X-Authenticated-User-Sub so the run
        can be authorized as the owner (OpenFGA keys subjects by sub)."""
        headers = {**_user_headers("alice@example.com"), "X-Authenticated-User-Sub": "alice-uuid"}
        resp = client.post("/api/v1/tasks", json=_cron_task("t1"), headers=headers)
        assert resp.status_code == 201
        # owner_sub is exposed read-only on the wire as the stable owner identity.
        assert resp.json()["owner_sub"] == "alice-uuid"
        tid = resp.json()["id"]

        stored = task_lifecycle._task_store
        assert stored is not None
        task = asyncio.run(stored.get(tid))
        assert task is not None
        assert task.owner_sub == "alice-uuid"

    def test_non_admin_cannot_spoof_owner_sub_on_create(self, client: TestClient):
        """owner_sub is server-bound only. A client-supplied owner_sub must be
        ignored — otherwise a task could authorize as an arbitrary subject at
        run time (privilege escalation). The verified header wins."""
        body = _cron_task("t1")
        body["owner_sub"] = "victim-uuid"  # attacker-controlled body
        headers = {**_user_headers("attacker@example.com"), "X-Authenticated-User-Sub": "attacker-uuid"}
        resp = client.post("/api/v1/tasks", json=body, headers=headers)
        assert resp.status_code == 201
        tid = resp.json()["id"]

        stored = task_lifecycle._task_store
        assert stored is not None
        task = asyncio.run(stored.get(tid))
        assert task is not None
        assert task.owner_sub == "attacker-uuid"

    def test_body_owner_sub_scrubbed_when_no_sub_header(self, client: TestClient):
        """Without a sub header, a body-supplied owner_sub is dropped (never
        trusted), leaving the task unauthorizable per-owner rather than
        authorizable as the spoofed subject."""
        body = _cron_task("t1")
        body["owner_sub"] = "spoofed-uuid"
        resp = client.post("/api/v1/tasks", json=body, headers=_user_headers("bob@example.com"))
        assert resp.status_code == 201
        tid = resp.json()["id"]

        stored = task_lifecycle._task_store
        assert stored is not None
        task = asyncio.run(stored.get(tid))
        assert task is not None
        assert task.owner_sub is None

    def test_update_preserves_owner_sub(self, client: TestClient):
        """owner_sub is not on the wire, so a PUT round-trip must carry the
        stored value forward rather than wipe it (which would drop the task into
        the per-owner-unauthorizable path)."""
        headers = {**_user_headers("alice@example.com"), "X-Authenticated-User-Sub": "alice-uuid"}
        tid = _create_task(client, _cron_task("t1"), headers=headers)

        resp = client.put(f"/api/v1/tasks/{tid}", json=_cron_task("t1"), headers=_user_headers("alice@example.com"))
        assert resp.status_code == 200

        stored = task_lifecycle._task_store
        assert stored is not None
        task = asyncio.run(stored.get(tid))
        assert task is not None
        assert task.owner_sub == "alice-uuid"

    def test_admin_create_for_other_user_leaves_owner_sub_none(self, client: TestClient):
        """Admin-on-behalf-of another user: their sub is not available, so
        owner_sub stays None (task must be recreated by its owner to be
        authorized per-owner) — never stamped with the admin's own sub."""
        body = _cron_task("t1")
        body["owner_id"] = "carol@example.com"
        headers = {**_admin_headers(), "X-Authenticated-User-Sub": "admin-uuid"}
        resp = client.post("/api/v1/tasks", json=body, headers=headers)
        assert resp.status_code == 201
        assert resp.json()["owner_id"] == "carol@example.com"
        tid = resp.json()["id"]

        stored = task_lifecycle._task_store
        assert stored is not None
        task = asyncio.run(stored.get(tid))
        assert task is not None
        assert task.owner_sub is None

    def test_admin_sees_all_tasks(self, client: TestClient):
        """Admin users see tasks owned by any user."""
        alice = _create_task(client, _cron_task("t1"), headers=_user_headers("alice@example.com"))
        bob = _create_task(client, _cron_task("t2"), headers=_user_headers("bob@example.com"))
        resp = client.get("/api/v1/tasks", headers=_admin_headers())
        assert resp.status_code == 200
        ids = [t["id"] for t in resp.json()]
        assert alice in ids
        assert bob in ids

    def test_non_admin_sees_only_own_tasks(self, client: TestClient):
        """Non-admin users only see their own tasks."""
        alice = _create_task(client, _cron_task("t1"), headers=_user_headers("alice@example.com"))
        bob = _create_task(client, _cron_task("t2"), headers=_user_headers("bob@example.com"))
        resp = client.get("/api/v1/tasks", headers=_user_headers("alice@example.com"))
        assert resp.status_code == 200
        ids = [t["id"] for t in resp.json()]
        assert alice in ids
        assert bob not in ids

    def test_non_admin_cannot_get_another_users_task(self, client: TestClient):
        """GET /tasks/{id} returns 403 when task belongs to a different user."""
        tid = _create_task(client, _cron_task("t1"), headers=_user_headers("alice@example.com"))
        resp = client.get(f"/api/v1/tasks/{tid}", headers=_user_headers("bob@example.com"))
        assert resp.status_code == 403

    def test_non_admin_cannot_delete_another_users_task(self, client: TestClient):
        """DELETE /tasks/{id} returns 403 when task belongs to a different user."""
        tid = _create_task(client, _cron_task("t1"), headers=_user_headers("alice@example.com"))
        resp = client.delete(f"/api/v1/tasks/{tid}", headers=_user_headers("bob@example.com"))
        assert resp.status_code == 403

    def test_owner_can_delete_own_task(self, client: TestClient):
        """The task owner can delete their own task."""
        tid = _create_task(client, _cron_task("t1"), headers=_user_headers("alice@example.com"))
        resp = client.delete(f"/api/v1/tasks/{tid}", headers=_user_headers("alice@example.com"))
        assert resp.status_code == 204

    def test_non_admin_cannot_update_another_users_task(self, client: TestClient):
        """PUT /tasks/{id} returns 403 when task belongs to a different user."""
        tid = _create_task(
            client, _cron_task("t1"), headers=_user_headers("alice@example.com")
        )
        updated_payload = _cron_task("t1")
        updated_payload["name"] = "renamed by bob"
        resp = client.put(
            f"/api/v1/tasks/{tid}",
            json=updated_payload,
            headers=_user_headers("bob@example.com"),
        )
        assert resp.status_code == 403

    def test_non_admin_cannot_trigger_another_users_task(self, client: TestClient):
        """POST /tasks/{id}/run returns 403 when task belongs to a different user."""
        tid = _create_task(
            client, _cron_task("t1"), headers=_user_headers("alice@example.com")
        )
        resp = client.post(
            f"/api/v1/tasks/{tid}/run",
            headers=_user_headers("bob@example.com"),
        )
        assert resp.status_code == 403

    def test_admin_can_update_another_users_task(self, client: TestClient):
        """An admin can PUT another user's task."""
        tid = _create_task(
            client, _cron_task("t1"), headers=_user_headers("bob@example.com")
        )
        updated_payload = _cron_task("t1")
        updated_payload["name"] = "renamed by admin"
        resp = client.put(
            f"/api/v1/tasks/{tid}",
            json=updated_payload,
            headers=_admin_headers(),
        )
        assert resp.status_code == 200
        # Ownership is preserved across an admin-initiated update.
        listed = client.get("/api/v1/tasks", headers=_admin_headers()).json()
        owners = {t["id"]: t["owner_id"] for t in listed}
        assert owners[tid] == "bob@example.com"

    def test_admin_can_delete_another_users_task(self, client: TestClient):
        """An admin can DELETE another user's task."""
        tid = _create_task(
            client, _cron_task("t1"), headers=_user_headers("bob@example.com")
        )
        resp = client.delete(f"/api/v1/tasks/{tid}", headers=_admin_headers())
        assert resp.status_code == 204


class TestAdminAuditLogging:
    """Section 4.4: admin actions on someone else's task emit a log line."""

    def test_admin_update_emits_audit_log(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ):
        """Admin PUT on another user's task emits a log line with both emails + action."""
        tid = _create_task(
            client, _cron_task("t1"), headers=_user_headers("bob@example.com")
        )
        updated_payload = _cron_task("t1")
        updated_payload["name"] = "renamed by admin"
        caplog.clear()
        with caplog.at_level("INFO", logger="autonomous_agents"):
            resp = client.put(
                f"/api/v1/tasks/{tid}",
                json=updated_payload,
                headers={
                    "X-Authenticated-User-Email": "admin@example.com",
                    "X-Authenticated-User-Is-Admin": "true",
                },
            )
            assert resp.status_code == 200
        admin_log_lines = [
            r.getMessage()
            for r in caplog.records
            if "Admin " in r.getMessage() and "acted on task" in r.getMessage()
        ]
        assert admin_log_lines, "expected an admin audit log line on PUT"
        msg = admin_log_lines[0]
        assert "admin@example.com" in msg
        assert "bob@example.com" in msg
        assert tid in msg
        assert "update" in msg

    def test_admin_delete_emits_audit_log(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ):
        """Admin DELETE on another user's task emits a log line with both emails + action."""
        tid = _create_task(
            client, _cron_task("t1"), headers=_user_headers("bob@example.com")
        )
        caplog.clear()
        with caplog.at_level("INFO", logger="autonomous_agents"):
            resp = client.delete(
                f"/api/v1/tasks/{tid}",
                headers={
                    "X-Authenticated-User-Email": "admin@example.com",
                    "X-Authenticated-User-Is-Admin": "true",
                },
            )
            assert resp.status_code == 204
        admin_log_lines = [
            r.getMessage()
            for r in caplog.records
            if "Admin " in r.getMessage() and "acted on task" in r.getMessage()
        ]
        assert admin_log_lines, "expected an admin audit log line on DELETE"
        msg = admin_log_lines[0]
        assert "admin@example.com" in msg
        assert "bob@example.com" in msg
        assert "delete" in msg

    def test_admin_trigger_emits_audit_log(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ):
        """Admin manual trigger on another user's task emits a log line."""
        tid = _create_task(
            client, _cron_task("t1"), headers=_user_headers("bob@example.com")
        )
        caplog.clear()
        with caplog.at_level("INFO", logger="autonomous_agents"):
            resp = client.post(
                f"/api/v1/tasks/{tid}/run",
                headers={
                    "X-Authenticated-User-Email": "admin@example.com",
                    "X-Authenticated-User-Is-Admin": "true",
                },
            )
            assert resp.status_code == 200
        admin_log_lines = [
            r.getMessage()
            for r in caplog.records
            if "Admin " in r.getMessage() and "acted on task" in r.getMessage()
        ]
        assert admin_log_lines, "expected an admin audit log line on manual trigger"
        msg = admin_log_lines[0]
        assert "admin@example.com" in msg
        assert "bob@example.com" in msg
        assert "trigger" in msg

    def test_owner_action_does_not_emit_admin_audit_log(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ):
        """Owner acting on their own task must not emit the cross-user admin audit log line."""
        tid = _create_task(
            client, _cron_task("t1"), headers=_user_headers("bob@example.com")
        )
        caplog.clear()
        with caplog.at_level("INFO", logger="autonomous_agents"):
            resp = client.delete(
                f"/api/v1/tasks/{tid}",
                headers=_user_headers("bob@example.com"),
            )
            assert resp.status_code == 204
        admin_log_lines = [
            r.getMessage()
            for r in caplog.records
            if "Admin " in r.getMessage() and "acted on task" in r.getMessage()
        ]
        assert admin_log_lines == [], (
            "owner deleting their own task should not emit the admin audit line"
        )
