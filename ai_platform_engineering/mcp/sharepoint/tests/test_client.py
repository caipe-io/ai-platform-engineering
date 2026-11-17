# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Microsoft Graph client tests with an in-memory HTTP transport."""

from __future__ import annotations

from collections import Counter
from urllib.parse import parse_qs

import httpx
import pytest

from api import SharePointGraphClient, SharePointGraphError
from models import SharePointConfig


def _config(**overrides: object) -> SharePointConfig:
    values: dict[str, object] = {
        "tenant_id": "00000000-0000-0000-0000-000000000000",
        "client_id": "11111111-1111-1111-1111-111111111111",
        "client_secret": "unit-test-secret",
        "site_url": "https://example.sharepoint.com/sites/example",
    }
    values.update(overrides)
    return SharePointConfig(**values)


@pytest.mark.asyncio
async def test_token_is_cached_and_site_is_scoped() -> None:
    calls: Counter[str] = Counter()

    async def handler(request: httpx.Request) -> httpx.Response:
        calls[request.url.path] += 1
        if request.url.path.endswith("/oauth2/v2.0/token"):
            form = parse_qs(request.content.decode())
            assert form["grant_type"] == ["client_credentials"]
            assert form["scope"] == ["https://graph.microsoft.com/.default"]
            return httpx.Response(200, json={"access_token": "token", "expires_in": 3600})
        assert request.headers["authorization"] == "Bearer token"
        assert request.url.path == "/v1.0/sites/example.sharepoint.com:/sites/example"
        return httpx.Response(
            200,
            json={"id": "example.sharepoint.com,site,web", "displayName": "Example", "webUrl": _config().site_url},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = SharePointGraphClient(_config(), http_client=http_client)
        await client.get_site()
        await client.get_site()

    assert calls["/00000000-0000-0000-0000-000000000000/oauth2/v2.0/token"] == 1


@pytest.mark.asyncio
async def test_collection_cursor_is_returned_and_reused() -> None:
    seen_queries: list[dict[str, list[str]]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/v2.0/token"):
            return httpx.Response(200, json={"access_token": "token", "expires_in": 3600})
        if ":/sites/example" in request.url.path:
            return httpx.Response(200, json={"id": "example.sharepoint.com,site,web"})
        seen_queries.append(parse_qs(request.url.query.decode()))
        return httpx.Response(
            200,
            json={
                "value": [{"id": "drive-1", "name": "Documents"}],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/sites/site/drives?$skiptoken=cursor-2",
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = SharePointGraphClient(_config(), http_client=http_client)
        first_page = await client.list_drives(10, None)
        second_page = await client.list_drives(10, first_page["next_cursor"])

    assert first_page["has_more"] is True
    assert first_page["next_cursor"] == "cursor-2"
    assert second_page["count"] == 1
    assert seen_queries[1]["$skiptoken"] == ["cursor-2"]


@pytest.mark.asyncio
async def test_text_file_read_is_bounded() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/v2.0/token"):
            return httpx.Response(200, json={"access_token": "token", "expires_in": 3600})
        if request.url.path.endswith("/content"):
            return httpx.Response(200, content=b"abcdefghij", headers={"content-type": "text/plain; charset=utf-8"})
        return httpx.Response(
            200,
            json={"id": "item-1", "name": "notes.txt", "size": 10, "file": {"mimeType": "text/plain"}},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = SharePointGraphClient(_config(), http_client=http_client)
        result = await client.read_text_file("drive-1", "item-1", max_characters=5)

    assert result["content"] == "abcde"
    assert result["truncated"] is True
    assert result["returned_characters"] == 5


@pytest.mark.parametrize("name,mime", [("Example.jsonl", "application/octet-stream"), ("Example.html", "text/html")])
async def test_existing_text_reader_accepts_html_and_jsonl(name: str, mime: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "test-token"})
        if request.url.path.endswith("/content"):
            return httpx.Response(200, content=b'{"example":true}\n')
        return httpx.Response(200, json={"id": "item-1", "name": name, "size": 17, "file": {"mimeType": mime}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await SharePointGraphClient(_config(), http).read_text_file("drive-1", "item-1", 1000)
    assert result["content"] == '{"example":true}\n'
    assert result["truncated"] is False


@pytest.mark.asyncio
async def test_text_file_download_stops_at_byte_limit() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/v2.0/token"):
            return httpx.Response(200, json={"access_token": "token", "expires_in": 3600})
        if request.url.path.endswith("/content"):
            assert request.headers["range"] == "bytes=0-1024"
            return httpx.Response(200, content=b"x" * 1_025, headers={"content-type": "text/plain"})
        return httpx.Response(
            200,
            json={"id": "item-1", "name": "notes.txt", "file": {"mimeType": "text/plain"}},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = SharePointGraphClient(_config(max_download_bytes=1_024), http_client=http_client)
        with pytest.raises(SharePointGraphError, match="exceeded") as exc_info:
            await client.read_text_file("drive-1", "item-1", max_characters=5_000)

    assert exc_info.value.status_code == 413


@pytest.mark.asyncio
async def test_binary_file_is_rejected_before_download() -> None:
    paths: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path.endswith("/oauth2/v2.0/token"):
            return httpx.Response(200, json={"access_token": "token", "expires_in": 3600})
        return httpx.Response(
            200,
            json={"id": "item-1", "name": "archive.zip", "size": 100, "file": {"mimeType": "application/zip"}},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = SharePointGraphClient(_config(), http_client=http_client)
        with pytest.raises(SharePointGraphError, match="Only text") as exc_info:
            await client.read_text_file("drive-1", "item-1", max_characters=5_000)

    assert exc_info.value.status_code == 415
    assert not any(path.endswith("/content") for path in paths)


@pytest.mark.asyncio
async def test_token_error_does_not_expose_secret() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid_client", "error_description": "rejected"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = SharePointGraphClient(_config(), http_client=http_client)
        with pytest.raises(SharePointGraphError) as exc_info:
            await client.get_site()

    assert "unit-test-secret" not in str(exc_info.value)


@pytest.mark.asyncio
async def test_filename_search_reads_nested_metadata_and_resumes_without_indexed_search() -> None:
    tokens: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "token"})
        assert request.url.path == "/v1.0/drives/drive-1/root/delta"
        assert request.url.params["$top"] == "50"
        token = request.url.params.get("token")
        tokens.append(token)
        if token is None:
            rows = [{"id": "unrelated", "name": "Notes.txt", "file": {}}]
            next_token = "page-2"
        elif token == "page-2":
            rows = [
                {"id": "nested", "name": "BÜDGET.xlsx", "file": {}, "parentReference": {"id": "nested-folder"}},
                {"id": "folder", "name": "Büdget reports", "folder": {}},
                {"id": "deleted", "name": "Büdget.txt", "file": {}, "deleted": {}},
                {"id": "shortcut", "name": "Büdget.txt", "file": {}, "remoteItem": {}},
                {"id": "root", "name": "Büdget", "folder": {}, "root": {}},
            ]
            next_token = "page-3"
        else:
            assert token == "page-3"
            return httpx.Response(200, json={"value": [{"id": "final", "name": "Büdget.csv", "file": {}}]})
        return httpx.Response(200, json={
            "value": rows, "@odata.nextLink": f"https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token={next_token}",
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = SharePointGraphClient(_config(), http)
        first = await client.search_drive_item_names("drive-1", "büdget", 50, None)
        assert [row["id"] for row in first["items"]] == ["nested", "folder"]
        assert first["has_more"] is True
        assert first["search_scope"] == "names"
        for drive, query in [("other-drive", "büdget"), ("drive-1", "unrelated")]:
            with pytest.raises(ValueError, match="cursor"):
                await client.search_drive_item_names(drive, query, 50, first["next_cursor"])
        assert tokens == [None, "page-2"]
        last = await client.search_drive_item_names("drive-1", "BÜDGET", 50, first["next_cursor"])
        assert [row["id"] for row in last["items"]] == ["final"]
        assert last["has_more"] is False
        assert last["next_cursor"] is None
    assert tokens == [None, "page-2", "page-3"]


@pytest.mark.asyncio
async def test_sparse_filename_search_is_bounded_and_empty_pages_keep_the_continuation() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "token"})
        calls += 1
        index = int(request.url.params.get("token", "1"))
        if index == 6:
            return httpx.Response(200, json={"value": [{"id": "found", "name": "Target.xlsx", "file": {}}]})
        return httpx.Response(200, json={
            "value": [{"id": str(index), "name": "Other.txt", "file": {}}],
            "@odata.nextLink": f"https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token={index + 1}",
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = SharePointGraphClient(_config(), http)
        first = await client.search_drive_item_names("drive-1", "target", 50, None)
        assert calls == 5
        assert first["items"] == []
        assert first["has_more"] is True
        last = await client.search_drive_item_names("drive-1", "target", 50, first["next_cursor"])
        assert last["items"][0]["id"] == "found"
        assert last["has_more"] is False
        assert calls == 6


@pytest.mark.asyncio
@pytest.mark.parametrize("next_link", [
    "https://example.test/v1.0/drives/drive-1/root/delta?token=next",
    "https://graph.microsoft.com/v1.0/drives/other-drive/root/delta?token=next",
    "https://graph.microsoft.com/v1.0/drives/drive-1/root/children?token=next",
    "http://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=next",
    "https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=first&token=second",
    "https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?$skiptoken=next",
    "https://graph.microsoft.com:443/v1.0/drives/drive-1/root/delta?token=next",
    "https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=next#fragment",
    "https://[",
    123,
])
async def test_filename_search_rejects_invalid_provider_continuations(next_link: object) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "token"})
        return httpx.Response(200, json={"value": [], "@odata.nextLink": next_link})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(SharePointGraphError, match="continuation") as exc:
            await SharePointGraphClient(_config(), http).search_drive_item_names("drive-1", "target", 50, None)
        assert exc.value.status_code == 502


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [403, 429, 500])
async def test_filename_search_propagates_provider_failures(status: int) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "token"})
        return httpx.Response(status, json={"error": {"code": "provider_failure"}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(SharePointGraphError) as exc:
            await SharePointGraphClient(_config(), http).search_drive_item_names("drive-1", "target", 50, None)
        assert exc.value.status_code == status
