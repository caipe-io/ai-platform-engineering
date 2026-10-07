# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Document stream security, completeness, site scope, and resource limits."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from mcp_agent_auth import middleware as auth
from starlette.middleware import Middleware
from starlette.testclient import TestClient

from api import SharePointGraphClient, SharePointGraphError
from api.documents import SharePointDocuments
from models import SharePointConfig
from server import build_server


def config(**kwargs: Any) -> SharePointConfig:
    return SharePointConfig(
        tenant_id="00000000-0000-0000-0000-000000000000",
        client_id="11111111-1111-1111-1111-111111111111",
        client_secret="test-secret",
        site_url="https://example.sharepoint.com/sites/example",
        **kwargs,
    )


def handler(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/token"):
        return httpx.Response(200, json={"access_token": "graph-token"})
    if ":/sites/example" in request.url.path:
        return httpx.Response(200, json={"id": "site-1"})
    if request.url.path.endswith("/drives"):
        return httpx.Response(200, json={"value": [{"id": "drive-1"}]})
    if request.url.path.endswith("/content"):
        return httpx.Response(200, content=b"%PDF-content" if request.url.params.get("format") else b"PK-content")
    return httpx.Response(
        200,
        json={
            "id": "item-1",
            "name": "slides.pptx",
            "size": 10,
            "eTag": "v1",
            "webUrl": "https://example.sharepoint.com/slides",
            "file": {"mimeType": "application/vnd.openxmlformats-officedocument.presentationml.presentation"},
        },
    )


async def read_stream(documents: SharePointDocuments, format: str = "original") -> bytes:
    async with documents.stream("drive-1", "item-1", format) as stream:
        return b"".join([chunk async for chunk in stream.body])


async def test_manifest_is_versioned_and_has_no_provider_download_url() -> None:
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        metadata = await SharePointDocuments(SharePointGraphClient(config(), http)).manifest("drive-1", "item-1")
    assert metadata["version"] == "v1"
    assert metadata["original_path"] == "/documents/drive-1/item-1/content"
    assert metadata["pdf_path"].endswith("?format=pdf")
    assert "graph-token" not in str(metadata)


async def test_drive_outside_site_is_rejected_before_item_access() -> None:
    requests: list[str] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.path)
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(record)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        with pytest.raises(SharePointGraphError, match="not in the configured site"):
            await documents.manifest("other-drive", "item-1")
    assert not any("/items/" in path for path in requests)


async def test_all_library_pages_are_checked() -> None:
    def paginated(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/drives"):
            if request.url.params.get("$skiptoken"):
                return httpx.Response(200, json={"value": [{"id": "drive-1"}]})
            return httpx.Response(
                200,
                json={
                    "value": [{"id": "drive-0"}],
                    "@odata.nextLink": "https://graph.microsoft.com/v1.0/sites/site-1/drives?$skiptoken=second",
                },
            )
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(paginated)) as http:
        result = await SharePointDocuments(SharePointGraphClient(config(), http)).manifest("drive-1", "item-1")
    assert result["item_id"] == "item-1"


@pytest.mark.parametrize("link", ["https://evil.example/sites/site-1/drives", "https://graph.microsoft.com/v1.0/sites/other/drives"])
async def test_library_continuation_cannot_escape_scope(link: str) -> None:
    def bad_link(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/drives"):
            return httpx.Response(200, json={"value": [], "@odata.nextLink": link})
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(bad_link)) as http:
        with pytest.raises(SharePointGraphError, match="continuation"):
            await SharePointDocuments(SharePointGraphClient(config(), http)).manifest("drive-1", "item-1")


async def test_redirect_does_not_forward_graph_token() -> None:
    def redirect(request: httpx.Request) -> httpx.Response:
        if request.url.host == "example.sharepoint.com":
            assert "authorization" not in request.headers
            return httpx.Response(200, content=b"%PDF-valid")
        if request.url.path.endswith("/content"):
            assert request.headers["authorization"] == "Bearer graph-token"
            return httpx.Response(302, headers={"location": "https://example.sharepoint.com/download?temporary=private"})
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(redirect)) as http:
        result = await read_stream(SharePointDocuments(SharePointGraphClient(config(), http)), "pdf")
    assert result == b"%PDF-valid"


async def test_microsoft_media_conversion_host_is_allowed_without_bearer_token() -> None:
    def redirect(request: httpx.Request) -> httpx.Response:
        if request.url.host == "region-mediap.svc.ms":
            assert "authorization" not in request.headers
            return httpx.Response(200, content=b"%PDF-valid")
        if request.url.path.endswith("/content"):
            return httpx.Response(302, headers={"location": "https://region-mediap.svc.ms/transform?temporary=private"})
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(redirect)) as http:
        assert await read_stream(SharePointDocuments(SharePointGraphClient(config(), http)), "pdf") == b"%PDF-valid"


@pytest.mark.parametrize(
    "url",
    [
        "http://example.sharepoint.com/content",
        "https://evil.example/content",
        "https://user@example.sharepoint.com/content",
        "https://example.sharepoint.com:8443/content",
    ],
)
async def test_unsafe_redirect_is_rejected(url: str) -> None:
    def redirect(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content"):
            return httpx.Response(302, headers={"location": url})
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(redirect)) as http:
        with pytest.raises(SharePointGraphError, match="unsupported download host"):
            await read_stream(SharePointDocuments(SharePointGraphClient(config(), http)))


@pytest.mark.parametrize("metadata", [{"folder": {}}, {"remoteItem": {}}, {"name": "archive.zip"}, {"size": 4096}])
async def test_unsupported_or_oversized_items_are_rejected(metadata: dict[str, Any]) -> None:
    def modified(request: httpx.Request) -> httpx.Response:
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), **metadata})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(modified)) as http:
        with pytest.raises(SharePointGraphError):
            await SharePointDocuments(SharePointGraphClient(config(max_document_bytes=1024), http)).manifest("drive-1", "item-1")


async def test_pdf_limit_is_independent_of_text_and_original_limit() -> None:
    def oversized(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content"):
            return httpx.Response(200, content=b"x" * 1025)
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(oversized)) as http:
        with pytest.raises(SharePointGraphError, match="limit"):
            await read_stream(SharePointDocuments(SharePointGraphClient(config(max_rendered_pdf_bytes=1024), http)), "pdf")


async def test_conversion_failure_does_not_expose_signed_url_or_error_body() -> None:
    def denied(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content"):
            return httpx.Response(403, json={"error": {"message": "https://example.sharepoint.com?secret=private"}})
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(denied)) as http:
        with pytest.raises(SharePointGraphError) as exc:
            await read_stream(SharePointDocuments(SharePointGraphClient(config(), http)), "pdf")
    assert "private" not in str(exc.value)
    assert exc.value.status_code == 403


def test_http_documents_are_not_exposed_when_auth_is_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "MCP_AUTH_MODE", "none")
    with TestClient(build_server(config()).http_app()) as http:
        assert http.get("/documents/drive-1/item-1/metadata").status_code == 503


def test_http_documents_use_existing_shared_key_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "MCP_AUTH_MODE", "shared_key")
    monkeypatch.setattr(auth, "MCP_SHARED_KEY", "stream-test-key")
    graph_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = build_server(config(), graph_http).http_app(middleware=[Middleware(auth.MCPAuthMiddleware)])
    with TestClient(app) as http:
        assert http.get("/documents/drive-1/item-1/content").status_code == 401
        response = http.get("/documents/drive-1/item-1/content?format=pdf", headers={"Authorization": "Bearer stream-test-key"})
        assert response.status_code == 200
        assert response.content == b"%PDF-content"
        assert response.headers["cache-control"] == "no-store"
        assert "private" not in str(response.headers)


def test_catalog_is_authenticated_paginated_and_site_scoped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "MCP_AUTH_MODE", "shared_key")
    monkeypatch.setattr(auth, "MCP_SHARED_KEY", "catalog-test-key")
    seen: list[httpx.Request] = []

    def catalog_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/children") or "/search(" in request.url.path:
            assert request.url.params.get("$top") == "50"
            return httpx.Response(
                200,
                json={
                    "value": [
                        {"id": "folder-1", "name": "Example folder", "folder": {}},
                        {"id": "item-1", "name": "Example.pptx", "size": 1024, "file": {}},
                        {"id": "other-file", "name": "Example.docx", "file": {}},
                        {"id": "remote-file", "name": "External.pdf", "file": {}, "remoteItem": {}},
                    ],
                    "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/drive-1/root/children?$skiptoken=next",
                },
            )
        return handler(request)

    graph_http = httpx.AsyncClient(transport=httpx.MockTransport(catalog_handler))
    app = build_server(config(), graph_http).http_app(middleware=[Middleware(auth.MCPAuthMiddleware)])
    with TestClient(app) as http:
        assert http.get("/healthz").status_code == 200
        assert http.get("/documents/catalog/libraries").status_code == 401
        headers = {"Authorization": "Bearer catalog-test-key"}
        response = http.get("/documents/catalog/items?drive_id=drive-1&limit=50&cursor=previous", headers=headers)
        assert response.status_code == 200
        assert [row["id"] for row in response.json()["items"]] == ["folder-1", "item-1"]
        assert response.json()["next_cursor"] == "next"
        assert response.headers["cache-control"] == "no-store"
        assert any(request.url.params.get("$skiptoken") == "previous" for request in seen)
        assert http.get("/documents/catalog/items?drive_id=other-drive", headers=headers).status_code == 404
        assert http.get("/documents/catalog/items?drive_id=drive-1&query=Example&limit=50", headers=headers).status_code == 200


def test_catalog_disabled_without_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "MCP_AUTH_MODE", "none")
    with TestClient(build_server(config()).http_app()) as http:
        assert http.get("/documents/catalog/libraries").status_code == 503
