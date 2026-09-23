"""Route-level tests for POST /v1/ingest/confluence/page.

Exercises the actual FastAPI handler (not just the identity/description
helpers covered by test_confluence_datasource_identity.py) for the folder
and whole-space URL shapes, plus the dedup-by-content-id merge path.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from common.models.rag import DataSourceInfo
from common.models.rbac import Role, UserContext
from server import restapi
from server.rbac import require_authenticated_user


def _user() -> UserContext:
  return UserContext(
    subject="primary-sub",
    email="primary@example.com",
    role=Role.ADMIN,
    is_authenticated=True,
    groups=[],
  )


async def _noop(*args, **kwargs) -> None:
  return None


@pytest.fixture
def client() -> TestClient:
  return TestClient(restapi.app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _wire(monkeypatch: pytest.MonkeyPatch):
  restapi.app.dependency_overrides[require_authenticated_user] = lambda: _user()
  ms = AsyncMock()
  ms.get_datasource_info.return_value = None
  jm = AsyncMock()
  jm.upsert_job.return_value = True
  enqueue = AsyncMock()
  monkeypatch.setattr(restapi, "metadata_storage", ms, raising=False)
  monkeypatch.setattr(restapi, "jobmanager", jm, raising=False)
  # Skip the configured-instance allowlist check; it's covered separately and
  # isn't the subject of this test.
  monkeypatch.setattr(restapi, "confluence_url", None, raising=False)
  monkeypatch.setattr(restapi, "authorize_source_ingestion", _noop, raising=False)
  monkeypatch.setattr(restapi, "provision_legacy_datasource_ownership", _noop, raising=False)
  monkeypatch.setattr(restapi, "reject_if_ingestion_job_blocking", _noop, raising=False)
  monkeypatch.setattr(restapi, "resolve_live_ingestor_id", AsyncMock(return_value="confluence:default"), raising=False)
  monkeypatch.setattr(restapi, "resolve_datasource_ingestor", AsyncMock(return_value="confluence:default"), raising=False)
  monkeypatch.setattr(restapi, "enqueue_ingestor_request", enqueue, raising=False)
  yield {"metadata_storage": ms, "jobmanager": jm, "enqueue_ingestor_request": enqueue}
  restapi.app.dependency_overrides.clear()


def _ingest(client: TestClient, url: str, **overrides: object):
  body = {"url": url, "reload_interval": 86400, **overrides}
  return client.post("/v1/ingest/confluence/page", json=body)


def test_folder_url_creates_a_folder_scoped_datasource(client: TestClient, _wire):
  response = _ingest(client, "https://example.atlassian.net/wiki/spaces/ENG/folder/456")

  assert response.status_code == 202
  stored = _wire["metadata_storage"].store_datasource_info.call_args.args[0]
  assert stored.datasource_id == "src_confluence___example_atlassian_net__ENG__folder__456"
  assert stored.metadata["content_kind"] == "folder"
  assert stored.metadata["page_configs"] == [
    {"folder_id": "456", "source": "https://example.atlassian.net/wiki/spaces/ENG/folder/456"},
  ]


def test_space_url_creates_a_whole_space_datasource_with_no_page_configs(client: TestClient, _wire):
  response = _ingest(client, "https://example.atlassian.net/wiki/spaces/ENG")

  assert response.status_code == 202
  stored = _wire["metadata_storage"].store_datasource_info.call_args.args[0]
  assert stored.datasource_id == "src_confluence___example_atlassian_net__ENG"
  assert stored.metadata["content_kind"] == "space"
  assert stored.metadata["page_configs"] == []


def test_resubmitting_the_same_folder_url_updates_the_existing_entry_instead_of_duplicating(
  client: TestClient, _wire,
):
  existing = DataSourceInfo(
    datasource_id="src_confluence___example_atlassian_net__ENG__folder__456",
    ingestor_id="confluence:default",
    source_type="confluence",
    last_updated=0,
    default_chunk_size=10000,
    default_chunk_overlap=2000,
    metadata={
      "space_key": "ENG",
      "page_configs": [{"folder_id": "456", "source": "https://example.atlassian.net/wiki/spaces/ENG/folder/456/Old"}],
    },
  )
  _wire["metadata_storage"].get_datasource_info.return_value = existing

  response = _ingest(client, "https://example.atlassian.net/wiki/spaces/ENG/folder/456/New")

  assert response.status_code == 202
  stored = _wire["metadata_storage"].store_datasource_info.call_args.args[0]
  assert stored.metadata["page_configs"] == [
    {"folder_id": "456", "source": "https://example.atlassian.net/wiki/spaces/ENG/folder/456/New"},
  ]


def test_invalid_confluence_url_shape_is_rejected(client: TestClient, _wire):
  response = _ingest(client, "https://example.atlassian.net/wiki/display/ENG")

  assert response.status_code == 400
  _wire["metadata_storage"].store_datasource_info.assert_not_called()
