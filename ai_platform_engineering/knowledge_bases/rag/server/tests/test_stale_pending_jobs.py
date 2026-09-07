"""Tests for reject_if_ingestion_job_blocking's stale-PENDING self-heal.

Before this fix, a PENDING job with no TTL that its ingestor pod never
dequeued (crash, downtime, a dropped Redis message) blocked every future
ingestion attempt for that datasource forever - the "already in progress or
pending" guard treated PENDING the same as IN_PROGRESS with no timeout.
Now a PENDING job past `is_stale_pending_job`'s threshold is failed out at
guard time instead of blocking the retry.
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from common.job_manager import JobInfo, JobStatus
from server import restapi


def _job(status: JobStatus, age_seconds: int, job_id: str = "job-1") -> JobInfo:
    return JobInfo(
        job_id=job_id,
        status=status,
        created_at=int(time.time()) - age_seconds,
        datasource_id="ds-1",
    )


@pytest.fixture(autouse=True)
def _wire(monkeypatch: pytest.MonkeyPatch):
    jm = AsyncMock()
    monkeypatch.setattr(restapi, "jobmanager", jm, raising=False)
    yield jm


@pytest.mark.asyncio
async def test_no_existing_jobs_does_not_raise(_wire):
    _wire.get_jobs_by_datasource.return_value = None
    await restapi.reject_if_ingestion_job_blocking("ds-1", "channel")


@pytest.mark.asyncio
async def test_in_progress_job_blocks(_wire):
    _wire.get_jobs_by_datasource.return_value = [_job(JobStatus.IN_PROGRESS, age_seconds=5)]

    with pytest.raises(HTTPException) as exc:
        await restapi.reject_if_ingestion_job_blocking("ds-1", "channel")

    assert exc.value.status_code == 400
    _wire.fail_stale_pending_job.assert_not_awaited()


@pytest.mark.asyncio
async def test_recent_pending_job_blocks(_wire):
    _wire.get_jobs_by_datasource.return_value = [_job(JobStatus.PENDING, age_seconds=5)]

    with pytest.raises(HTTPException):
        await restapi.reject_if_ingestion_job_blocking("ds-1", "channel")

    _wire.fail_stale_pending_job.assert_not_awaited()


@pytest.mark.asyncio
async def test_stale_pending_job_is_failed_and_does_not_block(_wire):
    stale = _job(JobStatus.PENDING, age_seconds=20 * 60, job_id="stale-job")
    _wire.get_jobs_by_datasource.return_value = [stale]

    await restapi.reject_if_ingestion_job_blocking("ds-1", "channel")

    _wire.fail_stale_pending_job.assert_awaited_once_with("stale-job")


@pytest.mark.asyncio
async def test_stale_pending_alongside_in_progress_still_blocks_on_in_progress(_wire):
    stale = _job(JobStatus.PENDING, age_seconds=20 * 60, job_id="stale-job")
    active = _job(JobStatus.IN_PROGRESS, age_seconds=5, job_id="active-job")
    _wire.get_jobs_by_datasource.return_value = [stale, active]

    with pytest.raises(HTTPException) as exc:
        await restapi.reject_if_ingestion_job_blocking("ds-1", "channel")

    assert "active-job" in exc.value.detail
    _wire.fail_stale_pending_job.assert_awaited_once_with("stale-job")


@pytest.mark.asyncio
async def test_completed_jobs_do_not_block(_wire):
    _wire.get_jobs_by_datasource.return_value = [_job(JobStatus.COMPLETED, age_seconds=99999)]

    await restapi.reject_if_ingestion_job_blocking("ds-1", "channel")

    _wire.fail_stale_pending_job.assert_not_awaited()
