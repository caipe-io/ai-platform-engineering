# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Configured-site pages exposed as a selectable collection, without a site crawl."""

from __future__ import annotations

import hashlib
import json
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from api.client import SharePointGraphClient, SharePointGraphError

# This reserved collection keeps stable page IDs in the existing source contract.
# It is never passed to Graph as a drive ID; the configured site owns every call.
SITE_PAGES_LIBRARY_ID = "site-pages"
SITE_PAGES_ROOT_ID = "root"
PAGE_FIELDS = "id,name,title,description,webUrl,eTag,lastModifiedDateTime"


def page_version(page: dict[str, Any]) -> str:
    tag = page.get("eTag") or page.get("@odata.etag")
    if isinstance(tag, str) and tag:
        return tag
    # Listing versions are hints only. Preparation fingerprints the complete
    # canvas when Graph supplies no tag, and rechecks it before publishing.
    return str(page.get("lastModifiedDateTime") or "")


class SharePointPages:
    def __init__(self, client: SharePointGraphClient) -> None:
        self.client = client

    async def list(self, limit: int, cursor: str | None, query: str = "") -> dict[str, Any]:
        site = self.client._id(await self.client.get_site_id())
        path = f"/sites/{site}/pages/microsoft.graph.sitePage"
        params = self.client._page_params(limit, None, PAGE_FIELDS)
        if cursor:
            if cursor.startswith("skip:"):
                offset = cursor.removeprefix("skip:")
                if not offset.isdecimal():
                    raise SharePointGraphError(400, "invalid_pagination", "Invalid site-page offset.")
                params["$skip"] = offset
            else:
                params["$skiptoken"] = cursor.removeprefix("token:")
        payload = await self.client._request_json(path, params=params)
        link = payload.get("@odata.nextLink")
        if link:
            self._validate_continuation(link, path)
        page = self.client._page(payload)
        if link:
            query_params = parse_qs(urlsplit(link).query)
            if query_params.get("$skiptoken"):
                page["next_cursor"] = "token:" + query_params["$skiptoken"][0]
            elif query_params.get("$skip") and query_params["$skip"][0].isdecimal():
                page["next_cursor"] = "skip:" + query_params["$skip"][0]
            else:
                page["next_cursor"] = None
        if page["has_more"] and not page["next_cursor"]:
            raise SharePointGraphError(502, "invalid_pagination", "Invalid site-page continuation.")
        items = []
        for row in page["items"]:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str):
                raise SharePointGraphError(502, "invalid_page_metadata", "Microsoft returned invalid site-page metadata.")
            name = row.get("title") or row.get("name") or row["id"]
            if query and query.casefold() not in f"{name} {row.get('name', '')}".casefold():
                continue
            items.append({
                "id": row["id"], "name": name, "webUrl": row.get("webUrl"),
                # Graph does not expose canvas byte sizes in page listings.
                # Each complete canvas is bounded when its metadata/content is read.
                "size": 0, "folder": False, "supported": True, "version": page_version(row),
            })
        return {**page, "items": items, "count": len(items)}

    @staticmethod
    def _validate_continuation(link: str, path: str) -> None:
        parsed = urlsplit(link)
        if (
            parsed.scheme != "https" or parsed.netloc != "graph.microsoft.com"
            or unquote(parsed.path) != f"/v1.0{unquote(path)}"
        ):
            raise SharePointGraphError(502, "invalid_pagination", "Invalid site-page continuation.")

    async def read(self, page_id: str) -> tuple[dict[str, Any], bytes]:
        if page_id in {".", ".."}:
            raise SharePointGraphError(400, "invalid_page_id", "Choose a valid site-page ID.")
        site = self.client._id(await self.client.get_site_id())
        raw, _ = await self.client._download_bounded(
            f"/sites/{site}/pages/{self.client._id(page_id)}/microsoft.graph.sitePage",
            params={"$select": PAGE_FIELDS + ",canvasLayout", "$expand": "canvasLayout"},
            follow_redirects=False,
        )
        try:
            page = json.loads(raw)
        except (ValueError, RecursionError) as exc:
            raise SharePointGraphError(502, "invalid_page_content", "Microsoft returned invalid site-page JSON.") from exc
        if not isinstance(page, dict) or page.get("id") != page_id or not isinstance(page.get("canvasLayout"), dict):
            raise SharePointGraphError(502, "invalid_page_content", "Microsoft did not return this page's complete canvas.")
        pending: list[Any] = [page["canvasLayout"]]
        while pending:
            value = pending.pop()
            if isinstance(value, dict):
                if any(key.endswith("@odata.nextLink") for key in value):
                    raise SharePointGraphError(502, "invalid_page_content", "Microsoft returned a partial page canvas.")
                pending.extend(value.values())
            elif isinstance(value, list):
                pending.extend(value)
        content = json.dumps(page, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        limit = min(self.client.config.max_download_bytes, self.client.config.max_document_bytes)
        if len(content) > limit:
            raise SharePointGraphError(413, "document_too_large", "The site page exceeds the configured text-file byte limit.")
        base = f"/documents/{SITE_PAGES_LIBRARY_ID}/{self.client._id(page_id)}"
        return {
            "drive_id": SITE_PAGES_LIBRARY_ID, "item_id": page_id,
            "name": page.get("title") or page.get("name") or page_id,
            "size": len(content), "web_url": page.get("webUrl"),
            "version": page_version(page) or "sha256:" + hashlib.sha256(content).hexdigest(),
            "last_modified": page.get("lastModifiedDateTime"), "format": "page",
            "original_path": f"{base}/content", "pdf_path": None,
        }, content
