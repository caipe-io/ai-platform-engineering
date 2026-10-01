"""Tests for JobManager's stale-PENDING-job detection.

Ingestors dequeue their Redis list within ~1s (blpop timeout=1); a job still
PENDING long after that means the ingestor pod that should have picked it up
crashed or never started, not that ingestion is genuinely still queued. A
stuck PENDING job with no TTL previously blocked every future ingestion
attempt for its datasource forever (server's "already in progress or
pending" guard treats PENDING as blocking).
"""

import time

from common.job_manager import JobInfo, JobStatus, is_stale_pending_job


def _job(status: JobStatus, age_seconds: int) -> JobInfo:
    return JobInfo(
        job_id="job-1",
        status=status,
        created_at=int(time.time()) - age_seconds,
        datasource_id="ds-1",
    )


def test_recent_pending_job_is_not_stale():
    assert is_stale_pending_job(_job(JobStatus.PENDING, age_seconds=5)) is False


def test_old_pending_job_is_stale():
    assert is_stale_pending_job(_job(JobStatus.PENDING, age_seconds=20 * 60)) is True


def test_pending_job_at_exact_threshold_is_not_stale():
    from common.job_manager import DEFAULT_STALE_PENDING_JOB_SECONDS

    assert is_stale_pending_job(_job(JobStatus.PENDING, age_seconds=DEFAULT_STALE_PENDING_JOB_SECONDS)) is False


def test_custom_threshold_is_respected():
    job = _job(JobStatus.PENDING, age_seconds=100)
    assert is_stale_pending_job(job, max_age_seconds=200) is False
    assert is_stale_pending_job(job, max_age_seconds=50) is True


def test_non_pending_statuses_are_never_stale():
    for status in (
        JobStatus.IN_PROGRESS,
        JobStatus.COMPLETED,
        JobStatus.COMPLETED_WITH_ERRORS,
        JobStatus.TERMINATED,
        JobStatus.FAILED,
    ):
        assert is_stale_pending_job(_job(status, age_seconds=99999)) is False
