from typing import Any
from unittest.mock import MagicMock
import json

import pytest
from fastmcp import FastMCP

import server
from tools import page_reads


def test_live_body_tools_are_registered(monkeypatch: pytest.MonkeyPatch) -> None:
    registered = []
    fake_server = MagicMock()

    def register(func: Any) -> Any:
        registered.append(func.__name__)
        return func

    fake_server.tool.return_value = register
    monkeypatch.setattr(server, "FastMCP", lambda name: fake_server)
    monkeypatch.setenv("MCP_MODE", "stdio")
    server.main()
    assert {"confluence_list_spaces", "confluence_search", "confluence_get_page", "confluence_get_page_chunk"}.issubset(registered)
    fake_server.run.assert_called_once_with(transport="stdio")


@pytest.mark.asyncio
async def test_real_mcp_delivery_is_one_bounded_json_text_block(monkeypatch: pytest.MonkeyPatch) -> None:
    body = '"\\\n漢字🙂' * 20_000

    async def request(*args: Any, **kwargs: Any) -> tuple[bool, dict[str, Any]]:
        return True, {"results": [{"content": {"id": "123", "body": {"storage": {"value": body}}}}]}

    monkeypatch.setattr(page_reads, "make_api_request", request)
    mcp = FastMCP("example")
    mcp.tool(output_schema=None)(page_reads.inline_json_tool(page_reads.confluence_get_page))
    result = await mcp.call_tool("confluence_get_page", {"page_id": "123"})
    assert result.structured_content is None
    assert len(result.content) == 1
    assert len(result.content[0].text.encode()) <= 8000
    payload = json.loads(result.content[0].text)
    assert body.startswith(payload["body"]) and payload["next_offset"] is not None
