# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Async Microsoft Graph client scoped to one configured SharePoint site."""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

import httpx

from models import SharePointConfig

GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"
GRAPH_SCOPE = "https://graph.microsoft.com/.default"
TOKEN_EXPIRY_SKEW_SECONDS = 60
TEXT_EXTENSIONS = frozenset({".csv", ".json", ".log", ".md", ".txt", ".xml", ".yaml", ".yml"})
TEXT_CONTENT_TYPES = frozenset(
    {
        "application/csv",
        "application/json",
        "application/xml",
        "application/x-yaml",
        "application/yaml",
    }
)

logger = logging.getLogger(__name__)


class SharePointGraphError(RuntimeError):
    """Sanitized Microsoft Graph or identity-platform failure."""

    def __init__(self, status_code: int, code: str, message: str, request_id: str | None = None) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        self.request_id = request_id
        super().__init__(message)


class SharePointGraphClient:
    """Read-only client for Microsoft Graph SharePoint APIs."""

    def __init__(self, config: SharePointConfig, http_client: httpx.AsyncClient | None = None) -> None:
        self.config = config
        self._http_client = http_client
        self._access_token: str | None = None
        self._access_token_expires_at = 0.0
        self._token_lock = asyncio.Lock()
        self._site_lock = asyncio.Lock()
        self._site_id: str | None = None

    async def _send(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        if self._http_client is not None:
            return await self._http_client.request(method, url, **kwargs)
        async with httpx.AsyncClient(
            timeout=self.config.request_timeout_seconds,
            follow_redirects=True,
        ) as client:
            return await client.request(method, url, **kwargs)

    async def _get_access_token(self, *, force_refresh: bool = False) -> str:
        now = time.monotonic()
        if not force_refresh and self._access_token and now < self._access_token_expires_at:
            return self._access_token

        async with self._token_lock:
            now = time.monotonic()
            if not force_refresh and self._access_token and now < self._access_token_expires_at:
                return self._access_token

            token_url = f"https://login.microsoftonline.com/{self.config.tenant_id}/oauth2/v2.0/token"
            response = await self._send(
                "POST",
                token_url,
                data={
                    "client_id": str(self.config.client_id),
                    "client_secret": self.config.client_secret.get_secret_value(),
                    "scope": GRAPH_SCOPE,
                    "grant_type": "client_credentials",
                },
                headers={"Accept": "application/json"},
            )
            if response.status_code != 200:
                raise SharePointGraphError(
                    response.status_code,
                    "token_request_failed",
                    "Microsoft identity rejected the app-only token request. Verify the tenant, client ID, secret, and admin consent.",
                    response.headers.get("request-id"),
                )

            try:
                payload = response.json()
                access_token = payload["access_token"]
                expires_in = max(int(payload.get("expires_in", 3600)), TOKEN_EXPIRY_SKEW_SECONDS + 1)
            except (KeyError, TypeError, ValueError) as exc:
                raise SharePointGraphError(502, "invalid_token_response", "Microsoft identity returned an invalid token response.") from exc

            self._access_token = str(access_token)
            self._access_token_expires_at = time.monotonic() + expires_in - TOKEN_EXPIRY_SKEW_SECONDS
            return self._access_token

    @staticmethod
    def _graph_error(response: httpx.Response) -> SharePointGraphError:
        code = "graph_request_failed"
        message = f"Microsoft Graph request failed with HTTP {response.status_code}."
        try:
            error = response.json().get("error", {})
            code = str(error.get("code") or code)
            graph_message = str(error.get("message") or "").strip()
            if graph_message:
                message = graph_message[:500]
        except (AttributeError, ValueError):
            pass
        request_id = response.headers.get("request-id") or response.headers.get("client-request-id")
        return SharePointGraphError(response.status_code, code, message, request_id)

    async def _request(self, path: str, *, params: dict[str, Any] | None = None) -> httpx.Response:
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Graph request paths must be relative to the configured v1.0 endpoint")

        for attempt in range(2):
            token = await self._get_access_token(force_refresh=attempt == 1)
            response = await self._send(
                "GET",
                f"{GRAPH_BASE_URL}{path}",
                params=params,
                follow_redirects=True,
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            )
            if response.status_code != 401 or attempt == 1:
                break

        if response.status_code < 200 or response.status_code >= 300:
            error = self._graph_error(response)
            logger.warning(
                "Microsoft Graph request failed: status=%s code=%s request_id=%s",
                error.status_code,
                error.code,
                error.request_id,
            )
            raise error
        return response

    async def _request_json(self, path: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
        response = await self._request(path, params=params)
        try:
            payload = response.json()
        except ValueError as exc:
            raise SharePointGraphError(502, "invalid_graph_response", "Microsoft Graph returned invalid JSON.") from exc
        if not isinstance(payload, dict):
            raise SharePointGraphError(502, "invalid_graph_response", "Microsoft Graph returned an unexpected response shape.")
        return payload

    async def _download_bounded(self, path: str) -> tuple[bytes, str | None]:
        """Stream a download and stop before it can exceed the configured limit."""
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Graph request paths must be relative to the configured v1.0 endpoint")

        for attempt in range(2):
            token = await self._get_access_token(force_refresh=attempt == 1)
            owns_client = self._http_client is None
            client = self._http_client or httpx.AsyncClient(
                timeout=self.config.request_timeout_seconds,
                follow_redirects=True,
            )
            try:
                async with client.stream(
                    "GET",
                    f"{GRAPH_BASE_URL}{path}",
                    follow_redirects=True,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Accept": "*/*",
                        "Range": f"bytes=0-{self.config.max_download_bytes}",
                    },
                ) as response:
                    if response.status_code == 401 and attempt == 0:
                        continue
                    if response.status_code < 200 or response.status_code >= 300:
                        raise self._graph_error(response)

                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > self.config.max_download_bytes:
                            raise SharePointGraphError(
                                413,
                                "file_too_large",
                                "The downloaded file exceeded the configured byte limit.",
                            )
                    return bytes(content), response.headers.get("content-type")
            finally:
                if owns_client:
                    await client.aclose()

        raise SharePointGraphError(401, "invalid_token", "Microsoft Graph rejected the refreshed access token.")

    @staticmethod
    def _next_cursor(payload: dict[str, Any]) -> str | None:
        next_link = payload.get("@odata.nextLink")
        if not isinstance(next_link, str):
            return None
        parsed = urlsplit(next_link)
        if parsed.scheme != "https" or parsed.hostname != "graph.microsoft.com":
            return None
        query = parse_qs(parsed.query)
        for key, values in query.items():
            if key.lower() in {"$skiptoken", "skiptoken", "$skip"} and values:
                return values[0]
        return None

    @staticmethod
    def _page(payload: dict[str, Any]) -> dict[str, Any]:
        items = payload.get("value", [])
        if not isinstance(items, list):
            raise SharePointGraphError(502, "invalid_graph_response", "Microsoft Graph returned an invalid collection.")
        next_cursor = SharePointGraphClient._next_cursor(payload)
        has_more = isinstance(payload.get("@odata.nextLink"), str)
        return {
            "items": items,
            "count": len(items),
            "has_more": has_more,
            "next_cursor": next_cursor,
            "total_count": payload.get("@odata.count"),
        }

    @staticmethod
    def _page_params(limit: int, cursor: str | None, select: str) -> dict[str, Any]:
        params: dict[str, Any] = {"$top": limit, "$select": select}
        if cursor:
            params["$skiptoken"] = cursor
        return params

    @staticmethod
    def _id(value: str) -> str:
        return quote(value, safe="")

    async def get_site(self) -> dict[str, Any]:
        """Resolve and return the configured site."""
        parsed = urlsplit(self.config.site_url)
        path = f"/sites/{quote(parsed.hostname or '', safe='.')}:/{quote(parsed.path.lstrip('/'), safe='/')}"
        return await self._request_json(
            path,
            params={"$select": "id,displayName,name,webUrl,createdDateTime,lastModifiedDateTime"},
        )

    async def get_site_id(self) -> str:
        """Resolve the configured site ID once per process."""
        if self._site_id:
            return self._site_id
        async with self._site_lock:
            if not self._site_id:
                site = await self.get_site()
                site_id = site.get("id")
                if not isinstance(site_id, str) or not site_id:
                    raise SharePointGraphError(502, "invalid_graph_response", "Microsoft Graph did not return a site ID.")
                self._site_id = site_id
        return self._site_id

    async def list_drives(self, limit: int, cursor: str | None) -> dict[str, Any]:
        site_id = self._id(await self.get_site_id())
        payload = await self._request_json(
            f"/sites/{site_id}/drives",
            params=self._page_params(limit, cursor, "id,name,description,driveType,webUrl,createdDateTime,lastModifiedDateTime"),
        )
        return self._page(payload)

    async def list_drive_items(
        self,
        drive_id: str,
        folder_item_id: str | None,
        limit: int,
        cursor: str | None,
    ) -> dict[str, Any]:
        drive = self._id(drive_id)
        parent = f"items/{self._id(folder_item_id)}" if folder_item_id else "root"
        payload = await self._request_json(
            f"/drives/{drive}/{parent}/children",
            params=self._page_params(
                limit,
                cursor,
                "id,name,size,webUrl,createdDateTime,lastModifiedDateTime,file,folder,parentReference",
            ),
        )
        return self._page(payload)

    async def search_drive_items(self, drive_id: str, query: str, limit: int, cursor: str | None) -> dict[str, Any]:
        escaped_query = query.replace("'", "''")
        payload = await self._request_json(
            f"/drives/{self._id(drive_id)}/root/search(q='{quote(escaped_query, safe='')}')",
            params=self._page_params(
                limit,
                cursor,
                "id,name,size,webUrl,createdDateTime,lastModifiedDateTime,file,folder,parentReference",
            ),
        )
        return self._page(payload)

    async def get_drive_item(self, drive_id: str, item_id: str) -> dict[str, Any]:
        return await self._request_json(
            f"/drives/{self._id(drive_id)}/items/{self._id(item_id)}",
            params={"$select": "id,name,size,webUrl,createdDateTime,lastModifiedDateTime,file,folder,parentReference"},
        )

    async def read_text_file(self, drive_id: str, item_id: str, max_characters: int) -> dict[str, Any]:
        metadata = await self.get_drive_item(drive_id, item_id)
        if metadata.get("folder") is not None:
            raise SharePointGraphError(400, "item_is_folder", "The selected drive item is a folder, not a file.")

        size = metadata.get("size")
        if isinstance(size, int) and size > self.config.max_download_bytes:
            raise SharePointGraphError(
                413,
                "file_too_large",
                f"The file is {size} bytes; the configured download limit is {self.config.max_download_bytes} bytes.",
            )

        name = str(metadata.get("name") or "")
        graph_mime_type = str((metadata.get("file") or {}).get("mimeType") or "").lower()
        extension = PurePosixPath(name).suffix.lower()
        if not (graph_mime_type.startswith("text/") or graph_mime_type in TEXT_CONTENT_TYPES or extension in TEXT_EXTENSIONS):
            raise SharePointGraphError(
                415,
                "unsupported_file_type",
                "Only text, Markdown, CSV, JSON, XML, YAML, and log files can be returned as text.",
            )

        content, response_content_type = await self._download_bounded(f"/drives/{self._id(drive_id)}/items/{self._id(item_id)}/content")
        text = content.decode("utf-8", errors="replace")
        truncated = len(text) > max_characters
        return {
            "id": metadata.get("id"),
            "name": name,
            "web_url": metadata.get("webUrl"),
            "mime_type": graph_mime_type or response_content_type,
            "size": size,
            "content": text[:max_characters],
            "truncated": truncated,
            "returned_characters": min(len(text), max_characters),
        }

    async def list_lists(self, limit: int, cursor: str | None) -> dict[str, Any]:
        site_id = self._id(await self.get_site_id())
        payload = await self._request_json(
            f"/sites/{site_id}/lists",
            params=self._page_params(
                limit,
                cursor,
                "id,name,displayName,description,webUrl,createdDateTime,lastModifiedDateTime,list",
            ),
        )
        return self._page(payload)

    async def list_items(
        self,
        list_id: str,
        field_names: list[str] | None,
        limit: int,
        cursor: str | None,
    ) -> dict[str, Any]:
        site_id = self._id(await self.get_site_id())
        params: dict[str, Any] = {"$top": limit, "$select": "id,webUrl,createdDateTime,lastModifiedDateTime"}
        params["$expand"] = f"fields($select={','.join(field_names)})" if field_names else "fields"
        if cursor:
            params["$skiptoken"] = cursor
        payload = await self._request_json(
            f"/sites/{site_id}/lists/{self._id(list_id)}/items",
            params=params,
        )
        return self._page(payload)
