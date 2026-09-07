"""Tests for per-datasource RBAC on document/chunk read endpoints.

Covers ``GET /v1/datasource/{datasource_id}/documents`` and
``GET /v1/chunk/{chunk_id:path}/content``. Both endpoints previously only
enforced the coarse READONLY role, letting any authenticated reader browse
or read chunk content for datasources their team does not own. They now call
``check_datasource_access`` (chunk content resolves the owning datasource
from the chunk's own Milvus record first).

The TestClient is used WITHOUT a ``with`` block so the app lifespan (Milvus /
Redis / Neo4j connections) is not triggered.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from common.models.rbac import Role, UserContext
from server import restapi
from server import rbac
from server.rbac import require_authenticated_user


def _user(role: str = Role.READONLY, subject: str = "primary-sub") -> UserContext:
    return UserContext(
        subject=subject,
        email="primary@example.com",
        role=role,
        is_authenticated=True,
        groups=[],
    )


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
    restapi.app.dependency_overrides[require_authenticated_user] = _user
    monkeypatch.setattr(restapi, "vector_db", MagicMock(), raising=False)
    query_service = AsyncMock()

    async def _build_filter_expression(filters: dict) -> str:
        return " and ".join(f'{key} == "{value}"' for key, value in filters.items())

    query_service.build_filter_expression.side_effect = _build_filter_expression
    monkeypatch.setattr(restapi, "vector_db_query_service", query_service, raising=False)
    monkeypatch.setattr(restapi, "authorize_search", AsyncMock(return_value=None))
    yield
    restapi.app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# GET /v1/datasource/{datasource_id}/documents
# ---------------------------------------------------------------------------


def test_list_documents_denied_returns_403_and_skips_query(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(restapi, "check_datasource_access", _deny(), raising=False)

    client = TestClient(restapi.app, raise_server_exceptions=False)
    response = client.get("/v1/datasource/secondary-ds/documents")

    assert response.status_code == 403
    restapi.vector_db.client.query.assert_not_called()


def test_list_documents_allowed_queries_milvus(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(restapi, "check_datasource_access", _allow(), raising=False)
    restapi.vector_db.client.query.return_value = []

    client = TestClient(restapi.app, raise_server_exceptions=False)
    response = client.get("/v1/datasource/primary-ds/documents")

    assert response.status_code == 200
    restapi.vector_db.client.query.assert_called_once()
    _, kwargs = restapi.vector_db.client.query.call_args
    assert "primary-ds" in kwargs["filter"]


def test_list_documents_passes_datasource_id_and_scope_to_check(monkeypatch: pytest.MonkeyPatch):
    calls = []

    async def _spy(user, datasource_id, scope):
        calls.append((datasource_id, scope))

    monkeypatch.setattr(restapi, "check_datasource_access", _spy, raising=False)
    restapi.vector_db.client.query.return_value = []

    client = TestClient(restapi.app, raise_server_exceptions=False)
    client.get("/v1/datasource/primary-ds/documents")

    assert calls == [("primary-ds", "read")]


def test_list_documents_allowed_via_real_helper_when_openfga_grants_access(monkeypatch: pytest.MonkeyPatch):
    """A caller is allowed through the REAL check_datasource_access helper when
    OpenFGA grants the per-datasource relation (no monkeypatch of the check
    itself — only the underlying OpenFGA call)."""
    restapi.app.dependency_overrides[require_authenticated_user] = lambda: _user(role=Role.ADMIN)
    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga")

    async def _grant(*args, **kwargs):
        return True

    monkeypatch.setattr(rbac, "_openfga_check_data_source", _grant, raising=False)
    restapi.vector_db.client.query.return_value = []

    client = TestClient(restapi.app, raise_server_exceptions=False)
    response = client.get("/v1/datasource/primary-ds/documents")

    assert response.status_code == 200


# ---------------------------------------------------------------------------
# GET /v1/chunk/{chunk_id:path}/content
# ---------------------------------------------------------------------------


def test_get_chunk_content_404_when_missing(monkeypatch: pytest.MonkeyPatch):
    calls = []

    async def _spy(*args, **kwargs):
        calls.append(args)

    monkeypatch.setattr(restapi, "check_datasource_access", _spy, raising=False)
    restapi.vector_db.client.query.return_value = []

    client = TestClient(restapi.app, raise_server_exceptions=False)
    response = client.get("/v1/chunk/missing-chunk/content")

    assert response.status_code == 404
    assert calls == []


def test_get_chunk_content_denied_returns_403(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(restapi, "check_datasource_access", _deny(), raising=False)
    restapi.vector_db.client.query.return_value = [
        {"id": "chunk-1", "text": "secret text", "datasource_id": "secondary-ds"}
    ]

    client = TestClient(restapi.app, raise_server_exceptions=False)
    response = client.get("/v1/chunk/chunk-1/content")

    assert response.status_code == 403


def test_get_chunk_content_allowed_returns_text(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(restapi, "check_datasource_access", _allow(), raising=False)
    restapi.vector_db.client.query.return_value = [
        {"id": "chunk-1", "text": "hello world", "datasource_id": "primary-ds"}
    ]

    client = TestClient(restapi.app, raise_server_exceptions=False)
    response = client.get("/v1/chunk/chunk-1/content")

    assert response.status_code == 200
    assert response.json()["text_content"] == "hello world"


def test_get_chunk_content_resolves_datasource_id_from_chunk_metadata(monkeypatch: pytest.MonkeyPatch):
    calls = []

    async def _spy(user, datasource_id, scope):
        calls.append((datasource_id, scope))

    monkeypatch.setattr(restapi, "check_datasource_access", _spy, raising=False)
    restapi.vector_db.client.query.return_value = [
        {"id": "chunk-1", "text": "hello world", "datasource_id": "primary-ds"}
    ]

    client = TestClient(restapi.app, raise_server_exceptions=False)
    client.get("/v1/chunk/chunk-1/content")

    assert calls == [("primary-ds", "read")]
    _, kwargs = restapi.vector_db.client.query.call_args
    assert "datasource_id" in kwargs["output_fields"]
