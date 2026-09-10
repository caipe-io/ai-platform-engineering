"""Tests for POST /v1/ingest/local-file/reupload.

Re-upload replaces the content of an existing local-file data source in
place: old vector/job/graph state is purged and a new ingestion job is run
under the same datasource_id, preserving other datasource settings.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from common.job_manager import JobInfo, JobStatus
from common.models.rag import DataSourceInfo
from common.models.rbac import Role, UserContext
from server import restapi
from server.rbac import require_authenticated_user


def _user(role: str = Role.ADMIN, subject: str = "primary-sub") -> UserContext:
    return UserContext(
        subject=subject,
        email="primary@example.com",
        role=role,
        is_authenticated=True,
        groups=[],
    )


def _datasource(source_type: str = "local_file") -> DataSourceInfo:
    return DataSourceInfo(
        datasource_id="primary-ds",
        ingestor_id=restapi.LOCAL_FILE_INGESTOR_ID,
        name="old.md",
        source_type=source_type,
        last_updated=0,
        default_chunk_size=10000,
        default_chunk_overlap=2000,
    )


def _job(job_id: str = "job-1", status: JobStatus = JobStatus.COMPLETED) -> JobInfo:
    return JobInfo(job_id=job_id, status=status, created_at=0, datasource_id="primary-ds")


def _allow():
    async def _ok(*args, **kwargs):
        return None

    return _ok


def _deny(status_code: int = 403, detail: str = "Access denied for this datasource"):
    async def _raise(*args, **kwargs):
        raise HTTPException(status_code=status_code, detail=detail)

    return _raise


@pytest.fixture
def client() -> TestClient:
    return TestClient(restapi.app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _wire(monkeypatch: pytest.MonkeyPatch):
    restapi.app.dependency_overrides[require_authenticated_user] = lambda: _user()
    jm = AsyncMock()
    jm.get_jobs_by_datasource.return_value = []
    jm.upsert_job.return_value = True
    ms = AsyncMock()
    ms.get_datasource_info.return_value = _datasource()
    ing = AsyncMock()
    vdb = AsyncMock()
    monkeypatch.setattr(restapi, "jobmanager", jm, raising=False)
    monkeypatch.setattr(restapi, "metadata_storage", ms, raising=False)
    monkeypatch.setattr(restapi, "ingestor", ing, raising=False)
    monkeypatch.setattr(restapi, "vector_db", vdb, raising=False)
    monkeypatch.setattr(restapi, "graph_rag_enabled", False, raising=False)
    monkeypatch.setattr(restapi, "check_datasource_management_access", _allow(), raising=False)
    yield {"jobmanager": jm, "metadata_storage": ms, "ingestor": ing, "vector_db": vdb}
    restapi.app.dependency_overrides.clear()


def _reupload(client: TestClient, datasource_id: str = "primary-ds", filename: str = "new.md", content: bytes = b"# new content"):
    return client.post(
        "/v1/ingest/local-file/reupload",
        data={"datasource_id": datasource_id},
        files={"file": (filename, content, "text/markdown")},
    )


def test_reupload_404_when_datasource_missing(client: TestClient, _wire):
    _wire["metadata_storage"].get_datasource_info.return_value = None

    response = _reupload(client)

    assert response.status_code == 404


def test_reupload_400_when_not_local_file_source(client: TestClient, _wire):
    _wire["metadata_storage"].get_datasource_info.return_value = _datasource(source_type="confluence")

    response = _reupload(client)

    assert response.status_code == 400


def test_reupload_403_when_access_denied(client: TestClient, monkeypatch: pytest.MonkeyPatch, _wire):
    monkeypatch.setattr(restapi, "check_datasource_management_access", _deny(), raising=False)

    response = _reupload(client)

    assert response.status_code == 403
    _wire["vector_db"].adelete.assert_not_awaited()


def test_reupload_400_when_job_in_progress(client: TestClient, _wire):
    _wire["jobmanager"].get_jobs_by_datasource.return_value = [_job(status=JobStatus.IN_PROGRESS)]

    response = _reupload(client)

    assert response.status_code == 400
    _wire["vector_db"].adelete.assert_not_awaited()


def test_reupload_happy_path_purges_old_content_and_ingests_new_file(client: TestClient, _wire):
    _wire["jobmanager"].get_jobs_by_datasource.return_value = [_job()]

    response = _reupload(client, filename="new.md", content=b"# brand new")

    assert response.status_code == 202
    body = response.json()
    assert body["datasource_id"] == "primary-ds"
    assert "job_id" in body

    _wire["jobmanager"].delete_job.assert_not_awaited()
    _wire["vector_db"].adelete.assert_awaited_once()
    _wire["ingestor"].ingest_documents.assert_awaited_once()
    _, ingest_kwargs = _wire["ingestor"].ingest_documents.call_args
    assert ingest_kwargs["datasource_id"] == "primary-ds"
    assert len(ingest_kwargs["documents"]) == 1
    assert ingest_kwargs["documents"][0].page_content == "# brand new"

    _wire["jobmanager"].increment_document_count.assert_awaited_once_with(body["job_id"], 1)

    stored = _wire["metadata_storage"].store_datasource_info.call_args[0][0]
    assert stored.datasource_id == "primary-ds"
    assert stored.name == "new.md"


def test_reupload_preserves_job_history_across_multiple_reuploads(client: TestClient, _wire):
    """Each re-upload should add a new job rather than deleting prior ones (matches the
    reload pattern in queue_datasource_reload/create_reload_job for other source types)."""
    _wire["jobmanager"].get_jobs_by_datasource.return_value = [_job(job_id="job-1")]

    first = _reupload(client, filename="second.md", content=b"# second")
    assert first.status_code == 202

    _wire["jobmanager"].get_jobs_by_datasource.return_value = [
        _job(job_id="job-1"),
        _job(job_id=first.json()["job_id"]),
    ]

    second = _reupload(client, filename="third.md", content=b"# third")
    assert second.status_code == 202

    _wire["jobmanager"].delete_job.assert_not_awaited()
    new_job_ids = {call.args[0] for call in _wire["jobmanager"].upsert_job.call_args_list}
    assert new_job_ids == {first.json()["job_id"], second.json()["job_id"]}
    assert first.json()["job_id"] != second.json()["job_id"]
