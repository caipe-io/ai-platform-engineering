"""Bounded Confluence CQL reads compatible with classic OAuth scopes."""

import hashlib
import json
from collections.abc import Awaitable, Callable
from functools import wraps
from typing import Any
from urllib.parse import parse_qs, urlparse

from fastmcp.exceptions import ToolError
from fastmcp.tools.base import ToolResult
from mcp.types import TextContent

from api.client import make_api_request

MAX_RESULT_BYTES = 8000
MAX_CHUNK_CHARS = 6000


def inline_json_tool(func: Callable[..., Awaitable[dict[str, Any]]]) -> Callable[..., Awaitable[ToolResult]]:
    """Render one bounded text payload, avoiding duplicate structured content."""
    @wraps(func)
    async def wrapped(*args: Any, **kwargs: Any) -> ToolResult:
        result = await func(*args, **kwargs)
        text = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        if len(text.encode()) > MAX_RESULT_BYTES:
            raise ToolError("Tool result exceeds the inline response budget; the read is incomplete")
        return ToolResult(content=[TextContent(type="text", text=text)])
    return wrapped


async def _search(cql: str, limit: int, cursor: str | None = None, expand: str = "content.space,content.version") -> dict[str, Any]:
    params: dict[str, Any] = {"cql": cql, "limit": limit, "expand": expand}
    if cursor:
        params["cursor"] = cursor
    success, response = await make_api_request("/search", params=params)
    if not success:
        raise ToolError(json.dumps(response))
    if not isinstance(response.get("results"), list):
        raise ToolError("Invalid Confluence search response: results must be a list")
    return response


async def confluence_search(cql: str, limit: int = 5, cursor: str | None = None) -> dict[str, Any]:
    """Search live caller-visible content. Returns metadata, not page bodies.

    Follow next_cursor for all results. Read bodies using confluence_get_page
    and its revision-aware continuation; search success alone is not a body read.
    """
    if not cql.strip() or len(cql) > 4000 or type(limit) is not int or not 1 <= limit <= 10:
        raise ToolError("Supply nonempty CQL (up to 4000 characters) and limit from 1 to 10")
    response = await _search(cql, limit, cursor)
    results = []
    for item in response["results"]:
        content = item.get("content") if isinstance(item, dict) else None
        if not isinstance(content, dict) or not content.get("id"):
            raise ToolError("Invalid Confluence search result: content ID is missing")
        results.append({
            "id": content["id"], "title": str(content.get("title", ""))[:256],
            "space_key": content.get("space", {}).get("key"),
            "version": content.get("version", {}).get("number"),
            "last_modified": content.get("version", {}).get("when"),
        })
    next_link = response.get("_links", {}).get("next")
    next_cursor = parse_qs(urlparse(next_link).query).get("cursor", [None])[0] if next_link else None
    if next_link and not next_cursor:
        raise ToolError("Confluence returned a continuation without a cursor; the search is incomplete")
    result = {"results": results, "next_cursor": next_cursor, "complete": not bool(next_link)}
    if len(json.dumps(result, ensure_ascii=False).encode()) > MAX_RESULT_BYTES:
        raise ToolError("Search metadata exceeds the response budget; retry with a smaller limit")
    return result


async def confluence_list_spaces(limit: int = 5, cursor: str | None = None) -> dict[str, Any]:
    """List caller-visible space metadata using classic-scope CQL; follow next_cursor."""
    if type(limit) is not int or not 1 <= limit <= 10:
        raise ToolError("limit must be from 1 to 10")
    response = await _search("type=space", limit, cursor, expand="")
    results = []
    for item in response["results"]:
        space = item.get("space") if isinstance(item, dict) else None
        if not isinstance(space, dict) or not space.get("key"):
            raise ToolError("Invalid Confluence search result: space key is missing")
        results.append({"id": space.get("id"), "key": space["key"], "name": str(space.get("name", ""))[:256], "type": space.get("type"), "status": space.get("status")})
    next_link = response.get("_links", {}).get("next")
    next_cursor = parse_qs(urlparse(next_link).query).get("cursor", [None])[0] if next_link else None
    if next_link and not next_cursor:
        raise ToolError("Confluence returned a continuation without a cursor; space enumeration is incomplete")
    result = {"results": results, "next_cursor": next_cursor, "complete": not bool(next_link)}
    if len(json.dumps(result, ensure_ascii=False).encode()) > MAX_RESULT_BYTES:
        raise ToolError("Space metadata exceeds the response budget; retry with a smaller limit")
    return result


async def _page(page_id: str) -> dict[str, Any]:
    if not page_id.isascii() or not page_id.isdecimal() or len(page_id) > 30:
        raise ToolError("page_id must contain ASCII digits")
    response = await _search(f"type=page AND id={page_id}", 1, expand="content.body.storage,content.space,content.version")
    if not response["results"]:
        raise ToolError("Page not found or not visible to the connected user")
    item = response["results"][0]
    content = item.get("content") if isinstance(item, dict) else None
    if not isinstance(content, dict):
        raise ToolError("Page response is missing expanded content")
    body_object = content.get("body")
    storage = body_object.get("storage") if isinstance(body_object, dict) else None
    body = storage.get("value") if isinstance(storage, dict) else None
    if str(content.get("id")) != page_id or not isinstance(body, str):
        raise ToolError("Page response is missing the requested ID or expanded storage body; no successful read")
    return {
        "page_id": page_id, "title": content.get("title", ""), "body": body,
        "space_key": content.get("space", {}).get("key"),
        "version": content.get("version", {}).get("number"),
        "last_modified": content.get("version", {}).get("when"),
    }


def _revision(page: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(page, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _chunk(page: dict[str, Any], offset: int = 0, limit: int = MAX_CHUNK_CHARS) -> dict[str, Any]:
    body = page["body"]
    revision = _revision(page)
    if offset > len(body):
        raise ToolError("offset exceeds total_chars")

    def result(length: int) -> dict[str, Any]:
        end = offset + length
        return {**page, "body": body[offset:end], "body_format": "storage", "offset": offset,
                "total_chars": len(body), "content_revision": revision,
                "next_offset": end if end < len(body) else None, "complete": offset == 0 and end == len(body),
                "hint": "Concatenate every chunk in offset order with the same content_revision before interpreting tables."}

    low, high = 0, min(limit, len(body) - offset)
    while low < high:
        middle = (low + high + 1) // 2
        if len(json.dumps(result(middle), ensure_ascii=False).encode()) <= MAX_RESULT_BYTES:
            low = middle
        else:
            high = middle - 1
    chunk = result(low)
    if len(json.dumps(chunk, ensure_ascii=False).encode()) > MAX_RESULT_BYTES or (low == 0 and offset < len(body)):
        raise ToolError("Page metadata exceeds the response budget; the body was not read")
    return chunk


async def confluence_get_page(page_id: str) -> dict[str, Any]:
    """Read the first bounded storage-body chunk using classic-scope CQL.

    Read every next_offset with confluence_get_page_chunk until it is null.
    Responses include version, source modification time and a body revision.
    """
    return _chunk(await _page(page_id))


async def confluence_get_page_chunk(page_id: str, content_revision: str, offset: int, limit: int = MAX_CHUNK_CHARS) -> dict[str, Any]:
    """Continue a body read. Restart at the first chunk if the source revision changed."""
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= MAX_CHUNK_CHARS:
        raise ToolError("offset must be nonnegative and limit must be from 1 to 6000")
    if len(content_revision) != 64 or any(char not in "0123456789abcdef" for char in content_revision):
        raise ToolError("Use content_revision returned by confluence_get_page")
    page = await _page(page_id)
    if _revision(page) != content_revision:
        raise ToolError("Page revision changed; restart confluence_get_page and do not mix revisions")
    return _chunk(page, offset, limit)
