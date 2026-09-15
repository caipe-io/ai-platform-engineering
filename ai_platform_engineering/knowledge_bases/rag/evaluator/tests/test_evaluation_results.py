from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from deepeval_eval.api.app import app
from deepeval_eval.api.evaluation_jobs import JobStatusEnum
from deepeval_eval.api.job_manager import job_manager

client = TestClient(app)


@pytest.fixture(autouse=True)
def enable_unauthenticated_access_for_api_tests():
    os.environ["ALLOW_UNAUTHENTICATED_ACCESS"] = "true"
    yield
    os.environ.pop("ALLOW_UNAUTHENTICATED_ACCESS", None)


# ---------------------------------------------------------------------------
# Evaluation Results Endpoints & Helpers Tests
# ---------------------------------------------------------------------------


def test_get_job_results_negative_pending():
    """Verify GET /jobs/{job_id}/results returns 400 if job is not completed yet."""
    job = job_manager.create_job(
        "hash_pending", {"dataset_name": "test"}, force_rerun=True
    )
    res = client.get(f"/jobs/{job['job_id']}/results")
    assert res.status_code == 400


def test_get_job_results_positive_completed():
    """Verify GET /jobs/{job_id}/results returns results for completed job."""
    job = job_manager.create_job(
        "hash_completed", {"dataset_name": "test"}, force_rerun=True
    )
    job["status"] = JobStatusEnum.COMPLETED
    job["results"] = [{"question": "q1"}]

    res = client.get(f"/jobs/{job['job_id']}/results")
    assert res.status_code == 200
    assert len(res.json()["results"]) == 1


def test_get_job_summary_positive_completed():
    """Verify GET /jobs/{job_id}/summary returns summary metadata without full results list."""
    job = job_manager.create_job(
        "hash_summary_test", {"dataset_name": "test_summary"}, force_rerun=True
    )
    job["status"] = JobStatusEnum.COMPLETED
    job["summary"] = {"total_items": 10, "metrics": {"faithfulness": 0.95}}

    res = client.get(f"/jobs/{job['job_id']}/summary")
    assert res.status_code == 200
    data = res.json()
    assert data["job_id"] == job["job_id"]
    assert data["status"] == "completed"
    assert data["summary"]["total_items"] == 10
    assert data["summary"]["metrics"]["faithfulness"] == 0.95
    assert "results" not in data


def test_get_job_summary_csv_positive():
    """Verify GET /jobs/{job_id}/summary?format=csv returns CSV representation of summary."""
    job = job_manager.create_job(
        "hash_summary_csv", {"dataset_name": "test_summary"}, force_rerun=True
    )
    job["status"] = JobStatusEnum.COMPLETED
    job["summary"] = {
        "total_items": 5,
        "p50_latency": 1.5,
        "p95_latency": 2.5,
        "total_tokens": 1000,
        "metrics": {"faithfulness": 0.95, "answer_relevancy": 0.88},
    }

    res = client.get(f"/jobs/{job['job_id']}/summary?format=csv")
    assert res.status_code == 200
    assert "text/csv" in res.headers["content-type"]
    assert (
        f"attachment; filename=job_{job['job_id']}_summary.csv"
        in res.headers["content-disposition"]
    )
    assert (
        "job_id,status,evaluation_time_seconds,total_items,p50_latency,p95_latency,total_tokens,faithfulness,answer_relevancy"
        in res.text
    )
    assert job["job_id"] in res.text
    assert "0.95" in res.text


def test_get_job_summary_invalid_format():
    """Verify GET /jobs/{job_id}/summary?format=invalid returns 400 Bad Request."""
    job = job_manager.create_job(
        "hash_summary_invalid", {"dataset_name": "test"}, force_rerun=True
    )
    job["status"] = JobStatusEnum.COMPLETED

    res = client.get(f"/jobs/{job['job_id']}/summary?format=xml")
    assert res.status_code == 400
    assert "Unsupported format" in res.json()["detail"]


def test_get_job_summary_negative_pending_and_failed():
    """Verify GET /jobs/{job_id}/summary returns 400 for pending job and 500 for failed job."""
    # Pending job
    job_pending = job_manager.create_job(
        "hash_sum_pending", {"dataset_name": "test"}, force_rerun=True
    )
    res_pending = client.get(f"/jobs/{job_pending['job_id']}/summary")
    assert res_pending.status_code == 400

    # Failed job
    job_failed = job_manager.create_job(
        "hash_sum_failed", {"dataset_name": "test"}, force_rerun=True
    )
    job_failed["status"] = JobStatusEnum.FAILED
    job_failed["error"] = "Evaluation engine error"

    res_failed = client.get(f"/jobs/{job_failed['job_id']}/summary")
    assert res_failed.status_code == 500
    assert "Evaluation engine error" in res_failed.json()["detail"]


@patch("deepeval_eval.api.evaluation_results.PostgresResultSink")
def test_save_job_results_to_db_positive(mock_sink_cls):
    """Verify POST /jobs/{job_id}/save-db calls PostgresResultSink.save."""
    mock_sink_instance = MagicMock()
    mock_sink_cls.return_value = mock_sink_instance

    job = job_manager.create_job(
        "hash_db_save", {"dataset_name": "test"}, force_rerun=True
    )
    job["status"] = JobStatusEnum.COMPLETED
    job["results"] = [{"question": "q1"}]

    res = client.post(f"/jobs/{job['job_id']}/save-db")
    assert res.status_code == 200
    assert res.json()["status"] == "success"
    mock_sink_instance.save.assert_called_once()


def test_save_job_results_to_db_negative_not_completed():
    """Verify POST /jobs/{job_id}/save-db returns 400 for incomplete jobs."""
    job = job_manager.create_job(
        "hash_db_save_neg", {"dataset_name": "test"}, force_rerun=True
    )

    res = client.post(f"/jobs/{job['job_id']}/save-db")
    assert res.status_code == 400


def test_query_db_evaluation_runs_positive():
    """Verify GET /results/db queries PostgreSQL database via PostgresResultSink."""
    mock_psycopg2 = MagicMock()
    mock_extras = MagicMock()
    mock_conn = MagicMock()
    mock_cur = MagicMock()

    mock_psycopg2.connect.return_value = mock_conn
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_cur.fetchall.return_value = [
        {
            "run_id": "run_1",
            "batch_id": "batch_1",
            "config_name": "enterprise",
            "loaded_at": "2026-07-22",
            "config_json": {},
        }
    ]

    with (
        patch.dict(
            "os.environ", {"DATABASE_URL": "postgresql://user:pass@localhost/db"}
        ),
        patch.dict(
            "sys.modules", {"psycopg2": mock_psycopg2, "psycopg2.extras": mock_extras}
        ),
    ):
        res = client.get("/results/db?limit=5")
        assert res.status_code == 200
        data = res.json()
        assert data["count"] == 1
        assert data["runs"][0]["run_id"] == "run_1"


def test_query_db_evaluation_runs_negative():
    """Verify GET /results/db handles connection failures cleanly with 500 error."""
    mock_psycopg2 = MagicMock()
    mock_psycopg2.connect.side_effect = Exception("DB Connection Error")

    with (
        patch.dict(
            "os.environ", {"DATABASE_URL": "postgresql://user:pass@localhost/db"}
        ),
        patch.dict(
            "sys.modules", {"psycopg2": mock_psycopg2, "psycopg2.extras": MagicMock()}
        ),
    ):
        res = client.get("/results/db")
        assert res.status_code == 500
        assert "DB Connection Error" in res.json()["detail"]


def test_get_job_results_additional_negative_cases():
    """Verify get_job_results for 404 not found and 500 failed jobs."""
    # Job not found
    res1 = client.get("/jobs/non_existent_9999/results")
    assert res1.status_code == 404

    # Job failed
    failed_job = job_manager.create_job(
        "hash_failed", {"dataset_name": "test"}, force_rerun=True
    )
    failed_job["status"] = JobStatusEnum.FAILED
    failed_job["error"] = "Custom error message"

    res2 = client.get(f"/jobs/{failed_job['job_id']}/results")
    assert res2.status_code == 500
    assert "Custom error message" in res2.json()["detail"]


@patch("deepeval_eval.api.evaluation_results.PostgresResultSink")
def test_save_job_results_to_db_additional_negative_cases(mock_sink_cls):
    """Verify save_job_results_to_db for not found, empty results, and sink errors."""
    # 404 Job not found
    res1 = client.post("/jobs/non_existent_8888/save-db")
    assert res1.status_code == 404

    # Empty results list
    empty_job = job_manager.create_job(
        "hash_empty_results", {"dataset_name": "test"}, force_rerun=True
    )
    empty_job["status"] = JobStatusEnum.COMPLETED
    empty_job["results"] = []

    res2 = client.post(f"/jobs/{empty_job['job_id']}/save-db")
    assert res2.status_code == 400
    assert "No evaluation results" in res2.json()["detail"]

    # Exception during sink.save
    mock_instance = MagicMock()
    mock_instance.save.side_effect = Exception("Sink write error")
    mock_sink_cls.return_value = mock_instance

    valid_job = job_manager.create_job(
        "hash_sink_err", {"dataset_name": "test"}, force_rerun=True
    )
    valid_job["status"] = JobStatusEnum.COMPLETED
    valid_job["results"] = [{"question": "q"}]

    res3 = client.post(f"/jobs/{valid_job['job_id']}/save-db")
    assert res3.status_code == 500
    assert "Sink write error" in res3.json()["detail"]


def test_get_job_results_csv_positive():
    """Verify GET /jobs/{job_id}/results format=csv returns CSV content."""
    job = job_manager.create_job(
        "hash_csv_test", {"dataset_name": "enterprise"}, force_rerun=True
    )
    job["status"] = JobStatusEnum.COMPLETED
    sample_results = [
        {
            "question_id": "q1",
            "question": "What is CAIPE?",
            "actual_output": "CAIPE is an enterprise RAG platform.",
            "latency": 1.25,
            "total_tokens": 150,
            "metrics": {"AnswerRelevancyMetric": {"score": 1.0, "reason": "Relevant"}},
        }
    ]
    job["results"] = sample_results

    response = client.get(f"/jobs/{job['job_id']}/results?format=csv")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    disp = response.headers["content-disposition"]
    assert f"attachment; filename=job_{job['job_id']}_results.csv" in disp
    assert "question_id,benchmark" in response.text
    assert "What is CAIPE?" in response.text
    assert "AVERAGE_METRICS" in response.text


def test_get_job_results_invalid_format():
    """Verify GET /jobs/{job_id}/results with unsupported format returns HTTP 400."""
    job = job_manager.create_job(
        "hash_invalid_format_test", {"dataset_name": "enterprise"}, force_rerun=True
    )
    job["status"] = JobStatusEnum.COMPLETED

    response = client.get(f"/jobs/{job['job_id']}/results?format=invalid_fmt")
    assert response.status_code == 400
    assert "Unsupported format" in response.json()["detail"]


def test_get_job_results_streaming_multi_item():
    """Verify streaming response for multi-item job results delivers valid JSON."""
    job = job_manager.create_job(
        "hash_streaming_multi", {"dataset_name": "test_streaming"}, force_rerun=True
    )
    job["status"] = JobStatusEnum.COMPLETED
    multi_results = [
        {"item_id": 1, "question": "q1", "answer": "a1"},
        {"item_id": 2, "question": "q2", "answer": "a2"},
        {"item_id": 3, "question": "q3", "answer": "a3"},
    ]
    job["results"] = multi_results

    res = client.get(f"/jobs/{job['job_id']}/results")
    assert res.status_code == 200
    data = res.json()
    assert data["job_id"] == job["job_id"]
    assert len(data["results"]) == 3
    assert data["results"][0]["item_id"] == 1
    assert data["results"][2]["item_id"] == 3


def test_get_job_results_streaming_none_results():
    """Verify streaming response when results payload is None/missing."""
    job = job_manager.create_job(
        "hash_streaming_none", {"dataset_name": "test_none"}, force_rerun=True
    )
    job["status"] = JobStatusEnum.COMPLETED

    res = client.get(f"/jobs/{job['job_id']}/results")
    assert res.status_code == 200
    data = res.json()
    assert data["job_id"] == job["job_id"]
    assert data["results"] == []


def test_save_job_results_to_db_with_completed_job_persists_to_postgresql():
    job = job_manager.create_job(
        "test_hash_save_db", config_dict={"dataset_name": "test_ds"}, force_rerun=True
    )
    job_id = job["job_id"]
    job_manager.update_job(
        job_id,
        {
            "status": JobStatusEnum.COMPLETED,
            "results": [{"question_id": "q1", "user_input": "Q", "actual_output": "A"}],
            "config_args": {"dataset_name": "test_ds"},
            "evaluation_time": 1.0,
        },
    )

    with patch("deepeval_eval.sinks.psql_sink.PostgresResultSink.save") as mock_save:
        res = client.post(f"/jobs/{job_id}/save-db")
        assert res.status_code == 200
        assert res.json()["status"] == "success"
        mock_save.assert_called_once()


def test_save_job_results_to_db_with_nonexistent_job_returns_http_404():
    res_404 = client.post("/jobs/non-existent-job-12345/save-db")
    assert res_404.status_code == 404


def test_query_db_evaluation_runs_with_stored_runs_returns_run_list():
    with patch(
        "deepeval_eval.sinks.psql_sink.PostgresResultSink.query_runs",
        return_value=[{"run_id": "run-1"}],
    ):
        res_list = client.get("/results/db")
        assert res_list.status_code == 200
        assert res_list.json()["count"] == 1


def test_query_db_evaluation_results_with_valid_run_id_returns_run_details():
    with patch(
        "deepeval_eval.sinks.psql_sink.PostgresResultSink.query_evaluation_results",
        return_value=[{"question_id": "q1"}],
    ):
        res_detail = client.get("/results/db/run-1")
        assert res_detail.status_code == 200
        assert res_detail.json()["run_id"] == "run-1"


def test_get_job_summary_json_and_csv() -> None:
    job = job_manager.create_job(
        "hash_summary_test", {"dataset_name": "test_ds"}, force_rerun=True
    )
    job_id = job["job_id"]
    job_manager.update_job(
        job_id,
        {
            "status": JobStatusEnum.COMPLETED,
            "results": [
                {
                    "question_id": "q1",
                    "user_input": "Q",
                    "actual_output": "A",
                    "Faithfulness": 1.0,
                }
            ],
            "evaluation_time": 1.5,
        },
    )

    # JSON summary
    res_json = client.get(f"/jobs/{job_id}/summary?format=json")
    assert res_json.status_code == 200
    assert res_json.json()["job_id"] == job_id

    # CSV summary
    res_csv = client.get(f"/jobs/{job_id}/summary?format=csv")
    assert res_csv.status_code == 200
    assert "job_id" in res_csv.text or "metrics" in res_csv.text

    # Unsupported format -> 400
    res_bad = client.get(f"/jobs/{job_id}/summary?format=yaml")
    assert res_bad.status_code == 400
