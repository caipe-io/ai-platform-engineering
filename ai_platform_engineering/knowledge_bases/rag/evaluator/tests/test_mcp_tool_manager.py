from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest
import requests

from deepeval_eval.clients.mcp_tool_manager import DynamicMCPToolManager

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_rag_client() -> MagicMock:
    client = MagicMock()
    client.base_url = "https://rag.example.org"
    client.session = MagicMock(spec=requests.Session)
    client.ensure_authenticated = MagicMock()
    return client


# ---------------------------------------------------------------------------
# Tests: DynamicMCPToolManager.create() - Happy Paths
# ---------------------------------------------------------------------------


def test_create_valid_config_returns_tool_id(mock_rag_client: MagicMock):
    """Verify create() returns the expected tool_id on a 200/201 response."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_resp.status_code = 200
    mock_rag_client.session.post.return_value = mock_resp

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="run-1234567890abcdef1234",
        datasource_ids=["ds-1"],
        semantic_weight=0.7,
    )

    tool_id = manager.create()

    assert tool_id == "eval-run-1234567890ab"
    assert manager.tool_id == tool_id
    mock_rag_client.ensure_authenticated.assert_called_once()
    mock_rag_client.session.post.assert_called_once()


def test_create_sets_tool_id_as_eval_prefix_with_truncated_run_id(
    mock_rag_client: MagicMock,
):
    """Verify tool_id is 'eval-{run_id[:16]}' for run_ids of any length."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_rag_client.session.post.return_value = mock_resp

    # Long run_id
    manager_long = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="verylongrunidentifierexceedingsixteenchars",
        datasource_ids=[],
    )
    assert manager_long.tool_id == "eval-verylongrunident"

    # Short run_id
    manager_short = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="short",
        datasource_ids=[],
    )
    assert manager_short.tool_id == "eval-short"


def test_create_maps_semantic_weight_into_parallel_searches_payload(
    mock_rag_client: MagicMock,
):
    """Verify semantic_weight is placed inside parallel_searches[0].semantic_weight."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_rag_client.session.post.return_value = mock_resp

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-id-12345",
        datasource_ids=["ds-enterprise"],
        semantic_weight=0.85,
    )
    manager.create()

    call_kwargs = mock_rag_client.session.post.call_args[1]
    payload = call_kwargs["json"]
    assert "parallel_searches" in payload
    assert len(payload["parallel_searches"]) == 1
    parallel_search = payload["parallel_searches"][0]
    assert parallel_search["semantic_weight"] == 0.85
    assert parallel_search["datasource_ids"] == ["ds-enterprise"]
    assert parallel_search["label"] == "results"


def test_create_empty_datasource_ids_sends_empty_list_in_payload(
    mock_rag_client: MagicMock,
):
    """Verify datasource_ids=[] is correctly serialised in the payload."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_rag_client.session.post.return_value = mock_resp

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-empty-ds",
        datasource_ids=[],
    )
    manager.create()

    call_kwargs = mock_rag_client.session.post.call_args[1]
    payload = call_kwargs["json"]
    assert payload["parallel_searches"][0]["datasource_ids"] == []


def test_create_extra_filters_forwarded_to_parallel_search(mock_rag_client: MagicMock):
    """Verify extra_filters dict is forwarded into parallel_searches[0].extra_filters."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_rag_client.session.post.return_value = mock_resp

    custom_filters = {"document_type": "pdf", "category": "engineering"}
    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-filters",
        datasource_ids=["ds-1"],
        extra_filters=custom_filters,
    )
    manager.create()

    call_kwargs = mock_rag_client.session.post.call_args[1]
    payload = call_kwargs["json"]
    assert payload["parallel_searches"][0]["extra_filters"] == custom_filters


def test_create_sets_ttl_expires_at_timestamp(mock_rag_client: MagicMock):
    """Verify expires_at timestamp is computed and set in payload when ttl_seconds is provided."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_rag_client.session.post.return_value = mock_resp

    before_ts = int(time.time())
    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-ttl",
        datasource_ids=[],
        ttl_seconds=7200,
    )
    manager.create()
    after_ts = int(time.time())

    call_kwargs = mock_rag_client.session.post.call_args[1]
    payload = call_kwargs["json"]
    assert "expires_at" in payload
    assert before_ts + 7200 <= payload["expires_at"] <= after_ts + 7200


# ---------------------------------------------------------------------------
# Tests: DynamicMCPToolManager.create() - Boundary & Error Cases
# ---------------------------------------------------------------------------


def test_create_semantic_weight_boundary_zero_sends_zero(mock_rag_client: MagicMock):
    """Verify boundary value semantic_weight=0.0 (keyword-only) is preserved."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_rag_client.session.post.return_value = mock_resp

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-bva-0",
        datasource_ids=[],
        semantic_weight=0.0,
    )
    manager.create()

    call_kwargs = mock_rag_client.session.post.call_args[1]
    assert call_kwargs["json"]["parallel_searches"][0]["semantic_weight"] == 0.0


def test_create_semantic_weight_boundary_one_sends_one(mock_rag_client: MagicMock):
    """Verify boundary value semantic_weight=1.0 (semantic-only) is preserved."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_rag_client.session.post.return_value = mock_resp

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-bva-1",
        datasource_ids=[],
        semantic_weight=1.0,
    )
    manager.create()

    call_kwargs = mock_rag_client.session.post.call_args[1]
    assert call_kwargs["json"]["parallel_searches"][0]["semantic_weight"] == 1.0


def test_create_http_4xx_raises_runtime_error(mock_rag_client: MagicMock):
    """Verify RuntimeError is raised when the RAG server returns HTTP 4xx."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = False
    mock_resp.status_code = 400
    mock_resp.text = "Bad Request: Invalid tool config"
    mock_rag_client.session.post.return_value = mock_resp

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-fail-4xx",
        datasource_ids=[],
    )

    with pytest.raises(RuntimeError) as exc_info:
        manager.create()

    assert "Failed to create ephemeral MCP tool" in str(exc_info.value)
    assert "400" in str(exc_info.value)


def test_create_http_5xx_raises_runtime_error(mock_rag_client: MagicMock):
    """Verify RuntimeError is raised when the RAG server returns HTTP 5xx."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = False
    mock_resp.status_code = 500
    mock_resp.text = "Internal Server Error"
    mock_rag_client.session.post.return_value = mock_resp

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-fail-5xx",
        datasource_ids=[],
    )

    with pytest.raises(RuntimeError) as exc_info:
        manager.create()

    assert "Failed to create ephemeral MCP tool" in str(exc_info.value)
    assert "500" in str(exc_info.value)


# ---------------------------------------------------------------------------
# Tests: DynamicMCPToolManager.delete() - Happy Path & Resilience
# ---------------------------------------------------------------------------


def test_delete_ok_response_logs_success_and_does_not_raise(mock_rag_client: MagicMock):
    """Verify delete() sends DELETE to the endpoint and does not raise on HTTP 200."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_resp.status_code = 200
    mock_rag_client.session.delete.return_value = mock_resp

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-del-ok",
        datasource_ids=[],
    )

    manager.delete()

    mock_rag_client.ensure_authenticated.assert_called_once()
    mock_rag_client.session.delete.assert_called_once_with(
        f"{mock_rag_client.base_url}/v1/mcp/custom-tools/{manager.tool_id}",
        timeout=30,
    )


def test_delete_404_response_logs_warning_and_does_not_raise(
    mock_rag_client: MagicMock,
):
    """Verify delete() does not raise when RAG server returns 404 (already deleted)."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = False
    mock_resp.status_code = 404
    mock_resp.text = "Not Found"
    mock_rag_client.session.delete.return_value = mock_resp

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-del-404",
        datasource_ids=[],
    )

    # Must not raise
    manager.delete()
    mock_rag_client.session.delete.assert_called_once()


def test_delete_5xx_response_logs_warning_and_does_not_raise(
    mock_rag_client: MagicMock,
):
    """Verify delete() does not raise when RAG server returns 500."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = False
    mock_resp.status_code = 500
    mock_resp.text = "Server Error"
    mock_rag_client.session.delete.return_value = mock_resp

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-del-500",
        datasource_ids=[],
    )

    manager.delete()
    mock_rag_client.session.delete.assert_called_once()


def test_delete_network_exception_logs_warning_and_does_not_raise(
    mock_rag_client: MagicMock,
):
    """Verify delete() does not raise when requests raises ConnectionError."""
    mock_rag_client.session.delete.side_effect = requests.ConnectionError(
        "Connection refused"
    )

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-del-net-err",
        datasource_ids=[],
    )

    # Must not raise
    manager.delete()


# ---------------------------------------------------------------------------
# Tests: Context Manager Lifecycle
# ---------------------------------------------------------------------------


def test_context_manager_enter_calls_create_and_returns_self(
    mock_rag_client: MagicMock,
):
    """Verify __enter__ executes create() and returns the manager instance."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_rag_client.session.post.return_value = mock_resp
    mock_rag_client.session.delete.return_value = mock_resp

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-ctx-enter",
        datasource_ids=[],
    )

    with manager as ctx:
        assert ctx is manager
        mock_rag_client.session.post.assert_called_once()

    mock_rag_client.session.delete.assert_called_once()


def test_context_manager_exit_calls_delete_even_on_exception(
    mock_rag_client: MagicMock,
):
    """Verify __exit__ calls delete() even if exception occurred within the with-block."""
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_rag_client.session.post.return_value = mock_resp
    mock_rag_client.session.delete.return_value = mock_resp

    manager = DynamicMCPToolManager(
        rag_client=mock_rag_client,
        run_id="test-run-ctx-err",
        datasource_ids=[],
    )

    with pytest.raises(ValueError, match="Evaluation runtime crash"):
        with manager:
            raise ValueError("Evaluation runtime crash")

    mock_rag_client.session.post.assert_called_once()
    mock_rag_client.session.delete.assert_called_once()


# ---------------------------------------------------------------------------
# Tests: execute_evaluation_job Integration with DynamicMCPToolManager
# ---------------------------------------------------------------------------


@patch("deepeval_eval.api.job_manager.run_evaluation")
@patch("deepeval_eval.api.job_manager._build_rag_client")
@patch("deepeval_eval.clients.search_rag.build_search_rag_client")
def test_execute_evaluation_job_dynamic_tool_true_injects_tool_id_before_client_build(
    mock_build_search_rag_client: MagicMock,
    mock_build_rag_client: MagicMock,
    mock_run_eval: MagicMock,
):
    """Verify search_tool_name in EvalConfig is set to the generated tool_id before _build_rag_client is called."""
    from deepeval_eval.api.evaluation_jobs import EvaluationRequest
    from deepeval_eval.api.job_manager import (
        execute_evaluation_job,
        job_manager,
    )

    mock_crud_client = MagicMock()
    mock_crud_client.base_url = "https://rag.example.org"
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    mock_crud_client.session.post.return_value = mock_resp
    mock_crud_client.session.delete.return_value = mock_resp
    mock_build_search_rag_client.return_value = mock_crud_client

    mock_run_eval.return_value = []

    req = EvaluationRequest(
        dataset_name="enterprise",
        datasource_id="ds-enterprise",
        dynamic_tool=True,
        semantic_weight=0.75,
        extra_filters={"format": "markdown"},
        tool_description="Custom ephemeral search",
    )
    job_id = "test-job-dynamic-1"
    job_manager.jobs[job_id] = {
        "job_id": job_id,
        "status": "pending",
        "eval_hash": "hash123",
        "created_at": time.time(),
        "config_args": req.model_dump(),
    }

    try:
        execute_evaluation_job(job_id, req)

        # Check that _build_rag_client was called with an eval_config whose search_tool_name matches eval-test-job-dynamic
        mock_build_rag_client.assert_called_once()
        called_config = mock_build_rag_client.call_args[0][0]
        assert called_config.search_tool_name == "eval-test-job-dynamic"
        assert called_config.semantic_weight == 0.75
        assert called_config.extra_filters == {"format": "markdown"}

        # Verify tool creation and deletion were both executed
        mock_crud_client.session.post.assert_called_once()
        mock_crud_client.session.delete.assert_called_once()
    finally:
        job_manager.jobs.pop(job_id, None)


@patch("deepeval_eval.api.job_manager.run_evaluation")
@patch("deepeval_eval.api.job_manager._build_rag_client")
@patch("deepeval_eval.clients.search_rag.build_search_rag_client")
def test_execute_evaluation_job_dynamic_tool_false_skips_tool_creation(
    mock_build_search_rag_client: MagicMock,
    mock_build_rag_client: MagicMock,
    mock_run_eval: MagicMock,
):
    """Verify no MCP tool creation occurs when dynamic_tool=False."""
    from deepeval_eval.api.evaluation_jobs import EvaluationRequest
    from deepeval_eval.api.job_manager import (
        execute_evaluation_job,
        job_manager,
    )

    mock_crud_client = MagicMock()
    mock_build_search_rag_client.return_value = mock_crud_client
    mock_run_eval.return_value = []

    req = EvaluationRequest(
        dataset_name="enterprise",
        datasource_id="ds-enterprise",
        dynamic_tool=False,
    )
    job_id = "test-job-dynamic-false"
    job_manager.jobs[job_id] = {
        "job_id": job_id,
        "status": "pending",
        "eval_hash": "hash456",
        "created_at": time.time(),
        "config_args": req.model_dump(),
    }

    try:
        execute_evaluation_job(job_id, req)

        mock_crud_client.session.post.assert_not_called()
        mock_crud_client.session.delete.assert_not_called()
    finally:
        job_manager.jobs.pop(job_id, None)


def test_create_when_rag_client_has_no_ensure_authenticated_succeeds():
    class SimpleClient:
        def __init__(self):
            self.base_url = "https://rag.example.org"
            self.session = MagicMock()

    client = SimpleClient()
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    client.session.post.return_value = mock_resp

    manager = DynamicMCPToolManager(rag_client=client, run_id="simple-run-1")
    tool_id = manager.create()
    assert tool_id.startswith("eval-")
    client.session.post.assert_called_once()


def test_create_when_post_raises_generic_exception_wraps_in_runtime_error(
    mock_rag_client: MagicMock,
):
    mock_rag_client.session.post.side_effect = requests.RequestException(
        "Network failed"
    )
    manager = DynamicMCPToolManager(rag_client=mock_rag_client, run_id="fail-run-1")

    with pytest.raises(RuntimeError) as exc_info:
        manager.create()
    assert "Failed to create ephemeral MCP tool" in str(exc_info.value)
    assert "Network failed" in str(exc_info.value)


def test_delete_when_rag_client_has_no_ensure_authenticated_succeeds():
    class SimpleClient:
        def __init__(self):
            self.base_url = "https://rag.example.org"
            self.session = MagicMock()

    client = SimpleClient()
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    client.session.delete.return_value = mock_resp

    manager = DynamicMCPToolManager(rag_client=client, run_id="simple-run-2")
    manager.delete()
    client.session.delete.assert_called_once()
