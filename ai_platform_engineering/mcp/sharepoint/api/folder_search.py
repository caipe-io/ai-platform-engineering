# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Bounded, stateless filename search below one selected folder."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, unquote, urlsplit

from api.client import SharePointGraphError

if TYPE_CHECKING:
    from api.client import SharePointGraphClient


async def search_folder_names(
    client: SharePointGraphClient, drive_id: str, folder_id: str, query: str, limit: int, cursor: str | None,
) -> dict[str, Any]:
    """Walk only children of the selected folder, including its descendants.

    The signed cursor keeps a depth-first traversal position, not a saved source
    or synchronization checkpoint. It cannot introduce a different search root.
    Each response reads at most five metadata pages; no file bodies are read.
    """
    scope = hashlib.sha256(json.dumps([drive_id, folder_id, query.casefold(), limit]).encode()).hexdigest()
    key = client.config.client_secret.get_secret_value().encode()
    stack = [{"id": folder_id, "name": "", "paging": None, "offset": 0}]
    if cursor:
        try:
            encoded, signature = cursor.split(".")
            raw = base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True)
            if len(cursor) > 4096 or not hmac.compare_digest(signature, hmac.new(key, raw, hashlib.sha256).hexdigest()):
                raise ValueError
            state = json.loads(raw)
            if state["v"] != 1 or state["scope"] != scope or not state["stack"] or state["stack"][0]["id"] != folder_id:
                raise ValueError
            stack = state["stack"]
        except (ValueError, KeyError, TypeError, UnicodeError) as exc:
            raise ValueError("Invalid folder search cursor. Start the search again.") from exc

    def next_page(payload: dict[str, Any], path: str, paging: list[str] | None) -> list[str] | None:
        link = payload.get("@odata.nextLink")
        if link is None:
            return None
        try:
            parsed = urlsplit(link) if isinstance(link, str) else None
            params = parse_qs(parsed.query) if parsed else {}
            tokens = [(name, value) for name, values in params.items()
                if name.casefold() in {"$skiptoken", "skiptoken", "$skip"} for value in values]
            if (parsed is None or parsed.scheme != "https" or parsed.netloc != "graph.microsoft.com" or parsed.fragment
                or unquote(parsed.path) != unquote(f"/v1.0{path}") or len(tokens) != 1 or not tokens[0][1]
                or list(tokens[0]) == paging):
                raise ValueError
        except ValueError as exc:
            raise SharePointGraphError(502, "invalid_graph_response", "Microsoft Graph returned an invalid folder continuation.") from exc
        return list(tokens[0])

    matches = []
    pages: dict[str, tuple[list[dict[str, Any]], list[str] | None]] = {}
    while stack and len(matches) < limit:
        frame = stack[-1]
        page_key = json.dumps([frame["id"], frame["paging"]])
        if page_key not in pages:
            if len(pages) >= 5:
                break
            path = f"/drives/{client._id(drive_id)}/items/{client._id(frame['id'])}/children"
            params: dict[str, Any] = {"$top": limit, "$select": "id,name,size,webUrl,file,folder,parentReference,remoteItem,deleted"}
            if frame["paging"]:
                params[frame["paging"][0]] = frame["paging"][1]
            payload = await client._request_json(path, params=params)
            rows = payload.get("value")
            if not isinstance(rows, list) or len(rows) > limit or any(not isinstance(row, dict) for row in rows):
                raise SharePointGraphError(502, "invalid_graph_response", "Microsoft Graph returned an invalid folder metadata page.")
            pages[page_key] = rows, next_page(payload, path, frame["paging"])
        rows, following = pages[page_key]
        if frame["offset"] > len(rows):
            raise ValueError("The folder changed during search. Start the search again.")
        if frame["offset"] == len(rows):
            if following:
                frame.update(paging=following, offset=0)
                if json.dumps([frame["id"], following]) in pages:
                    raise SharePointGraphError(502, "invalid_graph_response", "Microsoft Graph repeated a folder continuation.")
            else:
                stack.pop()
            continue
        row = rows[frame["offset"]]
        frame["offset"] += 1
        if any(facet in row for facet in ("remoteItem", "deleted", "root")) or not ("file" in row or "folder" in row):
            continue
        if query.casefold() in str(row.get("name") or "").casefold():
            matches.append({**row, "search_parent_folders": [{"id": parent["id"], "name": parent["name"]} for parent in stack[1:]]})
        if "folder" in row:
            item_id = row.get("id")
            if not isinstance(item_id, str) or not item_id or item_id in {parent["id"] for parent in stack} or len(stack) >= 50:
                raise SharePointGraphError(502, "invalid_graph_response", "Microsoft Graph returned an invalid folder hierarchy.")
            stack.append({"id": item_id, "name": str(row.get("name") or item_id), "paging": None, "offset": 0})
    # Exhaust cached parent pages without an extra empty continuation at the end.
    while stack:
        frame = stack[-1]
        page = pages.get(json.dumps([frame["id"], frame["paging"]]))
        if page is None or frame["offset"] < len(page[0]) or page[1]:
            break
        stack.pop()
    continuation = None
    if stack:
        raw = json.dumps({"v": 1, "scope": scope, "stack": stack}, separators=(",", ":")).encode()
        continuation = base64.urlsafe_b64encode(raw).decode().rstrip("=") + "." + hmac.new(key, raw, hashlib.sha256).hexdigest()
        if len(continuation) > 4096:
            raise SharePointGraphError(
                502, "search_scope_limit", "Folder search is too deep to continue. Browse into a subfolder and search there.",
            )
    return {"items": matches, "has_more": bool(stack), "next_cursor": continuation, "search_scope": "names"}
