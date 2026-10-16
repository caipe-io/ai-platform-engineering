"""Site-page catalogs and complete canvases keep the configured-site/auth boundary."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from mcp_agent_auth import middleware as auth
from starlette.middleware import Middleware
from starlette.testclient import TestClient

from api import SharePointGraphClient, SharePointGraphError
from api.documents import SharePointDocuments
from api.pages import SITE_PAGES_LIBRARY_ID, SITE_PAGES_ROOT_ID
from server import build_server
from tests.test_documents import config


def sample(page_id: str = "page-1") -> dict[str, Any]:
    return {
        "id": page_id, "name": "example.aspx", "title": "Example page", "eTag": "v1",
        "webUrl": "https://example.sharepoint.com/sites/example/SitePages/example.aspx",
        "canvasLayout": {"horizontalSections": [{"columns": [{"webparts": [{"innerHtml": "<h1>Example</h1><p>Page body</p>"}]}]}]},
    }


def transport(calls: list[httpx.Request], *, page: dict[str, Any] | None = None, status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "test-graph-token"})
        if ":/sites/example" in request.url.path:
            return httpx.Response(200, json={"id": "site-1"})
        if request.url.path.endswith("/drives"):
            return httpx.Response(200, json={"value": [{"id": "drive-1", "name": "Documents"}]})
        assert request.url.path.startswith("/v1.0/sites/site-1/pages/")
        if request.url.path == "/v1.0/sites/site-1/pages/microsoft.graph.sitePage":
            if request.url.params.get("$skip"):
                return httpx.Response(200, json={"value": [sample("page-2")]})
            return httpx.Response(200, json={
                "value": [sample()],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/sites/site-1/pages/microsoft.graph.sitePage?$skip=1",
            })
        assert request.url.params["$expand"] == "canvasLayout"
        return httpx.Response(status, json=page if page is not None else sample())
    return httpx.MockTransport(handler)


async def test_complete_page_has_a_versioned_bounded_stream_without_pdf_conversion() -> None:
    calls: list[httpx.Request] = []
    async with httpx.AsyncClient(transport=transport(calls)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        metadata = await documents.manifest(SITE_PAGES_LIBRARY_ID, "page-1")
        assert metadata["format"] == "page"
        assert metadata["version"] == "v1"
        assert metadata["pdf_path"] is None
        async with documents.stream(SITE_PAGES_LIBRARY_ID, "page-1") as stream:
            body = b"".join([chunk async for chunk in stream.body])
            assert len(body) == metadata["size"] == stream.content_length
            assert json.loads(body)["canvasLayout"] == sample()["canvasLayout"]
        with pytest.raises(SharePointGraphError, match="without PDF"):
            async with documents.stream(SITE_PAGES_LIBRARY_ID, "page-1", "pdf"):
                pass
    assert not any("/drives/" in request.url.path for request in calls)


async def test_page_folder_fully_lists_stable_page_ids_and_never_reads_canvases() -> None:
    calls: list[httpx.Request] = []
    async with httpx.AsyncClient(transport=transport(calls)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        preview = await documents.folder_snapshot(SITE_PAGES_LIBRARY_ID, SITE_PAGES_ROOT_ID, select_files=True)
    assert [row["item_id"] for row in preview["documents"]] == ["page-1", "page-2"]
    assert all(row["drive_id"] == SITE_PAGES_LIBRARY_ID and row["version"] == "v1" for row in preview["documents"])
    assert preview["document_count"] == 2
    assert preview["total_size"] == 0
    assert preview["within_limits"]
    assert not any("$expand" in request.url.params for request in calls)
    assert any(request.url.params.get("$skip") == "1" for request in calls)


async def test_page_pagination_accepts_equivalent_encoding_of_the_configured_site_id() -> None:
    site_id = "example.sharepoint.com,site-id,web-id"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "test-token"})
        if ":/sites/example" in request.url.path:
            return httpx.Response(200, json={"id": site_id})
        return httpx.Response(200, json={"value": [sample()],
            "@odata.nextLink": f"https://graph.microsoft.com/v1.0/sites/{site_id}/pages/microsoft.graph.sitePage?$skiptoken=next"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await SharePointDocuments(SharePointGraphClient(config(), http)).pages.list(1, None)
    assert result["next_cursor"] == "token:next"


@pytest.mark.parametrize("link", [
    "https://evil.example/sites/site-1/pages/microsoft.graph.sitePage?$skiptoken=next",
    "https://graph.microsoft.com/v1.0/sites/other-site/pages/microsoft.graph.sitePage?$skiptoken=next",
])
async def test_page_pagination_cannot_escape_the_configured_site(link: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "test-token"})
        if ":/sites/example" in request.url.path:
            return httpx.Response(200, json={"id": "site-1"})
        return httpx.Response(200, json={"value": [], "@odata.nextLink": link})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(SharePointGraphError, match="continuation"):
            await SharePointDocuments(SharePointGraphClient(config(), http)).pages.list(1, None)


@pytest.mark.parametrize("status", [403, 404])
async def test_inaccessible_pages_are_not_replaced_or_rendered(status: int) -> None:
    async with httpx.AsyncClient(transport=transport([], status=status)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        with pytest.raises(SharePointGraphError) as error:
            await documents.manifest(SITE_PAGES_LIBRARY_ID, "page-1")
    assert error.value.status_code == status


@pytest.mark.parametrize("page", [
    {**sample(), "id": "other-page"},
    {**sample(), "canvasLayout": None},
    {**sample(), "canvasLayout": {"horizontalSections@odata.nextLink": "https://example.test/partial"}},
])
async def test_wrong_or_partial_page_canvases_fail_explicitly(page: dict[str, Any]) -> None:
    async with httpx.AsyncClient(transport=transport([], page=page)) as http:
        with pytest.raises(SharePointGraphError, match="canvas"):
            await SharePointDocuments(SharePointGraphClient(config(), http)).manifest(SITE_PAGES_LIBRARY_ID, "page-1")


async def test_page_download_obeys_the_existing_text_byte_limit() -> None:
    page = {**sample(), "description": "x" * 2000}
    async with httpx.AsyncClient(transport=transport([], page=page)) as http:
        with pytest.raises(SharePointGraphError) as error:
            documents = SharePointDocuments(SharePointGraphClient(config(max_download_bytes=1024), http))
            await documents.manifest(SITE_PAGES_LIBRARY_ID, "page-1")
    assert error.value.status_code == 413


def test_page_collection_and_content_routes_require_existing_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "MCP_AUTH_MODE", "shared_key")
    monkeypatch.setattr(auth, "MCP_SHARED_KEY", "page-test-key")
    graph = httpx.AsyncClient(transport=transport([]))
    app = build_server(config(), graph).http_app(middleware=[Middleware(auth.MCPAuthMiddleware)])
    headers = {"Authorization": "Bearer page-test-key"}
    with TestClient(app) as http:
        assert http.get("/documents/site-pages/page-1/content").status_code == 401
        libraries = http.get("/documents/catalog/libraries", headers=headers).json()
        assert libraries["items"][0] == {"id": SITE_PAGES_LIBRARY_ID, "name": "Site pages"}
        root = http.get("/documents/catalog/items?drive_id=site-pages", headers=headers).json()
        assert root["items"] == [{"id": SITE_PAGES_ROOT_ID, "name": "Site pages", "folder": True}]
        pages = http.get("/documents/catalog/items?drive_id=site-pages&folder_item_id=root", headers=headers).json()
        assert pages["items"][0]["supported"]
        assert pages["next_cursor"] == "skip:1"
        assert http.get("/documents/site-pages/page-1/content", headers=headers).status_code == 200
        assert http.get("/documents/site-pages/other/folder", headers=headers).status_code == 404
