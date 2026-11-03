"""Manual retries must recover their original run without another queue slot."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import BackgroundTasks, HTTPException

from autonomous_agents.models import TaskDefinition, WebhookTrigger
from autonomous_agents.services import webhook_runtime
from autonomous_agents.services.trigger_instances import DedupKey


def arguments() -> dict:
    return dict(task=TaskDefinition(id="example-task", name="Example", prompt="Review",
        dynamic_agent_id="example-agent", trigger=WebhookTrigger(provider="github")),
        dedup_key=DedupKey(key="example-task:manual:nonce", strategy="manual"),
        body=b"{}", context={}, follow_up=None, background_tasks=BackgroundTasks(),
        max_pending_per_task=0, max_pending_per_owner=0, max_pending_global=0,
        max_pending_payload_bytes_global=0, max_concurrent_per_owner=1, max_concurrent_global=1)


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
