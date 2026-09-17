"""MCP contract tests for Jira comment tools."""

import pytest
from fastmcp import Client, FastMCP

from tools.jira import comments


@pytest.mark.asyncio
async def test_add_comment_exposes_and_accepts_native_adf(monkeypatch):
    """The MCP schema and transport should preserve an opted-in ADF document."""
    captured_request = {}
    adf_body = {
        "type": "doc",
        "version": 1,
        "content": [
            {
                "type": "heading",
                "attrs": {"level": 2},
                "content": [{"type": "text", "text": "Triage analysis"}],
            },
            {
                "type": "table",
                "content": [
                    {
                        "type": "tableRow",
                        "content": [
                            {
                                "type": "tableCell",
                                "content": [
                                    {
                                        "type": "paragraph",
                                        "content": [{"type": "text", "text": "Passed"}],
                                    }
                                ],
                            }
                        ],
                    }
                ],
            },
        ],
    }

    async def mock_request(path, method="GET", **kwargs):
        captured_request["path"] = path
        captured_request["method"] = method
        captured_request["data"] = kwargs.get("data")
        return True, {"id": "10000", "body": kwargs["data"]["body"]}

    monkeypatch.setattr(comments, "MCP_JIRA_READ_ONLY", False)
    monkeypatch.setattr(comments, "make_api_request", mock_request)

    server = FastMCP("jira-comment-contract-test")
    server.tool()(comments.add_comment)

    async with Client(server) as client:
        tools = await client.list_tools()
        result = await client.call_tool(
            "add_comment",
            {
                "issue_key": "PROJ-123",
                "body": adf_body,
                "visibility": {"type": "role", "value": "Administrators"},
                "body_format": "adf",
            },
        )

    tool = next(tool for tool in tools if tool.name == "add_comment")
    assert tool.inputSchema["properties"]["body_format"] == {
        "default": "text",
        "description": (
            "Format of body. Use 'text' (default) for backward-compatible plain "
            "text conversion. Use 'adf' to preserve native Jira formatting such "
            "as headings, marks, links, lists, code blocks, and tables."
        ),
        "enum": ["text", "adf"],
        "type": "string",
    }
    assert result.is_error is False
    assert captured_request == {
        "path": "rest/api/3/issue/PROJ-123/comment",
        "method": "POST",
        "data": {
            "body": adf_body,
            "visibility": {"type": "role", "value": "Administrators"},
        },
    }
