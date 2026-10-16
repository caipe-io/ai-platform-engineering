"""Tests for the notification publisher client (never raises, kill switch, retry)."""

import asyncio
import json
from pathlib import Path
import urllib.error

import pytest

from ai_platform_engineering.utils.notifications import client as nc


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "test-token")
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_URL", "http://ui.example.com:3000/")
    monkeypatch.delenv("NOTIFICATION_EVENTS_ENABLED", raising=False)
    monkeypatch.setattr(nc.time, "sleep", lambda _s: None)


def _event() -> dict:
    return nc.build_event(
        event_type="agent.completed",
        resource_type="conversation",
        resource_id="c1",
        attempt_id="a1",
        status="success",
        title="t" * 300,
        summary="s" * 900,
        recipients=[{"email": f"user{i}@example.com"} for i in range(60)],
        href="/chat/c1",
        include_org_admins=True,
    )


def test_build_event_matches_contract():
    event = _event()
    assert event["version"] == 1
    assert event["type"] == "agent.completed"
    assert event["resource"] == {"type": "conversation", "id": "c1"}
    assert event["attempt_id"] == "a1"
    assert len(event["data"]["title"]) <= 200
    assert len(event["data"]["summary"]) <= 500
    assert event["data"]["href"] == "/chat/c1"
    assert len(event["recipients"]) == 50
    assert event["include_org_admins"] is True
    assert event["occurred_at"].endswith("Z")


def test_build_event_drops_non_relative_href():
    event = nc.build_event(
        event_type="agent.failed", resource_type="r", resource_id="1", attempt_id="a",
        status="failed", title="t", summary="s", recipients=[], href="https://evil.example.com",
    )
    assert "href" not in event["data"]


def test_posts_url_headers_and_body(monkeypatch):
    seen = {}

    def fake_post(url, token, body):
        seen.update(url=url, token=token, body=json.loads(body))
        return 202

    monkeypatch.setattr(nc, "_post", fake_post)
    assert nc.publish_event_sync(_event()) is True
    assert seen["url"] == "http://ui.example.com:3000/api/internal/notifications/events"
    assert seen["token"] == "test-token"
    assert seen["body"]["attempt_id"] == "a1"


def test_default_url(monkeypatch):
    monkeypatch.delenv("NOTIFICATIONS_INTERNAL_URL")
    seen = {}
    monkeypatch.setattr(nc, "_post", lambda url, token, body: seen.setdefault("url", url) and 202)
    assert nc.publish_event_sync(_event()) is True
    assert seen["url"].startswith("http://caipe-ui:3000/")


@pytest.mark.parametrize("env", [("NOTIFICATION_EVENTS_ENABLED", "false"), ("NOTIFICATIONS_INTERNAL_TOKEN", "")])
def test_kill_switch_and_missing_token_are_noops(monkeypatch, env):
    monkeypatch.setenv(*env)
    calls = []
    monkeypatch.setattr(nc, "_post", lambda *a: calls.append(a) or 202)
    assert nc.events_enabled() is False
    assert nc.publish_event_sync(_event()) is False
    assert nc.schedule_publish(_event()) is None
    assert calls == []


def test_retries_once_on_503_then_succeeds(monkeypatch):
    codes = iter([503, 202])
    calls = []
    monkeypatch.setattr(nc, "_post", lambda *a: calls.append(1) or next(codes))
    assert nc.publish_event_sync(_event()) is True
    assert len(calls) == 2


def test_503_twice_gives_up_without_raising(monkeypatch):
    calls = []
    monkeypatch.setattr(nc, "_post", lambda *a: calls.append(1) or 503)
    assert nc.publish_event_sync(_event()) is False
    assert len(calls) == 2


@pytest.mark.parametrize("code", [400, 401, 500])
def test_non_retryable_status_not_retried(monkeypatch, code):
    calls = []
    monkeypatch.setattr(nc, "_post", lambda *a: calls.append(1) or code)
    assert nc.publish_event_sync(_event()) is False
    assert len(calls) == 1


def test_connection_error_retries_once_and_is_swallowed(monkeypatch):
    calls = []

    def boom(*_a):
        calls.append(1)
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(nc, "_post", boom)
    assert nc.publish_event_sync(_event()) is False
    assert len(calls) == 2


def test_timeout_and_unexpected_errors_swallowed(monkeypatch):
    monkeypatch.setattr(nc, "_post", lambda *a: (_ for _ in ()).throw(TimeoutError("slow")))
    assert nc.publish_event_sync(_event()) is False
    monkeypatch.setattr(nc, "_post", lambda *a: (_ for _ in ()).throw(ValueError("bug")))
    assert nc.publish_event_sync(_event()) is False


def test_async_publish_and_schedule(monkeypatch):
    monkeypatch.setattr(nc, "_post", lambda *a: 202)

    async def scenario() -> tuple[bool, bool]:
        direct = await nc.publish_event(_event())
        task = nc.schedule_publish(_event())
        assert task is not None
        return direct, await task

    assert asyncio.run(scenario()) == (True, True)


def test_async_publish_swallows_errors(monkeypatch):
    monkeypatch.setattr(nc, "_post", lambda *a: (_ for _ in ()).throw(RuntimeError("x")))
    assert asyncio.run(nc.publish_event(_event())) is False


def _normalized(path: Path) -> str:
    """Source with leading indentation stripped, so 2-space and 4-space copies compare equal."""
    return "\n".join(line.strip() for line in path.read_text().splitlines())


def test_service_copies_match_canonical_client() -> None:
    root = Path(__file__).resolve().parents[2]
    canonical = _normalized(root / "utils/notifications/client.py")
    copies = [
        root / "knowledge_bases/rag/common/src/common/notifications_client.py",
        root / "autonomous_agents/src/autonomous_agents/services/notifications_client.py",
        root / "dynamic_agents/src/dynamic_agents/services/notifications_client.py",
    ]
    for copy in copies:
        assert _normalized(copy) == canonical, f"{copy} drifted from utils/notifications/client.py"
