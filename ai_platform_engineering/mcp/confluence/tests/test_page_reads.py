import json
from typing import Any

import pytest
from fastmcp.exceptions import ToolError

from tools import page_reads
from tools.spaces import get_spaces


def response(body: Any, version: int = 1) -> dict[str, Any]:
    return {"results": [{"content": {
        "id": "123", "title": "Example tracker", "space": {"key": "EXAMPLE"},
        "body": {"storage": {"value": body}}, "version": {"number": version},
    }}]}


@pytest.mark.asyncio
@pytest.mark.parametrize("padding", ["x", '"\\\n\t', "漢字🙂"])
async def test_large_storage_table_is_lossless_and_bounded(monkeypatch: pytest.MonkeyPatch, padding: str) -> None:
    body = '<table><tr><td>' + padding * 80_000 + '</td><td>Final row</td></tr></table>'
    calls = []

    async def request(path: str, **kwargs: Any) -> tuple[bool, dict[str, Any]]:
        calls.append((path, kwargs))
        return True, response(body)

    monkeypatch.setattr(page_reads, "make_api_request", request)
    chunk = await page_reads.confluence_get_page("123")
    chunks = []
    while True:
        assert len(json.dumps(chunk, ensure_ascii=False).encode()) <= 8000
        assert len(chunk["body"]) <= 6000
        chunks.append(chunk["body"])
        if chunk["next_offset"] is None:
            break
        chunk = await page_reads.confluence_get_page_chunk("123", chunk["content_revision"], chunk["next_offset"])
    assert "".join(chunks) == body
    assert all(path == "/search" and kwargs["params"]["cql"] == "type=page AND id=123" for path, kwargs in calls)
    assert all("content.body.storage" in kwargs["params"]["expand"] for _, kwargs in calls)


@pytest.mark.asyncio
async def test_revision_change_requires_restart(monkeypatch: pytest.MonkeyPatch) -> None:
    results = iter([response("x" * 9000), response("changed", 2)])

    async def request(*args: Any, **kwargs: Any) -> tuple[bool, dict[str, Any]]:
        return True, next(results)

    monkeypatch.setattr(page_reads, "make_api_request", request)
    first = await page_reads.confluence_get_page("123")
    with pytest.raises(ToolError, match="revision changed"):
        await page_reads.confluence_get_page_chunk("123", first["content_revision"], first["next_offset"])


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [response(None), {"results": []}, {"results": [{"content": {"id": "123"}}]}])
async def test_absent_body_is_a_tool_error(monkeypatch: pytest.MonkeyPatch, payload: dict[str, Any]) -> None:
    async def request(*args: Any, **kwargs: Any) -> tuple[bool, dict[str, Any]]:
        return True, payload

    monkeypatch.setattr(page_reads, "make_api_request", request)
    with pytest.raises(ToolError):
        await page_reads.confluence_get_page("123")


@pytest.mark.asyncio
async def test_search_preserves_cursor_and_omits_body(monkeypatch: pytest.MonkeyPatch) -> None:
    async def request(*args: Any, **kwargs: Any) -> tuple[bool, dict[str, Any]]:
        assert kwargs["params"]["cursor"] == "first"
        return True, {**response("secret body"), "_links": {"next": "/wiki/rest/api/search?cursor=next%2Bvalue"}}

    monkeypatch.setattr(page_reads, "make_api_request", request)
    result = await page_reads.confluence_search("type=page", cursor="first")
    assert result["next_cursor"] == "next+value"
    assert result["complete"] is False
    assert "body" not in json.dumps(result)


@pytest.mark.asyncio
async def test_space_discovery_keeps_cursor_after_filtering_empty_batch(monkeypatch: pytest.MonkeyPatch) -> None:
    async def request(*args: Any, **kwargs: Any) -> tuple[bool, dict[str, Any]]:
        assert args[0] == "/search" and kwargs["params"]["cql"] == "type=space"
        return True, {"results": [{"space": {"id": "123", "key": "EXAMPLE", "name": "Example", "type": "global"}}], "_links": {"next": "/search?cursor=next"}}

    monkeypatch.setattr(page_reads, "make_api_request", request)
    result = await get_spaces(param_keys=["SECONDARY"])
    assert result == {"results": [], "next_cursor": "next", "complete": False}


TITLES = ["Café résumé", "日本語のページ", "Ünïcödé 🙂 план", "e\u0301 combining"]


@pytest.mark.asyncio
@pytest.mark.parametrize("title", TITLES)
async def test_non_ascii_title_survives_get_page_and_chunks(monkeypatch: pytest.MonkeyPatch, title: str) -> None:
    body = "<p>" + "é漢🙂" * 5000 + "</p>"
    payload = response(body)
    payload["results"][0]["content"]["title"] = title

    async def request(*args: Any, **kwargs: Any) -> tuple[bool, dict[str, Any]]:
        return True, payload

    monkeypatch.setattr(page_reads, "make_api_request", request)
    chunk = await page_reads.confluence_get_page("123")
    chunks = []
    while True:
        assert chunk["title"] == title
        assert len(json.dumps(chunk, ensure_ascii=False).encode()) <= 8000
        chunks.append(chunk["body"])
        if chunk["next_offset"] is None:
            break
        chunk = await page_reads.confluence_get_page_chunk("123", chunk["content_revision"], chunk["next_offset"])
    assert "".join(chunks) == body


@pytest.mark.asyncio
@pytest.mark.parametrize("title", TITLES)
async def test_non_ascii_title_survives_search_and_is_emitted_unescaped(monkeypatch: pytest.MonkeyPatch, title: str) -> None:
    payload = response("unused")
    payload["results"][0]["content"]["title"] = title

    async def request(*args: Any, **kwargs: Any) -> tuple[bool, dict[str, Any]]:
        return True, payload

    monkeypatch.setattr(page_reads, "make_api_request", request)
    assert (await page_reads.confluence_search("type=page"))["results"][0]["title"] == title
    result = await page_reads.inline_json_tool(page_reads.confluence_search)("type=page")
    assert title in result.content[0].text and "\\u" not in result.content[0].text


@pytest.mark.asyncio
@pytest.mark.parametrize(("limit", "fits"), [(5, True), (10, False)])
async def test_long_multibyte_titles_are_truncated_by_characters_and_bounded_by_bytes(monkeypatch: pytest.MonkeyPatch, limit: int, fits: bool) -> None:
    title = "🙂" * 300
    payload = {"results": [{"content": {"id": str(i), "title": title, "space": {"key": "EXAMPLE"}, "version": {"number": 1}}} for i in range(limit)]}

    async def request(*args: Any, **kwargs: Any) -> tuple[bool, dict[str, Any]]:
        return True, payload

    monkeypatch.setattr(page_reads, "make_api_request", request)
    if not fits:
        with pytest.raises(ToolError, match="smaller limit"):
            await page_reads.confluence_search("type=page", limit=limit)
        return
    result = await page_reads.inline_json_tool(page_reads.confluence_search)("type=page", limit=limit)
    titles = [item["title"] for item in json.loads(result.content[0].text)["results"]]
    assert titles == ["🙂" * 256] * limit
