"""Unit tests for list_datasource_documents endpoint and datasource_id validation in server.restapi."""

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from common.models.rbac import UserContext
from common.models.server import DatasourceDocumentsResponse
from server import doc_acl, restapi
from server.query_service import VectorDBQueryService
from server.restapi import _validate_datasource_id


class TestValidateDatasourceId:
  """Unit tests for _validate_datasource_id helper."""

  def test_valid_datasource_ids(self) -> None:
    """Valid alphanumeric, dash, and underscore IDs pass validation."""
    valid_ids = [
      "ds1",
      "datasource-123",
      "my_datasource_name",
      "a" * 256,
    ]
    for ds_id in valid_ids:
      assert _validate_datasource_id(ds_id) == ds_id

  def test_invalid_datasource_ids_rejected(self) -> None:
    """Unsafe characters (quotes, SQL/expression injection, spaces) raise HTTP 400."""
    invalid_ids = [
      "ds1' OR '1'='1",
      "ds1; DROP TABLE docs;",
      "datasource name",
      "ds1/../etc",
      "",
      "a" * 257,
      "ds1\n",
    ]
    for ds_id in invalid_ids:
      with pytest.raises(HTTPException) as exc_info:
        _validate_datasource_id(ds_id)
      assert exc_info.value.status_code == 400
      assert "Invalid datasource_id" in exc_info.value.detail


@pytest.fixture
def vector_db(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
  vector_db = MagicMock()
  vector_db.client.query.return_value = []
  vector_db.client.query_iterator.return_value.next.return_value = []
  monkeypatch.setattr(restapi, "vector_db", vector_db)
  monkeypatch.setattr(restapi, "vector_db_query_service", VectorDBQueryService(vector_db))
  monkeypatch.setattr(restapi, "check_datasource_access", AsyncMock())
  monkeypatch.setattr(restapi, "authorize_search", AsyncMock())
  return vector_db


async def _list_documents(offset: int = 0, limit: int = 10) -> DatasourceDocumentsResponse:
  return await restapi.list_datasource_documents(
    request=MagicMock(), datasource_id="primary", offset=offset, limit=limit,
    user=UserContext(subject="test-user", email="test-user@example.com", role="readonly", is_authenticated=True),
  )


@pytest.mark.asyncio
async def test_empty_datasource_returns_zero_counts(vector_db: MagicMock) -> None:
  response = await _list_documents()

  assert response.total_chunks == response.total_documents == 0
  assert response.documents == []
  assert response.has_more is False
  vector_db.client.query_iterator.return_value.close.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("offset", [0, 5, 100])
async def test_counts_are_independent_of_page_and_share_acl_filter(vector_db: MagicMock, monkeypatch: pytest.MonkeyPatch, offset: int) -> None:
  monkeypatch.setattr(doc_acl, "DOC_ACL_TAGS_ENABLED", True)
  chunks = [{"id": f"chunk-{i}", "document_id": "document-1", "chunk_index": i} for i in range(3)]

  def query(**kwargs: Any) -> list[dict[str, Any]]:
    return [{"count(*)": 20}] if kwargs["output_fields"] == ["count(*)"] else chunks

  vector_db.client.query.side_effect = query
  iterator = vector_db.client.query_iterator.return_value
  iterator.next.side_effect = [[{"document_id": "document-1"}, {"document_id": "document-2"}], [{"document_id": "document-1"}, {"document_id": "document-3"}], []]

  response = await _list_documents(offset=offset, limit=2)

  assert response.total_chunks == 20
  assert response.total_documents == 3
  assert len(response.documents) == 1
  assert len(response.documents[0].chunks) == 2
  assert response.has_more is True
  expected_filter = 'datasource_id == "primary" AND metadata["acl_tags"] in ["__public__"]'
  for call in vector_db.client.query.call_args_list:
    assert call.kwargs["filter"] == expected_filter
  assert vector_db.client.query_iterator.call_args.kwargs["filter"] == expected_filter
  iterator.close.assert_called_once()
  page_call = next(call for call in vector_db.client.query.call_args_list if "offset" in call.kwargs)
  assert page_call.kwargs["offset"] == offset
  assert page_call.kwargs["limit"] == 3


@pytest.mark.asyncio
async def test_documents_above_milvus_query_window_are_counted(vector_db: MagicMock) -> None:
  iterator = vector_db.client.query_iterator.return_value
  iterator.next.side_effect = [[{"document_id": f"document-{i}"} for i in range(17000)], []]
  vector_db.client.query.side_effect = lambda **kwargs: [{"count(*)": 17000}] if kwargs["output_fields"] == ["count(*)"] else []

  response = await _list_documents(offset=100)

  assert response.total_documents == response.total_chunks == 17000
  assert response.documents == []
  assert response.has_more is False


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["chunks", "documents"])
async def test_count_failure_returns_error_instead_of_page_totals(vector_db: MagicMock, failure: str) -> None:
  def query(**kwargs: Any) -> list[dict[str, Any]]:
    if kwargs["output_fields"] == ["count(*)"]:
      if failure == "chunks":
        raise RuntimeError("chunk count failed")
      return [{"count(*)": 20}]
    return [{"id": "chunk-1", "document_id": "document-1"}]

  vector_db.client.query.side_effect = query
  iterator = vector_db.client.query_iterator.return_value
  if failure == "documents":
    iterator.next.side_effect = RuntimeError("document count failed")

  with pytest.raises(HTTPException) as error:
    await _list_documents()

  assert error.value.status_code == 500
  if failure == "documents":
    iterator.close.assert_called_once()


@pytest.mark.asyncio
async def test_invalid_datasource_skips_all_reads(vector_db: MagicMock) -> None:
  with pytest.raises(HTTPException) as error:
    await restapi.list_datasource_documents(request=MagicMock(), datasource_id="primary\n", offset=0, limit=10)

  assert error.value.status_code == 400
  vector_db.client.query.assert_not_called()
  vector_db.client.query_iterator.assert_not_called()


@pytest.mark.asyncio
async def test_pagination_boundary_rejected_before_reads(vector_db: MagicMock) -> None:
  with pytest.raises(HTTPException) as error:
    await _list_documents(offset=16374, limit=10)

  assert error.value.status_code == 400
  vector_db.client.query.assert_not_called()
  vector_db.client.query_iterator.assert_not_called()
