from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from deepeval_eval.api.auth import UserContext
from deepeval_eval.api.evaluation_jobs import (
    EvaluationRequest,
    JobStatusEnum,
)
from deepeval_eval.api.job_manager import (
    RBAC_EVALUATOR_CLIENT_CREDENTIALS_ROLE,
    JobManager,
    _build_job_summary,
    _run_queued_evaluation,
    compute_eval_hash,
    db_manager,
    execute_evaluation_job,
    job_manager,
    persistent_job_queue,
    sanitize_config_args,
    validate_safe_path,
)
from deepeval_eval.auth.obo_exchange import OboExchangeError
from deepeval_eval.core.config import get_job_purge_rate, get_max_in_memory_jobs
from deepeval_eval.db.db_manager import DatabaseManager

# ---------------------------------------------------------------------------
# Unit Tests for Helper Functions, Path Sandboxing & Hash Management
# ---------------------------------------------------------------------------


def test_sanitize_config_args_valid_dict_omits_sensitive_and_null_keys():
    """Verify sensitive keys and null values are omitted from sanitized configuration output."""
    raw_config = {
        "dataset_name": "enterprise",
        "llm_api_key": "secret-12345",
        "auth_token": "bearer-abc",
        "prompt_style": None,
        "max_items": 10,
    }
    sanitized = sanitize_config_args(raw_config)
    assert "llm_api_key" not in sanitized
    assert "auth_token" not in sanitized
    assert "prompt_style" not in sanitized
    assert sanitized["dataset_name"] == "enterprise"
    assert sanitized["max_items"] == 10


def test_sanitize_config_args_all_sensitive_keys_returns_empty_dict():
    """Verify empty dictionary or dict with all sensitive/null keys returns empty dict."""
    raw_config = {
        "llm_api_key": "secret",
        "db_connection_string": "postgres://...",
        "auth_token": None,
    }
    sanitized = sanitize_config_args(raw_config)
    assert sanitized == {}


def test_compute_eval_hash_equivalent_configs_produces_deterministic_fingerprint():
    """Verify compute_eval_hash produces deterministic fingerprint in UUID format."""
    config1 = {"dataset_name": "enterprise", "top_k": 3, "force_rerun": False}
    config2 = {"dataset_name": "enterprise", "top_k": 3, "force_rerun": True}
    h1 = compute_eval_hash(config1)
    h2 = compute_eval_hash(config2)
    assert h1 == h2  # force_rerun should be ignored in hash
    assert len(h1) == 36
    assert uuid.UUID(h1)


def test_compute_eval_hash_differing_configs_produces_distinct_fingerprints():
    """Verify compute_eval_hash produces different fingerprint for different inputs."""
    config1 = {"dataset_name": "enterprise", "top_k": 3}
    config2 = {"dataset_name": "hotpotqa", "top_k": 3}
    h1 = compute_eval_hash(config1)
    h2 = compute_eval_hash(config2)
    assert h1 != h2


def test_compute_eval_hash_transient_questions_file_path_produces_identical_hash():
    """Verify ephemeral tempfile paths for questions_file do not alter the deterministic eval_hash."""
    config1 = {
        "dataset_name": "enterprise",
        "top_k": 3,
        "questions_file": "/tmp/eval_question_set_abc123/qset_1_hash1.jsonl",
    }
    config2 = {
        "dataset_name": "enterprise",
        "top_k": 3,
        "questions_file": "/tmp/eval_question_set_xyz789/qset_1_hash1.jsonl",
    }
    dataset_content = b'{"question_id": 1, "input": "test"}\n'
    h1 = compute_eval_hash(config1, dataset_bytes=dataset_content)
    h2 = compute_eval_hash(config2, dataset_bytes=dataset_content)
    assert h1 == h2


def test_compute_eval_hash_different_dataset_bytes_produces_distinct_hash():
    """Verify modifying dataset content produces a distinct eval_hash."""
    config = {"dataset_name": "enterprise", "top_k": 3}
    content1 = b'{"question_id": 1, "input": "question 1"}\n'
    content2 = b'{"question_id": 1, "input": "question 2"}\n'
    h1 = compute_eval_hash(config, dataset_bytes=content1)
    h2 = compute_eval_hash(config, dataset_bytes=content2)
    assert h1 != h2


def test_compute_eval_hash_when_submitter_metadata_provided_ignores_submitter_keys() -> (
    None
):
    """Verify compute_eval_hash produces identical fingerprint when submitter metadata differs."""
    base_config = {
        "dataset_name": "enterprise",
        "top_k": 3,
        "datasource_id": "ds-1",
        "question_set_id": 10,
    }
    user_a_config = {
        **base_config,
        "submitter_subject": "user-a-uuid",
        "submitter_email": "user.a@example.com",
        "submitter_role": "evaluator",
        "owner_team": "team-alpha",
        "visibility": "team",
    }
    user_b_config = {
        **base_config,
        "submitter_subject": "user-b-uuid",
        "submitter_email": "user.b@example.com",
        "submitter_role": "admin",
        "owner_team": "team-beta",
        "visibility": "private",
    }
    h_base = compute_eval_hash(base_config)
    h_a = compute_eval_hash(user_a_config)
    h_b = compute_eval_hash(user_b_config)

    assert h_a == h_base
    assert h_b == h_base
    assert h_a == h_b


def test_validate_safe_path_with_unauthorized_external_path_raises_http_400():
    assert validate_safe_path(None) is None
    with pytest.raises(HTTPException) as exc_info:
        validate_safe_path("/etc/passwd")
    assert exc_info.value.status_code == 400


# ---------------------------------------------------------------------------
# JobManager State & LRU Eviction Tests
# ---------------------------------------------------------------------------


def test_job_manager_cache_hit_from_database():
    """Verify JobManager returns cached job when database returns existing run."""
    mock_db = MagicMock(spec=DatabaseManager)
    cached_payload = {
        "job_id": "cached-job-123",
        "status": "completed",
        "created_at": 1700000000.0,
        "completed_at": 1700000050.0,
        "cached": True,
        "eval_hash": "hash123",
        "evaluation_time": 50.0,
        "config_args": {"top_k": 3},
        "summary": {"metrics": {"faithfulness": 1.0}},
        "results": [],
        "user_info": None,
        "error": None,
    }
    mock_db.evaluation.get_cached_job_by_hash.return_value = cached_payload
    jm = JobManager(db_manager=mock_db)

    config = {"dataset_name": "enterprise", "top_k": 3}
    job = jm.create_job("hash123", config, force_rerun=False)

    assert job["cached"] is True
    assert job["status"] == JobStatusEnum.COMPLETED
    assert job["job_id"] is not None
    assert len(job["job_id"]) == 36
    mock_db.evaluation.get_cached_job_by_hash.assert_called_once_with(
        "hash123", ttl_seconds=86400
    )


def test_job_manager_cache_hit_persists_full_independent_run_and_duplicated_results() -> (
    None
):
    """Verify that a cache hit creates a new unique job_id and persists duplicated results in Postgres."""
    mock_db = MagicMock(spec=DatabaseManager)
    mock_db.is_postgres.return_value = True

    cached_results = [
        {
            "question_id": "q1",
            "user_input": "What is CAIPE?",
            "actual_input": "Enriched instruction.\n\nWhat is CAIPE?",
            "reference": "CAIPE platform",
            "actual_output": "CAIPE is an AI platform.",
            "metrics": {"faithfulness": 1.0},
        }
    ]
    cached_payload = {
        "job_id": "original-job-001",
        "status": "completed",
        "created_at": 1700000000.0,
        "completed_at": 1700000050.0,
        "cached": True,
        "eval_hash": "hash_cached_dup",
        "evaluation_time": 45.0,
        "config_args": {"dataset_name": "enterprise", "top_k": 3},
        "summary": {"metrics": {"faithfulness": 1.0}},
        "results": cached_results,
        "user_info": {"email": "original_user@example.com"},
        "error": None,
    }
    mock_db.evaluation.get_cached_job_by_hash.return_value = cached_payload
    jm = JobManager(db_manager=mock_db)

    caller_user = UserContext(
        subject="user_b_sub",
        email="caller_user@example.com",
        role="member",
        groups=["team-a"],
    )
    config = {"dataset_name": "enterprise", "top_k": 3, "visibility": "private"}

    with patch("deepeval_eval.api.job_manager.PostgresResultSink") as mock_sink_cls:
        mock_sink_instance = MagicMock()
        mock_sink_cls.return_value = mock_sink_instance

        job = jm.create_job(
            "hash_cached_dup", config, force_rerun=False, user=caller_user
        )

        assert job["cached"] is True
        assert job["status"] == JobStatusEnum.COMPLETED
        assert job["job_id"] != "original-job-001"
        assert job["user_info"]["email"] == "caller_user@example.com"
        assert job["results"] == cached_results

        # Verify saved to queue table
        mock_db.evaluation.save_job_to_queue.assert_called_once()
        queue_call_kwargs = mock_db.evaluation.save_job_to_queue.call_args[1]
        assert queue_call_kwargs["job_id"] == job["job_id"]
        assert queue_call_kwargs["status"] == "completed"

        # Verify PostgresResultSink saved full duplicated results under caller's job_id
        mock_sink_cls.assert_called_once_with(db_manager=mock_db)
        mock_sink_instance.save.assert_called_once()
        save_kwargs = mock_sink_instance.save.call_args[1]
        assert save_kwargs["prefix"] == job["job_id"]
        assert save_kwargs["results"] == cached_results
        assert save_kwargs["config_args"]["run_id"] == job["job_id"]


def test_job_manager_cache_miss_creates_pending_job():
    """Verify JobManager creates pending job when cache misses."""
    mock_db = MagicMock(spec=DatabaseManager)
    mock_db.evaluation.get_cached_job_by_hash.return_value = None
    jm = JobManager(db_manager=mock_db)

    config = {"dataset_name": "enterprise", "top_k": 3}
    job = jm.create_job("hash456", config, force_rerun=False)

    assert job["cached"] is False
    assert job["status"] == JobStatusEnum.PENDING


def test_job_manager_create_and_list():
    """Verify JobManager job creation, retrieval, listing, and deduplication."""
    mock_db = MagicMock(spec=DatabaseManager)
    mock_db.evaluation.get_cached_job_by_hash.return_value = None
    jm = JobManager(db_manager=mock_db)

    config = {"dataset_name": "enterprise", "top_k": 3}
    eval_hash = compute_eval_hash(config)
    job1 = jm.create_job(eval_hash, config)
    assert job1["job_id"] is not None
    assert job1["status"] == JobStatusEnum.PENDING
    assert job1["cached"] is False

    # Force rerun -> should create new non-cached job
    job2 = jm.create_job(eval_hash, config, force_rerun=True)
    assert job2["cached"] is False
    assert job2["job_id"] != job1["job_id"]

    all_jobs = jm.list_jobs()
    assert len(all_jobs) >= 2


def test_job_manager_get_negative():
    """Verify JobManager returns None for unknown job_id."""
    mock_db = MagicMock(spec=DatabaseManager)
    jm = JobManager(db_manager=mock_db)
    assert jm.get_job("non_existent_id") is None


def test_job_manager_create_job_when_in_memory_capacity_exceeded_evicts_oldest_finished_jobs():
    mock_db = MagicMock()
    jm = JobManager(db_manager=mock_db)
    jm.MAX_IN_MEMORY_JOBS = 5

    for i in range(6):
        job = jm.create_job(
            f"eval_hash_{i}", config_dict={"dataset_name": f"ds_{i}"}, force_rerun=True
        )
        jm.update_job(job["job_id"], {"status": JobStatusEnum.COMPLETED})

    assert len(jm.jobs) <= 5


def test_job_manager_eviction_when_max_in_memory_jobs_reached_removes_oldest_finished_jobs() -> (
    None
):
    """Verify JobManager evicts finished jobs when MAX_IN_MEMORY_JOBS threshold is reached."""
    manager = JobManager(db_manager, max_in_memory_jobs=2)

    # Add 2 finished jobs
    j1 = manager.create_job("hash-1", {"dataset_name": "enterprise"})
    manager.jobs[j1["job_id"]]["status"] = JobStatusEnum.COMPLETED
    manager.hash_to_job_id["hash-1"] = j1["job_id"]

    j2 = manager.create_job("hash-2", {"dataset_name": "enterprise"})
    manager.jobs[j2["job_id"]]["status"] = JobStatusEnum.FAILED
    manager.hash_to_job_id["hash-2"] = j2["job_id"]

    # Add 3rd job to trigger eviction (10% of 2 is 0.2 -> max(1, int(0.2)) = 1 evicted)
    j3 = manager.create_job("hash-3", {"dataset_name": "enterprise"})
    assert j3["job_id"] in manager.jobs
    # Oldest finished job should have been evicted
    assert j1["job_id"] not in manager.jobs


def test_get_max_in_memory_jobs_default_and_env_override(monkeypatch) -> None:
    """Verify get_max_in_memory_jobs returns 50 by default and respects environment overrides."""
    monkeypatch.delenv("EVAL_IN_MEMORY_JOBS_MAX", raising=False)
    assert get_max_in_memory_jobs() == 50

    monkeypatch.setenv("EVAL_IN_MEMORY_JOBS_MAX", "30")
    assert get_max_in_memory_jobs() == 30

    monkeypatch.setenv("EVAL_IN_MEMORY_JOBS_MAX", "invalid")
    assert get_max_in_memory_jobs() == 50


def test_get_job_purge_rate_default_and_env_override(monkeypatch) -> None:
    """Verify get_job_purge_rate defaults to 0.10 and correctly handles ratio, percentage, and invalid strings."""
    monkeypatch.delenv("EVAL_IN_MEMORY_JOBS_EVICTION_RATE", raising=False)
    assert get_job_purge_rate() == 0.10

    monkeypatch.setenv("EVAL_IN_MEMORY_JOBS_EVICTION_RATE", "0.25")
    assert get_job_purge_rate() == 0.25

    monkeypatch.setenv("EVAL_IN_MEMORY_JOBS_EVICTION_RATE", "20%")
    assert get_job_purge_rate() == 0.20

    monkeypatch.setenv("EVAL_IN_MEMORY_JOBS_EVICTION_RATE", "15")
    assert get_job_purge_rate() == 0.15

    monkeypatch.setenv("EVAL_IN_MEMORY_JOBS_EVICTION_RATE", "invalid")
    assert get_job_purge_rate() == 0.10


def test_job_manager_custom_purge_rate_evicts_proportional_batch() -> None:
    """Verify JobManager with custom purge rate evicts the expected proportion of finished jobs."""
    manager = JobManager(db_manager, max_in_memory_jobs=5, purge_rate=0.40)
    for i in range(5):
        j = manager.create_job(f"hash-{i}", {"dataset_name": "enterprise"})
        manager.jobs[j["job_id"]]["status"] = JobStatusEnum.COMPLETED
        manager.hash_to_job_id[f"hash-{i}"] = j["job_id"]

    # Trigger eviction by creating 6th job
    j_new = manager.create_job("hash-new", {"dataset_name": "enterprise"})
    assert j_new["job_id"] in manager.jobs
    # 5 * 0.40 = 2 jobs evicted (hash-0 and hash-1)
    remaining_hashes = {
        job.get("eval_hash") for job in manager.jobs.values() if job.get("eval_hash")
    }
    assert "hash-0" not in remaining_hashes
    assert "hash-1" not in remaining_hashes
    assert "hash-2" in remaining_hashes


def test_job_manager_cached_job_summary_rebuilding_when_summary_empty() -> None:
    """Verify JobManager rebuilds summary from cached results if summary is empty."""
    mock_db = MagicMock()
    mock_db.evaluation.get_cached_job_by_hash.return_value = {
        "job_id": "cached-job-123",
        "results": [{"metric_name": "Relevancy", "score": 1.0}],
        "summary": None,
        "evaluation_time": 2.5,
    }

    manager = JobManager(mock_db)
    job = manager.create_job("hash-cached-summary", {"dataset_name": "enterprise"})
    assert job["cached"] is True
    assert job["summary"] != {}


def test_job_manager_update_job_non_existent_id_returns_none() -> None:
    """Verify JobManager.update_job returns None when job ID does not exist."""
    manager = JobManager(db_manager)
    res = manager.update_job("non-existent-job-xyz", {"status": "completed"})
    assert res is None


def test_job_manager_list_jobs_with_completed_at_and_error_fields() -> None:
    """Verify JobManager.list_jobs populates completed_at and error from persistent queue."""
    manager = JobManager(db_manager)
    local_job = manager.create_job("hash-local-err", {"dataset_name": "enterprise"})
    jid = local_job["job_id"]

    with patch(
        "deepeval_eval.api.job_manager.persistent_job_queue.list_jobs",
        return_value=[
            {
                "job_id": jid,
                "status": JobStatusEnum.FAILED,
                "completed_at": 1700000000.0,
                "error": "Execution timed out",
            }
        ],
    ):
        jobs = manager.list_jobs()
        match = next(j for j in jobs if j["job_id"] == jid)
        assert match["status"] == JobStatusEnum.FAILED
        assert match["completed_at"] == 1700000000.0
        assert match["error"] == "Execution timed out"


def test_job_manager_list_jobs_empty_allowed_ids_filters_by_user_email() -> None:
    """Verify JobManager.list_jobs filters jobs by user_email when allowed_ids is empty list."""
    manager = JobManager(db_manager)
    j1 = manager.create_job(
        "hash-u1",
        {
            "dataset_name": "enterprise",
            "user_info": {"email": "alice@example.com"},
        },
    )
    j2 = manager.create_job(
        "hash-u2",
        {
            "dataset_name": "enterprise",
            "user_info": {"email": "bob@example.com"},
        },
    )

    with patch(
        "deepeval_eval.api.job_manager.persistent_job_queue.list_jobs", return_value=[]
    ):
        jobs = manager.list_jobs(allowed_ids=[], user_email="alice@example.com")
        ids = [j["job_id"] for j in jobs]
        assert j1["job_id"] in ids
        assert j2["job_id"] not in ids


def test_job_manager_get_and_list_sync_with_persistent_queue() -> None:
    """Verify JobManager syncs statuses, timestamps, and error messages from persistent queue."""
    # 1. Job present in memory and persistent queue
    job = job_manager.create_job(
        "h_sync", {"dataset_name": "ds_sync"}, force_rerun=True
    )
    jid = job["job_id"]

    with patch.object(
        persistent_job_queue,
        "get_job",
        return_value={
            "job_id": jid,
            "status": "failed",
            "started_at": 1000.0,
            "completed_at": 1050.0,
            "error": "Simulated error",
        },
    ):
        synced = job_manager.get_job(jid)
        assert synced is not None
        assert synced["status"] == "failed"
        assert synced["started_at"] == 1000.0
        assert synced["completed_at"] == 1050.0
        assert synced["error"] == "Simulated error"

    # 2. Job present only in persistent queue
    with patch.object(
        persistent_job_queue,
        "get_job",
        return_value={
            "job_id": "job-external-1",
            "status": "completed",
            "created_at": 500.0,
            "completed_at": 550.0,
            "eval_hash": "h_ext",
            "config_args": {"dataset_name": "ext_ds"},
            "error": None,
        },
    ):
        ext_job = job_manager.get_job("job-external-1")
        assert ext_job is not None
        assert ext_job["job_id"] == "job-external-1"
        assert ext_job["status"] == "completed"

    # 3. list_jobs with allowed_ids and email filtering
    with patch.object(
        persistent_job_queue,
        "list_jobs",
        return_value=[
            {
                "job_id": "job-user-alice",
                "status": "completed",
                "created_at": 200.0,
                "config_args": {"user_info": {"email": "alice@example.com"}},
            },
            {
                "job_id": "job-user-bob",
                "status": "completed",
                "created_at": 100.0,
                "config_args": {"created_by": "bob@example.com"},
            },
        ],
    ):
        alice_jobs = job_manager.list_jobs(
            allowed_ids=[], user_email="alice@example.com"
        )
        assert any(j["job_id"] == "job-user-alice" for j in alice_jobs)


# ---------------------------------------------------------------------------
# Background Job Execution & Worker Loop Tests
# ---------------------------------------------------------------------------


@patch("deepeval_eval.api.job_manager.PostgresResultSink")
@patch("deepeval_eval.api.job_manager.run_evaluation")
@patch("deepeval_eval.api.job_manager._build_rag_client")
def test_execute_evaluation_job_positive(
    mock_build_rag, mock_run_eval, mock_sink, tmp_path: Path
):
    """Verify execute_evaluation_job updates job status to COMPLETED and passes PostgresResultSink."""
    mock_run_eval.return_value = [{"question": "q1", "metrics": {}}]

    req = EvaluationRequest(dataset_name="enterprise", max_items=1)
    eval_hash = compute_eval_hash(req.model_dump())
    job = job_manager.create_job(eval_hash, req.model_dump(), force_rerun=True)

    with patch.object(
        db_manager.evaluation,
        "get_job_results_payload",
        return_value=[{"question_id": "q1", "question": "q1"}],
    ):
        execute_evaluation_job(job["job_id"], req)

        updated_job = job_manager.get_job(job["job_id"])
        assert updated_job["status"] == JobStatusEnum.COMPLETED
        results = job_manager.get_job_results_payload(job["job_id"])
        assert len(results) == 1
        mock_run_eval.assert_called_once()
        _, kwargs = mock_run_eval.call_args
        assert "sinks" in kwargs
        assert len(kwargs["sinks"]) == 1


@patch(
    "deepeval_eval.api.job_manager.run_evaluation",
    side_effect=ValueError("Eval engine error"),
)
@patch("deepeval_eval.api.job_manager._build_rag_client")
def test_execute_evaluation_job_negative(mock_build_rag, mock_run_eval):
    """Verify execute_evaluation_job handles failure and re-raises exception."""
    req = EvaluationRequest(dataset_name="enterprise")
    eval_hash = compute_eval_hash(req.model_dump())
    job = job_manager.create_job(eval_hash, req.model_dump(), force_rerun=True)

    with pytest.raises(ValueError, match="Eval engine error"):
        execute_evaluation_job(job["job_id"], req)

    updated_job = job_manager.get_job(job["job_id"])
    assert updated_job["status"] == JobStatusEnum.FAILED
    assert "Eval engine error" in updated_job["error"]


def test_build_job_summary_positive():
    """Positive test for _build_job_summary with sample result metrics."""
    sample_results = [
        {
            "latency": 1.25,
            "total_tokens": 150,
            "evaluator_prompt_tokens": 500,
            "evaluator_completion_tokens": 100,
            "doc_id_recall": 1.0,
            "doc_id_precision": 0.5,
            "metrics": {
                "FaithfulnessMetric": {"score": 0.9, "success": True},
                "AnswerRelevancyMetric": {"score": 0.8, "success": True},
            },
        }
    ]
    summary = _build_job_summary(sample_results, eval_time=2.5)

    assert summary["total_items"] == 1
    assert summary["evaluation_time_seconds"] == 2.5
    assert summary["p50_latency"] == 1.25
    assert summary["total_tokens"] == 150
    assert "metrics" in summary
    assert summary["metrics"]["faithfulness"] == 0.9
    assert summary["metrics"]["answer_relevancy"] == 0.8
    assert summary["metrics"]["retrieval_recall"] == 1.0
    assert summary["metrics"]["retrieval_precision"] == 0.5
    assert summary["deepeval_evaluator_usage"]["prompt_tokens"] == 500
    assert summary["deepeval_evaluator_usage"]["completion_tokens"] == 100
    assert summary["deepeval_evaluator_usage"]["total_tokens"] == 600


def test_build_job_summary_negative():
    """Negative test for _build_job_summary with empty evaluation results."""
    summary = _build_job_summary([], eval_time=0.0)

    assert summary["total_items"] == 0
    assert summary["evaluation_time_seconds"] == 0.0
    assert summary["p50_latency"] == 0.0
    assert summary["total_tokens"] == 0
    assert summary["metrics"]["retrieval_recall"] == 0.0
    assert summary["metrics"]["retrieval_precision"] == 0.0
    assert summary["deepeval_evaluator_usage"]["total_tokens"] == 0


@patch("deepeval_eval.api.job_manager.execute_evaluation_job")
def test_run_queued_evaluation_cleans_up_temp_upload_dir(mock_execute):
    """Verify _run_queued_evaluation removes temporary upload directory on completion."""
    import tempfile

    temp_dir = tempfile.mkdtemp(prefix="eval_upload_")
    temp_file = Path(temp_dir) / "questions.json"
    temp_file.write_text('[{"question": "test"}]')

    config_dict = {
        "dataset_name": "temp_test",
        "questions_file": str(temp_file),
    }

    _run_queued_evaluation("job-temp-clean", config_dict)
    assert not Path(temp_dir).exists()


@patch("deepeval_eval.api.job_manager._build_rag_client")
@patch("deepeval_eval.api.job_manager.run_evaluation")
def test_execute_evaluation_job_handles_upload_json_file(
    mock_run_eval, mock_build_client, tmp_path: Path
):
    """Verify execute_evaluation_job processes uploaded .json dataset file cleanly."""
    q_file = tmp_path / "eval_upload_123" / "upload_dataset.json"
    q_file.parent.mkdir(parents=True, exist_ok=True)
    q_file.write_text('[{"user_input": "q1"}, {"user_input": "q2"}]', encoding="utf-8")

    mock_run_eval.return_value = [{"question": "q1", "actual_output": "ans1"}]

    req = EvaluationRequest(
        dataset_name="custom_upload",
        question_ids=["q1", "q2"],
        question_indices=[1, 2],
    )
    job = job_manager.create_job(
        "hash_upload_json_exec", req.model_dump(), force_rerun=True
    )

    execute_evaluation_job(job["job_id"], req, temp_file_path=str(q_file))

    assert mock_run_eval.called
    eval_config = mock_run_eval.call_args[0][0]
    assert str(eval_config.questions_file) == str(q_file)
    assert eval_config.question_ids == "q1,q2"
    assert eval_config.question_indices == "1,2"


@patch("deepeval_eval.api.job_manager.PostgresResultSink")
@patch("deepeval_eval.api.job_manager._build_rag_client")
@patch("deepeval_eval.api.job_manager.run_evaluation")
def test_execute_evaluation_job_postgres_sink_passed_to_run_evaluation(
    mock_run_eval, mock_build_client, mock_sink_cls, tmp_path: Path
):
    """Verify execute_evaluation_job passes PostgresResultSink instance in sinks to run_evaluation."""
    mock_sink_instance = MagicMock()
    mock_sink_cls.return_value = mock_sink_instance
    mock_run_eval.return_value = [{"question": "q1", "actual_output": "ans1"}]

    req = EvaluationRequest(
        dataset_name="db_save_test",
    )
    job = job_manager.create_job(
        "hash_db_save_test", req.model_dump(), force_rerun=True
    )

    execute_evaluation_job(job["job_id"], req)

    mock_run_eval.assert_called_once()
    _, kwargs = mock_run_eval.call_args
    assert "sinks" in kwargs
    assert kwargs["sinks"] == [mock_sink_instance]


@patch("deepeval_eval.api.job_manager._build_rag_client")
@patch("deepeval_eval.api.job_manager.run_evaluation")
def test_evaluation_request_accepts_experiment_name_and_forwards_to_eval_config(
    mock_run_eval, mock_build_client
):
    """Verify EvaluationRequest accepts experiment_name and forwards to EvalConfig."""
    req_exp = EvaluationRequest(
        dataset_name="enterprise",
        experiment_name="my-experiment-campaign",
    )
    assert req_exp.experiment_name == "my-experiment-campaign"
    assert not hasattr(req_exp, "run_id") or req_exp.model_dump().get("run_id") is None

    job = job_manager.create_job(
        "hash_exp_name_test", req_exp.model_dump(), force_rerun=True
    )
    mock_run_eval.return_value = [{"question": "q1", "actual_output": "ans1"}]

    execute_evaluation_job(job["job_id"], req_exp)

    assert mock_run_eval.called
    eval_config = mock_run_eval.call_args[0][0]
    assert eval_config.experiment_name == "my-experiment-campaign"


def test_execute_evaluation_job_dynamic_tool_and_db_save_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Verify execute_evaluation_job configures DynamicMCPToolManager and catches DB save failures gracefully."""
    created = job_manager.create_job(
        "h_dyn", {"dataset_name": "enterprise"}, force_rerun=True
    )
    jid = created["job_id"]

    req = EvaluationRequest(
        dataset_name="enterprise",
        dynamic_tool=True,
        semantic_weight=0.7,
        tool_description="Custom test tool",
        datasource_id="ds-dynamic-1",
    )

    mock_tool_mgr = MagicMock()
    mock_tool_mgr.tool_id = "dynamic_mcp_tool_123"
    mock_tool_mgr.__enter__.return_value = mock_tool_mgr
    mock_tool_mgr.__exit__.return_value = None

    with (
        patch(
            "deepeval_eval.clients.mcp_tool_manager.DynamicMCPToolManager",
            return_value=mock_tool_mgr,
        ),
        patch("deepeval_eval.clients.search_rag.build_search_rag_client"),
        patch("deepeval_eval.api.job_manager._build_rag_client"),
        patch(
            "deepeval_eval.api.job_manager.run_evaluation",
            return_value=[{"question_id": "q1", "actual_output": "out"}],
        ),
        patch(
            "deepeval_eval.api.job_manager.PostgresResultSink",
            side_effect=RuntimeError("DB connect failed"),
        ),
        caplog.at_level(logging.WARNING, logger="deepeval_eval.api.job_manager"),
    ):
        execute_evaluation_job(jid, req)
        assert (
            f"PostgresResultSink initialization for job '{jid}' failed" in caplog.text
        )


def test_run_queued_evaluation_revoked_permission_raises_permission_error() -> None:
    """Verify _run_queued_evaluation aborts with PermissionError when submitter authorization is revoked."""
    raw_config = {
        "dataset_name": "enterprise",
        "submitter_subject": "revoked-user-sub",
        "submitter_role": "readonly",
    }

    with patch(
        "deepeval_eval.api.job_manager.sync_authorize_evaluate_subject",
        return_value=False,
    ):
        with pytest.raises(PermissionError, match="EVAL_AUTHZ_REVOKED"):
            _run_queued_evaluation("job-revoked-123", raw_config)


def test_run_queued_evaluation_obo_enabled_injects_delegated_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify _run_queued_evaluation exchanges and injects OBO token for human user jobs."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "true")
    raw_config = {
        "dataset_name": "enterprise",
        "submitter_subject": "alice-sub",
        "submitter_role": "readonly",
    }

    with (
        patch(
            "deepeval_eval.api.job_manager.sync_authorize_evaluate_subject",
            return_value=True,
        ),
        patch(
            "deepeval_eval.api.job_manager.exchange_token_for_user",
            return_value="obo-delegated-token-abc",
        ) as mock_exchange,
        patch("deepeval_eval.api.job_manager.execute_evaluation_job") as mock_exec,
    ):
        _run_queued_evaluation("job-obo-123", raw_config)
        mock_exchange.assert_called_once_with("alice-sub")
        mock_exec.assert_called_once()
        _, kwargs = mock_exec.call_args
        assert kwargs["user_token"] == "obo-delegated-token-abc"
        assert kwargs["user_subject"] == "alice-sub"


def test_run_queued_evaluation_m2m_submitter_skips_obo_exchange(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify _run_queued_evaluation skips OBO exchange when submitter is an M2M client credentials token."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "true")
    raw_config = {
        "dataset_name": "enterprise",
        "submitter_subject": "m2m-service-account",
        "submitter_role": RBAC_EVALUATOR_CLIENT_CREDENTIALS_ROLE,
    }

    with (
        patch(
            "deepeval_eval.api.job_manager.sync_authorize_evaluate_subject",
            return_value=True,
        ),
        patch("deepeval_eval.api.job_manager.exchange_token_for_user") as mock_exchange,
        patch("deepeval_eval.api.job_manager.execute_evaluation_job") as mock_exec,
    ):
        _run_queued_evaluation("job-m2m-123", raw_config)
        mock_exchange.assert_not_called()
        mock_exec.assert_called_once()
        _, kwargs = mock_exec.call_args
        assert kwargs["user_token"] is None


def test_run_queued_evaluation_obo_token_exchange_failure_raises_permission_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify _run_queued_evaluation raises PermissionError with EVAL_OBO_FAILED when token exchange fails."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "true")
    raw_config = {
        "dataset_name": "enterprise",
        "submitter_subject": "failing-sub",
        "submitter_role": "readonly",
    }

    with (
        patch(
            "deepeval_eval.api.job_manager.sync_authorize_evaluate_subject",
            return_value=True,
        ),
        patch(
            "deepeval_eval.api.job_manager.exchange_token_for_user",
            side_effect=OboExchangeError("Network unreachable"),
        ),
    ):
        with pytest.raises(PermissionError, match="EVAL_OBO_FAILED"):
            _run_queued_evaluation("job-fail-obo-123", raw_config)


def test_run_queued_evaluation_cleanup_failure_logs_warning(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Verify _run_queued_evaluation catches and logs cleanup errors in temporary upload directories."""
    monkeypatch.setenv("EVALUATOR_OBO_ENABLED", "false")
    qfile = tmp_path / "questions.json"
    qfile.write_text("[]", encoding="utf-8")

    raw_config = {
        "dataset_name": "enterprise",
        "questions_file": str(qfile),
    }

    with (
        patch("deepeval_eval.api.job_manager.execute_evaluation_job"),
        patch("pathlib.Path.unlink", side_effect=OSError("Permission denied")),
    ):
        # Should not crash on cleanup error
        _run_queued_evaluation("job-cleanup-warn-123", raw_config)


def test_execute_evaluation_job_non_existent_job_returns_early() -> None:
    """Verify execute_evaluation_job returns early without error when job_id is not in job_manager."""
    req = EvaluationRequest(dataset_name="enterprise")
    # Should not raise exception and exit cleanly
    execute_evaluation_job("non-existent-eval-job-404", req)


def test_execute_evaluation_job_with_user_subject_and_user_token_sets_config_attributes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify execute_evaluation_job injects user_subject and user_token onto EvalConfig."""
    job = job_manager.create_job(
        "hash-exec-obo", {"dataset_name": "enterprise"}, force_rerun=True
    )
    jid = job["job_id"]
    req = EvaluationRequest(dataset_name="enterprise", max_items=1)

    captured_config: list[Any] = []

    def mock_run_eval(cfg: Any, **kwargs: Any) -> list[Any]:
        captured_config.append(cfg)
        return []

    with (
        patch("deepeval_eval.api.job_manager._build_rag_client"),
        patch(
            "deepeval_eval.api.job_manager.run_evaluation", side_effect=mock_run_eval
        ),
        patch("deepeval_eval.api.job_manager.PostgresResultSink"),
    ):
        execute_evaluation_job(
            jid,
            req,
            user_subject="usr-subject-abc",
            user_token="usr-token-xyz",
        )
        assert len(captured_config) == 1
        assert getattr(captured_config[0], "submitter_subject") == "usr-subject-abc"
        assert getattr(captured_config[0], "user_token") == "usr-token-xyz"


def test_execute_evaluation_job_dynamic_tool_with_agentic_settings_sets_search_tool() -> (
    None
):
    """Verify execute_evaluation_job configures dynamic search tool on agentic_settings when dynamic_tool is enabled."""
    job = job_manager.create_job(
        "hash-exec-dynamic",
        {"dataset_name": "enterprise", "dynamic_tool": True},
        force_rerun=True,
    )
    jid = job["job_id"]
    req = EvaluationRequest(
        dataset_name="enterprise",
        dynamic_tool=True,
        max_items=1,
        agentic=True,
    )

    mock_tool_mgr = MagicMock()
    mock_tool_mgr.tool_id = "dynamic_search_tool_v1"
    mock_tool_mgr.__enter__.return_value = mock_tool_mgr
    mock_tool_mgr.__exit__.return_value = None

    with (
        patch(
            "deepeval_eval.clients.mcp_tool_manager.DynamicMCPToolManager",
            return_value=mock_tool_mgr,
        ),
        patch("deepeval_eval.clients.search_rag.build_search_rag_client"),
        patch("deepeval_eval.api.job_manager._build_rag_client"),
        patch("deepeval_eval.api.job_manager.run_evaluation", return_value=[]),
        patch("deepeval_eval.api.job_manager.PostgresResultSink"),
    ):
        execute_evaluation_job(jid, req)
        assert job_manager.get_job(jid)["status"] == "completed"


def test_run_queued_evaluation_when_submitter_evaluate_revoked_raises_permission_error() -> (
    None
):
    """Verify _run_queued_evaluation raises PermissionError if org evaluate permission was revoked."""
    raw_config = {
        "submitter_subject": "revoked-user-123",
        "submitter_role": "readonly",
    }
    with patch(
        "deepeval_eval.api.job_manager.sync_authorize_evaluate_subject",
        return_value=False,
    ):
        with pytest.raises(
            PermissionError, match="EVAL_AUTHZ_REVOKED: Submitter permission revoked"
        ):
            _run_queued_evaluation("job-test-revoked-org", raw_config)


def test_run_queued_evaluation_when_agent_access_revoked_raises_permission_error() -> (
    None
):
    """Verify _run_queued_evaluation raises PermissionError if agent access was revoked."""
    raw_config = {
        "submitter_subject": "user-123",
        "submitter_role": "readonly",
        "agent_id": "revoked-agent",
    }
    with (
        patch(
            "deepeval_eval.api.job_manager.sync_authorize_evaluate_subject",
            return_value=True,
        ),
        patch(
            "deepeval_eval.api.job_manager.sync_authorize_agent_subject",
            return_value=False,
        ),
    ):
        with pytest.raises(
            PermissionError,
            match="EVAL_AUTHZ_REVOKED: Submitter access to agent 'revoked-agent' revoked",
        ):
            _run_queued_evaluation("job-test-revoked-agent", raw_config)


def test_run_queued_evaluation_when_datasource_access_revoked_raises_permission_error() -> (
    None
):
    """Verify _run_queued_evaluation raises PermissionError if datasource access was revoked."""
    raw_config = {
        "submitter_subject": "user-123",
        "submitter_role": "readonly",
        "datasource_id": "revoked-ds",
    }
    with (
        patch(
            "deepeval_eval.api.job_manager.sync_authorize_evaluate_subject",
            return_value=True,
        ),
        patch(
            "deepeval_eval.api.job_manager.sync_authorize_datasource_subject",
            return_value=False,
        ),
    ):
        with pytest.raises(
            PermissionError,
            match="EVAL_AUTHZ_REVOKED: Submitter access to datasource 'revoked-ds' revoked",
        ):
            _run_queued_evaluation("job-test-revoked-ds", raw_config)


def test_run_queued_evaluation_when_question_set_access_revoked_raises_permission_error() -> (
    None
):
    """Verify _run_queued_evaluation raises PermissionError if question set access was revoked."""
    raw_config = {
        "submitter_subject": "user-123",
        "submitter_role": "readonly",
        "question_set_id": 999,
    }
    with (
        patch(
            "deepeval_eval.api.job_manager.sync_authorize_evaluate_subject",
            return_value=True,
        ),
        patch(
            "deepeval_eval.api.job_manager.sync_authorize_question_set_subject",
            return_value=False,
        ),
    ):
        with pytest.raises(
            PermissionError,
            match="EVAL_AUTHZ_REVOKED: Submitter access to question set '999' revoked",
        ):
            _run_queued_evaluation("job-test-revoked-qset", raw_config)


def test_run_queued_evaluation_metric_set_and_datasource_forwarded_to_eval_config() -> (
    None
):
    """Verify _run_queued_evaluation forwards metric_set, prompt_args, datasource_id to execute_evaluation_job."""
    raw_config = {
        "submitter_subject": "user-123",
        "submitter_role": "admin",
        "question_set_id": 1,
        "datasource_id": "enterprise_rag_bench",
        "metric_set": "citation_bias_suite",
        "metrics": ["bias", "citation_correctness"],
        "prompt_style": "citation",
        "prompt_args": {"cite_format": "bracket"},
    }

    mock_job = {
        "job_id": "job-test-forwarding",
        "status": "completed",
        "summary": {
            "total_items": 1,
            "metrics": {"bias": 0.0, "citation_correctness": 1.0},
        },
        "results": [],
    }

    with (
        patch(
            "deepeval_eval.api.job_manager.sync_authorize_evaluate_subject",
            return_value=True,
        ),
        patch(
            "deepeval_eval.api.job_manager.sync_authorize_datasource_subject",
            return_value=True,
        ),
        patch(
            "deepeval_eval.api.job_manager.sync_authorize_question_set_subject",
            return_value=True,
        ),
        patch(
            "deepeval_eval.api.job_manager.execute_evaluation_job",
            return_value=mock_job,
        ) as mock_exec,
    ):
        _run_queued_evaluation("job-test-forwarding", raw_config)
        mock_exec.assert_called_once()
        called_req = mock_exec.call_args[0][1]
        assert called_req.metric_set == "citation_bias_suite"
        assert called_req.metrics == ["bias", "citation_correctness"]
        assert called_req.datasource_id == "enterprise_rag_bench"
        assert called_req.prompt_style == "citation"
        assert called_req.prompt_args == {"cite_format": "bracket"}
