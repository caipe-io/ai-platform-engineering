"""Tests for the YAML-driven webhook provider adapter layer.

Covers loading the bundled ``webhook_providers.yaml``, end-to-end
routing via ``WebhookTrigger.provider``, the per-provider signature
contracts (github, slack, jira, pagerduty, webex, generic_hmac),
operator-misconfiguration handling (unknown provider id =>
500), and the ``dedup_header`` default precedence between adapter
config and per-task overrides.
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
    TaskDefinition,
    TaskRun,
    TaskStatus,
    WebhookTrigger,
)
from autonomous_agents.routes import webhooks as webhooks_route
from autonomous_agents.routes.webhooks import router as webhooks_router
from autonomous_agents.services import webhook_adapters, webhook_runtime

# ``fire_webhook_task`` is called from ``webhook_runtime._fire_and_log``;
# patch the live binding there rather than the route module.
from autonomous_agents.services.webhook_runtime import (
    register_webhook_task as _register,
)


def _make_task(
    task_id: str = "wh-1",
    *,
    secret: str | None = None,
    provider: str = "github",
    dedup_header: str | None = None,
) -> TaskDefinition:
    return TaskDefinition(
        id=task_id,
        name="webhook task",
        agent="dummy-agent",
        prompt="run the thing",
        trigger=WebhookTrigger(
            secret=secret, provider=provider, dedup_header=dedup_header
        ),
    )


class _FakeMongoService:
    """Trigger-instance store stub."""

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

    async def get_trigger_instance(self, dedup_key: str):
        return self._rows.get(dedup_key)


@pytest.fixture
def client(monkeypatch) -> TestClient:
    """Isolated FastAPI app loading the bundled adapter YAML on each test."""
    webhook_adapters.reset_adapters()
    webhook_adapters.load_adapters()

    app = FastAPI()
    app.include_router(webhooks_router, prefix="/api/v1")
    webhook_runtime._webhook_tasks.clear()

    captured: dict[str, Any] = {"calls": []}

    async def _fake_fire(
        task: TaskDefinition,
        context: dict[str, Any],
        follow_up: Any = None,
        *,
        run_id: str | None = None,
        trigger_instance_id: str | None = None,
    ) -> TaskRun:
        actual_run_id = run_id or "r-1"
        captured["calls"].append(
            {
                "task_id": task.id,
                "context": context,
                "run_id": actual_run_id,
                "trigger_instance_id": trigger_instance_id,
            }
        )
        return TaskRun(
            run_id=actual_run_id,
            task_id=task.id,
            task_name=task.name,
            status=TaskStatus.SUCCESS,
            trigger_instance_id=trigger_instance_id,
        )

    monkeypatch.setattr(webhook_runtime, "fire_webhook_task", _fake_fire)

    fake_mongo = _FakeMongoService()
    monkeypatch.setattr(webhook_runtime, "get_mongo_service", lambda: fake_mongo)

    with TestClient(app) as test_client:
        test_client.captured = captured  # type: ignore[attr-defined]
        test_client.mongo = fake_mongo  # type: ignore[attr-defined]
        yield test_client

    webhook_runtime._webhook_tasks.clear()
    get_settings.cache_clear()


def _set_settings(monkeypatch, **overrides: Any) -> Settings:
    overrides.setdefault("webhook_replay_window_seconds", 0)
    overrides.setdefault("webhook_secret", None)
    settings = Settings(**overrides)
    monkeypatch.setattr(webhooks_route, "get_settings", lambda: settings)
    return settings


class TestRegistry:
    """Bundled adapter YAML loads and unknown ids surface as 500."""

    def test_bundled_yaml_loads_all_advertised_providers(self):
        """github / slack / pagerduty / jira / webex / generic_hmac always load."""
        webhook_adapters.reset_adapters()
        adapters = webhook_adapters.load_adapters()
        assert {"github", "slack", "pagerduty", "jira", "webex", "generic_hmac"} <= set(
            adapters.keys()
        )

    def test_unknown_provider_id_raises_500_at_route(self, client, monkeypatch):
        """Unknown provider id returns 500 (operator config bug, not sender bug)."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="this-does-not-exist"))

        resp = client.post("/api/v1/hooks/wh-1", json={})
        assert resp.status_code == 500
        assert "this-does-not-exist" in resp.json()["detail"]


def _slack_sig(secret: str, ts: str, body: bytes) -> str:
    base = f"v0:{ts}:".encode("utf-8") + body
    return "v0=" + hmac.new(secret.encode("utf-8"), base, hashlib.sha256).hexdigest()


class TestSlackAdapter:
    """Slack signing: ``v0:ts:body`` HMAC-SHA256, mandatory timestamp header."""

    def test_accepts_valid_signed_request(self, client, monkeypatch):
        """Valid Slack signature is accepted."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="slack", secret="slack-signing-secret"))

        body = json.dumps({"event": {"type": "app_mention"}}).encode()
        ts = str(int(time.time()))
        sig = _slack_sig("slack-signing-secret", ts, body)

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={
                "X-Slack-Signature": sig,
                "X-Slack-Request-Timestamp": ts,
            },
        )

        assert resp.status_code == 202, resp.text
        assert resp.json()["dedup_strategy"] == "signature"
        assert len(client.captured["calls"]) == 1

    def test_requires_timestamp_header(self, client, monkeypatch):
        """Slack rejects requests without ``X-Slack-Request-Timestamp``."""
        _set_settings(monkeypatch, webhook_replay_window_seconds=0)
        _register(_make_task(provider="slack", secret="s"))

        body = b"{}"
        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Slack-Signature": "v0=deadbeef"},
        )
        assert resp.status_code == 401
        assert "X-Slack-Request-Timestamp" in resp.json()["detail"]

    def test_rejects_old_timestamp_outside_300s(self, client, monkeypatch):
        """Slack rejects timestamps outside the 300s replay window."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="slack", secret="s"))

        body = b"{}"
        old_ts = str(int(time.time()) - 3600)
        sig = _slack_sig("s", old_ts, body)

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={
                "X-Slack-Signature": sig,
                "X-Slack-Request-Timestamp": old_ts,
            },
        )
        assert resp.status_code == 401
        assert "replay window" in resp.json()["detail"]

    def test_signature_mismatch_returns_generic_401(self, client, monkeypatch):
        """Mismatched Slack signature returns a generic 401 (no forgery oracle)."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="slack", secret="real-secret"))

        body = b"{}"
        ts = str(int(time.time()))
        bad_sig = _slack_sig("wrong-secret", ts, body)

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={
                "X-Slack-Signature": bad_sig,
                "X-Slack-Request-Timestamp": ts,
            },
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid webhook signature"


class TestJiraAdapter:
    """Jira signing: WebSub-style ``X-Hub-Signature`` over the raw body."""

    def test_accepts_documented_signed_request(self, client, monkeypatch):
        """Atlassian's documented signed-request example is accepted."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="jira", secret="It's a Secret to Everybody"))

        body = b"Hello World!"
        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={
                "X-Hub-Signature": (
                    "sha256="
                    "a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9"
                ),
                "X-Atlassian-Webhook-Identifier": "tenant-local-delivery-1",
            },
        )

        assert resp.status_code == 202, resp.text
        assert resp.json()["dedup_strategy"] == "header"
        row = next(iter(client.mongo._rows.values()))
        assert row["_id"].endswith(":hdr:tenant-local-delivery-1")
        assert len(client.captured["calls"]) == 1


def _pd_sig(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


class TestPagerDutyAdapter:
    """PagerDuty signing: ``v1=hex,v1=hex`` kv-csv supporting secret rotation."""

    def test_accepts_single_v1_signature(self, client, monkeypatch):
        """Single ``v1=hex`` signature is accepted."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="pagerduty", secret="pd-secret"))

        body = b'{"event":{"id":"abc"}}'
        sig = _pd_sig("pd-secret", body)

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-PagerDuty-Signature": f"v1={sig}"},
        )

        assert resp.status_code == 202, resp.text
        row = next(iter(client.mongo._rows.values()))
        assert row["dedup_strategy"] == "signature"

    def test_accepts_during_secret_rotation(self, client, monkeypatch):
        """``v1=old,v1=new`` is accepted if any signature matches the configured secret."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="pagerduty", secret="new-secret"))

        body = b"{}"
        old_sig = _pd_sig("old-secret", body)
        new_sig = _pd_sig("new-secret", body)

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={
                "X-PagerDuty-Signature": f"v1={old_sig},v1={new_sig}",
            },
        )

        assert resp.status_code == 202

    def test_rejects_when_no_signature_matches(self, client, monkeypatch):
        """All-mismatched ``v1=...,v1=...`` returns a generic 401."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="pagerduty", secret="real"))

        body = b"{}"
        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={
                "X-PagerDuty-Signature": (
                    f"v1={_pd_sig('wrong1', body)},v1={_pd_sig('wrong2', body)}"
                ),
            },
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid webhook signature"


def _spark_sig(secret: str, body: bytes) -> str:
    """Build a Webex ``X-Spark-Signature`` value (HMAC-SHA1 hex of body)."""
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha1).hexdigest()


class TestWebexAdapter:
    """Webex signing: HMAC-SHA1 over body, bare hex in ``X-Spark-Signature``."""

    def test_accepts_valid_signature(self, client, monkeypatch):
        """Valid Webex signature is accepted; canonical row is ``sha1=<hex>``."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="webex", secret="topsecret"))

        body = b'{"data":{"id":"x"}}'
        sig = _spark_sig("topsecret", body)

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Spark-Signature": sig},
        )
        assert resp.status_code == 202, resp.text
        assert resp.json()["dedup_strategy"] == "signature"
        row = next(iter(client.mongo._rows.values()))
        assert row["_id"].startswith("wh-1:sig:")
        assert row["_id"].endswith(sig)

    def test_rejects_mismatched_signature(self, client, monkeypatch):
        """Mismatched Webex signature returns a generic 401."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="webex", secret="topsecret"))

        body = b'{"data":{"id":"x"}}'
        bad_sig = _spark_sig("wrong-secret", body)

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Spark-Signature": bad_sig},
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid webhook signature"

    def test_rejects_missing_signature_header(self, client, monkeypatch):
        """Missing ``X-Spark-Signature`` returns 401 when a Webex secret is configured."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="webex", secret="topsecret"))

        resp = client.post(
            "/api/v1/hooks/wh-1",
            content=b'{"data":{"id":"x"}}',
        )
        assert resp.status_code == 401
        assert "X-Spark-Signature" in resp.json()["detail"]

    def test_dedup_keys_on_signature(self, client, monkeypatch):
        """Webex retries (same body+sig) dedup to the original run_id."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="webex", secret="s"))

        body = b'{"data":{"id":"msg-1"},"id":"event-1"}'
        sig = _spark_sig("s", body)
        headers = {"X-Spark-Signature": sig}

        first = client.post("/api/v1/hooks/wh-1", content=body, headers=headers)
        second = client.post("/api/v1/hooks/wh-1", content=body, headers=headers)

        assert first.status_code == 202
        assert second.status_code == 200
        assert second.json()["status"] == "deduped"
        assert second.json()["run_id"] == first.json()["run_id"]
        assert len(client.captured["calls"]) == 1


class TestGenericHmacAdapter:
    """The generic_hmac adapter exposes a vendor-neutral header."""

    def test_uses_vendor_neutral_header(self, client, monkeypatch):
        """Generic adapter accepts ``X-Webhook-Signature-256``, rejects ``X-Hub-Signature-256``."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="generic_hmac", secret="s"))

        body = b'{"x":1}'
        sig = "sha256=" + hmac.new(b"s", body, hashlib.sha256).hexdigest()

        bad = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Hub-Signature-256": sig},
        )
        assert bad.status_code == 401
        assert "X-Webhook-Signature-256" in bad.json()["detail"]

        ok = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={"X-Webhook-Signature-256": sig},
        )
        assert ok.status_code == 202


class TestDedupHeaderPrecedence:
    """Adapter-declared default ``dedup_header`` vs per-task override."""

    def test_github_default_header_used_when_task_has_none(self, client, monkeypatch):
        """Without per-task override, the github adapter's default ``X-GitHub-Delivery`` is used."""
        _set_settings(monkeypatch)
        _register(_make_task(provider="github", secret="s"))

        body_a = b'{"a":1}'
        body_b = b'{"b":2}'
        delivery_id = "d-uuid-1"
        sig_a = "sha256=" + hmac.new(b"s", body_a, hashlib.sha256).hexdigest()
        sig_b = "sha256=" + hmac.new(b"s", body_b, hashlib.sha256).hexdigest()

        first = client.post(
            "/api/v1/hooks/wh-1",
            content=body_a,
            headers={"X-Hub-Signature-256": sig_a, "X-GitHub-Delivery": delivery_id},
        )
        second = client.post(
            "/api/v1/hooks/wh-1",
            content=body_b,
            headers={"X-Hub-Signature-256": sig_b, "X-GitHub-Delivery": delivery_id},
        )

        assert first.status_code == 202
        assert first.json()["dedup_strategy"] == "header"
        assert second.status_code == 200
        assert second.json()["status"] == "deduped"
        assert len(client.captured["calls"]) == 1

    def test_per_task_dedup_header_overrides_adapter_default(self, client, monkeypatch):
        """Per-task ``dedup_header`` wins over the adapter default."""
        _set_settings(monkeypatch)
        _register(
            _make_task(
                provider="github", secret="s", dedup_header="X-Custom-Delivery-Id"
            )
        )

        body = b"{}"
        sig = "sha256=" + hmac.new(b"s", body, hashlib.sha256).hexdigest()

        first = client.post(
            "/api/v1/hooks/wh-1",
            content=body,
            headers={
                "X-Hub-Signature-256": sig,
                "X-GitHub-Delivery": "ignored-by-task",
                "X-Custom-Delivery-Id": "claim-this",
            },
        )
        assert first.status_code == 202
        assert first.json()["dedup_strategy"] == "header"
        row = next(iter(client.mongo._rows.values()))
        assert row["delivery_header_value"] == "claim-this"
