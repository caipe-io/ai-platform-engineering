"""Manual retries must recover their original run without another queue slot."""
from collections.abc import Iterator
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import BackgroundTasks, HTTPException
from mongomock_motor import AsyncMongoMockClient

from autonomous_agents.config import Settings
from autonomous_agents.models import TaskDefinition, WebhookTrigger
from autonomous_agents.services import webhook_runtime
from autonomous_agents.services.mongo import MongoService
from autonomous_agents.services.trigger_instances import DedupKey


def arguments() -> dict:
    return dict(task=TaskDefinition(id="example-task", name="Example", prompt="Review",
        dynamic_agent_id="example-agent", trigger=WebhookTrigger(provider="github")),
        dedup_key=DedupKey(key="example-task:manual:nonce", strategy="manual"),
        body=b"{}", context={}, follow_up=None, background_tasks=BackgroundTasks(),
        max_pending_per_task=10, max_pending_per_owner=10, max_pending_global=10,
        max_pending_payload_bytes_global=32768, max_concurrent_per_owner=1, max_concurrent_global=1)


async def test_manual_retry_recovers_original_run_even_with_full_queues() -> None:
    mongo = SimpleNamespace(get_trigger_instance=AsyncMock(return_value={"run_id": "original-run"}))
    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo), patch.object(
        webhook_runtime, "_try_reserve_queue_slot", side_effect=AssertionError("Duplicate reserved capacity")
    ):
        outcome = await webhook_runtime.dispatch_webhook_run(**arguments())
    assert outcome.status_code == 200
    assert outcome.run_id == "original-run"
    assert outcome.claimed is False


async def test_pending_manual_claim_returns_retryable_error_not_empty_run_id() -> None:
    mongo = SimpleNamespace(get_trigger_instance=AsyncMock(return_value={"run_id": None}))
    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo):
        with pytest.raises(HTTPException) as caught:
            await webhook_runtime.dispatch_webhook_run(**arguments())
    assert caught.value.status_code == 503
    assert caught.value.headers["Retry-After"] == "1"


async def test_simultaneous_retry_releases_slot_and_returns_retryable_error() -> None:
    mongo = SimpleNamespace(get_trigger_instance=AsyncMock(return_value=None))
    claim = SimpleNamespace(claimed=False, existing_run_id=None)
    lease = object()
    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo), patch.object(
        webhook_runtime, "_try_reserve_queue_slot", return_value=(lease, None)
    ), patch.object(webhook_runtime, "_claim_or_log", AsyncMock(return_value=claim)), patch.object(
        webhook_runtime, "_release_queue_slot"
    ) as release:
        with pytest.raises(HTTPException) as caught:
            await webhook_runtime.dispatch_webhook_run(**arguments())
    assert caught.value.status_code == 503
    release.assert_called_once_with(lease)


@pytest.fixture
def mongo() -> MongoService:
    service = MongoService(settings=Settings(_env_file=None, mongodb_database="example"))
    service.connect_with_client(AsyncMongoMockClient())
    return service


@pytest.fixture(autouse=True)
def reset_dispatch_limits() -> Iterator[None]:
    webhook_runtime._reset_dispatch_limiter_for_tests()
    yield
    webhook_runtime._reset_dispatch_limiter_for_tests()


async def test_manual_claim_persists_run_id_atomically_without_audit_attachment(mongo: MongoService) -> None:
    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo), patch.object(
        mongo, "attach_run_to_trigger_instance", AsyncMock(side_effect=RuntimeError("Audit update unavailable"))
    ) as attach, patch.object(webhook_runtime, "_enqueue_webhook_run") as enqueue:
        first = await webhook_runtime.dispatch_webhook_run(**arguments())
        row = await mongo.get_trigger_instance(arguments()["dedup_key"].key)
        assert row["run_id"] == first.run_id
        retry = await webhook_runtime.dispatch_webhook_run(**arguments())
    assert first.status_code == 202
    assert retry.status_code == 200
    assert retry.run_id == first.run_id
    assert enqueue.call_args.args[0].run_id == first.run_id
    enqueue.assert_called_once()
    attach.assert_not_called()


async def test_failed_enqueue_releases_claim_and_capacity_for_same_request(mongo: MongoService) -> None:
    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo), patch.object(
        webhook_runtime, "_enqueue_webhook_run", side_effect=RuntimeError("Queue unavailable")
    ):
        with pytest.raises(RuntimeError, match="Queue unavailable"):
            await webhook_runtime.dispatch_webhook_run(**arguments())
    assert await mongo.get_trigger_instance(arguments()["dedup_key"].key) is None
    assert webhook_runtime.webhook_dispatch_pending() == 0
    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo), patch.object(
        webhook_runtime, "_enqueue_webhook_run"
    ):
        retry = await webhook_runtime.dispatch_webhook_run(**arguments())
    assert retry.status_code == 202
    assert retry.run_id


async def test_failed_atomic_claim_does_not_enqueue_and_can_retry(mongo: MongoService) -> None:
    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo), patch.object(
        mongo, "record_trigger_instance", AsyncMock(side_effect=RuntimeError("Store unavailable"))
    ), patch.object(webhook_runtime, "_enqueue_webhook_run") as enqueue:
        with pytest.raises(HTTPException) as caught:
            await webhook_runtime.dispatch_webhook_run(**arguments())
        assert caught.value.status_code == 503
        enqueue.assert_not_called()
    assert webhook_runtime.webhook_dispatch_pending() == 0
    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo), patch.object(
        webhook_runtime, "_enqueue_webhook_run"
    ):
        retry = await webhook_runtime.dispatch_webhook_run(**arguments())
    assert retry.status_code == 202


async def test_failed_enqueue_cleanup_preserves_another_run_claim(mongo: MongoService) -> None:
    key = arguments()["dedup_key"].key
    await mongo.record_trigger_instance({"_id": key, "run_id": "replacement-run"})
    await mongo.delete_unqueued_trigger_instance(key, "failed-run")
    assert (await mongo.get_trigger_instance(key))["run_id"] == "replacement-run"
