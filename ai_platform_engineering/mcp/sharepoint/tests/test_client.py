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
