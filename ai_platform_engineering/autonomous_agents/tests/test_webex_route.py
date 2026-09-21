"""Tests for the Webex inbound route at ``/api/v1/hooks/webex/events``.

Covers the feature gate (503 when unconfigured / uninitialised),
signature validation (401), body parsing (400), every dispatcher
``DROP_*`` verdict (200 ignored), Webex API failures (502), the
FORWARD path (202 happy / 200 dedup / 404 missing parent or task),
Mongo claim failures (503), the route-shadow guard against
``/hooks/{task_id}`` shadowing, and the partial-config validator.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from autonomous_agents.config import Settings, get_settings
from autonomous_agents.models import (
    TaskDefinition,
    TaskRun,
    TaskStatus,
    WebhookTrigger,
)
from autonomous_agents.routes import webex as webex_route
from autonomous_agents.routes import webhooks as webhooks_route

# Run-store and Webex thread-map singletons live in services.task_runner
# after the scheduler/runner split; monkey-patch on the owning module.
from autonomous_agents.services import task_runner as task_runner_module
from autonomous_agents.services import webhook_adapters, webhook_runtime

# ``_fire_and_log`` and the ``get_mongo_service`` lookup live in
# ``services.webhook_runtime``. Monkey-patching the route modules
# would attach a dead attribute -- the actual call paths go through
# this module's name bindings.
from autonomous_agents.services.webex_threads import WebexThreadEntry
from autonomous_agents.services.webhook_runtime import (
    register_webhook_task as _register,
)


def _spark_sig(secret: str, body: bytes) -> str:
    """Webex's ``X-Spark-Signature``: bare lowercase hex of HMAC-SHA1(body)."""
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha1).hexdigest()


def _make_task(task_id: str = "task-abc") -> TaskDefinition:
    return TaskDefinition(
        id=task_id,
        name="webex task",
        agent="dummy-agent",
        prompt="run the thing",
        trigger=WebhookTrigger(provider="webex"),
    )


def _make_event(
    *,
    message_id: str = "msg-reply-1",
    person_id: str = "PERSON-USER",
) -> dict[str, Any]:
    return {"data": {"id": message_id, "personId": person_id}}


class _FakeWebexClient:
    """Stand-in for ``WebexClient`` so tests don't open httpx pools."""

    def __init__(self, messages: dict[str, dict[str, Any]] | None = None) -> None:
        self._messages = messages or {}
        self.raise_on_get_message: Exception | None = None

    async def get_message(self, message_id: str) -> dict[str, Any]:
        if self.raise_on_get_message is not None:
            raise self.raise_on_get_message
        return self._messages[message_id]


class _FakeMongoService:
    """``MongoService`` stub covering only ``record_trigger_instance`` / ``attach_run_to_trigger_instance``."""

    def __init__(self) -> None:
        self._rows: dict[str, dict[str, Any]] = {}
        self.is_connected = True
        self.raise_on_claim: Exception | None = None

    async def record_trigger_instance(
        self, doc: dict[str, Any]
    ) -> tuple[bool, dict[str, Any] | None]:
        if self.raise_on_claim is not None:
            raise self.raise_on_claim
        existing = self._rows.get(doc["_id"])
        if existing is not None:
            return False, existing
        self._rows[doc["_id"]] = dict(doc)
        return True, None

    async def attach_run_to_trigger_instance(
        self, dedup_key: str, run_id: str
    ) -> None:
        row = self._rows.get(dedup_key)
        if row is not None:
            row["run_id"] = run_id


class _FakeRunStore:
    """Minimal RunStore exposing ``list_by_task``."""

    def __init__(self) -> None:
        self._runs: dict[str, list[TaskRun]] = {}

    def add(self, run: TaskRun) -> None:
        self._runs.setdefault(run.task_id, []).append(run)

    async def list_by_task(self, task_id: str, *, limit: int = 100) -> list[TaskRun]:
        return list(self._runs.get(task_id, []))[:limit]


class _FakeWebexThreadMap:
    def __init__(self) -> None:
        self._entries: dict[str, WebexThreadEntry] = {}

    def seed(self, entry: WebexThreadEntry) -> None:
        self._entries[entry.message_id] = entry

    async def record(self, entry: WebexThreadEntry) -> None:
        stamped = (
            entry
            if entry.created_at is not None
            else WebexThreadEntry(
                message_id=entry.message_id,
                task_id=entry.task_id,
                run_id=entry.run_id,
                room_id=entry.room_id,
                created_at=datetime.now(timezone.utc),
            )
        )
        self._entries[entry.message_id] = stamped

    async def lookup(self, message_id: str) -> WebexThreadEntry | None:
        return self._entries.get(message_id)


def _make_parent_run(task_id: str, run_id: str) -> TaskRun:
    return TaskRun(
        run_id=run_id,
        task_id=task_id,
        task_name="webex task",
        status=TaskStatus.SUCCESS,
    )


@pytest.fixture
def app_and_state(monkeypatch):
    """Isolated FastAPI app with stubbed Webex / Mongo / scheduler / thread map."""
    webhook_adapters.reset_adapters()
    webhook_adapters.load_adapters()

    app = FastAPI()
    app.include_router(webex_route.router, prefix="/api/v1")
    app.include_router(webhooks_route.router, prefix="/api/v1")

    webhook_runtime._webhook_tasks.clear()

    captured: dict[str, Any] = {"calls": []}

    async def _fake_fire_and_log(
        *,
        task: TaskDefinition,
        context: dict[str, Any],
        follow_up: Any = None,
        run_id: str,
        trigger_instance_id: str | None,
    ) -> None:
        captured["calls"].append(
            {
                "task_id": task.id,
                "follow_up": follow_up,
                "run_id": run_id,
                "trigger_instance_id": trigger_instance_id,
            }
        )

    monkeypatch.setattr(webhook_runtime, "_fire_and_log", _fake_fire_and_log)

    fake_mongo = _FakeMongoService()
    monkeypatch.setattr(webhook_runtime, "get_mongo_service", lambda: fake_mongo)

    fake_thread_map = _FakeWebexThreadMap()
    monkeypatch.setattr(task_runner_module, "_webex_thread_map", fake_thread_map)

    fake_run_store = _FakeRunStore()
    monkeypatch.setattr(task_runner_module, "_run_store", fake_run_store)

    fake_webex = _FakeWebexClient()
    webex_route.set_webex_client(fake_webex)  # type: ignore[arg-type]
    webex_route.set_bot_person_id("BOT")

    state: dict[str, Any] = {
        "webex": fake_webex,
        "mongo": fake_mongo,
        "thread_map": fake_thread_map,
        "run_store": fake_run_store,
        "captured": captured,
        "app": app,
    }

    _set_settings(monkeypatch, state)

    with TestClient(app) as client:
        state["client"] = client
        yield state

    webhook_runtime._webhook_tasks.clear()
    webex_route.set_webex_client(None)
    webex_route.set_bot_person_id(None)
    get_settings.cache_clear()


def _set_settings(
    monkeypatch, state: dict[str, Any], **overrides: Any
) -> Settings:
    defaults: dict[str, Any] = {
        "webex_bot_token": "tok",
        "webex_webhook_secret": "topsecret",
        "webex_bot_public_url": "https://caipe.example.com",
        "webhook_replay_window_seconds": 0,
        "webhook_secret": None,
    }
    defaults.update(overrides)
    settings = Settings(**defaults)
    monkeypatch.setattr(webex_route, "get_settings", lambda: settings)
    state["settings"] = settings
    return settings


class TestFeatureGate:
    """503 + ``Retry-After`` when the Webex feature is unconfigured or uninitialised."""

    def test_returns_503_when_webex_disabled(self, app_and_state, monkeypatch):
        """No ``WEBEX_BOT_TOKEN`` => 503 ``not configured`` with ``Retry-After``."""
        _set_settings(
            monkeypatch,
            app_and_state,
            webex_bot_token=None,
            webex_bot_public_url=None,
            webex_webhook_secret=None,
        )
        webex_route.set_webex_client(None)
        webex_route.set_bot_person_id(None)

        client = app_and_state["client"]
        resp = client.post("/api/v1/hooks/webex/events", json={"data": {}})
        assert resp.status_code == 503
        assert resp.headers.get("Retry-After") == "30"
        assert "not configured" in resp.json()["detail"].lower()

    def test_returns_503_when_token_set_but_client_uninitialised(self, app_and_state):
        """Token set but lifespan didn't wire a client => 503 ``not initialised``."""
        webex_route.set_webex_client(None)
        webex_route.set_bot_person_id(None)

        client = app_and_state["client"]
        resp = client.post("/api/v1/hooks/webex/events", json={"data": {}})
        assert resp.status_code == 503
        assert resp.headers.get("Retry-After") == "30"
        assert "not initialised" in resp.json()["detail"].lower()


class TestSignatureVerification:
    """``X-Spark-Signature`` validation."""

    def test_returns_401_on_bad_signature(self, app_and_state):
        """Invalid signature returns a generic 401."""
        client = app_and_state["client"]
        body = json.dumps({"data": {"id": "msg-1"}}).encode()
        bad_sig = _spark_sig("wrong-secret", body)

        resp = client.post(
            "/api/v1/hooks/webex/events",
            content=body,
            headers={"X-Spark-Signature": bad_sig, "Content-Type": "application/json"},
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid webhook signature"

    def test_returns_401_on_missing_signature(self, app_and_state):
        """Missing ``X-Spark-Signature`` returns 401 when a secret is configured."""
        client = app_and_state["client"]
        resp = client.post(
            "/api/v1/hooks/webex/events",
            json={"data": {"id": "msg-1"}},
        )
        assert resp.status_code == 401
        assert "X-Spark-Signature" in resp.json()["detail"]


class TestBodyParsing:
    """Body parsing and Webex test-ping handling."""

    def test_returns_400_on_invalid_json(self, app_and_state):
        """Non-JSON body returns 400."""
        client = app_and_state["client"]
        body = b"not json at all"
        sig = _spark_sig("topsecret", body)

        resp = client.post(
            "/api/v1/hooks/webex/events",
            content=body,
            headers={"X-Spark-Signature": sig, "Content-Type": "application/json"},
        )
        assert resp.status_code == 400
        assert "invalid JSON" in resp.json()["detail"]

    def test_webex_test_ping_without_data_is_ignored(self, app_and_state):
        """Webex's webhook-creation test delivery (no ``data``) is ignored."""
        client = app_and_state["client"]
        body = json.dumps({"id": "ping-1"}).encode()
        sig = _spark_sig("topsecret", body)

        resp = client.post(
            "/api/v1/hooks/webex/events",
            content=body,
            headers={"X-Spark-Signature": sig, "Content-Type": "application/json"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"status": "ignored", "reason": "no event data"}


class TestDispatcherVerdicts:
    """Each ``DROP_*`` verdict surfaces as 200 ``ignored``."""

    @pytest.mark.asyncio
    async def test_drops_loopguard_via_event_personid(self, app_and_state):
        """Event ``personId`` matching the bot id short-circuits as ``drop_loopguard``."""
        client = app_and_state["client"]
        body = json.dumps({"data": {"id": "msg-1", "personId": "BOT"}}).encode()
        sig = _spark_sig("topsecret", body)

        resp = client.post(
            "/api/v1/hooks/webex/events",
            content=body,
            headers={"X-Spark-Signature": sig, "Content-Type": "application/json"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"status": "ignored", "verdict": "drop_loopguard"}
        assert app_and_state["captured"]["calls"] == []

    @pytest.mark.asyncio
    async def test_drops_not_thread_reply(self, app_and_state):
        """Messages with no ``parentId`` are dropped as ``drop_not_thread_reply``."""
        state = app_and_state
        state["webex"]._messages = {
            "msg-1": {"id": "msg-1", "personId": "USER", "text": "hello"}
        }
        body = json.dumps({"data": {"id": "msg-1", "personId": "USER"}}).encode()
        sig = _spark_sig("topsecret", body)

        resp = state["client"].post(
            "/api/v1/hooks/webex/events",
            content=body,
            headers={"X-Spark-Signature": sig, "Content-Type": "application/json"},
        )
        assert resp.status_code == 200
        assert resp.json()["verdict"] == "drop_not_thread_reply"

    @pytest.mark.asyncio
    async def test_drops_no_mapping(self, app_and_state):
        """Replies whose ``parentId`` isn't in the thread map are dropped."""
        state = app_and_state
        state["webex"]._messages = {
            "msg-1": {
                "id": "msg-1",
                "personId": "USER",
                "parentId": "msg-not-in-map",
                "text": "hi",
            }
        }
        body = json.dumps({"data": {"id": "msg-1", "personId": "USER"}}).encode()
        sig = _spark_sig("topsecret", body)

        resp = state["client"].post(
            "/api/v1/hooks/webex/events",
            content=body,
            headers={"X-Spark-Signature": sig, "Content-Type": "application/json"},
        )
        assert resp.status_code == 200
        assert resp.json()["verdict"] == "drop_no_mapping"


class TestWebexApiFailure:
    """Webex API errors surface as 502 so Webex retries."""

    @pytest.mark.asyncio
    async def test_webex_api_error_returns_502(self, app_and_state):
        """Webex API ``HTTPError`` returns 502 ``webex api error``."""
        state = app_and_state
        state["webex"].raise_on_get_message = httpx.HTTPError("boom")
        body = json.dumps({"data": {"id": "msg-1", "personId": "USER"}}).encode()
        sig = _spark_sig("topsecret", body)

        resp = state["client"].post(
            "/api/v1/hooks/webex/events",
            content=body,
            headers={"X-Spark-Signature": sig, "Content-Type": "application/json"},
        )
        assert resp.status_code == 502
        assert resp.json()["detail"] == "webex api error"


def _seed_forward(state: dict[str, Any]) -> dict[str, Any]:
    """Wire enough state for a FORWARD verdict to land on the route."""
    task = _make_task("task-abc")
    _register(task)
    state["run_store"].add(_make_parent_run("task-abc", "run-xyz"))
    state["thread_map"].seed(
        WebexThreadEntry(
            message_id="msg-task-1",
            task_id="task-abc",
            run_id="run-xyz",
            room_id="room-1",
        )
    )
    state["webex"]._messages = {
        "msg-reply-1": {
            "id": "msg-reply-1",
            "personId": "USER",
            "personEmail": "ops@example.com",
            "parentId": "msg-task-1",
            "text": "please retry",
        }
    }
    body = json.dumps(
        {"data": {"id": "msg-reply-1", "personId": "USER"}}
    ).encode()
    sig = _spark_sig("topsecret", body)
    return {
        "body": body,
        "headers": {
            "X-Spark-Signature": sig,
            "Content-Type": "application/json",
        },
    }


class TestForwardPath:
    """End-to-end FORWARD path: 202 happy, 200 dedup, 404 misroute, 503 Mongo down."""

    def test_returns_202_and_schedules_fire(self, app_and_state):
        """Legitimate Webex follow-up creates a follow-up run via the background scheduler."""
        state = app_and_state
        payload = _seed_forward(state)

        resp = state["client"].post(
            "/api/v1/hooks/webex/events",
            content=payload["body"],
            headers=payload["headers"],
        )
        assert resp.status_code == 202, resp.text
        body = resp.json()
        assert body["status"] == "accepted"
        assert body["task_id"] == "task-abc"
        assert body["parent_run_id"] == "run-xyz"
        assert body["dedup_strategy"] == "signature"

        assert len(state["captured"]["calls"]) == 1
        call = state["captured"]["calls"][0]
        assert call["task_id"] == "task-abc"
        assert call["follow_up"].parent_run_id == "run-xyz"
        assert call["follow_up"].user_text == "please retry"
        assert call["follow_up"].user_ref == "ops@example.com"
        assert call["follow_up"].transport == "webex"

    def test_duplicate_forward_dedupes_to_same_run_id(self, app_and_state):
        """Webex retries (same body+sig) dedup to the original run_id."""
        state = app_and_state
        payload = _seed_forward(state)

        first = state["client"].post(
            "/api/v1/hooks/webex/events",
            content=payload["body"],
            headers=payload["headers"],
        )
        second = state["client"].post(
            "/api/v1/hooks/webex/events",
            content=payload["body"],
            headers=payload["headers"],
        )

        assert first.status_code == 202
        assert second.status_code == 200
        assert second.json()["status"] == "deduped"
        assert second.json()["run_id"] == first.json()["run_id"]
        assert len(state["captured"]["calls"]) == 1

    def test_404s_when_parent_run_not_found(self, app_and_state):
        """Stale thread map referencing a missing parent run returns 404."""
        state = app_and_state
        payload = _seed_forward(state)
        state["run_store"]._runs.clear()

        resp = state["client"].post(
            "/api/v1/hooks/webex/events",
            content=payload["body"],
            headers=payload["headers"],
        )
        assert resp.status_code == 404
        assert "run-xyz" in resp.json()["detail"]

    def test_404s_when_task_id_unknown(self, app_and_state):
        """Thread map pointing at a deleted task returns 404."""
        state = app_and_state
        payload = _seed_forward(state)
        webhook_runtime._webhook_tasks.clear()

        resp = state["client"].post(
            "/api/v1/hooks/webex/events",
            content=payload["body"],
            headers=payload["headers"],
        )
        assert resp.status_code == 404

    def test_mongo_claim_failure_returns_503(self, app_and_state):
        """Mongo claim failure returns 503 so Webex retries."""
        state = app_and_state
        payload = _seed_forward(state)
        state["mongo"].raise_on_claim = RuntimeError("mongo down")

        resp = state["client"].post(
            "/api/v1/hooks/webex/events",
            content=payload["body"],
            headers=payload["headers"],
        )
        assert resp.status_code == 503
        assert "deduplication store" in resp.json()["detail"]


class TestRouteShadow:
    """The Webex events path must never resolve to the per-task ``receive_webhook`` handler."""

    def test_webex_events_path_does_not_invoke_receive_webhook(self, app_and_state, monkeypatch):
        """Routing insurance: ``/hooks/webex/events`` must not shadow into ``/hooks/{task_id}``."""
        invoked = {"flag": False}

        async def _flag_invoked(*args, **kwargs):  # pragma: no cover - asserts not called
            invoked["flag"] = True
            return {}

        monkeypatch.setattr(webhooks_route, "receive_webhook", _flag_invoked)

        state = app_and_state
        body = json.dumps({"data": {"id": "msg-1", "personId": "USER"}}).encode()
        sig = _spark_sig("topsecret", body)
        state["webex"]._messages = {
            "msg-1": {"id": "msg-1", "personId": "USER", "text": "hi"}
        }
        state["client"].post(
            "/api/v1/hooks/webex/events",
            content=body,
            headers={"X-Spark-Signature": sig, "Content-Type": "application/json"},
        )
        assert invoked["flag"] is False, (
            "webex.events resolved to receive_webhook -- route shadowing "
            "regression. Ensure webex.router is mounted BEFORE webhooks.router."
        )


class TestSettingsValidator:
    """Partial Webex config is rejected fast at Settings instantiation."""

    def test_rejects_token_without_public_url(self):
        """``WEBEX_BOT_TOKEN`` without ``WEBEX_BOT_PUBLIC_URL`` raises ValidationError."""
        from pydantic import ValidationError

        with pytest.raises(ValidationError) as exc:
            Settings(webex_bot_token="x", webex_bot_public_url=None)
        assert "WEBEX_BOT_PUBLIC_URL" in str(exc.value)

    def test_allows_token_and_public_url_set_together(self):
        """``WEBEX_BOT_TOKEN`` + ``WEBEX_BOT_PUBLIC_URL`` => ``webex_enabled=True``."""
        s = Settings(
            webex_bot_token="x",
            webex_bot_public_url="https://example.com",
        )
        assert s.webex_enabled is True

    def test_treats_blank_token_as_unset(self):
        """Blank-string env values collapse to None so the ``feature off`` branch is reachable."""
        s = Settings(
            webex_bot_token="",
            webex_bot_public_url="",
            webex_webhook_secret="",
        )
        assert s.webex_bot_token is None
        assert s.webex_bot_public_url is None
        assert s.webex_webhook_secret is None
        assert s.webex_enabled is False

    def test_webex_disabled_by_default(self):
        """Defaults: ``webex_enabled=False``."""
        s = Settings()
        assert s.webex_enabled is False
        assert s.webex_bot_token is None
