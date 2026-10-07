"""Webhook payload and in-process dispatch-capacity limits."""

import asyncio

import pytest
from fastapi import BackgroundTasks, HTTPException
from starlette.requests import Request

from autonomous_agents.models import TaskDefinition, WebhookTrigger
from autonomous_agents.services import webhook_runtime
from autonomous_agents.services.trigger_instances import DedupKey
from autonomous_agents.services.webhook_limits import read_limited_webhook_body


def _streaming_request(chunks: list[bytes], content_length: str | None = None) -> Request:
    messages = [
        {
            "type": "http.request",
            "body": chunk,
            "more_body": index < len(chunks) - 1,
        }
        for index, chunk in enumerate(chunks)
    ]

    async def receive() -> dict:
        return messages.pop(0)

    headers = []
    if content_length is not None:
        headers.append((b"content-length", content_length.encode("ascii")))
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/hook",
            "headers": headers,
        },
        receive,
    )


def test_rejects_declared_oversize_body_before_reading() -> None:
    request = _streaming_request([b"not-read"], content_length="9")

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(read_limited_webhook_body(request, max_bytes=8))

    assert exc_info.value.status_code == 413


def test_rejects_chunked_body_that_crosses_limit() -> None:
    request = _streaming_request([b"1234", b"5678"])

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(read_limited_webhook_body(request, max_bytes=7))

    assert exc_info.value.status_code == 413


def test_accepts_body_exactly_at_limit() -> None:
    request = _streaming_request([b"1234", b"5678"])

    body = asyncio.run(read_limited_webhook_body(request, max_bytes=8))

    assert body == b"12345678"


def _task(task_id: str, owner_id: str) -> TaskDefinition:
    return TaskDefinition(
        id=task_id,
        name=task_id,
        dynamic_agent_id="agent-1",
        prompt="Handle event",
        trigger=WebhookTrigger(provider="github", secret="secret"),
        owner_id=owner_id,
    )


def _dispatch(
    task: TaskDefinition,
    background_tasks: BackgroundTasks,
    *,
    body: bytes = b"{}",
    context: dict | None = None,
    pending_per_task: int = 100,
    pending_per_owner: int = 500,
    pending_global: int = 5_000,
    pending_payload_bytes_global: int = 67_108_864,
    concurrent_per_owner: int = 20,
    concurrent_global: int = 100,
):
    return asyncio.run(
        webhook_runtime.dispatch_webhook_run(
            task=task,
            dedup_key=DedupKey(key=None, strategy="none"),
            body=body,
            context=context or {},
            follow_up=None,
            background_tasks=background_tasks,
            max_pending_per_task=pending_per_task,
            max_pending_per_owner=pending_per_owner,
            max_pending_global=pending_global,
            max_pending_payload_bytes_global=pending_payload_bytes_global,
            max_concurrent_per_owner=concurrent_per_owner,
            max_concurrent_global=concurrent_global,
        )
    )


@pytest.fixture(autouse=True)
def _reset_dispatch_limiter():
    webhook_runtime._reset_dispatch_limiter_for_tests()
    yield
    webhook_runtime._reset_dispatch_limiter_for_tests()


@pytest.fixture
def fake_webhook_execution(monkeypatch):
    async def fake_fire_and_log(**_kwargs) -> None:
        return None

    monkeypatch.setattr(webhook_runtime, "_fire_and_log", fake_fire_and_log)


def test_task_queue_limit_drops_only_the_noisy_webhook(fake_webhook_execution) -> None:
    noisy_background = BackgroundTasks()
    other_background = BackgroundTasks()
    noisy_task = _task("noisy-hook", "alice@example.com")
    other_task = _task("other-hook", "alice@example.com")

    assert _dispatch(
        noisy_task, noisy_background, pending_per_task=1
    ).status_code == 202

    with pytest.raises(HTTPException) as exc_info:
        _dispatch(noisy_task, BackgroundTasks(), pending_per_task=1)

    assert exc_info.value.status_code == 429
    assert exc_info.value.headers == {"Retry-After": "1"}
    # A different webhook is not charged to the noisy hook's task quota.
    assert _dispatch(
        other_task, other_background, pending_per_task=1
    ).status_code == 202
    assert webhook_runtime.webhook_dispatch_pending(task_id="noisy-hook") == 1
    assert webhook_runtime.webhook_dispatch_pending(task_id="other-hook") == 1

    asyncio.run(noisy_background())
    asyncio.run(other_background())
    assert webhook_runtime.webhook_dispatch_pending() == 0


def test_owner_queue_limit_isolates_different_people(fake_webhook_execution) -> None:
    alice_background = BackgroundTasks()
    bob_background = BackgroundTasks()

    assert _dispatch(
        _task("alice-hook-1", "alice@example.com"),
        alice_background,
        pending_per_owner=1,
    ).status_code == 202

    with pytest.raises(HTTPException) as exc_info:
        _dispatch(
            _task("alice-hook-2", "alice@example.com"),
            BackgroundTasks(),
            pending_per_owner=1,
        )

    assert exc_info.value.status_code == 429
    # Alice exhausting her owner quota does not consume Bob's quota.
    assert _dispatch(
        _task("bob-hook", "bob@example.com"),
        bob_background,
        pending_per_owner=1,
    ).status_code == 202

    asyncio.run(alice_background())
    asyncio.run(bob_background())
    assert webhook_runtime.webhook_dispatch_pending() == 0


def test_global_queue_limit_remains_an_emergency_ceiling(fake_webhook_execution) -> None:
    first_background = BackgroundTasks()

    assert _dispatch(
        _task("hook-1", "alice@example.com"),
        first_background,
        pending_global=1,
    ).status_code == 202

    with pytest.raises(HTTPException) as exc_info:
        _dispatch(
            _task("hook-2", "bob@example.com"),
            BackgroundTasks(),
            pending_global=1,
        )

    assert exc_info.value.status_code == 429

    asyncio.run(first_background())
    assert webhook_runtime.webhook_dispatch_pending() == 0


def test_same_webhook_runs_fifo_and_never_concurrently(monkeypatch) -> None:
    active = 0
    max_active = 0
    order: list[int] = []

    async def fake_fire_and_log(**kwargs) -> None:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0)
        order.append(kwargs["context"]["sequence"])
        active -= 1

    monkeypatch.setattr(webhook_runtime, "_fire_and_log", fake_fire_and_log)
    task = _task("serial-hook", "alice@example.com")
    first_background = BackgroundTasks()
    second_background = BackgroundTasks()

    assert _dispatch(
        task, first_background, context={"sequence": 1}
    ).status_code == 202
    assert _dispatch(
        task, second_background, context={"sequence": 2}
    ).status_code == 202
    assert order == []

    asyncio.run(first_background())
    asyncio.run(second_background())

    assert order == [1, 2]
    assert max_active == 1
    assert webhook_runtime.webhook_dispatch_pending() == 0


def test_different_webhooks_can_run_concurrently(monkeypatch) -> None:
    active = 0
    max_active = 0

    async def fake_fire_and_log(**_kwargs) -> None:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1

    monkeypatch.setattr(webhook_runtime, "_fire_and_log", fake_fire_and_log)
    first_background = BackgroundTasks()
    second_background = BackgroundTasks()
    _dispatch(_task("hook-1", "alice@example.com"), first_background)
    _dispatch(_task("hook-2", "bob@example.com"), second_background)

    async def run_background_tasks() -> None:
        await asyncio.gather(first_background(), second_background())

    asyncio.run(run_background_tasks())

    assert max_active == 2
    assert webhook_runtime.webhook_dispatch_pending() == 0


def test_global_worker_limit_bounds_cross_webhook_execution(monkeypatch) -> None:
    active = 0
    max_active = 0

    async def fake_fire_and_log(**_kwargs) -> None:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1

    monkeypatch.setattr(webhook_runtime, "_fire_and_log", fake_fire_and_log)
    first_background = BackgroundTasks()
    second_background = BackgroundTasks()
    _dispatch(
        _task("hook-1", "alice@example.com"),
        first_background,
        concurrent_global=1,
    )
    _dispatch(
        _task("hook-2", "bob@example.com"),
        second_background,
        concurrent_global=1,
    )

    async def run_background_tasks() -> None:
        await asyncio.gather(first_background(), second_background())

    asyncio.run(run_background_tasks())

    assert max_active == 1
    assert webhook_runtime.webhook_dispatch_pending() == 0


def test_queued_payload_byte_budget_rejects_excess(fake_webhook_execution) -> None:
    first_background = BackgroundTasks()
    _dispatch(
        _task("hook-1", "alice@example.com"),
        first_background,
        body=b"12",
        pending_payload_bytes_global=3,
    )

    with pytest.raises(HTTPException) as exc_info:
        _dispatch(
            _task("hook-2", "bob@example.com"),
            BackgroundTasks(),
            body=b"34",
            pending_payload_bytes_global=3,
        )

    assert exc_info.value.status_code == 429
    asyncio.run(first_background())
