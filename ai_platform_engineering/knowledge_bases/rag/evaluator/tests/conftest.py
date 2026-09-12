from __future__ import annotations

import pytest

from deepeval_eval.core.config import get_eval_config


@pytest.fixture(autouse=True)
def clear_config_cache() -> None:
    """Clear lru_cache on get_eval_config before and after each test."""
    get_eval_config.cache_clear()
    yield
    get_eval_config.cache_clear()


@pytest.fixture(autouse=True)
def isolate_and_cleanup_test_job_queue() -> None:
    """Isolate and cleanup in-memory state and PostgreSQL records created during test execution."""
    from deepeval_eval.api.job_manager import (
        db_manager,
        job_manager,
        persistent_job_queue,
    )

    # Snapshot existing job IDs and run IDs before test execution if connected to PostgreSQL
    initial_db_job_ids: set[str] = set()
    initial_db_run_ids: set[str] = set()
    if db_manager.is_postgres():
        try:
            job_rows = db_manager.query_all("SELECT job_id FROM eval_job_queue")
            initial_db_job_ids = {r["job_id"] for r in job_rows}
            run_rows = db_manager.query_all("SELECT run_id FROM evaluation_runs")
            initial_db_run_ids = {r["run_id"] for r in run_rows}
        except Exception:
            pass

    yield

    # Clean up in-memory job manager and persistent queue state
    with job_manager._lock:
        job_manager.jobs.clear()
        job_manager.hash_to_job_id.clear()

    with persistent_job_queue._lock:
        persistent_job_queue._memory_jobs.clear()
        persistent_job_queue._memory_queue.clear()
        persistent_job_queue._active_jobs.clear()

    # Purge any new jobs and evaluation runs created during this test from PostgreSQL
    if db_manager.is_postgres():
        try:
            current_job_rows = db_manager.query_all("SELECT job_id FROM eval_job_queue")
            current_job_ids = {r["job_id"] for r in current_job_rows}
            new_job_ids = current_job_ids - initial_db_job_ids
            for jid in new_job_ids:
                db_manager.execute_write(
                    "DELETE FROM eval_job_queue WHERE job_id = %s", (jid,)
                )

            current_run_rows = db_manager.query_all(
                "SELECT run_id FROM evaluation_runs"
            )
            current_run_ids = {r["run_id"] for r in current_run_rows}
            new_run_ids = current_run_ids - initial_db_run_ids
            for rid in new_run_ids:
                db_manager.execute_write(
                    "DELETE FROM evaluation_runs WHERE run_id = %s", (rid,)
                )
        except Exception:
            pass
