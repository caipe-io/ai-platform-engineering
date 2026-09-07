from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from common.ingestor_listener import (
  configured_reload_interval,
  reload_persisted_datasources,
)
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


def test_reload_persisted_datasources_can_select_database_managed_sources(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  monkeypatch.setattr("common.ingestor_listener.time.time", lambda: 10_000)
  legacy = _datasource("legacy", last_updated=0)
  managed = _datasource("managed", last_updated=0)
  managed.metadata = {"config_managed": True}
  client = AsyncMock()
  client.ingestor_id = "example:primary"
  client.list_datasources.return_value = [legacy, managed]
  job_manager = AsyncMock()
  job_manager.get_jobs_by_datasource.return_value = None
  reload_handler = AsyncMock()

  result = asyncio.run(
    reload_persisted_datasources(
      client,
      reload_handler,
      config_managed_only=True,
      job_manager=job_manager,
    )
  )

  assert result == (1, 1)
  reload_handler.assert_awaited_once_with(client, job_manager, managed, None)


def test_configured_reload_interval_preserves_existing_cadence() -> None:
  datasource = _datasource("existing", last_updated=0, reload_interval=7200)

  assert configured_reload_interval({}) == 86400
  assert configured_reload_interval({}, datasource) == 7200
  assert configured_reload_interval({"reload_interval": 3600}, datasource) == 3600


def test_configured_reload_interval_rejects_invalid_values() -> None:
  with pytest.raises(ValueError, match="at least"):
    configured_reload_interval({"reload_interval": 30})
