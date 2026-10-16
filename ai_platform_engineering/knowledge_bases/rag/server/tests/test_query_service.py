"""Unit tests for VectorDBQueryService in server.query_service."""

import json
from typing import List
import pytest
from unittest.mock import AsyncMock, MagicMock
from server.query_service import VectorDBQueryService
from common.models.server import QueryResult


class TestVectorDBQueryService:
  """Unit tests for VectorDBQueryService query methods."""

  @pytest.fixture
  def mock_milvus(self) -> MagicMock:
    """Fixture providing a mocked Milvus instance."""
    milvus = MagicMock()
    milvus.collection_name = "test_docs"
    milvus.client = MagicMock()
    milvus.asimilarity_search_with_score = AsyncMock()
    return milvus

  @pytest.fixture
  def query_service(self, mock_milvus: MagicMock) -> VectorDBQueryService:
    """Fixture providing a VectorDBQueryService instance."""
    return VectorDBQueryService(vector_db=mock_milvus)

  @pytest.mark.asyncio
  async def test_query_with_text_delegates_to_similarity_search(self, query_service: VectorDBQueryService, mock_milvus: MagicMock) -> None:
    """Non-empty query delegates to similarity search even if filter is present."""
    mock_milvus.asimilarity_search_with_score.return_value = []

    results: List[QueryResult] = await query_service.query("kubernetes", filters={"datasource_id": "ds1"})

    mock_milvus.asimilarity_search_with_score.assert_awaited_once()
    assert results == []

  @pytest.mark.asyncio
  async def test_empty_query_with_filter_uses_scalar_path(self, query_service: VectorDBQueryService, mock_milvus: MagicMock) -> None:
    """Empty query with filter present uses Milvus scalar query path."""
    mock_milvus.client.query.return_value = [
      {
        "pk": "123",
        "text": "sample chunk content",
        "metadata": {"datasource_id": "ds1"},
        "custom_field": "val1",
      }
    ]

    results: List[QueryResult] = await query_service.query("", filters={"datasource_id": "ds1"})

    mock_milvus.asimilarity_search_with_score.assert_not_called()
    mock_milvus.client.query.assert_called_once_with(
      collection_name="test_docs",
      filter='datasource_id == "ds1"',
      limit=10,
      output_fields=["*"],
    )
    assert len(results) == 1
    assert results[0].document.page_content == "sample chunk content"
    assert results[0].document.metadata["datasource_id"] == "ds1"
    assert results[0].document.metadata["custom_field"] == "val1"
    assert results[0].document.metadata["pk"] == "123"

  @pytest.mark.asyncio
  async def test_scalar_path_falls_back_to_page_content_field(self, query_service: VectorDBQueryService, mock_milvus: MagicMock) -> None:
    """Scalar path falls back to page_content when text key is absent."""
    mock_milvus.client.query.return_value = [
      {
        "pk": "456",
        "page_content": "page content fallback",
      }
    ]

    results: List[QueryResult] = await query_service.query("", filters={"datasource_id": "ds1"})

    assert len(results) == 1
    assert results[0].document.page_content == "page content fallback"

  @pytest.mark.asyncio
  async def test_scalar_path_handles_explicit_empty_text_string(self, query_service: VectorDBQueryService, mock_milvus: MagicMock) -> None:
    """Scalar path preserves explicit text='' without falling back or failing."""
    mock_milvus.client.query.return_value = [
      {
        "pk": "789",
        "text": "",
        "page_content": "should not be used",
      }
    ]

    results: List[QueryResult] = await query_service.query("", filters={"datasource_id": "ds1"})

    assert len(results) == 1
    assert results[0].document.page_content == ""

  @pytest.mark.asyncio
  async def test_empty_query_no_filter_delegates_to_similarity_search(self, query_service: VectorDBQueryService, mock_milvus: MagicMock) -> None:
    """Empty query without filters delegates to similarity search (not scalar path)."""
    mock_milvus.asimilarity_search_with_score.return_value = []

    results: List[QueryResult] = await query_service.query("", filters=None)

    mock_milvus.asimilarity_search_with_score.assert_awaited_once()
    mock_milvus.client.query.assert_not_called()
    assert results == []

  @pytest.mark.asyncio
  async def test_scalar_path_exception_returns_empty_list(self, query_service: VectorDBQueryService, mock_milvus: MagicMock) -> None:
    """Exceptions in scalar query are caught and return an empty list."""
    mock_milvus.client.query.side_effect = RuntimeError("Milvus connection lost")

    results: List[QueryResult] = await query_service.query("", filters={"datasource_id": "ds1"})

    assert results == []

  @pytest.mark.asyncio
  @pytest.mark.parametrize("value", ["admin' OR '1'=='1", 'example\\" OR true', "example\nvalue"])
  async def test_filter_string_values_are_escaped_against_injection(self, query_service: VectorDBQueryService, mock_milvus: MagicMock, value: str) -> None:
    mock_milvus.client.query.return_value = []

    await query_service.query("", filters={"metadata.author": value})

    assert mock_milvus.client.query.call_args.kwargs["filter"] == f'metadata["author"] == {json.dumps(value, ensure_ascii=False)}'

  @pytest.mark.asyncio
  async def test_datasource_list_and_prefix_filters_remain_supported(self, query_service: VectorDBQueryService, mock_milvus: MagicMock) -> None:
    mock_milvus.client.query.return_value = []

    await query_service.query("", filters={"datasource_id": ["primary", "secondary*"]})

    assert mock_milvus.client.query.call_args.kwargs["filter"] == '(datasource_id in ["primary"] or datasource_id like "secondary%")'

  @pytest.mark.asyncio
  async def test_empty_datasource_list_remains_deny_filter(self, query_service: VectorDBQueryService, mock_milvus: MagicMock) -> None:
    mock_milvus.client.query.return_value = []

    await query_service.query("", filters={"datasource_id": []})

    assert mock_milvus.client.query.call_args.kwargs["filter"] == 'datasource_id in ["__noresults__"]'
    mock_milvus.asimilarity_search_with_score.assert_not_called()

  @pytest.mark.asyncio
  async def test_scalar_metadata_does_not_mutate_milvus_rows(self, query_service: VectorDBQueryService, mock_milvus: MagicMock) -> None:
    metadata = {"source": "example"}
    mock_milvus.client.query.return_value = [{"text": "content", "metadata": metadata, "datasource_id": "primary", "dense": [1.0], "sparse": {1: 1.0}}]

    results = await query_service.query("", filters={"datasource_id": "primary"})

    assert metadata == {"source": "example"}
    assert results[0].document.metadata == {"source": "example", "datasource_id": "primary"}
