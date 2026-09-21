"""Unit tests for Jira issue model parsing."""

from models.jira.issue import JiraIssue


def test_malformed_adf_description_is_rejected():
    """Malformed ADF descriptions should not reach the text converter."""
    issue = JiraIssue.from_api_response(
        {
            "id": "10000",
            "key": "PROJ-123",
            "fields": {
                "summary": "Malformed description",
                "description": {
                    "type": "doc",
                    "version": 1,
                    "content": "not-a-list",
                },
            },
        }
    )

    assert issue.key == "PROJ-123"
    assert issue.description is None
