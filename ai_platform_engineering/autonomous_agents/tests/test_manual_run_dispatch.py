"""Manual retries must recover their original run without another queue slot."""
from collections.abc import Iterator
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import BackgroundTasks, HTTPException
from mongomock_motor import AsyncMongoMockClient

from autonomous_agents.config import Settings
from autonomous_agents.models import TaskDefinition, TaskRun, TaskStatus, WebhookTrigger
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
    mongo = SimpleNamespace(get_trigger_instance=AsyncMock(return_value={
        "run_id": "original-run", "manual_queue_accepted": True}))
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


@pytest.mark.parametrize("failure_stage", ["claim", "enqueue"])
async def test_committed_claim_and_failed_rollback_never_report_phantom_acceptance(
    mongo: MongoService, failure_stage: str
) -> None:
    record = mongo.record_trigger_instance

    async def commit_then_raise(doc: dict) -> None:
        await record(doc)
        raise RuntimeError("Claim acknowledgement lost")

    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo):
        with patch.object(mongo, "delete_unqueued_trigger_instance", AsyncMock(side_effect=RuntimeError("Rollback unavailable"))):
            if failure_stage == "claim":
                with patch.object(mongo, "record_trigger_instance", commit_then_raise), patch.object(
                    webhook_runtime, "_enqueue_webhook_run"
                ) as enqueue:
                    with pytest.raises(HTTPException) as caught:
                        await webhook_runtime.dispatch_webhook_run(**arguments())
                    assert caught.value.status_code == 503
                    enqueue.assert_not_called()
            else:
                with patch.object(webhook_runtime, "_enqueue_webhook_run", side_effect=RuntimeError("Original enqueue error")):
                    with pytest.raises(RuntimeError, match="Original enqueue error"):
                        await webhook_runtime.dispatch_webhook_run(**arguments())
            row = await mongo.get_trigger_instance(arguments()["dedup_key"].key)
            assert row["run_id"]
            with patch.object(webhook_runtime, "_enqueue_webhook_run") as enqueue:
                with pytest.raises(HTTPException) as retry_error:
                    await webhook_runtime.dispatch_webhook_run(**arguments())
                assert retry_error.value.status_code == 503
                assert retry_error.value.headers["Retry-After"] == "1"
                enqueue.assert_not_called()
        assert webhook_runtime.webhook_dispatch_pending() == 0
        with patch.object(webhook_runtime, "_enqueue_webhook_run") as enqueue:
            recovered = await webhook_runtime.dispatch_webhook_run(**arguments())
            duplicate = await webhook_runtime.dispatch_webhook_run(**arguments())
        assert recovered.status_code == 202
        assert duplicate.status_code == 200
        assert duplicate.run_id == recovered.run_id
        enqueue.assert_called_once()


async def test_committed_claim_with_lost_acknowledgement_is_rolled_back(mongo: MongoService) -> None:
    record = mongo.record_trigger_instance

    async def commit_then_raise(doc: dict) -> None:
        await record(doc)
        raise RuntimeError("Claim acknowledgement lost")

    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo):
        with patch.object(mongo, "record_trigger_instance", commit_then_raise), patch.object(
            webhook_runtime, "_enqueue_webhook_run"
        ) as enqueue:
            with pytest.raises(HTTPException) as caught:
                await webhook_runtime.dispatch_webhook_run(**arguments())
            assert caught.value.status_code == 503
            enqueue.assert_not_called()
        assert await mongo.get_trigger_instance(arguments()["dedup_key"].key) is None
        with patch.object(webhook_runtime, "_enqueue_webhook_run"):
            assert (await webhook_runtime.dispatch_webhook_run(**arguments())).status_code == 202


async def test_concurrent_retry_cannot_accept_claim_before_enqueue(mongo: MongoService) -> None:
    record = mongo.record_trigger_instance

    async def record_and_retry(doc: dict) -> tuple:
        result = await record(doc)
        with pytest.raises(HTTPException) as caught:
            await webhook_runtime.dispatch_webhook_run(**arguments())
        assert caught.value.status_code == 503
        return result

    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo), patch.object(
        mongo, "record_trigger_instance", record_and_retry
    ), patch.object(webhook_runtime, "_enqueue_webhook_run") as enqueue:
        assert (await webhook_runtime.dispatch_webhook_run(**arguments())).status_code == 202
        enqueue.assert_called_once()


async def test_live_queue_confirms_acceptance_when_marker_update_fails(mongo: MongoService) -> None:
    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo), patch.object(
        mongo, "mark_manual_trigger_queued", AsyncMock(side_effect=RuntimeError("Marker unavailable"))
    ):
        first = await webhook_runtime.dispatch_webhook_run(**arguments())
        retry = await webhook_runtime.dispatch_webhook_run(**arguments())
    assert first.status_code == 202
    assert retry.status_code == 200
    assert retry.run_id == first.run_id
    assert webhook_runtime.webhook_dispatch_pending() == 1


@pytest.mark.parametrize("recorded_task_id", [None, "other-task", "example-task"])
async def test_unconfirmed_claim_requires_queue_or_matching_run_evidence(
    mongo: MongoService, recorded_task_id: str | None
) -> None:
    await mongo.record_trigger_instance({"_id": arguments()["dedup_key"].key, "run_id": "original-run"})
    if recorded_task_id:
        await mongo.record_run(TaskRun(run_id="original-run", task_id=recorded_task_id,
            task_name="Example", status=TaskStatus.SUCCESS))
    with patch.object(webhook_runtime, "get_mongo_service", return_value=mongo), patch.object(
        webhook_runtime, "_enqueue_webhook_run"
    ) as enqueue:
        if recorded_task_id == "example-task":
            outcome = await webhook_runtime.dispatch_webhook_run(**arguments())
            assert outcome.status_code == 200
            assert outcome.run_id == "original-run"
        else:
            with pytest.raises(HTTPException) as caught:
                await webhook_runtime.dispatch_webhook_run(**arguments())
            assert caught.value.status_code == 503
        enqueue.assert_not_called()
