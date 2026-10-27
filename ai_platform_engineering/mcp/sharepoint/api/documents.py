# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Site-scoped document streams; no signed download URLs leave this service."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Literal
from urllib.parse import parse_qsl, urljoin, urlsplit

import httpx

from api.client import GRAPH_BASE_URL, SharePointGraphClient, SharePointGraphError

DocumentFormat = Literal["original", "pdf"]
DOCUMENT_EXTENSIONS = frozenset({".pptx", ".pdf"})
MAX_FOLDER_DOCUMENTS = 10
MAX_FOLDER_ENTRIES = 1000


@dataclass
class DocumentStream:
    body: AsyncIterator[bytes]
    content_type: str
    content_length: int | None


class SharePointDocuments:
    """Reuse the app token while enforcing site membership and byte limits."""

    def __init__(self, client: SharePointGraphClient) -> None:
        self.client = client
        self._drives: set[str] = set()
        self._drives_expiry = 0.0
        self._drive_lock = asyncio.Lock()
        self._stream_slot = asyncio.Semaphore(2)

    async def _assert_drive(self, drive_id: str) -> None:
        async with self._drive_lock:
            if time.monotonic() >= self._drives_expiry:
                site = self.client._id(await self.client.get_site_id())
                path = f"/sites/{site}/drives"
                params: dict[str, Any] = {"$top": 100, "$select": "id"}
                drives: set[str] = set()
                seen: set[str] = set()
                while True:
                    payload = await self.client._request_json(path, params=params)
                    drives.update(str(row["id"]) for row in payload.get("value", []) if isinstance(row, dict) and row.get("id"))
                    link = payload.get("@odata.nextLink")
                    if not link:
                        break
                    parsed = urlsplit(link)
                    if link in seen or parsed.scheme != "https" or parsed.netloc != "graph.microsoft.com" or parsed.path != f"/v1.0{path}":
                        raise SharePointGraphError(502, "invalid_pagination", "Invalid site-library continuation.")
                    seen.add(link)
                    params = dict(parse_qsl(parsed.query))
                self._drives = drives
                self._drives_expiry = time.monotonic() + 300
        if drive_id not in self._drives:
            raise SharePointGraphError(404, "outside_configured_site", "The document library is not in the configured site.")

    async def manifest(self, drive_id: str, item_id: str) -> dict[str, Any]:
        await self._assert_drive(drive_id)
        metadata = await self.client._request_json(
            f"/drives/{self.client._id(drive_id)}/items/{self.client._id(item_id)}",
            params={"$select": "id,name,size,webUrl,eTag,cTag,lastModifiedDateTime,file,folder,remoteItem"},
        )
        if "folder" in metadata or "remoteItem" in metadata or not isinstance(metadata.get("file"), dict):
            raise SharePointGraphError(415, "unsupported_document", "Choose a file in this site, not a folder or remote shortcut.")
        extension = PurePosixPath(str(metadata.get("name", ""))).suffix.lower()
        if extension not in DOCUMENT_EXTENSIONS:
            raise SharePointGraphError(415, "unsupported_document", "Document preparation currently supports PPTX and PDF files.")
        limit = self.client.config.max_document_bytes
        if isinstance(metadata.get("size"), int) and metadata["size"] > limit:
            raise SharePointGraphError(413, "document_too_large", f"The document exceeds the {limit}-byte streaming limit.")
        base = f"/documents/{self.client._id(drive_id)}/{self.client._id(item_id)}"
        return {
            "drive_id": drive_id,
            "item_id": item_id,
            "name": metadata.get("name"),
            "size": metadata.get("size"),
            "web_url": metadata.get("webUrl"),
            "version": metadata.get("eTag") or metadata.get("cTag") or "",
            "last_modified": metadata.get("lastModifiedDateTime"),
            "format": extension.lstrip("."),
            "original_path": f"{base}/content",
            "pdf_path": f"{base}/content?format=pdf" if extension == ".pptx" else f"{base}/content",
        }

    async def folder_snapshot(self, drive_id: str, item_id: str, *, select_files: bool = False) -> dict[str, Any]:
        """Preview direct children only; never recurse, truncate a valid set, or download files."""
        async with asyncio.timeout(40):
            await self._assert_drive(drive_id)
            folder = await self.client._request_json(
                f"/drives/{self.client._id(drive_id)}/items/{self.client._id(item_id)}",
                params={"$select": "id,name,webUrl,folder,remoteItem"},
            )
            if folder.get("id") != item_id or not isinstance(folder.get("folder"), dict) or "remoteItem" in folder:
                raise SharePointGraphError(415, "unsupported_folder", "Choose a folder in the configured site, not a file or shortcut.")
            documents: list[dict[str, Any]] = []
            count = total_size = child_folders = unsupported = scanned = 0
            cursor: str | None = None
            seen: set[str] = set()
            identities: set[str] = set()
            while True:
                page = await self.client.list_drive_items(drive_id, item_id, 100, cursor)
                scanned += len(page["items"])
                if scanned > MAX_FOLDER_ENTRIES:
                    raise SharePointGraphError(
                        413, "folder_scan_limit",
                        "Folder has too many direct entries to preview safely. Choose a smaller folder (maximum 1000 entries).",
                    )
                for row in page["items"]:
                    identity = row.get("id")
                    if not isinstance(identity, str) or identity in identities:
                        continue
                    identities.add(identity)
                    if "remoteItem" in row:
                        unsupported += 1
                        continue
                    if "folder" in row:
                        child_folders += 1
                        continue
                    extension = PurePosixPath(str(row.get("name", ""))).suffix.lower()
                    if not isinstance(row.get("file"), dict) or extension not in DOCUMENT_EXTENSIONS:
                        unsupported += 1
                        continue
                    size = row.get("size")
                    if type(size) is not int or size < 0:
                        raise SharePointGraphError(
                            502, "invalid_folder_metadata", "Microsoft did not return a valid document size for this folder."
                        )
                    count += 1
                    total_size += size
                    if select_files or count <= MAX_FOLDER_DOCUMENTS:
                        documents.append({
                            "drive_id": drive_id, "item_id": identity,
                            "name": row["name"], "size": size, "web_url": row.get("webUrl"),
                            "version": row.get("eTag") or row.get("cTag") or "",
                        })
                if not page["has_more"]:
                    break
                cursor = page["next_cursor"]
                if not cursor or cursor in seen:
                    raise SharePointGraphError(502, "invalid_pagination", "Invalid folder continuation.")
                seen.add(cursor)
            within_limits = count <= MAX_FOLDER_DOCUMENTS and total_size <= self.client.config.max_document_bytes
            return {
                "folder": {
                    "kind": "folder", "drive_id": drive_id, "item_id": item_id,
                    "name": folder.get("name") or item_id, "web_url": folder.get("webUrl"),
                },
                "documents": documents if select_files or within_limits else [],
                "document_count": count, "total_size": total_size,
                "child_folder_count": child_folders, "unsupported_count": unsupported,
                "within_limits": within_limits,
                "limits": {"max_documents": MAX_FOLDER_DOCUMENTS, "max_total_bytes": self.client.config.max_document_bytes},
            }

    def _valid_download_url(self, url: str) -> bool:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        return (
            parsed.scheme == "https"
            and not parsed.username
            and not parsed.password
            and parsed.port in {None, 443}
            and (
                host == "graph.microsoft.com"
                or host.endswith(".sharepoint.com")
                or host.endswith(".files.1drv.com")
                or host.endswith("-mediap.svc.ms")
            )
        )

    @asynccontextmanager
    async def stream(self, drive_id: str, item_id: str, format: DocumentFormat = "original") -> AsyncIterator[DocumentStream]:
        manifest = await self.manifest(drive_id, item_id)
        if format not in {"original", "pdf"}:
            raise SharePointGraphError(400, "invalid_format", "Choose original or pdf.")
        converted = format == "pdf" and manifest["format"] != "pdf"
        limit = self.client.config.max_rendered_pdf_bytes if converted else self.client.config.max_document_bytes
        path = f"/drives/{self.client._id(drive_id)}/items/{self.client._id(item_id)}/content"
        url = f"{GRAPH_BASE_URL}{path}" + ("?format=pdf" if converted else "")
        owns_client = self.client._http_client is None
        http = self.client._http_client or httpx.AsyncClient(timeout=self.client.config.request_timeout_seconds)
        response: httpx.Response | None = None
        try:
            async with self._stream_slot:
                deadline = time.monotonic() + self.client.config.document_timeout_seconds
                token = await self.client._get_access_token()
                for _ in range(5):
                    headers = {"Accept": "*/*", "Accept-Encoding": "identity"}
                    # Graph tokens must never reach a redirected storage host.
                    if urlsplit(url).netloc == "graph.microsoft.com":
                        headers["Authorization"] = f"Bearer {token}"
                    request = http.build_request("GET", url, headers=headers)
                    response = await asyncio.wait_for(
                        http.send(request, stream=True, follow_redirects=False), max(0, deadline - time.monotonic())
                    )
                    if response.status_code not in {301, 302, 303, 307, 308}:
                        break
                    next_url = urljoin(url, response.headers.get("location", ""))
                    await response.aclose()
                    response = None
                    if not self._valid_download_url(next_url):
                        raise SharePointGraphError(
                            502, "unsafe_redirect", f"Microsoft returned an unsupported download host ({urlsplit(next_url).hostname})."
                        )
                    url = next_url
                else:
                    raise SharePointGraphError(502, "redirect_limit", "Microsoft returned too many download redirects.")

                if response.status_code != 200:
                    # Stream errors are intentionally generic: response URLs may be signed.
                    raise SharePointGraphError(
                        response.status_code,
                        "document_download_failed",
                        f"Document download/conversion failed (HTTP {response.status_code}).",
                    )
                length_header = response.headers.get("content-length")
                length = int(length_header) if length_header and length_header.isdigit() else None
                if length is not None and length > limit:
                    raise SharePointGraphError(413, "document_too_large", f"The download exceeds the {limit}-byte limit.")

                async def chunks() -> AsyncIterator[bytes]:
                    count = 0
                    iterator = response.aiter_bytes(65_536).__aiter__()
                    while True:
                        try:
                            chunk = await asyncio.wait_for(anext(iterator), max(0, deadline - time.monotonic()))
                        except StopAsyncIteration:
                            break
                        count += len(chunk)
                        if count > limit:
                            raise SharePointGraphError(413, "document_too_large", "The document exceeded its streaming byte limit.")
                        yield chunk
                    if length is not None and count != length:
                        raise SharePointGraphError(502, "incomplete_download", "Microsoft returned an incomplete document.")

                yield DocumentStream(
                    chunks(),
                    "application/pdf"
                    if converted or manifest["format"] == "pdf"
                    else "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    length,
                )
        finally:
            if response is not None:
                await response.aclose()
            if owns_client:
                await http.aclose()
