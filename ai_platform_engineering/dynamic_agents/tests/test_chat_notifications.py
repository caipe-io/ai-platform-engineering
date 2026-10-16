"""Chat-run notifications: agent.completed (long runs only) and agent.failed."""

from __future__ import annotations

import asyncio
import importlib
import itertools
import urllib.error
from types import SimpleNamespace
from typing import Any

import pytest

chat = importlib.import_module("dynamic_agents.routes.chat")
nc = importlib.import_module("dynamic_agents.services.notifications_client")
runtime_cache = importlib.import_module("dynamic_agents.services.runtime_cache")
models = importlib.import_module("dynamic_agents.models")


class _Encoder:
    def on_run_error(self, message: str, code: str | None = None) -> list[str]:
        return [f"error:{message}"]


class _Runtime:
    def __init__(self, *, fail: Exception | None = None, interrupt: dict | None = None, cancelled: bool = False) -> None:
        self._fail = fail
        self._interrupt = interrupt
        self._cancelled = cancelled

    async def stream(self, *args: Any, **kwargs: Any):
        yield "frame-1"
        if self._fail:
            raise self._fail
        yield "frame-2"

    async def has_pending_interrupt(self, session_id: str) -> dict | None:
        return self._interrupt


class _Cache:
    def __init__(self, runtime: _Runtime | None = None, raises: Exception | None = None) -> None:
        self._runtime = runtime
        self._raises = raises

    def set_mongo_service(self, _mongo: Any) -> None:
        pass

    async def get_or_create(self, *args: Any, **kwargs: Any) -> _Runtime:
        if self._raises:
            raise self._raises
        assert self._runtime is not None
        return self._runtime


AGENT = SimpleNamespace(id="agent-1", name="Helper Agent")
USER = models.UserContext(email="user@example.com", sub="sub-user-1")


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "test-token")
    monkeypatch.delenv("NOTIFICATION_EVENTS_ENABLED", raising=False)
    monkeypatch.delenv("NOTIFICATION_CHAT_MIN_SECONDS", raising=False)
    monkeypatch.setattr(nc.time, "sleep", lambda _s: None)


@pytest.fixture
def published(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    events: list[dict] = []
    monkeypatch.setattr(chat, "schedule_publish", events.append)
    return events


def _clock(monkeypatch: pytest.MonkeyPatch, elapsed: float) -> None:
    ticks = itertools.chain([0.0, elapsed], itertools.repeat(elapsed))
    monkeypatch.setattr(chat, "time", SimpleNamespace(monotonic=lambda: next(ticks)))


async def _run(monkeypatch: pytest.MonkeyPatch, cache: _Cache, *, turn_id: str | None = "turn-1", suppress: bool = False) -> list[str]:
    monkeypatch.setattr(chat, "get_runtime_cache", lambda: cache)
    frames = [
        frame
        async for frame in chat._generate_sse_events(
            AGENT, [], "hello SECRET", "conv-1", USER, _Encoder(), turn_id=turn_id, suppress_notifications=suppress
        )
    ]
    await asyncio.gather(*list(chat._notification_tasks))
    return frames


async def test_long_run_emits_completed(monkeypatch: pytest.MonkeyPatch, published: list[dict]) -> None:
    _clock(monkeypatch, 45.0)
    frames = await _run(monkeypatch, _Cache(_Runtime()))
    assert frames == ["frame-1", "frame-2"]
    assert len(published) == 1
    event = published[0]
    assert event["type"] == "agent.completed"
    assert event["resource"] == {"type": "conversation", "id": "conv-1"}
    assert event["attempt_id"] == "conv-1:turn-1"
    assert event["recipients"] == [{"subject": "sub-user-1", "email": "user@example.com"}]
    assert event["data"]["href"] == "/chat/conv-1"
    assert "SECRET" not in str(event)


async def test_short_run_does_not_emit_completed(monkeypatch: pytest.MonkeyPatch, published: list[dict]) -> None:
    _clock(monkeypatch, 5.0)
    await _run(monkeypatch, _Cache(_Runtime()))
    assert published == []


async def test_min_seconds_env_is_respected(monkeypatch: pytest.MonkeyPatch, published: list[dict]) -> None:
    monkeypatch.setenv("NOTIFICATION_CHAT_MIN_SECONDS", "2")
    _clock(monkeypatch, 5.0)
    await _run(monkeypatch, _Cache(_Runtime()))
    assert [e["type"] for e in published] == ["agent.completed"]


async def test_cancelled_or_interrupted_run_does_not_emit(monkeypatch: pytest.MonkeyPatch, published: list[dict]) -> None:
    _clock(monkeypatch, 60.0)
    await _run(monkeypatch, _Cache(_Runtime(cancelled=True)))
    _clock(monkeypatch, 60.0)
    await _run(monkeypatch, _Cache(_Runtime(interrupt={"type": "form_input"})))
    assert published == []


@pytest.mark.parametrize(
    "cache",
    [
        _Cache(raises=runtime_cache.RuntimeCapacityError("full")),
        _Cache(raises=runtime_cache.RuntimeInitError("agent-1", RuntimeError("bad"))),
        _Cache(raises=RuntimeError("boom token=abc123")),
        _Cache(runtime=_Runtime(fail=RuntimeError("mid-stream abc123"))),
    ],
)
async def test_short_failure_still_emits_failed(monkeypatch: pytest.MonkeyPatch, published: list[dict], cache: _Cache) -> None:
    _clock(monkeypatch, 1.0)
    frames = await _run(monkeypatch, cache)
    assert frames[-1].startswith("error:")
    assert [e["type"] for e in published] == ["agent.failed"]
    assert published[0]["data"]["status"] == "failed"
    assert "abc123" not in str(published[0])


async def test_unattended_runs_are_suppressed(monkeypatch: pytest.MonkeyPatch, published: list[dict]) -> None:
    _clock(monkeypatch, 60.0)
    await _run(monkeypatch, _Cache(_Runtime()), suppress=True)
    _clock(monkeypatch, 60.0)
    await _run(monkeypatch, _Cache(raises=RuntimeError("x")), suppress=True)
    assert published == []


def test_suppress_helper() -> None:
    assert chat._suppress_chat_notifications(SimpleNamespace(autonomous=True, client_context=None)) is True
    assert chat._suppress_chat_notifications(SimpleNamespace(autonomous=False, client_context=None)) is False
    assert chat._suppress_chat_notifications(SimpleNamespace(autonomous=False, client_context=models.ClientContext(source="scheduler"))) is True


@pytest.mark.parametrize("failure", [urllib.error.URLError("refused"), TimeoutError("slow")])
async def test_real_client_errors_never_change_stream(monkeypatch: pytest.MonkeyPatch, failure: Exception) -> None:
    def boom(*_args: object) -> int:
        raise failure

    monkeypatch.setattr(nc, "_post", boom)
    _clock(monkeypatch, 60.0)
    frames = await _run(monkeypatch, _Cache(_Runtime()))
    assert frames == ["frame-1", "frame-2"]
    for pending in list(nc._background_tasks):
        assert await pending is False


async def test_real_client_5xx_never_changes_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(nc, "_post", lambda *_a: 503)
    _clock(monkeypatch, 1.0)
    frames = await _run(monkeypatch, _Cache(raises=RuntimeError("x")))
    assert frames == [f"error:{chat.GENERIC_AGENT_ERROR}"]
    for pending in list(nc._background_tasks):
        assert await pending is False


async def test_kill_switch_and_missing_token_send_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[Any] = []
    monkeypatch.setattr(nc, "_post", lambda *a: calls.append(a) or 202)
    monkeypatch.setenv("NOTIFICATION_EVENTS_ENABLED", "false")
    _clock(monkeypatch, 60.0)
    await _run(monkeypatch, _Cache(_Runtime()))
    monkeypatch.delenv("NOTIFICATION_EVENTS_ENABLED")
    monkeypatch.setenv("NOTIFICATIONS_INTERNAL_TOKEN", "")
    _clock(monkeypatch, 60.0)
    await _run(monkeypatch, _Cache(raises=RuntimeError("x")))
    assert calls == []
    assert chat._chat_min_seconds() == 30.0
