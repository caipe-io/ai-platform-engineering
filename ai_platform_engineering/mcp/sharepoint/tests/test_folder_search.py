# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Search stays below the selected folder across traversal and pagination."""

import base64
import json
from urllib.parse import quote

import httpx
import pytest
from mcp_agent_auth import middleware as auth
from starlette.middleware import Middleware
from starlette.testclient import TestClient

from api import SharePointGraphClient, SharePointGraphError
from server import build_server
from tests.test_documents import config, handler


def tree_handler(seen: list[httpx.Request]):
    def serve(request: httpx.Request) -> httpx.Response:
        if "/children" not in request.url.path:
            assert not request.url.path.endswith("/delta"), "A scoped search must not scan the library root"
            return handler(request)
        seen.append(request)
        folder = request.url.path.split("/")[-2]
        token = request.url.params.get("$skiptoken")
        if folder == "archive":
            assert token is None
            # Nested folders are searched even when their names do not match.
            rows = [{"id": "nested", "name": "Projects", "folder": {}},
                    {"id": "direct", "name": "Overview.docx", "size": 1, "file": {}},
                    {"id": "shortcut", "name": "Overview outside", "folder": {}, "remoteItem": {}}]
        elif folder == "nested" and token is None:
            return httpx.Response(200, json={"value": [
                {"id": "deep", "name": "Overview folder", "folder": {}},
                {"id": "removed", "name": "Overview.docx", "file": {}, "deleted": {}},
            ], "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/drive-1/items/nested/children?$skiptoken=second"})
        elif folder == "nested":
            assert token == "second"
            rows = [{"id": "last", "name": "Overview.xlsx", "size": 1, "file": {}}]
        else:
            assert folder == "deep"
            rows = [{"id": "inside", "name": "Overview.csv", "size": 1, "file": {}}]
        return httpx.Response(200, json={"value": rows})
    return serve


@pytest.mark.asyncio
async def test_scoped_search_finds_only_archive_descendants_and_retains_their_breadcrumbs() -> None:
    seen = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(tree_handler(seen))) as http:
        client = SharePointGraphClient(config(), http)
        result = await client.search_drive_item_names("drive-1", "overview", 50, None, folder_item_id="archive")
    assert [row["id"] for row in result["items"]] == ["deep", "inside", "last", "direct"]
    assert result["items"][0]["search_parent_folders"] == [{"id": "nested", "name": "Projects"}]
    assert result["items"][1]["search_parent_folders"] == [{"id": "nested", "name": "Projects"}, {"id": "deep", "name": "Overview folder"}]
    assert result["has_more"] is False and result["next_cursor"] is None
    assert len(seen) == 4


@pytest.mark.asyncio
async def test_scoped_search_cursor_preserves_root_query_page_size_and_position_without_state() -> None:
    seen = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(tree_handler(seen))) as http:
        client = SharePointGraphClient(config(), http)
        # Every provider page has at most three entries.
        first = await client.search_drive_item_names("drive-1", "overview", 3, None, folder_item_id="archive")
        assert [row["id"] for row in first["items"]] == ["deep", "inside", "last"]
        assert first["has_more"] and first["next_cursor"]
        for drive, folder, query, limit in [("drive-2", "archive", "overview", 3), ("drive-1", "sibling", "overview", 3),
                ("drive-1", "archive", "different", 3), ("drive-1", "archive", "overview", 4), ("drive-1", None, "overview", 3)]:
            with pytest.raises(ValueError, match="cursor"):
                await client.search_drive_item_names(drive, query, limit, first["next_cursor"], folder_item_id=folder)
        calls = len(seen)
        encoded, signature = first["next_cursor"].split(".")
        data = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        data["stack"][-1]["id"] = "sibling"
        forged = base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=") + "." + signature
        with pytest.raises(ValueError, match="cursor"):
            await client.search_drive_item_names("drive-1", "overview", 3, forged, folder_item_id="archive")
        assert len(seen) == calls
        # Continuation works in another client/worker, with no server-side catalog state.
        last = await SharePointGraphClient(config(), http).search_drive_item_names(
            "drive-1", "OVERVIEW", 3, first["next_cursor"], folder_item_id="archive",
        )
        assert [row["id"] for row in last["items"]] == ["direct"] and not last["has_more"]


@pytest.mark.asyncio
async def test_sparse_folder_search_retains_progress_after_five_pages() -> None:
    seen = []
    def serve(request: httpx.Request) -> httpx.Response:
        if not request.url.path.endswith("/children"):
            return handler(request)
        seen.append(request)
        assert request.url.path.endswith("/items/archive/children")
        index = int(request.url.params.get("$skiptoken", "1"))
        if index == 6:
            return httpx.Response(200, json={"value": [{"id": "target", "name": "Target.docx", "file": {}}]})
        return httpx.Response(200, json={"value": [{"id": str(index), "name": "Other.txt", "file": {}}],
            "@odata.nextLink": f"https://graph.microsoft.com/v1.0/drives/drive-1/items/archive/children?$skiptoken={index+1}"})
    async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as http:
        client = SharePointGraphClient(config(), http)
        first = await client.search_drive_item_names("drive-1", "target", 50, None, folder_item_id="archive")
        assert first["items"] == [] and first["has_more"] and len(seen) == 5
        last = await client.search_drive_item_names("drive-1", "target", 50, first["next_cursor"], folder_item_id="archive")
        assert [row["id"] for row in last["items"]] == ["target"] and not last["has_more"] and len(seen) == 6


@pytest.mark.asyncio
@pytest.mark.parametrize("next_link", [
    "https://graph.microsoft.com/v1.0/drives/drive-1/root/children?$skiptoken=next",
    "https://graph.microsoft.com/v1.0/drives/drive-1/items/sibling/children?$skiptoken=next",
    "https://example.test/v1.0/drives/drive-1/items/archive/children?$skiptoken=next",
    "https://graph.microsoft.com/v1.0/drives/drive-1/items/archive/children?$skiptoken=one&$skiptoken=two",
])
async def test_scoped_search_rejects_continuations_that_escape_the_folder(next_link: str) -> None:
    def serve(request: httpx.Request) -> httpx.Response:
        if not request.url.path.endswith("/children"):
            return handler(request)
        return httpx.Response(200, json={"value": [], "@odata.nextLink": next_link})
    async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as http:
        with pytest.raises(SharePointGraphError, match="continuation"):
            await SharePointGraphClient(config(), http).search_drive_item_names("drive-1", "target", 50, None, folder_item_id="archive")


def test_catalog_keeps_selected_folder_scope_and_cannot_reuse_its_cursor_elsewhere(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "MCP_AUTH_MODE", "shared_key")
    monkeypatch.setattr(auth, "MCP_SHARED_KEY", "folder-search-key")
    seen = []
    graph_http = httpx.AsyncClient(transport=httpx.MockTransport(tree_handler(seen)))
    app = build_server(config(), graph_http).http_app(middleware=[Middleware(auth.MCPAuthMiddleware)])
    with TestClient(app) as http:
        headers = {"Authorization": "Bearer folder-search-key"}
        route = "/documents/catalog/items?drive_id=drive-1&folder_item_id=archive&query=overview&limit=3"
        assert http.get(route).status_code == 401
        first = http.get(route, headers=headers)
        assert first.status_code == 200
        assert [row["id"] for row in first.json()["items"]] == ["deep", "inside", "last"]
        assert first.json()["items"][0]["search_parent_folders"] == [{"id": "nested", "name": "Projects"}]
        cursor = quote(first.json()["next_cursor"], safe="")
        assert http.get(route.replace("archive", "sibling") + "&cursor=" + cursor, headers=headers).status_code == 400
        assert http.get(route.replace("drive-1", "other-drive"), headers=headers).status_code == 404
        last = http.get(route + "&cursor=" + cursor, headers=headers)
        assert last.status_code == 200 and [row["id"] for row in last.json()["items"]] == ["direct"]
        assert http.get(route.replace("archive", ".."), headers=headers).status_code == 400
