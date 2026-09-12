from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
import requests

from deepeval_eval.clients.ingest_rag import (
    IngestRagClient,
    build_ingest_rag_client,
    check_response,
)


def test_check_response_positive() -> None:
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = True
    result = check_response(mock_resp)
    assert result == mock_resp


def test_check_response_negative() -> None:
    mock_resp = MagicMock(spec=requests.Response)
    mock_resp.ok = False
    mock_resp.status_code = 404
    mock_resp.request = MagicMock()
    mock_resp.request.method = "GET"
    mock_resp.request.url = "http://example.com"
    mock_resp.text = "Not Found"

    with pytest.raises(RuntimeError, match="HTTP 404"):
        check_response(mock_resp)


def test_ingest_rag_client_ingest_endpoints(tmp_path) -> None:
    client = IngestRagClient(
        base_url="https://rag.example.org/api", token="static_token"
    )

    mock_resp = MagicMock()
    mock_resp.ok = True
    mock_resp.status_code = 200

    # test register_ingestor
    mock_resp.json.return_value = {
        "ingestor_id": "ing123",
        "max_documents_per_ingest": 100,
    }
    with patch.object(client.session, "post", return_value=mock_resp):
        ing_id, max_docs = client.register_ingestor("type", "name", "desc")
        assert ing_id == "ing123"
        assert max_docs == 100

    # test reset_datasource
    mock_resp_del = MagicMock()
    mock_resp_del.status_code = 204
    with patch.object(client.session, "delete", return_value=mock_resp_del):
        client.reset_datasource("ds1")

    # test upsert_datasource
    with patch.object(client.session, "post", return_value=mock_resp):
        client.upsert_datasource("ds1", "Name", "ing123", "desc", "slack")

    # test open_job and close_job
    mock_resp.json.return_value = {"job_id": "job789"}
    with patch.object(client.session, "post", return_value=mock_resp):
        job_id = client.open_job("ds1", 10, "start")
        assert job_id == "job789"

    with patch.object(client.session, "patch", return_value=mock_resp):
        client.close_job("job789", "finish")

    # test ingest_batch
    docs = [{"text": "doc1"}]
    with patch.object(client.session, "post", return_value=mock_resp):
        client.ingest_batch(docs, "ing123", "ds1", "job789")


def test_ingest_rag_client_ingest_batch_retries_on_timeout_success() -> None:
    client = IngestRagClient(
        base_url="https://rag.example.org/api", token="static_token"
    )
    docs = [{"text": "doc1"}]

    mock_resp_success = MagicMock()
    mock_resp_success.ok = True
    mock_resp_success.status_code = 200

    # First attempt: ReadTimeout; Second attempt: Success
    with (
        patch.object(
            client.session,
            "post",
            side_effect=[
                requests.exceptions.ReadTimeout("Read timed out"),
                mock_resp_success,
                mock_resp_success,  # increment-document-count
                mock_resp_success,  # increment-progress
            ],
        ) as mock_post,
        patch("time.sleep") as mock_sleep,
    ):
        client.ingest_batch(
            docs, "ing123", "ds1", "job789", max_retries=2, initial_backoff=0.1
        )
        assert mock_post.call_count == 4
        mock_sleep.assert_called_once_with(0.1)


def test_ingest_rag_client_ingest_batch_exhausts_retries_failure() -> None:
    client = IngestRagClient(
        base_url="https://rag.example.org/api", token="static_token"
    )
    docs = [{"text": "doc1"}]

    with (
        patch.object(
            client.session,
            "post",
            side_effect=requests.exceptions.ReadTimeout("Read timed out"),
        ) as mock_post,
        patch("time.sleep") as mock_sleep,
    ):
        with pytest.raises(requests.exceptions.ReadTimeout):
            client.ingest_batch(
                docs, "ing123", "ds1", "job789", max_retries=2, initial_backoff=0.1
            )
        assert mock_post.call_count == 3
        assert mock_sleep.call_count == 2


def test_build_ingest_rag_client_positive(monkeypatch) -> None:
    monkeypatch.setenv("CAIPE_BASE_URL", "http://localhost:8080")
    monkeypatch.setenv("CAIPE_AUTH_TOKEN", "token123")
    monkeypatch.setenv("INSECURE_SSL", "true")
    client = build_ingest_rag_client()
    assert isinstance(client, IngestRagClient)
    assert client.base_url == "http://localhost:8080"
    assert client.session.verify is False


def test_reset_datasource_when_error_status_raises_runtime_error() -> None:
    client = IngestRagClient(
        base_url="https://rag.example.org/api", token="example_token"
    )
    mock_resp = MagicMock()
    mock_resp.ok = False
    mock_resp.status_code = 500
    mock_resp.request = MagicMock()
    mock_resp.request.method = "DELETE"
    mock_resp.request.url = "https://rag.example.org/api/v1/datasource"
    mock_resp.text = "Internal error"

    with patch.object(client.session, "delete", return_value=mock_resp):
        with pytest.raises(RuntimeError) as exc_info:
            client.reset_datasource("ds-error")
        assert "HTTP 500" in str(exc_info.value)


def test_close_job_when_unauthorized_refreshes_token_and_retries() -> None:
    client = IngestRagClient(
        base_url="https://rag.example.org/api",
        token="initial_token",
        keycloak_url="https://keycloak.example.org",
        client_id="example-client",
        client_secret="example-secret",
    )
    mock_resp_401 = MagicMock()
    mock_resp_401.ok = False
    mock_resp_401.status_code = 401

    mock_resp_200 = MagicMock()
    mock_resp_200.ok = True
    mock_resp_200.status_code = 200

    with (
        patch.object(
            client.session, "patch", side_effect=[mock_resp_401, mock_resp_200]
        ) as mock_patch,
        patch.object(client.token_manager, "force_refresh") as mock_refresh,
    ):
        client.close_job("job-123", "completed successfully")
        assert mock_refresh.call_count == 1
        assert mock_patch.call_count == 2


def test_ingest_batch_when_server_returns_503_retries_and_succeeds() -> None:
    client = IngestRagClient(
        base_url="https://rag.example.org/api", token="example_token"
    )
    docs = [{"text": "doc1"}]

    mock_resp_503 = MagicMock()
    mock_resp_503.status_code = 503
    mock_resp_503.text = "Service Unavailable"

    mock_resp_200 = MagicMock()
    mock_resp_200.ok = True
    mock_resp_200.status_code = 200

    with (
        patch.object(
            client.session,
            "post",
            side_effect=[
                mock_resp_503,
                mock_resp_200,
                mock_resp_200,  # increment-document-count
                mock_resp_200,  # increment-progress
            ],
        ) as mock_post,
        patch("time.sleep"),
    ):
        client.ingest_batch(
            docs, "ing1", "ds1", "job1", max_retries=1, initial_backoff=0.01
        )
        assert mock_post.call_count == 4


def test_ingest_batch_when_increment_progress_fails_raises_runtime_error() -> None:
    client = IngestRagClient(
        base_url="https://rag.example.org/api", token="example_token"
    )
    docs = [{"text": "doc1"}]

    mock_resp_ok = MagicMock()
    mock_resp_ok.ok = True
    mock_resp_ok.status_code = 200

    mock_resp_inc_err = MagicMock()
    mock_resp_inc_err.ok = False
    mock_resp_inc_err.status_code = 500
    mock_resp_inc_err.request = MagicMock()
    mock_resp_inc_err.request.method = "POST"
    mock_resp_inc_err.request.url = (
        "https://rag.example.org/api/v1/job/job1/increment-document-count"
    )
    mock_resp_inc_err.text = "Failed increment"

    with patch.object(
        client.session,
        "post",
        side_effect=[
            mock_resp_ok,
            mock_resp_inc_err,
        ],
    ):
        with pytest.raises(RuntimeError) as exc_info:
            client.ingest_batch(docs, "ing1", "ds1", "job1", max_retries=0)
        assert "HTTP 500" in str(exc_info.value)
