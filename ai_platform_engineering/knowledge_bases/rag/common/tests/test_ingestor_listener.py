from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock
from contextlib import asynccontextmanager
from types import SimpleNamespace
from collections.abc import AsyncIterator
from pydantic import BaseModel

import pytest

from common.ingestor_listener import reload_persisted_datasources
from common import ingestor_listener as listener
from common.mongo_storage import CURRENT_CLAIM
from common.models.server import IngestorRequest
from common.job_manager import JobInfo, JobStatus
from common.models.rag import DataSourceInfo


def _datasource(
  datasource_id: str,
  *,
  last_updated: int | None,
  reload_interval: int = 3600,
) -> DataSourceInfo:
  return DataSourceInfo(
    datasource_id=datasource_id,
    ingestor_id="example:primary",
    source_type="example",
    last_updated=last_updated,
    reload_interval=reload_interval,
  )


def test_reload_persisted_datasources_honors_each_interval(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  monkeypatch.setattr("common.ingestor_listener.time.time", lambda: 10_000)
  due = _datasource("due", last_updated=5_000, reload_interval=3600)
  fresh = _datasource("fresh", last_updated=9_500, reload_interval=3600)
  client = AsyncMock()
  client.ingestor_id = "example:primary"
  client.list_datasources.return_value = [due, fresh]
  job_manager = AsyncMock()
  job_manager.get_jobs_by_datasource.return_value = None
  reload_handler = AsyncMock()

  result = asyncio.run(
    reload_persisted_datasources(
      client,
      reload_handler,
      job_manager=job_manager,
    )
  )

  assert result == (1, 1)
  reload_handler.assert_awaited_once_with(client, job_manager, due, None)


def test_reload_persisted_datasources_skips_active_job(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  monkeypatch.setattr("common.ingestor_listener.time.time", lambda: 10_000)
  datasource = _datasource("primary", last_updated=0)
  client = AsyncMock()
  client.ingestor_id = "example:primary"
  client.list_datasources.return_value = [datasource]
  job_manager = AsyncMock()
  job_manager.get_jobs_by_datasource.return_value = [
    JobInfo(
      job_id="job-primary",
      status=JobStatus.IN_PROGRESS,
      created_at=9_000,
      datasource_id="primary",
    )
  ]
  reload_handler = AsyncMock()

  result = asyncio.run(
    reload_persisted_datasources(
      client,
      reload_handler,
      due_only=False,
      job_manager=job_manager,
    )
  )

  assert result == (0, 1)
  reload_handler.assert_not_awaited()


def test_reload_persisted_datasources_isolates_source_failure(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  monkeypatch.setattr("common.ingestor_listener.time.time", lambda: 10_000)
  first = _datasource("first", last_updated=0)
  second = _datasource("second", last_updated=0)
  client = AsyncMock()
  client.ingestor_id = "example:primary"
  client.list_datasources.return_value = [first, second]
  job_manager = AsyncMock()
  job_manager.get_jobs_by_datasource.return_value = None
  reload_handler = AsyncMock(side_effect=[RuntimeError("first failed"), None])

  result = asyncio.run(
    reload_persisted_datasources(
      client,
      reload_handler,
      job_manager=job_manager,
    )
  )

  assert result == (1, 0)
  assert reload_handler.await_count == 2


def test_reload_persisted_datasources_handles_list_failure() -> None:
  client = AsyncMock()
  client.ingestor_id = "example:primary"
  client.list_datasources.side_effect = ConnectionError("metadata unavailable")
  job_manager = AsyncMock()
  reload_handler = AsyncMock()

  result = asyncio.run(
    reload_persisted_datasources(
      client,
      reload_handler,
      job_manager=job_manager,
    )
  )

  assert result == (0, 0)
  reload_handler.assert_not_awaited()


def test_periodic_reload_preserves_durable_old_pending_command():
  client = AsyncMock()
  client.ingestor_id = "example:primary"
  client.list_datasources.return_value = [_datasource("primary", last_updated=0)]
  manager = AsyncMock()
  manager.get_jobs_by_datasource.return_value = [JobInfo(job_id="primary", status=JobStatus.PENDING, created_at=0, datasource_id="primary")]
  manager.fail_stale_pending_job.return_value = False
  handler = AsyncMock()
  assert asyncio.run(reload_persisted_datasources(client, handler, due_only=False, job_manager=manager)) == (0, 1)
  handler.assert_not_awaited()


@pytest.mark.parametrize("cancelled", [False, True])
def test_listener_records_failure_inside_claim_and_preserves_cancellation(monkeypatch: pytest.MonkeyPatch, cancelled: bool) -> None:
  async def scenario() -> None:

    class Payload(BaseModel):
      pass

    storage, manager = AsyncMock(), AsyncMock()
    manager.get_job.return_value = JobInfo(job_id="primary", status=JobStatus.IN_PROGRESS, created_at=0, datasource_id="primary")
    command = {"_id": "command", "token": "command-token", "payload": IngestorRequest(ingestor_id="primary", command="ingest", payload={}, job_id="primary").model_dump_json()}
    received, started, failed = False, asyncio.Event(), asyncio.Event()
    contexts = []

    async def claim(_queue: str) -> dict | None:
      nonlocal received
      if not received:
        received = True
        return command
      await asyncio.Event().wait()
      return None

    async def finish(_command: dict, *, failed: bool = False) -> None:
      if failed:
        contexts.append(CURRENT_CLAIM.get())

    async def update(*args: object, **kwargs: object) -> bool:
      contexts.append(CURRENT_CLAIM.get())
      failed.set()
      return True

    async def handler(*args: object) -> None:
      started.set()
      if cancelled:
        await asyncio.Event().wait()
      raise ValueError("example failure")

    @asynccontextmanager
    async def ownership(*args: object) -> AsyncIterator[bool]:
      marker = CURRENT_CLAIM.set({"_id": "primary", "token": "owner"})
      try:
        yield True
      finally:
        CURRENT_CLAIM.reset(marker)

    storage.claim_command.side_effect = claim
    storage.finish_command.side_effect = finish
    manager.upsert_job.side_effect = update
    monkeypatch.setattr(listener, "MongoStorage", MagicMock(return_value=storage))
    monkeypatch.setattr(listener, "JobManager", MagicMock(return_value=manager))
    monkeypatch.setattr(listener, "ingestion_claim", ownership)
    task = asyncio.create_task(listener.run_ingestor_listener(
      SimpleNamespace(ingestor_id="primary", ingestor_type="example"), ingest_command="ingest", ingest_model=Payload,
      ingest_handler=handler, reload_all_command="reload-all", reload_all_handler=AsyncMock(),
      reload_datasource_command="reload", reload_model=Payload, reload_handler=AsyncMock(),
    ))
    await asyncio.wait_for(started.wait(), 1)
    if not cancelled:
      await asyncio.wait_for(failed.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
      await task
    assert contexts[0] == {"_id": "primary", "token": "owner"}
    storage.finish_command.assert_awaited_once_with(command, failed=True)
  asyncio.run(scenario())


def test_lease_loss_stops_operation_without_cancelling_scheduler(monkeypatch: pytest.MonkeyPatch) -> None:
  async def scenario() -> None:
    storage = AsyncMock()
    storage.acquire_datasource.return_value = {"_id": "primary", "token": "lease"}
    storage.renew.return_value = False
    monkeypatch.setattr(listener, "LEASE_SECONDS", 0.003)
    stopped = asyncio.Event()

    async def operation() -> None:
      try:
        await asyncio.Event().wait()
      finally:
        stopped.set()

    with pytest.raises(listener.IngestionLeaseLostError):
      await listener.run_claimed_ingestion(storage, "primary", operation)
    assert stopped.is_set()
    assert asyncio.current_task().cancelling() == 0
    completed = AsyncMock()
    storage.renew.return_value = True
    assert await listener.run_claimed_ingestion(storage, "secondary", completed)
    completed.assert_awaited_once()
    assert CURRENT_CLAIM.get() is None

  asyncio.run(scenario())


def test_external_cancellation_is_not_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
  async def scenario() -> None:
    storage = AsyncMock()
    storage.acquire_datasource.return_value = {"_id": "primary", "token": "lease"}
    started = asyncio.Event()

    async def operation() -> None:
      started.set()
      await asyncio.Event().wait()

    task = asyncio.create_task(listener.run_claimed_ingestion(storage, "primary", operation))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
      await task
    storage.release_datasource.assert_awaited_once()

  asyncio.run(scenario())


def test_invalid_command_acknowledgement_failure_keeps_listener_alive(monkeypatch: pytest.MonkeyPatch) -> None:
  async def scenario() -> None:
    storage, manager = AsyncMock(), AsyncMock()
    received = asyncio.Event()
    count = 0

    async def claim(_queue: str) -> dict | None:
      nonlocal count
      count += 1
      if count == 1:
        return {"_id": "invalid", "payload": "not-json"}
      received.set()
      await asyncio.Event().wait()
      return None

    storage.claim_command.side_effect = claim
    storage.finish_command.side_effect = ConnectionError("database unavailable")
    monkeypatch.setattr(listener, "MongoStorage", lambda: storage)
    monkeypatch.setattr(listener, "JobManager", lambda **_kwargs: manager)
    handler = AsyncMock()
    client = SimpleNamespace(ingestor_id="primary", ingestor_type="example")
    task = asyncio.create_task(listener.run_ingestor_listener(
      client, ingest_command="ingest", ingest_model=BaseModel, ingest_handler=handler,
      reload_all_command="reload_all", reload_all_handler=handler,
      reload_datasource_command="reload", reload_model=BaseModel, reload_handler=handler,
    ))
    await asyncio.wait_for(received.wait(), 1)
    assert not task.done()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
      await task
    storage.finish_command.assert_awaited_once()

  asyncio.run(scenario())
