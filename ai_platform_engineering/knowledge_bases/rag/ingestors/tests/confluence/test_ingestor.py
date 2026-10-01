"""Focused tests for Confluence ingestion preview and on-demand processing."""

from __future__ import annotations

import os
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

os.environ.setdefault("CONFLUENCE_URL", "https://example.atlassian.net/wiki")
os.environ.setdefault("CONFLUENCE_USERNAME", "test-user@example.com")
os.environ.setdefault("CONFLUENCE_TOKEN", "test-token")

# The executable module supports direct script startup and therefore imports
# its sibling as `loader`. Alias the package import for unit-test collection.
from ingestors.confluence import loader as loader_module  # noqa: E402

sys.modules.setdefault("loader", loader_module)

import ingestors.confluence.ingestor as ingestor_module  # noqa: E402
from common.job_manager import JobInfo, JobStatus  # noqa: E402
from common.models.rag import DataSourceInfo  # noqa: E402
from common.models.server import ConfluenceIngestRequest  # noqa: E402


@pytest.mark.asyncio
async def test_preview_page_uses_bounded_selection_without_ingesting(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  loader = MagicMock()
  loader.__aenter__ = AsyncMock(return_value=loader)
  loader.__aexit__ = AsyncMock(return_value=None)
  loader.load_pages = AsyncMock(
    return_value=(
      [
        {
          "id": "123",
          "title": "Example root",
          "_links": {"webui": "/spaces/EXAMPLE/pages/123"},
        }
      ],
      [("456", "Child page could not be loaded")],
    )
  )
  loader.last_load_truncated = True
  loader_factory = MagicMock(return_value=loader)
  monkeypatch.setattr(ingestor_module, "ConfluenceLoader", loader_factory)

  rag_client = MagicMock()
  rag_client.ingestor_id = "confluence:example"
  rag_client.ingest_documents = AsyncMock()
  request = ConfluenceIngestRequest(
    url="https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/123/Root",
    get_child_pages=True,
    reload_interval=86400,
  )

  result = await ingestor_module.preview_page_ingestion(rag_client, request)

  loader.load_pages.assert_awaited_once_with(
    "EXAMPLE",
    [{"page_id": "123", "get_child_pages": True}],
    max_pages=ingestor_module.PREVIEW_MAX_ITEMS + 1,
  )
  assert result["truncated"] is True
  assert result["items"] == [
    {
      "id": "123",
      "title": "Example root",
      "url": "https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/123",
    }
  ]
  assert result["warnings"] == ["Child page could not be loaded"]
  rag_client.ingest_documents.assert_not_awaited()


@pytest.mark.asyncio
async def test_preview_folder_url_expands_to_a_folder_config(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  loader = MagicMock()
  loader.__aenter__ = AsyncMock(return_value=loader)
  loader.__aexit__ = AsyncMock(return_value=None)
  loader.load_pages = AsyncMock(return_value=([], []))
  loader.last_load_truncated = False
  loader_factory = MagicMock(return_value=loader)
  monkeypatch.setattr(ingestor_module, "ConfluenceLoader", loader_factory)

  rag_client = MagicMock()
  rag_client.ingestor_id = "confluence:example"
  request = ConfluenceIngestRequest(
    url="https://example.atlassian.net/wiki/spaces/EXAMPLE/folder/789",
    reload_interval=86400,
  )

  result = await ingestor_module.preview_page_ingestion(rag_client, request)

  loader.load_pages.assert_awaited_once_with(
    "EXAMPLE",
    [{"folder_id": "789"}],
    max_pages=ingestor_module.PREVIEW_MAX_ITEMS + 1,
  )
  assert result["summary"]["content_kind"] == "folder"
  assert result["summary"]["root_content_id"] == "789"


@pytest.mark.asyncio
async def test_preview_space_url_enumerates_the_whole_space(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  loader = MagicMock()
  loader.__aenter__ = AsyncMock(return_value=loader)
  loader.__aexit__ = AsyncMock(return_value=None)
  loader.load_pages = AsyncMock(return_value=([], []))
  loader.last_load_truncated = False
  loader_factory = MagicMock(return_value=loader)
  monkeypatch.setattr(ingestor_module, "ConfluenceLoader", loader_factory)

  rag_client = MagicMock()
  rag_client.ingestor_id = "confluence:example"
  request = ConfluenceIngestRequest(
    url="https://example.atlassian.net/wiki/spaces/EXAMPLE",
    reload_interval=86400,
  )

  result = await ingestor_module.preview_page_ingestion(rag_client, request)

  loader.load_pages.assert_awaited_once_with(
    "EXAMPLE",
    None,
    max_pages=ingestor_module.PREVIEW_MAX_ITEMS + 1,
  )
  assert result["summary"]["content_kind"] == "space"
  assert result["summary"]["root_content_id"] is None


@pytest.mark.asyncio
async def test_preview_rejects_an_unsupported_url_shape() -> None:
  rag_client = MagicMock()
  request = ConfluenceIngestRequest(
    url="https://example.atlassian.net/wiki/display/EXAMPLE",
    reload_interval=86400,
  )

  with pytest.raises(ValueError, match="Invalid Confluence URL format"):
    await ingestor_module.preview_page_ingestion(rag_client, request)


def _make_datasource(datasource_id: str) -> DataSourceInfo:
  return DataSourceInfo(
    datasource_id=datasource_id,
    ingestor_id="confluence:example",
    source_type="confluence",
    last_updated=None,
    default_chunk_size=10000,
    default_chunk_overlap=2000,
  )


def _make_job(datasource_id: str, status: JobStatus = JobStatus.PENDING) -> JobInfo:
  return JobInfo(job_id="job-1", status=status, created_at=0, datasource_id=datasource_id)


@pytest.mark.asyncio
async def test_process_page_ingestion_ingests_a_page(monkeypatch: pytest.MonkeyPatch) -> None:
  datasource_id = "src_confluence___example_atlassian_net__EXAMPLE__123"
  datasource_info = _make_datasource(datasource_id)

  loader = MagicMock()
  loader.__aenter__ = AsyncMock(return_value=loader)
  loader.__aexit__ = AsyncMock(return_value=None)
  loader.load_pages = AsyncMock(return_value=([{"id": "123"}], []))
  loader.ingest_pages = AsyncMock()
  loader_factory = MagicMock(return_value=loader)
  monkeypatch.setattr(ingestor_module, "ConfluenceLoader", loader_factory)

  rag_client = MagicMock()
  rag_client.ingestor_id = "confluence:example"
  rag_client.list_datasources = AsyncMock(return_value=[datasource_info])
  rag_client.upsert_datasource = AsyncMock()

  job_manager = MagicMock()
  job_manager.get_job = AsyncMock(return_value=_make_job(datasource_id))
  job_manager.upsert_job = AsyncMock()

  request = ConfluenceIngestRequest(
    url="https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/123/Root",
    get_child_pages=True,
    reload_interval=86400,
  )

  await ingestor_module.process_page_ingestion(rag_client, job_manager, request, "job-1")

  loader.load_pages.assert_awaited_once_with(
    "EXAMPLE",
    [{"page_id": "123", "get_child_pages": True}],
  )
  loader.ingest_pages.assert_awaited_once()
  rag_client.upsert_datasource.assert_awaited_once()


@pytest.mark.asyncio
async def test_process_page_ingestion_expands_a_folder_url(monkeypatch: pytest.MonkeyPatch) -> None:
  datasource_id = "src_confluence___example_atlassian_net__EXAMPLE__folder__789"
  datasource_info = _make_datasource(datasource_id)

  loader = MagicMock()
  loader.__aenter__ = AsyncMock(return_value=loader)
  loader.__aexit__ = AsyncMock(return_value=None)
  loader.load_pages = AsyncMock(return_value=([{"id": "1"}, {"id": "2"}], []))
  loader.ingest_pages = AsyncMock()
  loader_factory = MagicMock(return_value=loader)
  monkeypatch.setattr(ingestor_module, "ConfluenceLoader", loader_factory)

  rag_client = MagicMock()
  rag_client.ingestor_id = "confluence:example"
  rag_client.list_datasources = AsyncMock(return_value=[datasource_info])
  rag_client.upsert_datasource = AsyncMock()

  job_manager = MagicMock()
  job_manager.get_job = AsyncMock(return_value=_make_job(datasource_id))
  job_manager.upsert_job = AsyncMock()

  request = ConfluenceIngestRequest(
    url="https://example.atlassian.net/wiki/spaces/EXAMPLE/folder/789",
    reload_interval=86400,
  )

  await ingestor_module.process_page_ingestion(rag_client, job_manager, request, "job-1")

  loader.load_pages.assert_awaited_once_with("EXAMPLE", [{"folder_id": "789"}])
  loader.ingest_pages.assert_awaited_once_with([{"id": "1"}, {"id": "2"}], "job-1")


@pytest.mark.asyncio
async def test_process_page_ingestion_raises_when_job_does_not_belong_to_datasource(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  datasource_id = "src_confluence___example_atlassian_net__EXAMPLE__123"
  datasource_info = _make_datasource(datasource_id)

  rag_client = MagicMock()
  rag_client.ingestor_id = "confluence:example"
  rag_client.list_datasources = AsyncMock(return_value=[datasource_info])

  job_manager = MagicMock()
  job_manager.get_job = AsyncMock(return_value=_make_job("some-other-datasource"))
  job_manager.add_error_msg = AsyncMock()

  request = ConfluenceIngestRequest(
    url="https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/123/Root",
    reload_interval=86400,
  )

  with pytest.raises(ValueError, match="does not belong to datasource"):
    await ingestor_module.process_page_ingestion(rag_client, job_manager, request, "job-1")
