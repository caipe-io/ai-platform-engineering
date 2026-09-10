"""Tests for the ``/hooks/{task_id}`` and ``/hooks/{task_id}/follow-up`` routers.

Covers per-task secret precedence with the global ``WEBHOOK_SECRET``
fallback, replay protection guarded by ``WEBHOOK_REPLAY_WINDOW_SECONDS``,
deduplication via the ``trigger_instances`` collection, and the
follow-up route's GLOBAL-secret HMAC validation. Mongo and the
scheduler are stubbed via in-file fakes so the suite stays
infra-free.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from autonomous_agents.config import Settings, get_settings
from autonomous_agents.models import (
    FollowUpContext,
    TaskDefinition,
    TaskRun,
    TaskStatus,
    WebhookTrigger,
)
from autonomous_agents.routes import webhooks as webhooks_route
from autonomous_agents.routes.webhooks import (
    router as webhooks_router,
)

# ``fire_webhook_task`` is called from ``webhook_runtime._fire_and_log``.
# Monkey-patching on the webhooks route module would attach a dead
# attribute -- the real call goes through this module's name binding.
from autonomous_agents.services import webhook_runtime
from autonomous_agents.services.webhook_runtime import (
    register_webhook_task as _register,
)


def _make_task(
    task_id: str = "wh-1",
    *,
    secret: str | None = None,
    provider: str = "github",
) -> TaskDefinition:
    return TaskDefinition(
        id=task_id,
        name="webhook task",
        agent="dummy-agent",
        prompt="run the thing",
        trigger=WebhookTrigger(secret=secret, provider=provider),
    )


def _make_dedup_task(
    task_id: str = "wh-1",
    *,
    secret: str | None = None,
    dedup_header: str | None = None,
    provider: str = "github",
) -> TaskDefinition:
    return TaskDefinition(
        id=task_id,
        name="webhook task",
        agent="dummy-agent",
        prompt="run the thing",
        trigger=WebhookTrigger(
            secret=secret,
            provider=provider,
            dedup_header=dedup_header,
        ),
    )


def _hex_sig(secret: str, body: bytes, timestamp: str | None = None) -> str:
    """Produce ``sha256=<hex>`` matching the production signature contract."""
    if timestamp is not None:
        signed = timestamp.encode("utf-8") + b"." + body
    else:
        signed = body
    return "sha256=" + hmac.new(
        secret.encode("utf-8"), signed, hashlib.sha256
    ).hexdigest()


class _FakeMongoService:
    """In-memory ``MongoService`` stand-in covering only the trigger-instance API."""

    def __init__(self) -> None:
        self._rows: dict[str, dict[str, Any]] = {}
        self.is_connected = True

    async def record_trigger_instance(
        self, doc: dict[str, Any]
    ) -> tuple[bool, dict[str, Any] | None]:
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

    async def get_trigger_instance(
        self, dedup_key: str
    ) -> dict[str, Any] | None:
        return self._rows.get(dedup_key)


class _FakeRunStore:
    """In-memory ``RunStore`` stub covering only ``list_by_task``."""

    def __init__(self, runs: list[TaskRun]) -> None:
        self._runs = list(runs)

    async def record(self, run: TaskRun) -> None:  # pragma: no cover -- unused here
        self._runs.append(run)

    async def list_by_task(self, task_id: str, limit: int = 100) -> list[TaskRun]:
        return [r for r in self._runs if r.task_id == task_id][:limit]

    async def list_all(self, limit: int = 500) -> list[TaskRun]:  # pragma: no cover -- unused
        return list(self._runs[:limit])


@pytest.fixture
def client(monkeypatch) -> TestClient:
    """Isolated FastAPI app with stubbed ``fire_webhook_task`` / Mongo / RunStore."""
    app = FastAPI()
    app.include_router(webhooks_router, prefix="/api/v1")

    webhook_runtime._webhook_tasks.clear()

    captured: dict[str, Any] = {"calls": []}

    async def _fake_fire(
        task: TaskDefinition,
        context: dict[str, Any],
        follow_up: FollowUpContext | None = None,
        *,
        run_id: str | None = None,
        trigger_instance_id: str | None = None,
    ) -> TaskRun:
        actual_run_id = run_id or "r-1"
        captured["calls"].append(
            {
                "task_id": task.id,
                "context": context,
                "follow_up": follow_up,
                "run_id": actual_run_id,
                "trigger_instance_id": trigger_instance_id,
            }
        )
        return TaskRun(
            run_id=actual_run_id,
            task_id=task.id,
            task_name=task.name,
            status=TaskStatus.SUCCESS,
            parent_run_id=follow_up.parent_run_id if follow_up else None,
            trigger_instance_id=trigger_instance_id,
        )

    monkeypatch.setattr(webhook_runtime, "fire_webhook_task", _fake_fire)

    fake_mongo = _FakeMongoService()
    monkeypatch.setattr(webhook_runtime, "get_mongo_service", lambda: fake_mongo)

    runs = _FakeRunStore(
        [
            TaskRun(
                run_id="r-original",
                task_id="wh-1",
                task_name="webhook task",
                status=TaskStatus.SUCCESS,
            ),
            TaskRun(
                run_id="r-other-task",
                task_id="wh-2",
                task_name="other webhook task",
                status=TaskStatus.SUCCESS,
            ),
        ]
    )
    monkeypatch.setattr(webhooks_route, "get_run_store", lambda: runs)

    with TestClient(app) as test_client:
        test_client.captured = captured  # type: ignore[attr-defined]
        test_client.runs = runs  # type: ignore[attr-defined]
        test_client.mongo = fake_mongo  # type: ignore[attr-defined]
        yield test_client

    webhook_runtime._webhook_tasks.clear()
    get_settings.cache_clear()


def _set_settings(monkeypatch, **overrides: Any) -> Settings:
    """Replace the cached Settings singleton for one test."""
    overrides.setdefault("webhook_replay_window_seconds", 0)
    overrides.setdefault("webhook_secret", None)
    settings = Settings(**overrides)
    monkeypatch.setattr(webhooks_route, "get_settings", lambda: settings)
    return settings


def test_webhook_runtime_registers_into_lookup_table() -> None:
    """The webhook route resolves tasks from the service-owned registry."""
    webhook_runtime._webhook_tasks.clear()
    task = _make_task()
    _register(task)

    assert webhook_runtime.get_webhook_task(task.id) is task


class TestInitialFireSecrets:
    """Per-task secret precedence and global ``WEBHOOK_SECRET`` fallback on initial fires."""

    def test_no_secret_anywhere_accepts_unsigned_request(self, client, monkeypatch):
        """No secret configured anywhere => unsigned requests are accepted."""
        _set_settings(monkeypatch)
        _register(_make_task())

        resp = client.post("/api/v1/hooks/wh-1", json={"hello": "world"})

        assert resp.status_code == 202
        body = resp.json()
        assert body["task_id"] == "wh-1"
        assert body["status"] == "accepted"
        assert body["dedup_strategy"] == "none"

        [call] = client.captured["calls"]
        assert call["task_id"] == "wh-1"
        assert call["context"] == {"source": None, "event": None, "data": {"hello": "world"}}
        assert call["run_id"] == body["run_id"]
        assert call["trigger_instance_id"] is None

    def test_oversize_payload_is_dropped_before_dispatch(self, client, monkeypatch):
        """Bodies above the configured cap never become agent runs."""
        _set_settings(monkeypatch, webhook_max_payload_bytes=8)
        _register(_make_task(secret="task-secret"))

        resp = client.post("/api/v1/hooks/wh-1", content=b"123456789")

        assert resp.status_code == 413
        assert client.captured["calls"] == []

    def test_per_task_secret_required_when_set(self, client, monkeypatch):
        """A configured per-task secret rejects unsigned requests with 401."""
        _set_settings(monkeypatch)
        _register(_make_task(secret="task-secret"))

        body = json.dumps({"x": 1}).encode()
        sig = _hex_sig("task-secret", body)

        ok = client.post(
            "/api/v1/hooks/wh-1", content=body, headers={"X-Hub-Signature-256": sig}
        )
        assert ok.status_code == 202
        assert ok.json()["dedup_strategy"] == "signature"

        bad = client.post("/api/v1/hooks/wh-1", content=body)
        assert bad.status_code == 401
        assert "Missing X-Hub-Signature-256" in bad.json()["detail"]

    def test_provider_less_task_uses_generic_hmac(self, client, monkeypatch):
        """Webhook tasks without ``provider`` use the vendor-neutral adapter."""
        _set_settings(monkeypatch)
        task = TaskDefinition(
            id="wh-1",
            name="webhook task",
            agent="dummy-agent",
            prompt="run the thing",
            trigger=WebhookTrigger(secret="task-secret"),
        )
        _register(task)

        body = json.dumps({"x": 1}).encode()
        sig = _hex_sig("task-secret", body)

        ok = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Webhook-Signature-256": sig},
        )
        assert ok.status_code == 202

        bad = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Hub-Signature-256": sig},
        )
        assert bad.status_code == 401
        assert "Missing X-Webhook-Signature-256" in bad.json()["detail"]

    def test_global_secret_fallback_used_when_task_has_none(self, client, monkeypatch):
        """Tasks without a per-task secret fall back to the global ``WEBHOOK_SECRET``."""
        _set_settings(monkeypatch, webhook_secret="global-fallback")
        _register(_make_task())

        body = b'{"event":"push"}'
        sig = _hex_sig("global-fallback", body)

        resp = client.post(
            "/api/v1/hooks/wh-1", content=body, headers={"X-Hub-Signature-256": sig}
        )
        assert resp.status_code == 202

    def test_per_task_secret_wins_over_global(self, client, monkeypatch):
        """Per-task secret takes precedence over the global fallback."""
        _set_settings(monkeypatch, webhook_secret="global-fallback")
        _register(_make_task(secret="task-secret"))

        body = b'{"event":"push"}'
        bad = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Hub-Signature-256": _hex_sig("global-fallback", body)},
        )
        assert bad.status_code == 401

        ok = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Hub-Signature-256": _hex_sig("task-secret", body)},
        )
        assert ok.status_code == 202

    def test_invalid_signature_does_not_leak_expected_value(self, client, monkeypatch):
        """Invalid signature returns a generic message (no forgery oracle)."""
        _set_settings(monkeypatch)
        _register(_make_task(secret="s"))

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=b"{}",
            headers={"X-Hub-Signature-256": "sha256=deadbeef"},
        )

        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid webhook signature"


class TestInitialFireReplayProtection:
    """Replay window guarded by ``WEBHOOK_REPLAY_WINDOW_SECONDS``."""

    def test_window_disabled_keeps_github_style_signing(self, client, monkeypatch):
        """``window=0`` accepts the legacy body-only HMAC."""
        _set_settings(monkeypatch, webhook_replay_window_seconds=0)
        _register(_make_task(secret="s"))

        body = b'{"a":1}'
        sig = _hex_sig("s", body)

        resp = client.post(
            "/api/v1/hooks/wh-1", content=body, headers={"X-Hub-Signature-256": sig}
        )
        assert resp.status_code == 202

    def test_window_enabled_requires_timestamp_header(self, client, monkeypatch):
        """``window>0`` rejects requests missing ``X-Webhook-Timestamp``."""
        _set_settings(monkeypatch, webhook_replay_window_seconds=300)
        _register(_make_task(secret="s"))

        body = b"{}"
        sig = _hex_sig("s", body)

        resp = client.post(
            "/api/v1/hooks/wh-1", content=body, headers={"X-Hub-Signature-256": sig}
        )
        assert resp.status_code == 401
        assert "X-Webhook-Timestamp" in resp.json()["detail"]

    def test_window_enabled_signs_timestamp_dot_body(self, client, monkeypatch):
        """``window>0`` accepts ``HMAC(secret, "{ts}.{body}")``."""
        _set_settings(monkeypatch, webhook_replay_window_seconds=300)
        _register(_make_task(secret="s"))

        body = b'{"hello":"world"}'
        ts = str(int(time.time()))
        sig = _hex_sig("s", body, timestamp=ts)

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Hub-Signature-256": sig, "X-Webhook-Timestamp": ts},
        )
        assert resp.status_code == 202

    def test_window_rejects_too_old_timestamp(self, client, monkeypatch):
        """Timestamps older than the window are rejected as replays."""
        _set_settings(monkeypatch, webhook_replay_window_seconds=60)
        _register(_make_task(secret="s"))

        body = b"{}"
        old_ts = str(int(time.time()) - 3600)
        sig = _hex_sig("s", body, timestamp=old_ts)

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Hub-Signature-256": sig, "X-Webhook-Timestamp": old_ts},
        )
        assert resp.status_code == 401
        assert "replay window" in resp.json()["detail"]

    def test_window_rejects_far_future_timestamp(self, client, monkeypatch):
        """Timestamps far in the future are rejected (clock-skew bound)."""
        _set_settings(monkeypatch, webhook_replay_window_seconds=60)
        _register(_make_task(secret="s"))

        body = b"{}"
        future_ts = str(int(time.time()) + 3600)
        sig = _hex_sig("s", body, timestamp=future_ts)

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Hub-Signature-256": sig, "X-Webhook-Timestamp": future_ts},
        )
        assert resp.status_code == 401

    def test_window_rejects_non_numeric_timestamp(self, client, monkeypatch):
        """Non-numeric timestamps return 400."""
        _set_settings(monkeypatch, webhook_replay_window_seconds=60)
        _register(_make_task(secret="s"))

        body = b"{}"
        ts = "not-a-number"
        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Hub-Signature-256": "sha256=zz", "X-Webhook-Timestamp": ts},
        )
        assert resp.status_code == 400
        assert "numeric epoch" in resp.json()["detail"]

    @pytest.mark.parametrize("bad_ts", ["nan", "NaN", "inf", "-inf", "Infinity"])
    def test_window_rejects_non_finite_timestamp(self, client, monkeypatch, bad_ts):
        """Non-finite floats (nan / inf) bypass the range check and must be rejected."""
        _set_settings(monkeypatch, webhook_replay_window_seconds=60)
        _register(_make_task(secret="s"))

        body = b"{}"
        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Hub-Signature-256": "sha256=zz", "X-Webhook-Timestamp": bad_ts},
        )
        assert resp.status_code == 400
        assert "finite" in resp.json()["detail"]

    def test_window_disabled_ignores_timestamp_header(self, client, monkeypatch):
        """``window=0`` accepts body-only signatures even when a timestamp header is present."""
        _set_settings(monkeypatch, webhook_replay_window_seconds=0)
        _register(_make_task(secret="s"))

        body = b'{"a":1}'
        sig = _hex_sig("s", body)

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={
                "X-Hub-Signature-256": sig,
                "X-Webhook-Timestamp": str(int(time.time())),
            },
        )
        assert resp.status_code == 202


class TestInitialFireBehaviour:
    """Misc behavioural guards on the initial-fire endpoint."""

    def test_unknown_task_returns_404(self, client, monkeypatch):
        """Unknown task id returns 404."""
        _set_settings(monkeypatch)
        resp = client.post("/api/v1/hooks/missing", json={})
        assert resp.status_code == 404

    def test_disabled_task_unregisters_endpoint(self, client, monkeypatch):
        """Toggling ``enabled=False`` unregisters the webhook endpoint."""
        _set_settings(monkeypatch)
        task = _make_task()
        _register(task)

        assert client.post("/api/v1/hooks/wh-1", json={}).status_code == 202

        disabled = task.model_copy(update={"enabled": False})
        _register(disabled)
        assert client.post("/api/v1/hooks/wh-1", json={}).status_code == 404

    def test_signature_helper_matches_endpoint_for_body_only(self, client, monkeypatch):
        """``_expected_signature`` matches what the endpoint computes (library-caller contract)."""
        _set_settings(monkeypatch)
        _register(_make_task(secret="library-secret"))

        body = b'{"id":42}'
        sig = webhooks_route._expected_signature("library-secret", body, None)

        resp = client.post(
            "/api/v1/hooks/wh-1", content=body, headers={"X-Hub-Signature-256": sig}
        )
        assert resp.status_code == 202

    def test_github_ping_is_ignored_without_firing_task(self, client, monkeypatch):
        """GitHub ``ping`` deliveries return 200 ``ignored`` and don't fire the task."""
        _set_settings(monkeypatch)
        _register(_make_task())

        resp = client.post(
            "/api/v1/hooks/wh-1",
            json={"zen": "Accessible for all.", "hook": {"events": ["issues"]}},
            headers={"X-GitHub-Event": "ping"},
        )

        assert resp.status_code == 200
        assert resp.json() == {
            "status": "ignored",
            "reason": "github_ping",
            "task_id": "wh-1",
        }
        assert client.captured["calls"] == []

    def test_signed_github_ping_still_requires_valid_signature(self, client, monkeypatch):
        """Even ``ping`` deliveries must carry a valid signature when one is required."""
        _set_settings(monkeypatch)
        _register(_make_task(secret="task-secret"))

        body = json.dumps({"zen": "Accessible for all."}).encode()

        unsigned = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-GitHub-Event": "ping"},
        )
        assert unsigned.status_code == 401

        signed = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={
                "X-GitHub-Event": "ping",
                "X-Hub-Signature-256": _hex_sig("task-secret", body),
            },
        )
        assert signed.status_code == 200
        assert signed.json()["status"] == "ignored"
        assert client.captured["calls"] == []


class TestInitialFireDeduplication:
    """Webhook deduplication via the ``trigger_instances`` collection."""

    def test_duplicate_signed_delivery_is_deduped(self, client, monkeypatch):
        """Same body + secret => same key => second delivery is deduped, task fires once."""
        _set_settings(monkeypatch)
        _register(_make_dedup_task(secret="s"))

        body = b'{"event":"push","sha":"abc"}'
        sig = _hex_sig("s", body)

        first = client.post(
            "/api/v1/hooks/wh-1", content=body, headers={"X-Hub-Signature-256": sig}
        )
        assert first.status_code == 202
        first_body = first.json()
        assert first_body["dedup_strategy"] == "signature"
        assert first_body["status"] == "accepted"
        original_run_id = first_body["run_id"]
        assert original_run_id

        second = client.post(
            "/api/v1/hooks/wh-1", content=body, headers={"X-Hub-Signature-256": sig}
        )
        assert second.status_code == 200
        second_body = second.json()
        assert second_body["status"] == "deduped"
        assert second_body["run_id"] == original_run_id
        assert second_body["dedup_strategy"] == "signature"

        assert len(client.captured["calls"]) == 1
        assert client.captured["calls"][0]["run_id"] == original_run_id

    def test_distinct_signed_deliveries_both_fire(self, client, monkeypatch):
        """Different bodies => different keys => both legitimate deliveries fire."""
        _set_settings(monkeypatch)
        _register(_make_dedup_task(secret="s"))

        body_a = b'{"event":"push","sha":"aaa"}'
        body_b = b'{"event":"push","sha":"bbb"}'

        resp_a = client.post(
            "/api/v1/hooks/wh-1",
            content=body_a,
            headers={"X-Hub-Signature-256": _hex_sig("s", body_a)},
        )
        resp_b = client.post(
            "/api/v1/hooks/wh-1",
            content=body_b,
            headers={"X-Hub-Signature-256": _hex_sig("s", body_b)},
        )

        assert resp_a.status_code == 202
        assert resp_b.status_code == 202
        assert resp_a.json()["run_id"] != resp_b.json()["run_id"]
        assert len(client.captured["calls"]) == 2

    def test_dedup_header_strategy_used_when_configured_and_present(self, client, monkeypatch):
        """A configured ``dedup_header`` overrides signature-based dedup."""
        _set_settings(monkeypatch)
        _register(_make_dedup_task(secret="s", dedup_header="X-GitHub-Delivery"))

        body_a = b'{"action":"opened"}'
        body_b = b'{"action":"opened","extra":"stuff"}'
        delivery_id = "delivery-uuid-1234"

        first = client.post(
            "/api/v1/hooks/wh-1",
            content=body_a,
            headers={
                "X-Hub-Signature-256": _hex_sig("s", body_a),
                "X-GitHub-Delivery": delivery_id,
            },
        )
        second = client.post(
            "/api/v1/hooks/wh-1",
            content=body_b,
            headers={
                "X-Hub-Signature-256": _hex_sig("s", body_b),
                "X-GitHub-Delivery": delivery_id,
            },
        )

        assert first.status_code == 202
        assert first.json()["dedup_strategy"] == "header"
        assert second.status_code == 200
        assert second.json()["status"] == "deduped"
        assert second.json()["dedup_strategy"] == "header"
        assert second.json()["run_id"] == first.json()["run_id"]
        assert len(client.captured["calls"]) == 1

    def test_dedup_header_falls_back_to_signature_when_header_absent(self, client, monkeypatch):
        """Header strategy gracefully falls back to signature when the header is missing."""
        _set_settings(monkeypatch)
        _register(_make_dedup_task(secret="s", dedup_header="X-GitHub-Delivery"))

        body = b'{"hi":"there"}'
        sig = _hex_sig("s", body)

        first = client.post(
            "/api/v1/hooks/wh-1", content=body, headers={"X-Hub-Signature-256": sig}
        )
        second = client.post(
            "/api/v1/hooks/wh-1", content=body, headers={"X-Hub-Signature-256": sig}
        )

        assert first.status_code == 202
        assert first.json()["dedup_strategy"] == "signature"
        assert second.status_code == 200
        assert second.json()["dedup_strategy"] == "signature"
        assert len(client.captured["calls"]) == 1

    def test_unsigned_no_header_skips_dedup_and_still_fires(self, client, monkeypatch):
        """No secret and no dedup_header => dedup is impossible but the task still fires."""
        _set_settings(monkeypatch)
        _register(_make_dedup_task())

        body = {"event": "push"}
        first = client.post("/api/v1/hooks/wh-1", json=body)
        second = client.post("/api/v1/hooks/wh-1", json=body)

        assert first.status_code == 202
        assert first.json()["dedup_strategy"] == "none"
        assert second.status_code == 202
        assert second.json()["dedup_strategy"] == "none"
        assert first.json()["run_id"] != second.json()["run_id"]
        assert len(client.captured["calls"]) == 2

    def test_trigger_instance_id_is_back_linked_to_run(self, client, monkeypatch):
        """The dedup row is back-linked to the run_id returned in the 202 response."""
        _set_settings(monkeypatch)
        _register(_make_dedup_task(secret="s"))

        body = b'{"x":1}'
        sig = _hex_sig("s", body)

        resp = client.post(
            "/api/v1/hooks/wh-1", content=body, headers={"X-Hub-Signature-256": sig}
        )
        assert resp.status_code == 202
        body_json = resp.json()
        run_id = body_json["run_id"]
        trigger_id = body_json["trigger_instance_id"]
        assert trigger_id is not None

        row = client.mongo._rows[trigger_id]
        assert row["run_id"] == run_id
        assert row["task_id"] == "wh-1"
        assert row["dedup_strategy"] == "signature"

        assert client.captured["calls"][0]["trigger_instance_id"] == trigger_id

    def test_dedup_store_unavailable_returns_503(self, client, monkeypatch):
        """If Mongo fails on the dedup write, the route 503s and does not fire the task."""
        _set_settings(monkeypatch)
        _register(_make_dedup_task(secret="s"))

        class _BrokenMongo:
            is_connected = True

            async def record_trigger_instance(self, doc):  # noqa: ARG002
                raise RuntimeError("mongo is on fire")

            async def attach_run_to_trigger_instance(self, *_):
                return None

        monkeypatch.setattr(webhook_runtime, "get_mongo_service", lambda: _BrokenMongo())

        body = b'{"x":1}'
        sig = _hex_sig("s", body)
        resp = client.post(
            "/api/v1/hooks/wh-1", content=body, headers={"X-Hub-Signature-256": sig}
        )

        assert resp.status_code == 503
        assert client.captured["calls"] == []


class TestFollowUpHappyPath:
    """``/follow-up`` forwards a ``FollowUpContext`` and links the new run via ``parent_run_id``."""

    def test_unsigned_forwards_context_and_parent_link(self, client, monkeypatch):
        """No global secret => unsigned follow-up is accepted and forwarded."""
        _set_settings(monkeypatch)
        _register(_make_task())

        resp = client.post(
            "/api/v1/hooks/wh-1/follow-up",
            json={
                "parent_run_id": "r-original",
                "user_text": "investigate the auth path more",
                "user_ref": "alice@example.com",
                "transport": "webex",
            },
        )

        assert resp.status_code == 202, resp.text
        body = resp.json()
        assert body["task_id"] == "wh-1"
        assert body["parent_run_id"] == "r-original"
        assert body["status"] == "accepted"
        assert body["run_id"]

        [call] = client.captured["calls"]
        follow_up = call["follow_up"]
        assert isinstance(follow_up, FollowUpContext)
        assert follow_up.parent_run_id == "r-original"
        assert follow_up.user_text == "investigate the auth path more"
        assert follow_up.user_ref == "alice@example.com"
        assert follow_up.transport == "webex"
        assert call["context"] == {}
        assert call["run_id"] == body["run_id"]


class TestFollowUpHmacValidation:
    """``/follow-up`` HMAC validation always uses the GLOBAL secret."""

    def test_requires_signature_when_global_secret_is_set(self, client, monkeypatch):
        """Configuring the global secret enforces signature validation on follow-ups."""
        _set_settings(monkeypatch, webhook_secret="bridge-shared-secret")
        _register(_make_task())

        payload = {
            "parent_run_id": "r-original",
            "user_text": "please retry with verbose mode",
        }
        body = json.dumps(payload).encode()

        bad = client.post("/api/v1/hooks/wh-1/follow-up", content=body)
        assert bad.status_code == 401
        assert "Missing X-Hub-Signature-256" in bad.json()["detail"]
        assert client.captured["calls"] == []

        ok = client.post(
            "/api/v1/hooks/wh-1/follow-up",
            content=body,
            headers={"X-Hub-Signature-256": _hex_sig("bridge-shared-secret", body)},
        )
        assert ok.status_code == 202
        assert len(client.captured["calls"]) == 1

    def test_invalid_signature_rejected(self, client, monkeypatch):
        """Wrong signature returns 401 and never dispatches the task."""
        _set_settings(monkeypatch, webhook_secret="bridge-shared-secret")
        _register(_make_task())

        body = b'{"parent_run_id":"r-original","user_text":"hi"}'
        resp = client.post(
            "/api/v1/hooks/wh-1/follow-up",
            content=body,
            headers={"X-Hub-Signature-256": _hex_sig("wrong-secret", body)},
        )
        assert resp.status_code == 401
        assert client.captured["calls"] == []

    def test_uses_global_secret_not_per_task_secret(self, client, monkeypatch):
        """The follow-up route ignores the per-task secret and verifies against the global secret."""
        _set_settings(monkeypatch, webhook_secret="global-bridge-secret")
        _register(_make_task(secret="task-only-secret-for-original-fires"))

        body = b'{"parent_run_id":"r-original","user_text":"reply"}'

        bad = client.post(
            "/api/v1/hooks/wh-1/follow-up",
            content=body,
            headers={"X-Hub-Signature-256": _hex_sig("task-only-secret-for-original-fires", body)},
        )
        assert bad.status_code == 401
        assert client.captured["calls"] == []

        ok = client.post(
            "/api/v1/hooks/wh-1/follow-up",
            content=body,
            headers={"X-Hub-Signature-256": _hex_sig("global-bridge-secret", body)},
        )
        assert ok.status_code == 202
        assert len(client.captured["calls"]) == 1

    def test_uses_github_adapter_regardless_of_task_provider(self, client, monkeypatch):
        """Follow-up signing is always github-style (``X-Hub-Signature-256`` over body), regardless of task provider."""
        _set_settings(monkeypatch, webhook_secret="bridge-shared-secret")
        _register(_make_task(provider="slack"))

        body = b'{"parent_run_id":"r-original","user_text":"reply"}'

        ok = client.post(
            "/api/v1/hooks/wh-1/follow-up",
            content=body,
            headers={"X-Hub-Signature-256": _hex_sig("bridge-shared-secret", body)},
        )
        assert ok.status_code == 202, ok.text
        assert len(client.captured["calls"]) == 1


class TestFollowUpRoutingSafety:
    """``/follow-up`` rejects mis-routed parent run ids."""

    def test_unknown_parent_run_404s(self, client, monkeypatch):
        """Unknown ``parent_run_id`` returns 404 and never fires the task."""
        _set_settings(monkeypatch)
        _register(_make_task())

        resp = client.post(
            "/api/v1/hooks/wh-1/follow-up",
            json={
                "parent_run_id": "r-does-not-exist",
                "user_text": "anything",
            },
        )
        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"]
        assert client.captured["calls"] == []

    def test_parent_run_belonging_to_another_task_is_rejected(self, client, monkeypatch):
        """Cross-task graft (parent run belongs to a different task) returns 404."""
        _set_settings(monkeypatch)
        _register(_make_task("wh-1"))

        resp = client.post(
            "/api/v1/hooks/wh-1/follow-up",
            json={
                "parent_run_id": "r-other-task",
                "user_text": "anything",
            },
        )
        assert resp.status_code == 404
        assert client.captured["calls"] == []

    def test_unknown_task_id_404s(self, client, monkeypatch):
        """Unknown task id on the follow-up URL returns 404."""
        _set_settings(monkeypatch)
        resp = client.post(
            "/api/v1/hooks/missing/follow-up",
            json={"parent_run_id": "r-original", "user_text": "x"},
        )
        assert resp.status_code == 404
        assert "No webhook task found" in resp.json()["detail"]


class TestFollowUpBodyParsing:
    """``/follow-up`` body validation."""

    def test_body_must_be_json(self, client, monkeypatch):
        """Non-JSON body returns 400."""
        _set_settings(monkeypatch)
        _register(_make_task())

        resp = client.post(
            "/api/v1/hooks/wh-1/follow-up",
            content=b"not json",
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 400
        assert "valid JSON" in resp.json()["detail"]

    def test_body_must_have_required_fields(self, client, monkeypatch):
        """Missing ``parent_run_id`` returns 400."""
        _set_settings(monkeypatch)
        _register(_make_task())

        resp = client.post(
            "/api/v1/hooks/wh-1/follow-up",
            json={"user_text": "missing parent_run_id"},
        )
        assert resp.status_code == 400
        assert "parent_run_id" in resp.json()["detail"]
