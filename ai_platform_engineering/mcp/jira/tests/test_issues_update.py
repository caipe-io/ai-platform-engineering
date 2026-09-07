"""Tests for Jira issue update handling."""

import json

import pytest


class _FakeFieldDiscovery:
    async def normalize_field_name_to_id(self, field_name: str) -> str:
        return field_name

    async def get_field_schema(self, field_id: str) -> dict[str, str]:
        return {"type": "string"}


@pytest.mark.asyncio
async def test_update_issue_accepts_json_string_fields(monkeypatch):
    """MCP clients may pass object parameters as JSON strings."""
    from mcp_jira.tools.jira import issues

    captured: dict[str, object] = {}

    async def mock_make_api_request(path, method="GET", **kwargs):
        captured["path"] = path
        captured["method"] = method
        captured["data"] = kwargs.get("data")
        captured["params"] = kwargs.get("params")
        return True, {}

    monkeypatch.setattr(issues, "MCP_JIRA_READ_ONLY", False)
    monkeypatch.setattr(issues, "get_field_discovery", lambda: _FakeFieldDiscovery())
    monkeypatch.setattr(issues, "make_api_request", mock_make_api_request)

    result = await issues.update_issue("TW-9", '{"summary": "solved"}')

    assert json.loads(result)["updated_fields"] == ["summary"]
    assert captured["path"] == "rest/api/3/issue/TW-9"
    assert captured["method"] == "PUT"
    assert captured["data"] == {"fields": {"summary": "solved"}}


@pytest.mark.asyncio
async def test_update_issue_rejects_json_string_array_fields(monkeypatch):
    """A string is accepted only when it decodes to a JSON object."""
    from mcp_jira.tools.jira import issues

    monkeypatch.setattr(issues, "MCP_JIRA_READ_ONLY", False)

    result = await issues.update_issue("TW-9", '["summary", "solved"]')

    parsed = json.loads(result)
    assert parsed["success"] is False
    assert "JSON must decode to an object" in parsed["error"]
