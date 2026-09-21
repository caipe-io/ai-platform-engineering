"""ADF contract tests for Jira issue description write paths."""

import json

import pytest
from fastmcp import Client, FastMCP

from tools.jira import issues


class _FakeFieldDiscovery:
    async def normalize_field_name_to_id(self, field_name: str) -> str:
        return field_name

    async def get_field_schema(self, field_id: str) -> dict[str, str]:
        return {"type": "string"}


@pytest.fixture
def native_description():
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {
                "type": "heading",
                "attrs": {"level": 2},
                "content": [{"type": "text", "text": "Investigation"}],
            },
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "Runbook",
                        "marks": [
                            {
                                "type": "link",
                                "attrs": {"href": "https://example.test/runbook"},
                            }
                        ],
                    }
                ],
            },
        ],
    }


@pytest.fixture
def capture_issue_request(monkeypatch):
    captured = {}

    async def mock_request(path, method="GET", **kwargs):
        captured["path"] = path
        captured["method"] = method
        captured["data"] = kwargs.get("data")
        captured["params"] = kwargs.get("params")
        if path == "rest/api/3/issue/bulk":
            return True, {"issues": [{"id": "10000", "key": "PROJ-1"}]}
        return True, {"id": "10000", "key": "PROJ-1"}

    monkeypatch.setattr(issues, "MCP_JIRA_READ_ONLY", False)
    monkeypatch.setattr(issues, "check_read_only", lambda: None)
    monkeypatch.setattr(issues, "get_field_discovery", lambda: _FakeFieldDiscovery())
    monkeypatch.setattr(issues, "make_api_request", mock_request)
    return captured


@pytest.mark.asyncio
async def test_create_issue_accepts_native_adf(
    native_description,
    capture_issue_request,
):
    result = await issues.create_issue(
        "PROJ",
        "Rich description",
        description=native_description,
        description_format="adf",
    )

    assert result["key"] == "PROJ-1"
    assert capture_issue_request["data"]["fields"]["description"] == native_description


@pytest.mark.asyncio
async def test_batch_create_issues_accepts_native_adf(
    native_description,
    capture_issue_request,
):
    payload = json.dumps(
        [
            {
                "project_key": "PROJ",
                "summary": "Rich description",
                "issue_type": "Task",
                "description": native_description,
            }
        ]
    )

    result = json.loads(await issues.batch_create_issues(payload))

    assert result["issues"][0]["key"] == "PROJ-1"
    issue_fields = capture_issue_request["data"]["issueUpdates"][0]["fields"]
    assert issue_fields["description"] == native_description
    assert "description_format" not in issue_fields


@pytest.mark.asyncio
async def test_update_issue_preserves_native_adf_before_string_normalization(
    native_description,
    capture_issue_request,
):
    result = json.loads(
        await issues.update_issue("PROJ-1", {"description": native_description})
    )

    assert result["updated_fields"] == ["description"]
    assert capture_issue_request["data"] == {
        "fields": {"description": native_description}
    }


@pytest.mark.asyncio
async def test_create_issue_rejects_format_mismatch_before_api_call(
    native_description,
    capture_issue_request,
):
    result = await issues.create_issue(
        "PROJ",
        "Invalid description",
        description=native_description,
    )

    assert result == {
        "success": False,
        "error": "description must be a string when description_format is 'text'.",
    }
    assert capture_issue_request == {}


@pytest.mark.asyncio
async def test_create_issue_mcp_schema_exposes_description_format():
    server = FastMCP("jira-issue-description-contract-test")
    server.tool()(issues.create_issue)

    async with Client(server) as client:
        tools = await client.list_tools()

    tool = next(tool for tool in tools if tool.name == "create_issue")
    description_format = tool.inputSchema["properties"]["description_format"]
    assert description_format["default"] == "text"
    assert description_format["enum"] == ["text", "adf"]
