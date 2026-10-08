"""Direct-only folder previews: site scope, pagination, and explicit limits."""
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
    return SharePointConfig(tenant_id="00000000-0000-0000-0000-000000000000",
        client_id="11111111-1111-1111-1111-111111111111", client_secret="test-secret",
        site_url="https://example.sharepoint.com/sites/example", **kwargs)


def file(index: int, size: int = 100) -> dict[str, Any]:
    return {"id": f"file-{index}", "name": f"Document-{index}.pdf", "size": size, "file": {}}


def transport(
    items: list[dict[str, Any]], calls: list[str], *, paginate: bool = False, folder: dict[str, Any] | None = None,
) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        calls.append(path)
        if path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "test-graph-token"})
        if ":/sites/example" in path:
            return httpx.Response(200, json={"id": "site-1"})
        if path.endswith("/drives"):
            return httpx.Response(200, json={"value": [{"id": "drive-1"}]})
        if path.endswith("/children"):
            assert path == "/v1.0/drives/drive-1/items/folder-1/children"
            assert {"eTag", "cTag"}.issubset(request.url.params["$select"].split(","))
            if paginate and not request.url.params.get("$skiptoken"):
                return httpx.Response(200, json={"value": items[:1], "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/drive-1/items/folder-1/children?$skiptoken=second"})
            return httpx.Response(200, json={"value": items[1:] if paginate else items})
        return httpx.Response(200, json=folder if folder is not None else {"id": "folder-1", "name": "Example folder", "folder": {}})
    return httpx.MockTransport(handler)


async def test_lists_all_pages_but_never_descends_into_child_folders() -> None:
    calls: list[str] = []
    items = [file(1), {"id": "child-1", "name": "Nested", "folder": {}},
        {"id": "text-1", "name": "Text.docx", "file": {}}, file(2), {**file(3), "remoteItem": {}}]
    async with httpx.AsyncClient(transport=transport(items, calls, paginate=True)) as http:
        result = await SharePointDocuments(SharePointGraphClient(config(), http)).folder_snapshot("drive-1", "folder-1")
    assert result["document_count"] == 2
    assert result["total_size"] == 200
    assert result["child_folder_count"] == 1
    assert result["unsupported_count"] == 2
    assert result["within_limits"] is True
    assert result["folder"]["kind"] == "folder"
    assert not any("child-1" in path or path.endswith("/content") for path in calls)


@pytest.mark.parametrize("items,limit", [([file(n) for n in range(11)], 2048), ([file(1, 2048)], 1024)])
async def test_over_limit_folder_returns_counts_but_no_partial_set(items: list[dict[str, Any]], limit: int) -> None:
    async with httpx.AsyncClient(transport=transport(items, [])) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(max_document_bytes=limit), http))
        result = await documents.folder_snapshot("drive-1", "folder-1")
    assert result["within_limits"] is False
    assert result["document_count"] == len(items)
    assert result["documents"] == []


async def test_selection_preview_lists_all_500_files_without_downloading() -> None:
    calls: list[str] = []
    items = [file(n) for n in range(500)]
    async with httpx.AsyncClient(transport=transport(items, calls, paginate=True)) as http:
        result = await SharePointDocuments(SharePointGraphClient(config(), http)).folder_snapshot("drive-1", "folder-1", select_files=True)
    assert result["document_count"] == 500
    assert len(result["documents"]) == 500
    assert result["within_limits"] is False
    assert result["limits"]["max_documents"] == 10
    assert not any(path.endswith("/content") for path in calls)


async def test_folder_listing_exposes_graph_versions_for_change_detection() -> None:
    items = [{**file(1), "eTag": "etag-v2", "cTag": "ctag-v1"}, {**file(2), "cTag": "ctag-v3"}]
    async with httpx.AsyncClient(transport=transport(items, [])) as http:
        result = await SharePointDocuments(SharePointGraphClient(config(), http)).folder_snapshot("drive-1", "folder-1", select_files=True)
    assert [row["version"] for row in result["documents"]] == ["etag-v2", "ctag-v3"]


async def test_empty_folder_can_be_attached_for_future_direct_files() -> None:
    async with httpx.AsyncClient(transport=transport([], [])) as http:
        result = await SharePointDocuments(SharePointGraphClient(config(), http)).folder_snapshot("drive-1", "folder-1")
    assert result["within_limits"] is True
    assert result["documents"] == []


async def test_excessive_direct_entries_fail_explicitly() -> None:
    items = [{"id": f"text-{n}", "name": "Note.txt", "file": {}} for n in range(1001)]
    async with httpx.AsyncClient(transport=transport(items, [])) as http:
        with pytest.raises(SharePointGraphError, match="too many direct entries"):
            await SharePointDocuments(SharePointGraphClient(config(), http)).folder_snapshot("drive-1", "folder-1")


@pytest.mark.parametrize("folder", [{"id": "folder-1", "file": {}}, {"id": "folder-1", "folder": {}, "remoteItem": {}}])
async def test_rejects_files_and_shortcuts(folder: dict[str, Any]) -> None:
    async with httpx.AsyncClient(transport=transport([], [], folder=folder)) as http:
        with pytest.raises(SharePointGraphError, match="not a file or shortcut"):
            await SharePointDocuments(SharePointGraphClient(config(), http)).folder_snapshot("drive-1", "folder-1")


def test_folder_route_uses_existing_shared_key_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "MCP_AUTH_MODE", "shared_key")
    monkeypatch.setattr(auth, "MCP_SHARED_KEY", "test-folder-key")
    graph = httpx.AsyncClient(transport=transport([file(1)], []))
    with TestClient(build_server(config(), graph).http_app(middleware=[Middleware(auth.MCPAuthMiddleware)])) as http:
        assert http.get("/documents/drive-1/folder-1/folder").status_code == 401
        result = http.get("/documents/drive-1/folder-1/folder", headers={"Authorization": "Bearer test-folder-key"})
        assert result.status_code == 200
        assert result.json()["document_count"] == 1
        assert result.headers["cache-control"] == "no-store"


def test_selection_route_still_requires_auth_and_lists_over_limit_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "MCP_AUTH_MODE", "shared_key")
    monkeypatch.setattr(auth, "MCP_SHARED_KEY", "test-folder-key")
    graph = httpx.AsyncClient(transport=transport([file(n) for n in range(16)], []))
    with TestClient(build_server(config(), graph).http_app(middleware=[Middleware(auth.MCPAuthMiddleware)])) as http:
        path = "/documents/drive-1/folder-1/folder?select_files=true"
        assert http.get(path).status_code == 401
        result = http.get(path, headers={"Authorization": "Bearer test-folder-key"})
        assert result.status_code == 200
        assert len(result.json()["documents"]) == 16
        assert result.json()["within_limits"] is False
