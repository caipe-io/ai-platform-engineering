from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from deepeval_eval.api.app import app
from deepeval_eval.api.evaluation_jobs import EvaluationRequest
from deepeval_eval.api.job_manager import (
    db_manager,
    persistent_job_queue,
    validate_safe_path,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def enable_unauthenticated_access_for_api_tests():
    """Ensure API authentication bypass is enabled for test execution."""
    os.environ["ALLOW_UNAUTHENTICATED_ACCESS"] = "true"
    yield
    os.environ.pop("ALLOW_UNAUTHENTICATED_ACCESS", None)


@patch("deepeval_eval.api.job_manager.run_evaluation")
@patch("deepeval_eval.api.job_manager._build_rag_client")
def test_api_submit_poll_and_get_results_flow(mock_build_client, mock_run_eval):
    """API integration test: Submit job, poll status, verify secret omission, and fetch results in JSON/CSV."""
    mock_run_eval.return_value = [
        {
            "question": "What is CAIPE?",
            "actual_output": "CAIPE is an AI platform.",
            "metrics": {"g-eval": {"score": 1.0, "success": True}},
        }
    ]

    # 1. Submit evaluation job via POST /eval/jobs
    payload = {
        "dataset_name": "enterprise",
        "max_items": 1,
        "llm_api_key": "sk-secret-key-12345",
    }
    submit_resp = client.post("/eval/jobs", json=payload)
    assert submit_resp.status_code == 202
    submit_data = submit_resp.json()
    assert "job_id" in submit_data
    job_id = submit_data["job_id"]

    try:
        # 2. Poll job status via GET /jobs/{job_id}
        poll_resp = client.get(f"/jobs/{job_id}")
        assert poll_resp.status_code == 200
        poll_data = poll_resp.json()
        assert poll_data["job_id"] == job_id
        assert poll_data["status"] in ("pending", "running", "completed")

        # Verify sensitive credentials are omitted from config_args in status response
        config_args = poll_data.get("config_args", {})
        assert "llm_api_key" not in config_args

        # 3. Retrieve results in JSON format via GET /jobs/{job_id}/results
        if poll_data["status"] == "completed":
            results_json_resp = client.get(f"/jobs/{job_id}/results?format=json")
            assert results_json_resp.status_code == 200
            results_data = results_json_resp.json()
            assert results_data["job_id"] == job_id
            assert len(results_data["results"]) == 1

            # 4. Retrieve results in CSV format via GET /jobs/{job_id}/results?format=csv
            results_csv_resp = client.get(f"/jobs/{job_id}/results?format=csv")
            assert results_csv_resp.status_code == 200
            assert results_csv_resp.headers["content-type"].startswith("text/csv")
    finally:
        persistent_job_queue.delete_job(job_id)


@patch("deepeval_eval.api.job_manager.run_evaluation")
@patch("deepeval_eval.api.job_manager._build_rag_client")
def test_api_upload_dataset_and_execute_flow(
    mock_build_client, mock_run_eval, tmp_path: Path
):
    """API integration test: Upload dataset file via multipart POST /eval/jobs/upload, execute, and verify."""
    mock_run_eval.return_value = [
        {
            "question": "Uploaded Question",
            "actual_output": "Uploaded Answer",
            "metrics": {},
        }
    ]

    dataset_json = json.dumps(
        [{"user_input": "Uploaded Question", "reference": "Uploaded Answer"}]
    )
    files = {"file": ("dataset.json", dataset_json.encode("utf-8"), "application/json")}
    params = {"dataset_name": "api_custom_upload", "max_items": 1}

    with (
        patch.object(db_manager.questions, "find_by_content_hash", return_value=None),
        patch.object(
            db_manager.questions,
            "create_question_set",
            return_value={"id": 99, "name": "api_custom_upload"},
        ),
        patch.object(db_manager.questions, "add_questions", return_value=[]),
    ):
        upload_resp = client.post("/eval/jobs/upload", params=params, files=files)
        assert upload_resp.status_code == 202
        upload_data = upload_resp.json()
        job_id = upload_data["job_id"]
        assert job_id is not None

        try:
            poll_resp = client.get(f"/jobs/{job_id}")
            assert poll_resp.status_code == 200
            assert poll_resp.json()["job_id"] == job_id
        finally:
            persistent_job_queue.delete_job(job_id)


def test_api_path_sandboxing_security():
    """Verify that validate_safe_path restricts unauthorized path access outside allowed sandbox roots."""
    # Safe path under system temp
    temp_safe = Path(tempfile.gettempdir()) / "eval_test_file.json"
    assert validate_safe_path(temp_safe) == temp_safe.resolve()

    # Unauthorized system path
    with pytest.raises(HTTPException) as exc_info:
        validate_safe_path("/etc/passwd")
    assert exc_info.value.status_code == 400
    assert "restricted" in exc_info.value.detail.lower()


def test_evaluation_request_schema_excludes_network_url_overrides():
    """Verify EvaluationRequest does not expose client-controlled network endpoints or key overrides."""
    fields = EvaluationRequest.model_fields
    assert "llm_base_url" not in fields
    assert "llm_api_key" not in fields
    assert "agent_url" not in fields
    assert "trace_log" not in fields
    assert "questions_file" not in fields
