"""Focused tests for the non-persisting Confluence ingestion preview."""

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
