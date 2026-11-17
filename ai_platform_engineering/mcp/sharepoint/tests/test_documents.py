# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Document stream security, completeness, site scope, and resource limits."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import AsyncMock

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


@pytest.mark.parametrize("status", [200, 206])
@pytest.mark.parametrize("redirect", [False, True])
async def test_large_csv_header_stream_is_bounded_even_when_range_is_ignored(status: int, redirect: bool) -> None:
    downloaded: list[httpx.Request] = []

    def serve(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content") or request.url.host == "example.sharepoint.com":
            downloaded.append(request)
            assert request.headers["range"] == "bytes=0-65535"
            if redirect and request.url.host == "graph.microsoft.com":
                return httpx.Response(302, headers={"location": "https://example.sharepoint.com/download"})
            if request.url.host != "graph.microsoft.com":
                assert "authorization" not in request.headers
            headers = {"content-range": "bytes 0-65535/9000000"} if status == 206 else {}
            return httpx.Response(status, content=b"h" * (65_536 if status == 206 else 200_000), headers=headers)
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "name": "Large.csv", "size": 9_000_000})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        assert (await documents.manifest("drive-1", "item-1"))["size"] == 9_000_000
        assert (await documents.manifest("drive-1", "item-1", header_only=True))["size"] == 9_000_000
        async with documents.stream("drive-1", "item-1", header_only=True) as stream:
            assert stream.content_length == 65_536
            assert len(b"".join([chunk async for chunk in stream.body])) == 65_536
    assert len(downloaded) == (2 if redirect else 1)


async def test_header_stream_rejects_non_csv_without_downloading() -> None:
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        with pytest.raises(SharePointGraphError) as exc:
            async with documents.stream("drive-1", "item-1", header_only=True):
                pytest.fail("A presentation cannot use CSV header streaming")
        assert exc.value.status_code == 400


async def test_manual_csv_above_100_mib_streams_completely_with_a_separate_text_limit() -> None:
    size = 103 * 1024 * 1024

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            remaining = size
            while remaining:
                chunk = b"x" * min(65_536, remaining)
                remaining -= len(chunk)
                yield chunk

    def serve(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content"):
            assert "range" not in request.headers
            return httpx.Response(200, stream=Body(), headers={"content-length": str(size)})
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "name": "Large.csv", "size": size})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(max_text_document_bytes=1024), http))
        assert (await documents.manifest("drive-1", "item-1"))["size"] == size
        async with documents.stream("drive-1", "item-1") as stream:
            assert stream.content_length == size
            received = 0
            async for chunk in stream.body:
                received += len(chunk)
            assert received == size


async def test_csv_still_enforces_the_configured_general_document_limit() -> None:
    def serve(request: httpx.Request) -> httpx.Response:
        assert not request.url.path.endswith("/content")
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "name": "Large.csv", "size": 2049})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(max_document_bytes=2048), http))
        with pytest.raises(SharePointGraphError) as exc:
            async with documents.stream("drive-1", "item-1"):
                pytest.fail("A CSV cannot bypass the configured document limit")
        assert exc.value.status_code == 413


async def test_header_stream_stops_reading_and_closes_provider_response() -> None:
    class Body(httpx.AsyncByteStream):
        reads = 0
        closed = False

        async def __aiter__(self) -> AsyncIterator[bytes]:
            for _ in range(100):
                self.reads += 1
                yield b"h" * 65_536

        async def aclose(self) -> None:
            self.closed = True

    body = Body()
    def serve(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content"):
            return httpx.Response(200, stream=body)
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "name": "Example.csv", "size": 6_553_600})
        return response
    async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        async with documents.stream("drive-1", "item-1", header_only=True) as stream:
            assert len(b"".join([chunk async for chunk in stream.body])) == 65_536
    assert body.reads == 1 and body.closed


@pytest.mark.parametrize("content_range", ["bytes 1-65535/9000000", "bytes 0-999999/9000000", "bytes 0-3/9000000", "invalid"])
async def test_header_stream_rejects_invalid_partial_responses(content_range: str) -> None:
    def serve(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content"):
            return httpx.Response(206, content=b"header\n", headers={"content-range": content_range})
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "name": "Example.csv"})
        return response
    async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        with pytest.raises(SharePointGraphError) as exc:
            async with documents.stream("drive-1", "item-1", header_only=True):
                pytest.fail("Invalid ranges cannot supply header evidence")
        assert exc.value.code == "invalid_range"


async def test_word_stream_preserves_original_type_and_converts_to_pdf() -> None:
    requests: list[httpx.Request] = []

    def word_handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        response = handler(request)
        if "/items/" in request.url.path and not request.url.path.endswith("/content"):
            return httpx.Response(200, json={**response.json(), "name": "Example.DOCX"})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(word_handler)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        metadata = await documents.manifest("drive-1", "item-1")
        assert metadata["format"] == "docx"
        assert metadata["pdf_path"].endswith("?format=pdf")
        async with documents.stream("drive-1", "item-1") as stream:
            assert stream.content_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            assert b"".join([chunk async for chunk in stream.body]) == b"PK-content"
        async with documents.stream("drive-1", "item-1", "pdf") as stream:
            assert stream.content_type == "application/pdf"
            assert b"".join([chunk async for chunk in stream.body]) == b"%PDF-content"
    downloads = [request for request in requests if request.url.path.endswith("/content")]
    assert len(downloads) == 2
    assert not downloads[0].url.query
    assert downloads[1].url.params["format"] == "pdf"


@pytest.mark.parametrize("name,mime,document_format", [
    ("Example.md", "text/markdown", "md"),
    ("Example.markdown", "application/octet-stream", "md"),
    ("Example.txt", "text/plain", "txt"),
    ("Example.html", "text/html", "html"),
    ("Example.htm", "application/octet-stream", "html"),
    ("Example.JSONL", "application/octet-stream", "jsonl"),
    ("Example.json", "application/json", "json"),
    ("Example.csv", "application/vnd.ms-excel", "csv"),
    ("Example.xml", "application/xml", "xml"),
    ("Example.yaml", "application/octet-stream", "yaml"),
    ("Example.log", "application/octet-stream", "log"),
    ("Example.rst", "text/x-rst", "txt"),
    ("Example.PNG", "application/octet-stream", "png"),
    ("Example.jpg", "image/jpeg", "jpeg"),
    ("Example.jpeg", "application/octet-stream", "jpeg"),
    ("Example.gif", "image/gif", "gif"),
    ("Example.webp", "image/webp", "webp"),
    ("Example.avif", "image/avif", "avif"),
    ("Example.svg", "image/svg+xml", "svg"),
    ("Screenshot", "image/png", "png"),
])
async def test_text_and_images_are_streamed_completely_without_pdf_conversion(name: str, mime: str, document_format: str) -> None:
    content = b"Example body\n"
    calls: list[httpx.Request] = []

    def text_handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path.endswith("/content"):
            assert not request.url.query
            return httpx.Response(200, content=content)
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "name": name, "size": len(content), "file": {"mimeType": mime}})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(text_handler)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        metadata = await documents.manifest("drive-1", "item-1")
        assert metadata["format"] == document_format
        assert metadata["pdf_path"] is None
        assert await read_stream(documents) == content
        with pytest.raises(SharePointGraphError, match="do not require PDF"):
            await read_stream(documents, "pdf")
    assert sum(request.url.path.endswith("/content") for request in calls) == 1


async def test_text_has_an_independent_download_limit() -> None:
    def oversized(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content"):
            return httpx.Response(200, content=b"x" * 1025)
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "name": "Example.txt", "size": 10})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(oversized)) as http:
        with pytest.raises(SharePointGraphError) as error:
            await read_stream(SharePointDocuments(SharePointGraphClient(config(max_text_document_bytes=1024), http)))
    assert error.value.status_code == 413


async def test_text_document_stream_limit_is_independent_of_chat_download_limit() -> None:
    content = b'{"message":"example"}\n' * 300_000
    assert 5 * 1024 * 1024 < len(content) < 8_000_000

    def large_text(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content"):
            return httpx.Response(200, content=content)
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "name": "Events.jsonl", "size": len(content)})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(large_text)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(max_download_bytes=1024), http))
        assert documents.client.config.max_download_bytes == 1024
        assert (await documents.manifest("drive-1", "item-1"))["size"] == len(content)
        assert await read_stream(documents) == content


async def test_image_downloads_use_their_own_limit_and_original_mime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("api.documents.MAX_IMAGE_BYTES", 2048)

    def image_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content"):
            return httpx.Response(200, content=b"x" * 1500)
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "name": "Example.jpg", "size": 1500})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(image_handler)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(max_download_bytes=1024), http))
        assert (await documents.manifest("drive-1", "item-1"))["format"] == "jpeg"
        async with documents.stream("drive-1", "item-1") as stream:
            assert stream.content_type == "image/jpeg"
            assert len(b"".join([chunk async for chunk in stream.body])) == 1500
        monkeypatch.setattr("api.documents.MAX_IMAGE_BYTES", 1024)
        with pytest.raises(SharePointGraphError) as error:
            await documents.manifest("drive-1", "item-1")
        assert error.value.status_code == 413


async def test_image_stream_overflow_is_rejected_even_when_metadata_is_small(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("api.documents.MAX_IMAGE_BYTES", 1024)

    def image_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content"):
            return httpx.Response(200, content=b"x" * 1025)
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "name": "Example.png", "size": 10})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(image_handler)) as http:
        with pytest.raises(SharePointGraphError) as error:
            await read_stream(SharePointDocuments(SharePointGraphClient(config(), http)))
    assert error.value.status_code == 413


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


@pytest.mark.parametrize("extension,mime", [
    ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ("xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"),
    ("xls", "application/vnd.ms-excel"),
])
async def test_workbooks_have_native_streams_and_never_use_pdf_conversion(extension: str, mime: str) -> None:
    def workbook(request: httpx.Request) -> httpx.Response:
        response = handler(request)
        if "/items/" in request.url.path and not request.url.path.endswith("/content"):
            return httpx.Response(200, json={**response.json(), "name": f"Example.{extension.upper()}"})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(workbook)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        manifest = await documents.manifest("drive-1", "item-1")
        assert manifest["format"] == extension and manifest["pdf_path"] is None
        async with documents.stream("drive-1", "item-1") as stream:
            assert stream.content_type == mime
            assert b"".join([chunk async for chunk in stream.body])
        with pytest.raises(SharePointGraphError):
            async with documents.stream("drive-1", "item-1", "pdf"):
                pytest.fail("Workbooks must use native extraction, not PDF conversion")
        assert documents.byte_limit(extension) == 104_857_600
        assert documents.byte_limit("csv") == documents.client.config.max_document_bytes
        assert documents.byte_limit("txt") == documents.client.config.max_text_document_bytes
        assert documents.format_for_item({"name": "Example.csv", "file": {"mimeType": "application/vnd.ms-excel"}}) == "csv"


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


@pytest.mark.parametrize("metadata", [
    {"folder": {}}, {"remoteItem": {}}, {"name": "archive.zip"}, {"name": "Example.doc"},
    {"name": "Example.docm"}, {"name": "Example.xlsb"}, {"size": 4096},
])
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
        if request.url.path.endswith("/root/delta"):
            return httpx.Response(200, json={"value": [
                {"id": "nested-file", "name": "Example.xlsx", "size": 512, "file": {}},
                {"id": "remote-file", "name": "Example.pdf", "file": {}, "remoteItem": {}},
            ]})
        if request.url.path.endswith("/children") or "/search(" in request.url.path:
            assert request.url.params.get("$top") == "50"
            return httpx.Response(
                200,
                json={
                    "value": [
                        {"id": "folder-1", "name": "Example folder", "folder": {}},
                        {"id": "item-1", "name": "Example.pptx", "size": 1024, "file": {}},
                        {"id": "word-file", "name": "Example.docx", "size": 512, "file": {}},
                        {"id": "image-file", "name": "Diagram.png", "size": 512, "file": {}},
                        {"id": "svg-file", "name": "Diagram.svg", "size": 512, "file": {}},
                        {"id": "large-image", "name": "Large.jpg", "size": 20_971_521, "file": {}},
                        {"id": "workbook-file", "name": "Example.xlsx", "size": 512, "file": {}},
                        {"id": "manual-data", "name": "Manual.jsonl", "size": 6_000_000, "file": {}},
                        {"id": "oversized-data", "name": "Large.jsonl", "size": 9_930_000, "file": {}},
                        {"id": "other-file", "name": "Example.xlsb", "file": {}},
                        {"id": "large-csv", "name": "Large.csv", "size": 108_003_328, "file": {}},
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
        assert [row["id"] for row in response.json()["items"]] == [
            "folder-1", "item-1", "word-file", "image-file", "svg-file", "large-image", "workbook-file", "manual-data",
            "oversized-data", "large-csv",
        ]
        assert response.json()["items"][2]["supported"] is True
        assert response.json()["items"][3]["supported"] is True
        assert response.json()["items"][4]["supported"] is True
        assert response.json()["items"][5]["supported"] is False
        assert response.json()["items"][6]["supported"] is True
        assert response.json()["items"][7]["supported"] is True
        assert response.json()["items"][8]["supported"] is False
        assert response.json()["items"][8]["max_bytes"] == 8_000_000
        assert response.json()["items"][9]["supported"] is True
        assert response.json()["items"][9]["max_bytes"] == 2_147_483_648
        assert response.json()["next_cursor"] == "next"
        assert response.headers["cache-control"] == "no-store"
        assert any(request.url.params.get("$skiptoken") == "previous" for request in seen)
        assert http.get("/documents/catalog/items?drive_id=other-drive", headers=headers).status_code == 404
        search = http.get("/documents/catalog/items?drive_id=drive-1&query=Example&limit=50", headers=headers)
        assert search.status_code == 200
        assert search.json()["search_scope"] == "names"
        assert [item["id"] for item in search.json()["items"]] == ["nested-file"]
        assert not any("/search(" in request.url.path for request in seen)
        assert http.get("/documents/catalog/items?drive_id=other-drive&query=Example", headers=headers).status_code == 404
        assert http.get("/documents/catalog/items?drive_id=drive-1&query=Example&cursor=invalid", headers=headers).status_code == 400


def test_catalog_disabled_without_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "MCP_AUTH_MODE", "none")
    with TestClient(build_server(config()).http_app()) as http:
        assert http.get("/documents/catalog/libraries").status_code == 503


def test_search_provider_failure_is_actionable_and_does_not_disable_folder_browsing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "MCP_AUTH_MODE", "shared_key")
    monkeypatch.setattr(auth, "MCP_SHARED_KEY", "catalog-test-key")
    monkeypatch.setattr(
        SharePointGraphClient, "search_drive_item_names",
        AsyncMock(side_effect=SharePointGraphError(500, "generalException", "private provider error")),
    )
    graph_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = build_server(config(), graph_http).http_app(middleware=[Middleware(auth.MCPAuthMiddleware)])
    with TestClient(app) as http:
        headers = {"Authorization": "Bearer catalog-test-key"}
        response = http.get("/documents/catalog/items?drive_id=drive-1&query=example", headers=headers)
        assert response.status_code == 503
        assert response.json()["code"] == "search_unavailable"
        assert "Browse folders" in response.json()["error"]
        assert "private" not in response.text
        assert http.get("/documents/catalog/libraries", headers=headers).status_code == 200
        assert http.get("/documents/catalog/items?drive_id=drive-1", headers=headers).status_code == 200


@pytest.mark.parametrize("failure_type", [httpx.ReadTimeout, httpx.RemoteProtocolError])
async def test_stream_logs_original_cause_without_signed_urls_and_closes_response(
    caplog: pytest.LogCaptureFixture, failure_type: type[httpx.HTTPError],
) -> None:
    class FailingBody(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self) -> AsyncIterator[bytes]:
            yield b"x" * 65_536
            raise failure_type("https://example.sharepoint.com/download?signature=private-token")

        async def aclose(self) -> None:
            self.closed = True

    body = FailingBody()

    def stream_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content"):
            return httpx.Response(200, headers={"Content-Length": "100000"}, stream=body)
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(stream_handler)) as http:
        with pytest.raises(failure_type):
            await read_stream(SharePointDocuments(SharePointGraphClient(config(), http)))
    assert body.closed
    assert "drive=drive-1 item=item-1 format=original operation=content_body" in caplog.text
    assert "bytes_yielded=65536 expected_bytes=100000 elapsed=" in caplog.text
    assert f"exception={failure_type.__name__}" in caplog.text
    assert "private-token" not in caplog.text and "https://" not in caplog.text
    assert "graph-token" not in caplog.text


@pytest.mark.parametrize("name,size", [("Large.csv", 3 * 1024**3), ("Large.xlsx", 101 * 1024**2), ("Large.jsonl", 92_000_000)])
async def test_metadata_only_inspection_does_not_bypass_full_stream_limits(name: str, size: int) -> None:
    def serve(request: httpx.Request) -> httpx.Response:
        assert not request.url.path.endswith("/content")
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "name": name, "size": size})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        assert (await documents.manifest("drive-1", "item-1", metadata_only=True))["size"] == size
        with pytest.raises(SharePointGraphError) as error:
            await read_stream(documents)
        assert error.value.status_code == 413


async def test_csv_header_only_scope_is_allowed_above_the_full_download_cap() -> None:
    def serve(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/content"):
            assert request.headers["range"] == "bytes=0-65535"
            return httpx.Response(200, content=b"header\n" + b"x" * 100_000)
        response = handler(request)
        if "/items/" in request.url.path:
            return httpx.Response(200, json={**response.json(), "name": "Large.csv", "size": 3 * 1024**3})
        return response

    async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as http:
        documents = SharePointDocuments(SharePointGraphClient(config(), http))
        async with documents.stream("drive-1", "item-1", header_only=True) as stream:
            assert len(b"".join([chunk async for chunk in stream.body])) == 65_536


def test_metadata_only_http_inspection_stays_authenticated_and_cannot_download(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth, "MCP_AUTH_MODE", "shared_key")
    monkeypatch.setattr(auth, "MCP_SHARED_KEY", "metadata-test-key")
    graph_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app = build_server(config(), graph_http).http_app(middleware=[Middleware(auth.MCPAuthMiddleware)])
    with TestClient(app) as http:
        assert http.get("/documents/drive-1/item-1/metadata?metadata_only=true").status_code == 401
        headers = {"Authorization": "Bearer metadata-test-key"}
        assert http.get("/documents/drive-1/item-1/metadata?metadata_only=true", headers=headers).status_code == 200
        assert http.get("/documents/drive-1/item-1/metadata?metadata_only=maybe", headers=headers).status_code == 400
        assert http.get("/documents/drive-1/item-1/content?metadata_only=true", headers=headers).status_code == 400
        assert http.get("/documents/other-drive/item-1/metadata?metadata_only=true", headers=headers).status_code == 404
