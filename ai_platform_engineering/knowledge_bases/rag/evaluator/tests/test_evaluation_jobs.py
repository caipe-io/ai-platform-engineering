from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from deepeval_eval.api.app import app
from deepeval_eval.api.evaluation_jobs import (
    JobStatusEnum,
    _parse_dataset_bytes,
)
from deepeval_eval.api.job_manager import db_manager, job_manager

client = TestClient(app)


@pytest.fixture(autouse=True)
def enable_unauthenticated_access_for_api_tests():
    os.environ["ALLOW_UNAUTHENTICATED_ACCESS"] = "true"
    yield
    os.environ.pop("ALLOW_UNAUTHENTICATED_ACCESS", None)


# ---------------------------------------------------------------------------
# Evaluation Jobs Endpoints & Handlers Tests
# ---------------------------------------------------------------------------


@patch("deepeval_eval.api.job_manager.execute_evaluation_job")
def test_submit_eval_job_positive(mock_execute):
    """Verify POST /eval/jobs returns 202 Accepted and launches background task."""
    payload = {
        "dataset_name": "enterprise",
        "answer_mode": "reference",
        "top_k": 3,
        "max_items": 2,
        "force_rerun": True,
        "dynamic_tool": True,
        "semantic_weight": 0.8,
        "extra_filters": {"doc_type": "pdf"},
        "tool_description": "Dynamic evaluation search tool",
    }
    res = client.post("/eval/jobs", json=payload)
    assert res.status_code == 202
    data = res.json()
    assert "job_id" in data
    assert data["status"] in ("pending", "running", "completed")


def test_submit_eval_job_dynamic_tool_boundary_validation():
    """Verify POST /eval/jobs validates semantic_weight boundary constraints [0.0, 1.0]."""
    # Invalid semantic_weight > 1.0
    res_high = client.post(
        "/eval/jobs", json={"dataset_name": "enterprise", "semantic_weight": 1.5}
    )
    assert res_high.status_code == 422

    # Invalid semantic_weight < 0.0
    res_low = client.post(
        "/eval/jobs", json={"dataset_name": "enterprise", "semantic_weight": -0.1}
    )
    assert res_low.status_code == 422


def test_submit_eval_job_negative_invalid_body():
    """Verify POST /eval/jobs returns 422 Unprocessable Entity for invalid field types."""
    payload = {
        "max_items": -5,  # Constraint: ge=1
    }
    res = client.post("/eval/jobs", json=payload)
    assert res.status_code == 422


@patch("deepeval_eval.api.job_manager.execute_evaluation_job")
def test_submit_eval_job_with_upload_positive(mock_execute):
    """Verify POST /eval/jobs/upload accepts multipart dataset file upload."""
    file_content = b'[{"question": "What is CAIPE?"}]'
    files = {"file": ("test_questions.json", file_content, "application/json")}

    with (
        patch.object(db_manager.questions, "find_by_content_hash", return_value=None),
        patch.object(
            db_manager.questions,
            "create_question_set",
            return_value={"id": 1, "name": "custom"},
        ),
        patch.object(db_manager.questions, "add_questions", return_value=[]),
    ):
        res = client.post(
            "/eval/jobs/upload?dataset_name=custom&top_k=2&force_rerun=true",
            files=files,
        )
        assert res.status_code == 202
        data = res.json()
        assert "job_id" in data


def test_submit_eval_job_with_upload_supports_experiment_name():
    """Verify POST /eval/jobs/upload accepts experiment_name query parameter."""
    file_content = b'[{"question": "What is CAIPE?"}]'
    files = {"file": ("test_questions.json", file_content, "application/json")}

    with (
        patch.object(db_manager.questions, "find_by_content_hash", return_value=None),
        patch.object(
            db_manager.questions,
            "create_question_set",
            return_value={"id": 2, "name": "custom"},
        ),
        patch.object(db_manager.questions, "add_questions", return_value=[]),
    ):
        res = client.post(
            "/eval/jobs/upload?dataset_name=custom&experiment_name=exp_upload_77&force_rerun=true",
            files=files,
        )
        assert res.status_code == 202
        job_id = res.json()["job_id"]
        job = job_manager.get_job(job_id)
        assert job is not None
        assert job["config_args"]["experiment_name"] == "exp_upload_77"


def test_submit_eval_job_with_upload_supports_tool_names_and_prompt_styles():
    """Verify POST /eval/jobs/upload accepts search_tool_name, fetch_tool_name, prompt_style, and prompt_args."""
    file_content = b'[{"question": "What is hybrid search?"}]'
    files = {"file": ("test_questions.json", file_content, "application/json")}

    with (
        patch.object(db_manager.questions, "find_by_content_hash", return_value=None),
        patch.object(
            db_manager.questions,
            "create_question_set",
            return_value={"id": 3, "name": "custom"},
        ),
        patch.object(db_manager.questions, "add_questions", return_value=[]),
    ):
        res = client.post(
            "/eval/jobs/upload"
            "?dataset_name=custom"
            "&search_tool_name=custom_search"
            "&fetch_tool_name=custom_fetch"
            "&prompt_style=agentic_short"
            "&prompt_args=%7B%22domain%22%3A%22test%22%7D"
            "&force_rerun=true",
            files=files,
        )
        assert res.status_code == 202
        job_id = res.json()["job_id"]
        job = job_manager.get_job(job_id)
        assert job is not None
        assert job["config_args"]["search_tool_name"] == "custom_search"
        assert job["config_args"]["fetch_tool_name"] == "custom_fetch"
        assert job["config_args"]["prompt_style"] == "agentic_short"
        assert job["config_args"]["prompt_args"] == {"domain": "test"}


def test_submit_eval_job_with_upload_supports_dynamic_tool_params():
    """Verify POST /eval/jobs/upload accepts dynamic_tool, semantic_weight, extra_filters, and tool_description."""
    file_content = b'[{"question": "What is dynamic search?"}]'
    files = {"file": ("test_questions.json", file_content, "application/json")}

    with (
        patch.object(db_manager.questions, "find_by_content_hash", return_value=None),
        patch.object(
            db_manager.questions,
            "create_question_set",
            return_value={"id": 4, "name": "custom"},
        ),
        patch.object(db_manager.questions, "add_questions", return_value=[]),
    ):
        res = client.post(
            "/eval/jobs/upload"
            "?dataset_name=custom"
            "&dynamic_tool=true"
            "&semantic_weight=0.7"
            "&extra_filters=%7B%22doc_type%22%3A%22pdf%22%7D"
            "&tool_description=UploadEphemeralTool"
            "&force_rerun=true",
            files=files,
        )
        assert res.status_code == 202
        job_id = res.json()["job_id"]
        job = job_manager.get_job(job_id)
        assert job is not None
        assert job["config_args"]["dynamic_tool"] is True
        assert job["config_args"]["semantic_weight"] == 0.7
        assert job["config_args"]["extra_filters"] == {"doc_type": "pdf"}
        assert job["config_args"]["tool_description"] == "UploadEphemeralTool"


def test_submit_eval_job_with_upload_negative_empty_file():
    """Verify POST /eval/jobs/upload rejects empty files with 400 Bad Request."""
    files = {"file": ("empty.json", b"", "application/json")}

    res = client.post("/eval/jobs/upload", files=files)
    assert res.status_code == 400
    assert "empty" in res.json()["detail"].lower()


def test_get_job_status_and_list():
    """Verify GET /jobs and GET /jobs/{job_id} endpoints include config_args details."""
    res_sub = client.post(
        "/eval/jobs",
        json={"dataset_name": "enterprise", "top_k": 5, "force_rerun": True},
    )
    job_id = res_sub.json()["job_id"]

    res_get = client.get(f"/jobs/{job_id}")
    assert res_get.status_code == 200
    get_json = res_get.json()
    assert get_json["job_id"] == job_id
    assert "config_args" in get_json
    assert get_json["config_args"]["dataset_name"] == "enterprise"
    assert get_json["config_args"]["top_k"] == 5

    res_list = client.get("/jobs")
    assert res_list.status_code == 200
    list_json = res_list.json()
    assert len(list_json) >= 1
    matched = [j for j in list_json if j["job_id"] == job_id]
    assert len(matched) == 1
    assert "config_args" in matched[0]
    assert matched[0]["config_args"]["dataset_name"] == "enterprise"


def test_get_job_status_negative_not_found():
    """Verify GET /jobs/{job_id} returns 404 for unknown job ID."""
    res = client.get("/jobs/unknown_job_id_999")
    assert res.status_code == 404


def test_submit_eval_job_with_upload_cached_positive():
    """Verify upload endpoint returns cached job response when hash matches."""
    file_content = b'[{"question": "What is CAIPE upload cache?"}]'
    files = {"file": ("cached_questions.json", file_content, "application/json")}

    with patch.object(
        db_manager.questions,
        "find_by_content_hash",
        return_value={"id": 42, "name": "cached_up"},
    ):
        with patch.object(
            db_manager.evaluation,
            "get_cached_job_by_hash",
            return_value={
                "job_id": "cached-job-99",
                "status": "completed",
                "cached": True,
                "eval_hash": "hash_cached",
                "created_at": 1700000000.0,
                "completed_at": 1700000050.0,
                "evaluation_time": 50.0,
                "config_args": {"dataset_name": "cached_up"},
                "summary": {},
                "results": [],
                "user_info": None,
                "error": None,
            },
        ):
            res = client.post(
                "/eval/jobs/upload?dataset_name=cached_up&force_rerun=false",
                files=files,
            )
            assert res.status_code == 202
            assert res.json()["cached"] is True
            assert res.json()["job_id"] is not None
            assert len(res.json()["job_id"]) == 36


def test_submit_eval_job_sanitizes_credentials():
    """Verify sensitive API keys and tokens are stripped from job config_args to prevent leakage."""
    res = client.post(
        "/eval/jobs",
        json={
            "dataset_name": "sanitization_test",
            "llm_api_key": "sk-secret-key-999",
            "auth_token": "bearer-token-111",
            "force_rerun": True,
        },
    )
    assert res.status_code == 202
    job_id = res.json()["job_id"]

    job = job_manager.get_job(job_id)
    assert job is not None
    config_args = job["config_args"]
    assert "llm_api_key" not in config_args
    assert "auth_token" not in config_args


def test_submit_eval_job_with_upload_creates_and_links_question_set(tmp_path: Path):
    """Verify POST /eval/jobs/upload creates a question set in DB and enqueues job with question_set_id."""
    with patch(
        "deepeval_eval.api.job_manager.persistent_job_queue.enqueue"
    ) as mock_enqueue:
        with (
            patch.object(
                db_manager.questions, "find_by_content_hash", return_value=None
            ),
            patch.object(
                db_manager.questions,
                "create_question_set",
                return_value={"id": 88, "name": "test_upload_json"},
            ),
            patch.object(db_manager.questions, "add_questions", return_value=[]),
        ):
            file_content = b'[{"user_input": "What is CAIPE upload?"}]'
            files = {"file": ("test_questions.json", file_content, "application/json")}

            res = client.post(
                "/eval/jobs/upload?dataset_name=test_upload_json&force_rerun=true",
                files=files,
            )
            assert res.status_code == 202
            assert mock_enqueue.called
            enqueue_args = mock_enqueue.call_args[0]
            config_dict = enqueue_args[2]
            assert config_dict["question_set_id"] == 88


def test_submit_eval_job_with_upload_in_memory_without_disk_write(tmp_path: Path):
    """Verify upload endpoint parses files in-memory without creating temporary files on disk."""
    with (
        patch("tempfile.mkdtemp", return_value=str(tmp_path)),
        patch("deepeval_eval.api.job_manager.execute_evaluation_job"),
        patch.object(db_manager.questions, "find_by_content_hash", return_value=None),
        patch.object(
            db_manager.questions,
            "create_question_set",
            return_value={"id": 77, "name": "test_async_up"},
        ),
        patch.object(db_manager.questions, "add_questions", return_value=[]),
    ):
        file_content = b'[{"question": "How does in-memory parse work?"}]'
        files = {"file": ("test_async_upload.json", file_content, "application/json")}

        res = client.post(
            "/eval/jobs/upload?dataset_name=test_async_up&force_rerun=true",
            files=files,
        )
        assert res.status_code == 202
        assert len(list(tmp_path.glob("*"))) == 0


def test_update_job_visibility_valid_job_success():
    """Verify PATCH /jobs/{job_id}/visibility updates job visibility and owner team."""
    config = {"dataset_name": "enterprise", "top_k": 3}
    job = job_manager.create_job("hash_vis_test_1", config, force_rerun=True)
    job_id = job["job_id"]

    with patch(
        "deepeval_eval.api.evaluation_jobs.update_resource_visibility",
        new_callable=AsyncMock,
    ) as mock_update_vis:
        res = client.patch(
            f"/jobs/{job_id}/visibility",
            json={"visibility": "public", "owner_team": "data-platform"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["job_id"] == job_id
        mock_update_vis.assert_called_once()

        updated_job = job_manager.get_job(job_id)
        assert updated_job is not None
        assert updated_job["config_args"]["visibility"] == "public"
        assert updated_job["config_args"]["owner_team"] == "data-platform"


def test_update_job_visibility_nonexistent_job_returns_404():
    """Verify PATCH /jobs/{job_id}/visibility on non-existent job returns 404."""
    with patch(
        "deepeval_eval.api.evaluation_jobs.update_resource_visibility",
        new_callable=AsyncMock,
    ):
        res = client.patch(
            "/jobs/nonexistent-job-uuid-1234/visibility",
            json={"visibility": "private"},
        )
        assert res.status_code == 404
        assert "not found" in res.json()["detail"].lower()


def test_parse_dataset_bytes_with_jsonl_content_returns_parsed_rows():
    jsonl_content = '{"question_id": "q1", "input": "Q1", "expected_output": "A1"}\nnot a json line\n{"question_id": "q2", "user_input": "Q2"}'
    rows_jsonl = _parse_dataset_bytes(jsonl_content.encode("utf-8"), "dataset.jsonl")
    assert len(rows_jsonl) == 2
    assert rows_jsonl[0]["input"] == "Q1"
    assert rows_jsonl[1]["input"] == "Q2"


def test_parse_dataset_bytes_with_csv_content_returns_parsed_rows():
    csv_content = "question_id,question,reference\nq10,What is CAIPE?,AI platform\n"
    rows_csv = _parse_dataset_bytes(csv_content.encode("utf-8"), "dataset.csv")
    assert len(rows_csv) == 1
    assert rows_csv[0]["input"] == "What is CAIPE?"


def test_parse_dataset_bytes_with_nested_json_objects_returns_parsed_rows():
    import json

    # questions key
    json_questions = json.dumps(
        {"questions": [{"question_id": "q100", "input": "Q100"}]}
    )
    rows_json_q = _parse_dataset_bytes(json_questions.encode("utf-8"), "dataset.json")
    assert len(rows_json_q) == 1
    assert rows_json_q[0]["question_id"] == "q100"

    # items key
    json_items = json.dumps({"items": [{"id": "item1", "input": "Item 1"}]})
    rows_json_items = _parse_dataset_bytes(json_items.encode("utf-8"), "dataset.json")
    assert len(rows_json_items) == 1

    # single dict
    json_single = json.dumps({"input": "Single Question"})
    rows_single = _parse_dataset_bytes(json_single.encode("utf-8"), "dataset.json")
    assert len(rows_single) == 1


def test_parse_dataset_bytes_with_malformed_json_returns_empty_list():
    rows_bad = _parse_dataset_bytes(b"not a json at all", "dataset.json")
    assert len(rows_bad) == 0


def test_list_jobs_and_get_job_by_id() -> None:
    job = job_manager.create_job(
        "h_list_test", {"dataset_name": "ds1"}, force_rerun=True
    )
    job_id = job["job_id"]

    res_list = client.get("/jobs?limit=5")
    assert res_list.status_code == 200

    res_get = client.get(f"/jobs/{job_id}")
    assert res_get.status_code == 200
    assert res_get.json()["job_id"] == job_id


def test_prepare_job_from_question_set_not_found_and_empty() -> None:
    """Verify _prepare_job_from_question_set returns 404 for missing set and 400 for empty set."""
    # 1. Not found -> 404
    with patch.object(db_manager.questions, "get_question_set", return_value=None):
        res = client.post("/eval/jobs/question-sets/99999")
        assert res.status_code == 404

    # 2. Empty question set -> 400
    with (
        patch.object(
            db_manager.questions,
            "get_question_set",
            return_value={"id": 888, "name": "EmptySet", "question_count": 0},
        ),
        patch.object(
            db_manager.questions,
            "list_questions",
            return_value={"items": [], "total": 0},
        ),
    ):
        res = client.post("/eval/jobs/question-sets/888")
        assert res.status_code == 400
        assert "contains no questions" in res.text


def test_submit_eval_job_with_question_set_id_success() -> None:
    """Verify submitting an eval job referencing a valid question set succeeds."""
    with (
        patch.object(
            db_manager.questions,
            "get_question_set",
            return_value={
                "id": 101,
                "name": "ValidSet",
                "question_count": 5,
                "content_hash": "hash_101",
            },
        ),
        patch("deepeval_eval.api.evaluation_jobs.persistent_job_queue.enqueue"),
        patch("deepeval_eval.api.evaluation_jobs.write_evaluation_ownership"),
    ):
        # Via /eval/jobs body
        res1 = client.post(
            "/eval/jobs", json={"question_set_id": 101, "force_rerun": True}
        )
        assert res1.status_code == 202
        assert res1.json()["status"] == "pending"

        # Via /eval/jobs/question-sets/{set_id}
        res2 = client.post("/eval/jobs/question-sets/101", json={"force_rerun": True})
        assert res2.status_code == 202
        assert res2.json()["status"] == "pending"


def test_parse_dataset_bytes_jsonl_invalid_json_skips_malformed_lines() -> None:
    """Verify _parse_dataset_bytes handles JSONL with invalid JSON lines gracefully."""
    content = b'{"input": "valid question 1", "expected_output": "answer 1"}\n{malformed json line}\n{"input": "valid question 2", "expected_output": "answer 2"}\n'
    rows = _parse_dataset_bytes(content, "questions.jsonl")
    assert len(rows) == 2
    assert rows[0]["input"] == "valid question 1"
    assert rows[1]["input"] == "valid question 2"


def test_parse_dataset_bytes_json_dict_with_items_key_extracts_items() -> None:
    """Verify _parse_dataset_bytes extracts question items when JSON object contains 'items' list."""
    content = b'{"items": [{"input": "Item Q1", "expected_output": "Ans1"}]}'
    rows = _parse_dataset_bytes(content, "dataset.json")
    assert len(rows) == 1
    assert rows[0]["input"] == "Item Q1"


def test_parse_dataset_bytes_single_dict_extracts_row() -> None:
    """Verify _parse_dataset_bytes extracts single question dictionary when JSON root is a single object."""
    content = b'{"input": "Single Question", "expected_output": "Single Answer"}'
    rows = _parse_dataset_bytes(content, "dataset.json")
    assert len(rows) == 1
    assert rows[0]["input"] == "Single Question"


def test_parse_dataset_bytes_doc_ids_string_normalized_to_list() -> None:
    """Verify _parse_dataset_bytes converts string expected_doc_ids to list."""
    content = b'[{"input": "Doc Question", "expected_doc_ids": "doc-uuid-123"}]'
    rows = _parse_dataset_bytes(content, "dataset.json")
    assert len(rows) == 1
    assert rows[0]["expected_doc_ids"] == ["doc-uuid-123"]


def test_parse_dataset_bytes_empty_input_skips_row() -> None:
    """Verify _parse_dataset_bytes skips items with empty input string."""
    content = b'[{"input": ""}, {"question": "   "}, {"input": "Real Question"}]'
    rows = _parse_dataset_bytes(content, "dataset.json")
    assert len(rows) == 1
    assert rows[0]["input"] == "Real Question"


def test_update_job_visibility_with_config_json_updates_visibility_and_owner_team() -> (
    None
):
    """Verify PATCH /jobs/{job_id}/visibility updates config_json fields if present."""
    job = job_manager.create_job(
        "hash-vis-json", {"dataset_name": "enterprise"}, force_rerun=True
    )
    jid = job["job_id"]
    job_manager.jobs[jid]["config_json"] = {"visibility": "private"}

    with patch("deepeval_eval.api.evaluation_jobs.update_resource_visibility"):
        resp = client.patch(
            f"/jobs/{jid}/visibility",
            json={"visibility": "public", "owner_team": "platform-team"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["job_id"] == jid
        assert job_manager.jobs[jid]["config_json"]["visibility"] == "public"
        assert job_manager.jobs[jid]["config_json"]["owner_team"] == "platform-team"


def test_update_job_visibility_with_config_args_and_owner_team_updates_fields() -> None:
    """Verify PATCH /jobs/{job_id}/visibility updates config_args fields when owner_team is supplied."""
    job = job_manager.create_job(
        "hash-vis-args", {"dataset_name": "enterprise"}, force_rerun=True
    )
    jid = job["job_id"]

    with patch("deepeval_eval.api.evaluation_jobs.update_resource_visibility"):
        resp = client.patch(
            f"/jobs/{jid}/visibility",
            json={"visibility": "team", "owner_team": "rag-team"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["job_id"] == jid
        assert job_manager.jobs[jid]["config_args"]["visibility"] == "team"
        assert job_manager.jobs[jid]["config_args"]["owner_team"] == "rag-team"


def test_submit_eval_job_with_datasource_id_and_agent_id_authorizes_access() -> None:
    """Verify POST /eval/jobs checks permissions when datasource_id and agent_id are passed."""
    payload = {
        "dataset_name": "enterprise",
        "datasource_id": "ds-target-1",
        "agent_id": "agent-target-1",
    }
    with (
        patch("deepeval_eval.api.evaluation_jobs.authorize_evaluate"),
        patch(
            "deepeval_eval.api.evaluation_jobs.authorize_datasource_access"
        ) as mock_ds_authz,
        patch(
            "deepeval_eval.api.evaluation_jobs.authorize_agent_access"
        ) as mock_agent_authz,
        patch("deepeval_eval.api.evaluation_jobs.write_evaluation_ownership"),
        patch("deepeval_eval.api.evaluation_jobs.persistent_job_queue.enqueue"),
    ):
        resp = client.post("/eval/jobs", json=payload)
        assert resp.status_code == 202
        mock_ds_authz.assert_called_once()
        mock_agent_authz.assert_called_once()


def test_submit_eval_job_upload_with_datasource_and_agent_id_authorizes_access() -> (
    None
):
    """Verify POST /eval/jobs/upload checks permissions for datasource_id and agent_id."""
    files = {
        "file": (
            "dataset.json",
            b'[{"input": "Upload Q", "expected_output": "Upload Ans"}]',
            "application/json",
        )
    }
    params = {
        "datasource_id": "ds-upload-1",
        "agent_id": "agent-upload-1",
        "prompt_args": "{invalid json prompt args}",
        "extra_filters": "{invalid json extra filters}",
    }
    with (
        patch("deepeval_eval.api.evaluation_jobs.authorize_evaluate"),
        patch(
            "deepeval_eval.api.evaluation_jobs.authorize_datasource_access"
        ) as mock_ds_authz,
        patch(
            "deepeval_eval.api.evaluation_jobs.authorize_agent_access"
        ) as mock_agent_authz,
        patch("deepeval_eval.api.evaluation_jobs.write_evaluation_ownership"),
        patch(
            "deepeval_eval.api.evaluation_jobs.db_manager.questions.find_by_content_hash",
            return_value=None,
        ),
        patch(
            "deepeval_eval.api.evaluation_jobs.db_manager.questions.create_question_set",
            return_value={"id": 9999, "name": "dataset"},
        ),
        patch(
            "deepeval_eval.api.evaluation_jobs.db_manager.questions.add_questions",
            return_value=1,
        ),
        patch("deepeval_eval.api.evaluation_jobs.persistent_job_queue.enqueue"),
    ):
        resp = client.post("/eval/jobs/upload", files=files, params=params)
        assert resp.status_code == 202
        mock_ds_authz.assert_called_once()
        mock_agent_authz.assert_called_once()


def test_submit_eval_job_upload_empty_questions_raises_bad_request() -> None:
    """Verify POST /eval/jobs/upload raises 400 when uploaded file contains no valid questions."""
    files = {
        "file": (
            "empty.json",
            b'[{"input": ""}]',
            "application/json",
        )
    }
    with patch("deepeval_eval.api.evaluation_jobs.authorize_evaluate"):
        resp = client.post("/eval/jobs/upload", files=files)
        assert resp.status_code == 400
        assert "contains no valid questions" in resp.json()["detail"]


@patch("deepeval_eval.api.evaluation_jobs.authorize_evaluate")
@patch("deepeval_eval.api.evaluation_jobs.authorize_datasource_access")
@patch("deepeval_eval.api.evaluation_jobs.authorize_agent_access")
def test_submit_eval_job_by_question_set_with_datasource_and_agent_and_cache(
    mock_agent_auth, mock_ds_auth, mock_eval_auth
):
    """Verify POST /eval/jobs/question-sets/{set_id} handles datasource, agent authz, and cached jobs."""
    with (
        patch.object(
            db_manager.questions,
            "get_question_set",
            return_value={
                "id": 505,
                "name": "enterprise",
                "question_count": 2,
                "content_hash": "hash_505",
            },
        ),
        patch(
            "deepeval_eval.api.evaluation_jobs.job_manager.create_job",
            return_value={
                "job_id": "cached-505-job",
                "status": JobStatusEnum.COMPLETED,
                "cached": True,
                "eval_hash": "hash_505",
                "created_at": 1000.0,
                "completed_at": 1050.0,
                "evaluation_time": 50.0,
                "config_args": {"dataset_name": "enterprise"},
                "summary": {},
                "results": [],
            },
        ),
        patch("deepeval_eval.api.evaluation_jobs.write_evaluation_ownership"),
    ):
        res = client.post(
            "/eval/jobs/question-sets/505",
            json={
                "datasource_id": "ds-qset-1",
                "agent_id": "agent-qset-1",
                "force_rerun": False,
            },
        )
        assert res.status_code == 202
        assert res.json()["cached"] is True
        mock_ds_auth.assert_called_once()
        mock_agent_auth.assert_called_once()


@patch("deepeval_eval.api.evaluation_jobs.authorize_evaluate")
def test_submit_eval_job_cached_returns_job_response_directly(mock_auth):
    """Verify POST /eval/jobs returns cached JobResponse directly without enqueuing."""
    with (
        patch(
            "deepeval_eval.api.evaluation_jobs.job_manager.create_job",
            return_value={
                "job_id": "cached-direct-job-123",
                "status": JobStatusEnum.COMPLETED,
                "cached": True,
                "eval_hash": "hash_direct_123",
                "created_at": 1000.0,
                "completed_at": 1050.0,
                "evaluation_time": 50.0,
                "config_args": {"dataset_name": "enterprise"},
                "summary": {},
                "results": [],
            },
        ),
        patch("deepeval_eval.api.evaluation_jobs.write_evaluation_ownership"),
        patch(
            "deepeval_eval.api.evaluation_jobs.persistent_job_queue.enqueue"
        ) as mock_enqueue,
    ):
        res = client.post(
            "/eval/jobs",
            json={"dataset_name": "enterprise", "force_rerun": False},
        )
        assert res.status_code == 202
        assert res.json()["cached"] is True
        mock_enqueue.assert_not_called()


@patch("deepeval_eval.api.evaluation_jobs.update_resource_visibility")
def test_update_job_visibility_when_job_has_neither_config_json_nor_config_args(
    mock_auth,
):
    """Verify PATCH /jobs/{job_id}/visibility handles bare job objects without config dicts."""
    job = job_manager.create_job(
        "hash_no_config", {"dataset_name": "enterprise"}, force_rerun=True
    )
    jid = job["job_id"]
    # Remove config dicts
    job.pop("config_args", None)
    job.pop("config_json", None)

    res = client.patch(
        f"/jobs/{jid}/visibility",
        json={"visibility": "public"},
    )
    assert res.status_code == 200
    assert res.json()["job_id"] == jid
