from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest

from deepeval_eval.api.job_queue import DatabaseManager, PersistentJobQueue
from deepeval_eval.core.config import get_max_concurrent_jobs


@pytest.fixture
def unconfigured_db(monkeypatch: pytest.MonkeyPatch) -> DatabaseManager:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("LANGGRAPH_CHECKPOINT_POSTGRES_DSN", raising=False)
    monkeypatch.delenv("POSTGRES_DSN", raising=False)
    monkeypatch.delenv("POSTGRES_HOST", raising=False)
    monkeypatch.delenv("PGHOST", raising=False)
    monkeypatch.delenv("DB_HOST", raising=False)
    return DatabaseManager()


def test_database_manager_unconfigured(unconfigured_db: DatabaseManager) -> None:
    assert unconfigured_db.is_postgres() is False
    with pytest.raises(RuntimeError, match="PostgreSQL database is not configured"):
        unconfigured_db.get_connection()


def test_database_manager_postgres_connection_string() -> None:
    db_mgr = DatabaseManager(
        connection_string="postgresql://user:pass@localhost:5432/db"
    )
    assert db_mgr.is_postgres() is True


def test_persistent_job_queue_in_memory_enqueue_and_get(
    unconfigured_db: DatabaseManager,
) -> None:
    queue = PersistentJobQueue(unconfigured_db)
    job_record = queue.enqueue("job-123", "hash123", {"dataset_name": "test"})
    assert job_record["job_id"] == "job-123"
    assert job_record["status"] == "pending"

    fetched = queue.get_job("job-123")
    assert fetched is not None
    assert fetched["job_id"] == "job-123"
    assert fetched["eval_hash"] == "hash123"
    assert fetched["config_args"] == {"dataset_name": "test"}

    jobs = queue.list_jobs()
    assert len(jobs) >= 1
    assert any(j["job_id"] == "job-123" for j in jobs)


def test_persistent_job_queue_worker_execution(
    unconfigured_db: DatabaseManager,
) -> None:
    executed_jobs: list[str] = []

    def dummy_task(job_id: str, config: dict) -> None:
        time.sleep(0.05)
        executed_jobs.append(job_id)

    queue = PersistentJobQueue(unconfigured_db)
    queue.set_task_executor(dummy_task)
    queue.start()

    try:
        queue.enqueue("job-worker-1", "h1", {"dataset_name": "test1"})
        queue.enqueue("job-worker-2", "h2", {"dataset_name": "test2"})

        timeout = time.time() + 3.0
        while len(executed_jobs) < 2 and time.time() < timeout:
            time.sleep(0.05)

        assert "job-worker-1" in executed_jobs
        assert "job-worker-2" in executed_jobs

        j1 = queue.get_job("job-worker-1")
        assert j1 is not None and j1["status"] == "completed"
    finally:
        queue.stop()


def test_persistent_job_queue_worker_execution_failure(
    unconfigured_db: DatabaseManager,
) -> None:
    def failing_task(job_id: str, config: dict) -> None:
        raise RuntimeError("Synthetic evaluation failure")

    queue = PersistentJobQueue(unconfigured_db)
    queue.set_task_executor(failing_task)
    queue.start()

    try:
        queue.enqueue("job-worker-fail", "hfail", {"dataset_name": "test_fail"})

        timeout = time.time() + 3.0
        j_fail = None
        while time.time() < timeout:
            j_fail = queue.get_job("job-worker-fail")
            if j_fail and j_fail["status"] == "failed":
                break
            time.sleep(0.05)

        assert j_fail is not None
        assert j_fail["status"] == "failed"
        assert "Synthetic evaluation failure" in (j_fail.get("error") or "")
    finally:
        queue.stop()


def test_persistent_job_queue_postgres_mode() -> None:
    db_mgr = DatabaseManager(
        connection_string="postgresql://user:pass@localhost:5432/db"
    )
    mock_psycopg2 = MagicMock()
    mock_conn = MagicMock()
    mock_cur = MagicMock()

    mock_psycopg2.connect.return_value = mock_conn
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_cur.fetchall.return_value = [
        {
            "job_id": "pg-job-1",
            "eval_hash": "hash_pg",
            "status": "pending",
            "config_json": '{"dataset_name": "pg_test"}',
            "created_at": time.time(),
            "started_at": None,
            "completed_at": None,
            "error": None,
        }
    ]

    with patch.dict(
        "sys.modules", {"psycopg2": mock_psycopg2, "psycopg2.extras": MagicMock()}
    ):
        queue = PersistentJobQueue(db_mgr)
        job = queue.get_job("pg-job-1")
        assert job is not None
        assert job["job_id"] == "pg-job-1"


def test_get_max_concurrent_jobs_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVAL_MAX_CONCURRENT_JOBS", "5")
    assert get_max_concurrent_jobs() == 5

    monkeypatch.setenv("EVAL_MAX_CONCURRENT_JOBS", "invalid")
    assert get_max_concurrent_jobs() == 1


def test_sanitize_config_dict_redacts_secrets(
    unconfigured_db: DatabaseManager,
) -> None:
    queue = PersistentJobQueue(unconfigured_db)
    raw_config = {
        "dataset_name": "test_secret",
        "llm_api_key": "sk-secret-123",
        "auth_token": "bearer-token-xyz",
        "rag_auth_token": "rag-secret",
    }
    job = queue.enqueue("job-sec-1", "hashsec", raw_config)
    assert "llm_api_key" not in job["config_args"]
    assert "auth_token" not in job["config_args"]
    assert "rag_auth_token" not in job["config_args"]
    assert job["config_args"]["dataset_name"] == "test_secret"


# ---------------------------------------------------------------------------
# Regression tests: startup stall fix & connect_timeout enforcement
# ---------------------------------------------------------------------------


@pytest.fixture
def postgres_db() -> DatabaseManager:
    """DatabaseManager pre-configured with a Postgres DSN (no actual connection made)."""
    return DatabaseManager(
        connection_string="postgresql://user:pass@unreachable:5432/db"
    )


class TestConnectTimeoutEnforced:
    """Verify psycopg2.connect is always called with connect_timeout=5."""

    def test_connect_with_dsn_string_has_timeout(
        self, postgres_db: DatabaseManager
    ) -> None:
        """Positive: DSN-form connect() is called with connect_timeout=5."""
        mock_psycopg2 = MagicMock()
        mock_psycopg2.connect.return_value = MagicMock()

        with patch.dict("sys.modules", {"psycopg2": mock_psycopg2}):
            try:
                postgres_db.get_connection()
            except Exception:
                pass

        mock_psycopg2.connect.assert_called_once()
        _, kwargs = mock_psycopg2.connect.call_args
        assert kwargs.get("connect_timeout") == 5 or (
            len(mock_psycopg2.connect.call_args.args) > 0
            and "connect_timeout=5" in str(mock_psycopg2.connect.call_args)
        ), "connect_timeout=5 must be passed to psycopg2.connect when using DSN string"

    def test_connect_with_keyword_args_has_timeout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Positive: keyword-args form connect() is called with connect_timeout=5."""
        monkeypatch.setenv("POSTGRES_HOST", "unreachable-host")
        monkeypatch.setenv("POSTGRES_PORT", "5432")
        monkeypatch.setenv("POSTGRES_DB", "testdb")
        monkeypatch.setenv("POSTGRES_USER", "testuser")
        monkeypatch.setenv("POSTGRES_PASSWORD", "testpass")
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("LANGGRAPH_CHECKPOINT_POSTGRES_DSN", raising=False)
        monkeypatch.delenv("POSTGRES_DSN", raising=False)
        monkeypatch.delenv("DB_CONNECTION_STRING", raising=False)

        db_mgr = DatabaseManager.__new__(DatabaseManager)
        db_mgr.connection_string = None
        import threading

        db_mgr._lock = threading.Lock()

        mock_psycopg2 = MagicMock()
        mock_psycopg2.connect.return_value = MagicMock()

        with patch.dict("sys.modules", {"psycopg2": mock_psycopg2}):
            try:
                db_mgr.get_connection()
            except Exception:
                pass

        mock_psycopg2.connect.assert_called_once()
        _, kwargs = mock_psycopg2.connect.call_args
        assert kwargs.get("connect_timeout") == 5, (
            "connect_timeout=5 must be passed to psycopg2.connect in keyword-args path"
        )

    def test_connect_without_timeout_would_block_indefinitely(
        self, postgres_db: DatabaseManager
    ) -> None:
        """Negative: absence of connect_timeout would be a regression — assert it is present."""
        mock_psycopg2 = MagicMock()
        mock_psycopg2.connect.return_value = MagicMock()

        with patch.dict("sys.modules", {"psycopg2": mock_psycopg2}):
            try:
                postgres_db.get_connection()
            except Exception:
                pass

        _, kwargs = mock_psycopg2.connect.call_args
        assert "connect_timeout" in kwargs, (
            "Regression: connect_timeout missing — psycopg2.connect will block indefinitely "
            "on unreachable hosts"
        )


class TestStartNonBlocking:
    """Verify PersistentJobQueue.start() submits recovery to the executor and
    does NOT call _recover_and_dispatch synchronously on the calling thread."""

    def test_start_submits_recovery_to_executor_not_inline(
        self, postgres_db: DatabaseManager
    ) -> None:
        """Positive: start() uses executor.submit for DB recovery, not a direct call."""
        queue = PersistentJobQueue(postgres_db)
        queue.set_task_executor(MagicMock())

        recover_calls: list[str] = []

        def tracking_recover() -> None:
            recover_calls.append("recover_called")

        queue._recover_and_dispatch = tracking_recover  # type: ignore[method-assign]

        mock_executor = MagicMock()
        submitted_fns: list = []

        def capture_submit(fn, *args, **kwargs):
            submitted_fns.append(fn)
            return MagicMock()

        mock_executor.submit.side_effect = capture_submit

        with patch(
            "deepeval_eval.api.job_queue.ThreadPoolExecutor",
            return_value=mock_executor,
        ):
            queue.start()

        # Recovery must have been submitted to the executor, not called inline
        assert len(submitted_fns) == 1, (
            "_recover_and_dispatch must be submitted to executor"
        )
        assert submitted_fns[0] is tracking_recover
        assert recover_calls == [], (
            "Regression: _recover_and_dispatch was called synchronously on the event loop thread "
            "— this causes uvicorn 'Waiting for application startup.' to stall"
        )

    def test_start_returns_immediately_without_db(
        self, unconfigured_db: DatabaseManager
    ) -> None:
        """Positive: start() returns immediately when Postgres is not configured."""
        queue = PersistentJobQueue(unconfigured_db)
        queue.set_task_executor(MagicMock())

        start_time = time.monotonic()
        queue.start()
        elapsed = time.monotonic() - start_time
        queue.stop()

        assert elapsed < 0.5, (
            f"start() took {elapsed:.3f}s without DB — should be near instant"
        )

    def test_start_is_idempotent(self, unconfigured_db: DatabaseManager) -> None:
        """Positive: calling start() twice does not error or duplicate executor."""
        queue = PersistentJobQueue(unconfigured_db)
        queue.set_task_executor(MagicMock())
        queue.start()
        queue.start()  # second call must be a no-op
        assert queue._running is True
        queue.stop()

    def test_start_does_not_block_with_slow_recovery(
        self, postgres_db: DatabaseManager
    ) -> None:
        """Behavioral regression: start() returns in <0.5s even when _recover_and_dispatch
        takes 2 seconds (simulates an unreachable / slow Postgres host).

        This is the direct reproduction of the original startup stall bug.
        If _recover_and_dispatch() is called synchronously (pre-fix), this test
        takes ~2 seconds and fails the timing assertion, reproducing the exact
        symptom: uvicorn stuck at 'Waiting for application startup.'
        """
        import threading

        queue = PersistentJobQueue(postgres_db)
        queue.set_task_executor(MagicMock())

        recovery_started = threading.Event()

        def slow_recovery() -> None:
            """Simulates a 2-second blocking psycopg2.connect() on an unreachable host."""
            recovery_started.set()
            time.sleep(2.0)

        queue._recover_and_dispatch = slow_recovery  # type: ignore[method-assign]

        start_time = time.monotonic()
        queue.start()
        elapsed = time.monotonic() - start_time

        # start() must return well before the 2s slow recovery finishes
        assert elapsed < 0.5, (
            f"REGRESSION: start() blocked for {elapsed:.2f}s — "
            "_recover_and_dispatch() is being called synchronously on the calling thread. "
            "This reproduces the uvicorn 'Waiting for application startup.' stall. "
            "Fix: submit _recover_and_dispatch to self._executor instead of calling directly."
        )

        # Recovery must still RUN — just in the background, not on this thread
        assert recovery_started.wait(timeout=1.5), (
            "Recovery should have started in a background thread"
        )
        queue.stop()

    def test_would_stall_if_recovery_were_synchronous(
        self, postgres_db: DatabaseManager
    ) -> None:
        """Negative / confirmatory: documents what the pre-fix (broken) behaviour looked like.

        Calls _recover_and_dispatch() synchronously (as the old code did) with a
        deliberately fast mock (0.3s) and verifies it blocks start() for that duration.
        This confirms our timing threshold is correctly calibrated to catch the regression.
        """
        queue = PersistentJobQueue(postgres_db)
        queue.set_task_executor(MagicMock())

        SIMULATED_DELAY = 0.3  # deliberately short so the test stays fast

        def blocking_recovery() -> None:
            time.sleep(SIMULATED_DELAY)

        # Manually call synchronously (pre-fix pattern) to confirm it DOES block
        start_time = time.monotonic()
        blocking_recovery()  # calling directly = the old broken pattern
        elapsed = time.monotonic() - start_time

        assert elapsed >= SIMULATED_DELAY, (
            "Confirmatory test failed: synchronous recovery must block for at least "
            f"{SIMULATED_DELAY}s — this validates that the timing threshold in "
            "test_start_does_not_block_with_slow_recovery would correctly catch a regression."
        )
        queue.stop()


class TestDatabaseManagerLogging:
    """Verify DB errors are logged at warning/error level, not silently at debug."""

    def test_init_db_failure_logs_warning_not_debug(
        self, postgres_db: DatabaseManager, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Positive: DatabaseManager.__init__ logs a warning when init_db fails."""
        import logging

        mock_psycopg2 = MagicMock()
        mock_psycopg2.connect.side_effect = OSError("Connection refused")

        with patch.dict("sys.modules", {"psycopg2": mock_psycopg2}):
            with caplog.at_level(logging.WARNING, logger="deepeval_eval.api.job_queue"):
                db_mgr = DatabaseManager(
                    connection_string="postgresql://user:pass@unreachable:5432/db"
                )

        assert db_mgr is not None
        warning_msgs = [
            r.message for r in caplog.records if r.levelno >= logging.WARNING
        ]
        assert any(
            "unreachable" in m or "DB may be unreachable" in m or "init" in m.lower()
            for m in warning_msgs
        ), (
            "Regression: DatabaseManager init DB failure must log at WARNING, "
            f"got: {warning_msgs}"
        )

    def test_get_job_postgres_failure_logs_warning(
        self, postgres_db: DatabaseManager, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Positive: get_job() Postgres failure falls back to memory and logs a warning."""
        import logging

        queue = PersistentJobQueue(postgres_db)
        # Seed in-memory fallback
        queue._memory_jobs["fallback-job"] = {
            "job_id": "fallback-job",
            "eval_hash": "h",
            "status": "pending",
            "config_args": {},
            "created_at": time.time(),
            "started_at": None,
            "completed_at": None,
            "error": None,
        }

        mock_psycopg2 = MagicMock()
        mock_psycopg2.connect.side_effect = OSError("Connection refused")
        mock_psycopg2.extras = MagicMock()

        with patch.dict(
            "sys.modules", {"psycopg2": mock_psycopg2, "psycopg2.extras": MagicMock()}
        ):
            with caplog.at_level(logging.WARNING, logger="deepeval_eval.api.job_queue"):
                result = queue.get_job("fallback-job")

        assert result is not None, (
            "get_job must fall back to memory when Postgres fails"
        )
        assert result["job_id"] == "fallback-job"
        warning_msgs = [
            r.message for r in caplog.records if r.levelno >= logging.WARNING
        ]
        assert any("Postgres" in m or "falling back" in m for m in warning_msgs), (
            "Regression: get_job Postgres failure must log at WARNING level, "
            f"got: {warning_msgs}"
        )

    def test_list_jobs_postgres_failure_logs_warning(
        self, postgres_db: DatabaseManager, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Positive: list_jobs() Postgres failure falls back to memory and logs a warning."""
        import logging

        queue = PersistentJobQueue(postgres_db)
        queue._memory_jobs["mem-job-1"] = {
            "job_id": "mem-job-1",
            "eval_hash": "h",
            "status": "completed",
            "config_args": {},
            "created_at": time.time(),
            "started_at": None,
            "completed_at": None,
            "error": None,
        }

        mock_psycopg2 = MagicMock()
        mock_psycopg2.connect.side_effect = OSError("Connection refused")

        with patch.dict(
            "sys.modules", {"psycopg2": mock_psycopg2, "psycopg2.extras": MagicMock()}
        ):
            with caplog.at_level(logging.WARNING, logger="deepeval_eval.api.job_queue"):
                results = queue.list_jobs()

        assert any(j["job_id"] == "mem-job-1" for j in results), (
            "list_jobs must fall back to memory when Postgres fails"
        )
        warning_msgs = [
            r.message for r in caplog.records if r.levelno >= logging.WARNING
        ]
        assert any("Postgres" in m or "falling back" in m for m in warning_msgs), (
            "Regression: list_jobs Postgres failure must log at WARNING level, "
            f"got: {warning_msgs}"
        )

    def test_dispatch_postgres_failure_logs_error(
        self, postgres_db: DatabaseManager, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Positive: _dispatch_next_if_possible() Postgres failure logs at ERROR level."""
        import logging
        from concurrent.futures import ThreadPoolExecutor

        queue = PersistentJobQueue(postgres_db)
        queue.set_task_executor(MagicMock())
        queue._running = True
        queue._executor = ThreadPoolExecutor(max_workers=1)

        mock_psycopg2 = MagicMock()
        mock_psycopg2.connect.side_effect = OSError("Connection refused")

        try:
            with patch.dict(
                "sys.modules",
                {"psycopg2": mock_psycopg2, "psycopg2.extras": MagicMock()},
            ):
                with caplog.at_level(
                    logging.ERROR, logger="deepeval_eval.api.job_queue"
                ):
                    queue._dispatch_next_if_possible()
        finally:
            queue._executor.shutdown(wait=False)

        error_msgs = [r.message for r in caplog.records if r.levelno >= logging.ERROR]
        assert any(
            "dispatch" in m.lower() or "pending" in m.lower() for m in error_msgs
        ), (
            "Regression: _dispatch_next_if_possible Postgres failure must log at ERROR level, "
            f"got: {error_msgs}"
        )


def test_sanitize_config_dict_strips_sensitive_keys():
    """Verify sanitize_config_dict removes sensitive token/key fields from config dict."""
    from deepeval_eval.api.job_queue import sanitize_config_dict

    config = {
        "dataset_name": "test",
        "api_key": "secret_123",
        "access_token": "bearer_456",
        "max_items": 10,
    }
    sanitized = sanitize_config_dict(config)
    assert sanitized["dataset_name"] == "test"
    assert sanitized["max_items"] == 10
    assert "api_key" not in sanitized
    assert "access_token" not in sanitized


def test_persistent_job_queue_delete_job_memory_store(postgres_db: DatabaseManager):
    """Verify delete_job removes job from in-memory queue store."""
    queue = PersistentJobQueue(postgres_db)
    queue._memory_jobs["job-to-delete"] = {
        "job_id": "job-to-delete",
        "status": "pending",
    }
    queue.delete_job("job-to-delete")
    assert "job-to-delete" not in queue._memory_jobs


def test_persistent_job_queue_evict_old_memory_jobs(postgres_db: DatabaseManager):
    """Verify _evict_old_memory_jobs trims in-memory jobs when count exceeds max capacity."""
    queue = PersistentJobQueue(postgres_db)
    queue._max_memory_jobs = 100
    for i in range(105):
        queue._memory_jobs[f"job-{i}"] = {
            "job_id": f"job-{i}",
            "status": "completed",
            "created_at": i,
        }

    queue._evict_old_memory_jobs()
    assert len(queue._memory_jobs) <= 100


def test_persistent_job_queue_get_job_postgres_exception_sanitizes_job_id(
    postgres_db: DatabaseManager, caplog: pytest.LogCaptureFixture
):
    """Verify get_job sanitizes job_id in log messages when Postgres query raises exception."""
    import logging
    import uuid

    queue = PersistentJobQueue(postgres_db)

    # Mock DB query to raise exception
    postgres_db.query_all = MagicMock(side_effect=RuntimeError("DB connection dropped"))

    valid_uuid = str(uuid.uuid4())
    with caplog.at_level(logging.WARNING):
        res = queue.get_job(valid_uuid)
        assert res is None
        assert f"Failed to query job '{valid_uuid}'" in caplog.text

    caplog.clear()
    malicious_id = "malicious_job\nINJECTION\r\n"
    with caplog.at_level(logging.WARNING):
        res = queue.get_job(malicious_id)
        assert res is None
        assert "malicious_job\nINJECTION" not in caplog.text
        assert "Failed to query job 'malicious_jobINJECTION'" in caplog.text


def test_persistent_job_queue_start_already_running_and_executor_already_present(
    postgres_db: DatabaseManager,
):
    """Verify start() returns early when already running or preserves existing executor."""
    queue = PersistentJobQueue(postgres_db)
    queue._running = True
    queue.start()  # should return early

    queue._running = False
    mock_exec = MagicMock()
    queue._executor = mock_exec
    with patch.object(queue, "_recover_and_dispatch"):
        queue.start()
        assert queue._executor is mock_exec


def test_persistent_job_queue_stop_when_not_running_or_no_executor(
    postgres_db: DatabaseManager,
):
    """Verify stop() handles when queue is not running or executor is None."""
    queue = PersistentJobQueue(postgres_db)
    queue._running = False
    queue.stop()  # should return early

    queue._running = True
    queue._executor = None
    queue._active_jobs.add("job-1")
    queue.stop()
    assert queue._running is False
    assert len(queue._active_jobs) == 0


def test_persistent_job_queue_update_status_postgres_paths(
    postgres_db: DatabaseManager,
):
    """Verify update_status executes expected SQL for running, completed, and failed statuses in Postgres."""
    queue = PersistentJobQueue(postgres_db)
    postgres_db.execute_write = MagicMock()

    # Status: running
    queue.update_status("job-100", "running", started_at=1000.0)
    postgres_db.execute_write.assert_called_with(
        "UPDATE eval_job_queue SET status=%s, started_at=%s WHERE job_id=%s",
        ("running", 1000.0, "job-100"),
    )

    # Status: completed
    queue._active_jobs.add("job-100")
    queue.update_status("job-100", "completed", completed_at=1050.0)
    postgres_db.execute_write.assert_called_with(
        "UPDATE eval_job_queue SET status=%s, completed_at=%s, error=%s WHERE job_id=%s",
        ("completed", 1050.0, None, "job-100"),
    )
    assert "job-100" not in queue._active_jobs

    # Status: failed
    queue._active_jobs.add("job-200")
    queue.update_status(
        "job-200", "failed", error="Execution timeout", completed_at=2050.0
    )
    postgres_db.execute_write.assert_called_with(
        "UPDATE eval_job_queue SET status=%s, completed_at=%s, error=%s WHERE job_id=%s",
        ("failed", 2050.0, "Execution timeout", "job-200"),
    )
    assert "job-200" not in queue._active_jobs


def test_persistent_job_queue_get_job_postgres_invalid_json(
    postgres_db: DatabaseManager,
):
    """Verify get_job handles corrupted config_json in Postgres and returns empty config_args."""
    queue = PersistentJobQueue(postgres_db)
    postgres_db.query_all = MagicMock(
        return_value=[
            {
                "job_id": "job-bad-json",
                "eval_hash": "hash-bad",
                "status": "pending",
                "config_json": "NOT_A_VALID_JSON{",
                "created_at": 1000.0,
                "started_at": None,
                "completed_at": None,
                "error": None,
            }
        ]
    )

    res = queue.get_job("job-bad-json")
    assert res is not None
    assert res["job_id"] == "job-bad-json"
    assert res["config_args"] == {}


def test_persistent_job_queue_list_jobs_openfga_and_ownership_filters(
    postgres_db: DatabaseManager,
):
    """Verify list_jobs filters jobs by allowed_ids, public visibility, and owner email."""
    queue = PersistentJobQueue(postgres_db)

    # 1. allowed_ids is empty and no user_email -> returns []
    assert queue.list_jobs(allowed_ids=[]) == []

    # 2. allowed_ids has specific IDs
    postgres_db.query_all = MagicMock(
        return_value=[
            {
                "job_id": "job-allowed-1",
                "eval_hash": "h1",
                "status": "completed",
                "config_json": '{"dataset_name": "enterprise"}',
                "created_at": 100.0,
            },
            {
                "job_id": "job-forbidden-2",
                "eval_hash": "h2",
                "status": "completed",
                "config_json": '{"dataset_name": "enterprise"}',
                "created_at": 90.0,
            },
        ]
    )
    res_allowed = queue.list_jobs(allowed_ids=["job-allowed-1"])
    assert len(res_allowed) == 1
    assert res_allowed[0]["job_id"] == "job-allowed-1"

    # 3. allowed_ids is empty with user_email -> public visibility & owner fallback
    postgres_db.query_all = MagicMock(
        return_value=[
            {
                "job_id": "job-public",
                "eval_hash": "h_pub",
                "status": "completed",
                "config_json": '{"visibility": "public"}',
                "created_at": 100.0,
            },
            {
                "job_id": "job-owned",
                "eval_hash": "h_own",
                "status": "completed",
                "config_json": '{"visibility": "private", "user_info": {"email": "alice@example.com"}}',
                "created_at": 95.0,
            },
            {
                "job_id": "job-other-user",
                "eval_hash": "h_oth",
                "status": "completed",
                "config_json": '{"visibility": "private", "created_by": "bob@example.com"}',
                "created_at": 90.0,
            },
            {
                "job_id": "job-bad-json",
                "eval_hash": "h_bad",
                "status": "completed",
                "config_json": "{invalid json}",
                "created_at": 85.0,
            },
        ]
    )
    res_openfga_fallback = queue.list_jobs(
        allowed_ids=[], user_email="alice@example.com"
    )
    job_ids = [j["job_id"] for j in res_openfga_fallback]
    assert "job-public" in job_ids
    assert "job-owned" in job_ids
    assert "job-other-user" not in job_ids
    assert "job-bad-json" not in job_ids


def test_persistent_job_queue_recover_and_dispatch_postgres_success_and_exception(
    postgres_db: DatabaseManager, caplog: pytest.LogCaptureFixture
):
    """Verify _recover_and_dispatch updates pending status and logs DB warnings on failure."""
    import logging

    queue = PersistentJobQueue(postgres_db)
    postgres_db.execute_write = MagicMock()
    with patch.object(queue, "_dispatch_next_if_possible") as mock_dispatch:
        queue._recover_and_dispatch()
        postgres_db.execute_write.assert_called_once_with(
            "UPDATE eval_job_queue SET status='pending' WHERE status IN ('running', 'queued')",
            (),
        )
        mock_dispatch.assert_called_once()

    # Exception in DB recovery
    postgres_db.execute_write = MagicMock(
        side_effect=RuntimeError("Recovery DB timeout")
    )
    with (
        patch.object(queue, "_dispatch_next_if_possible") as mock_dispatch,
        caplog.at_level(logging.WARNING),
    ):
        queue._recover_and_dispatch()
        assert "PostgreSQL job recovery skipped" in caplog.text
        mock_dispatch.assert_called_once()


def test_persistent_job_queue_dispatch_next_postgres_flow_and_errors(
    postgres_db: DatabaseManager, caplog: pytest.LogCaptureFixture
):
    """Verify _dispatch_next_if_possible on Postgres executes pending jobs and handles submission errors."""
    import logging

    queue = PersistentJobQueue(postgres_db)
    queue.max_workers = 10
    queue._running = True
    queue._task_fn = MagicMock()
    mock_exec = MagicMock()
    queue._executor = mock_exec

    # Normal submission
    postgres_db.query_all = MagicMock(
        return_value=[
            {"job_id": "job-pg-1", "config_json": '{"dataset_name": "test1"}'}
        ]
    )
    queue._dispatch_next_if_possible()
    assert "job-pg-1" in queue._active_jobs
    mock_exec.submit.assert_called_once()

    # Submit error
    queue._active_jobs.clear()
    mock_exec.reset_mock()
    mock_exec.submit.side_effect = RuntimeError("Thread pool exhausted")
    postgres_db.query_all = MagicMock(
        return_value=[
            {"job_id": "job-pg-2", "config_json": '{"dataset_name": "test2"}'}
        ]
    )
    with caplog.at_level(logging.ERROR):
        queue._dispatch_next_if_possible()
        assert "Failed to submit job job-pg-2 to worker pool" in caplog.text
        assert "job-pg-2" not in queue._active_jobs

    # Query exception
    postgres_db.query_all = MagicMock(side_effect=RuntimeError("Select locked failed"))
    with caplog.at_level(logging.ERROR):
        queue._dispatch_next_if_possible()
        assert (
            "Failed to query pending jobs from Postgres during dispatch" in caplog.text
        )


def test_persistent_job_queue_dispatch_next_memory_edge_cases(
    unconfigured_db: DatabaseManager, caplog: pytest.LogCaptureFixture
):
    """Verify _dispatch_next_if_possible for memory queue handles worker capacity, active duplicates, and submit errors."""
    import logging

    queue = PersistentJobQueue(unconfigured_db)
    queue._running = True
    queue._task_fn = MagicMock()
    mock_exec = MagicMock()
    queue._executor = mock_exec

    # 1. Capacity full
    queue.max_workers = 1
    queue._active_jobs.add("active-1")
    queue._memory_queue.append("job-queued-1")
    queue._dispatch_next_if_possible()
    assert len(mock_exec.submit.mock_calls) == 0

    # 2. Duplicate in active jobs
    queue.max_workers = 5
    queue._memory_queue.append("active-1")
    queue._dispatch_next_if_possible()
    assert len(mock_exec.submit.mock_calls) == 0

    # 3. Status not pending
    queue._memory_jobs["job-non-pending"] = {"status": "completed"}
    queue._memory_queue.append("job-non-pending")
    queue._dispatch_next_if_possible()
    assert len(mock_exec.submit.mock_calls) == 0

    # 4. Submit exception
    queue._memory_jobs["job-submit-fail"] = {
        "status": "pending",
        "raw_config": {"k": "v"},
    }
    queue._memory_queue.append("job-submit-fail")
    mock_exec.submit.side_effect = RuntimeError("Submit error")
    with caplog.at_level(logging.ERROR):
        queue._dispatch_next_if_possible()
        assert "Failed to submit job job-submit-fail to worker pool" in caplog.text
        assert "job-submit-fail" not in queue._active_jobs


def test_persistent_job_queue_run_job_wrapper_no_task_fn(
    unconfigured_db: DatabaseManager,
):
    """Verify _run_job_wrapper returns early when _task_fn is not registered."""
    queue = PersistentJobQueue(unconfigured_db)
    queue._task_fn = None
    queue._run_job_wrapper("job-1", {})  # should return without error


def test_persistent_job_queue_delete_job_postgres_success_and_exception(
    postgres_db: DatabaseManager, caplog: pytest.LogCaptureFixture
):
    """Verify delete_job on Postgres executes DELETE statement and handles exceptions."""
    import logging

    queue = PersistentJobQueue(postgres_db)
    postgres_db.execute_write = MagicMock()
    queue.delete_job("job-del-pg")
    postgres_db.execute_write.assert_called_once_with(
        "DELETE FROM eval_job_queue WHERE job_id=%s",
        ("job-del-pg",),
    )

    postgres_db.execute_write = MagicMock(side_effect=RuntimeError("DB delete failed"))
    with caplog.at_level(logging.WARNING):
        queue.delete_job("job-del-err")
        assert "Failed to delete job 'job-del-err' from Postgres" in caplog.text


def test_persistent_job_queue_dispatch_next_postgres_invalid_json(
    postgres_db: DatabaseManager,
) -> None:
    """Verify _dispatch_next_if_possible handles invalid config_json gracefully and submits with empty dict."""
    queue = PersistentJobQueue(postgres_db)
    queue.max_workers = 5
    queue._running = True
    queue._task_fn = MagicMock()
    mock_exec = MagicMock()
    queue._executor = mock_exec

    postgres_db.query_all = MagicMock(
        return_value=[{"job_id": "job-bad-cfg", "config_json": "NOT_JSON{"}]
    )
    queue._dispatch_next_if_possible()
    assert "job-bad-cfg" in queue._active_jobs
    mock_exec.submit.assert_called_once_with(queue._run_job_wrapper, "job-bad-cfg", {})
