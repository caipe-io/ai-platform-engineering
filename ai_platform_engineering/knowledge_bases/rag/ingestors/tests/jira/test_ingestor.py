"""
Unit tests for the Jira ingestor module.

Covers:
  - _extract_text_from_adf: plain text, nested nodes, block-level whitespace,
    hardBreak, None/string inputs
  - _format_adf_field: ADF doc, plain string, None, non-string fallback
  - _format_date: valid ISO 8601, Z suffix, None/empty, unparseable string
  - _build_issue_document: full document structure, optional fields (resolved,
    labels, components, custom fields, linked issues, comments),
    missing/None field values, metadata correctness

NOTE: ingestor.py validates env vars at module level. We pre-set them via
os.environ before the import so the module loads without raising ValueError.
"""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Set required env vars before importing the module
# ---------------------------------------------------------------------------
os.environ.setdefault("JIRA_URL", "https://example.atlassian.net")
os.environ.setdefault("JIRA_EMAIL", "test@example.com")
os.environ.setdefault("ATLASSIAN_TOKEN", "test-token")

# ---------------------------------------------------------------------------
# Import the module under test -- `common` is a real installed dependency
# (see pyproject.toml [tool.uv.sources]), so no sys.modules stubbing is
# needed here.
# ---------------------------------------------------------------------------
import ingestors.jira.ingestor as ingestor_module  # noqa: E402
from ingestors.jira.ingestor import (  # noqa: E402
    _extract_text_from_adf,
    _format_adf_field,
    _format_date,
    _build_issue_document,
    preview_project_ingestion,
)
from common.models.server import JiraIngestRequest  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

def make_issue(
    key: str = "PROJ-1",
    summary: str = "Test issue",
    issue_type: str = "Bug",
    status: str = "Open",
    priority: str = "High",
    assignee: str = "Alice",
    reporter: str = "Bob",
    created: str = "2024-01-01T10:00:00+00:00",
    updated: str = "2024-01-02T10:00:00+00:00",
    resolutiondate: str | None = None,
    labels: list | None = None,
    components: list | None = None,
    description: dict | None = None,
    issuelinks: list | None = None,
    extra_fields: dict | None = None,
) -> dict:
    fields: dict = {
        "summary": summary,
        "issuetype": {"name": issue_type},
        "status": {"name": status},
        "priority": {"name": priority},
        "assignee": {"displayName": assignee},
        "reporter": {"displayName": reporter},
        "created": created,
        "updated": updated,
        "resolutiondate": resolutiondate,
        "labels": labels or [],
        "components": [{"name": c} for c in (components or [])],
        "description": description,
        "issuelinks": issuelinks or [],
    }
    if extra_fields:
        fields.update(extra_fields)
    return {"key": key, "fields": fields}


def make_comment(author: str = "Charlie", created: str = "2024-01-03T10:00:00+00:00", body: str = "A comment") -> dict:
    return {
        "author": {"displayName": author},
        "created": created,
        "body": body,
    }


def make_adf_doc(text: str) -> dict:
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": text}],
            }
        ],
    }


@pytest.mark.asyncio
async def test_preview_project_is_bounded_and_does_not_ingest() -> None:
    jira = MagicMock()
    jira.preview_issues.return_value = (
        [
            make_issue(
                key="EXAMPLE-1",
                summary="Preview item",
                issue_type="Task",
                status="Open",
            )
        ],
        True,
    )
    rag_client = MagicMock()
    rag_client.ingest_documents = AsyncMock()
    request = JiraIngestRequest(
        project_key="EXAMPLE",
        source_slug="preview",
        name="Example preview",
        jql="project = EXAMPLE",
        reload_interval=86400,
    )

    with patch.object(ingestor_module, "JiraClient", return_value=jira):
        result = await preview_project_ingestion(rag_client, request)

    jira.preview_issues.assert_called_once_with(
        "project = EXAMPLE",
        ingestor_module.PREVIEW_MAX_ITEMS,
    )
    assert result["truncated"] is True
    assert result["items"] == [
        {
            "id": "EXAMPLE-1",
            "title": "EXAMPLE-1: Preview item",
            "url": "https://example.atlassian.net/browse/EXAMPLE-1",
            "detail": "Task · Open",
        }
    ]
    rag_client.ingest_documents.assert_not_awaited()


# ---------------------------------------------------------------------------
# _extract_text_from_adf
# ---------------------------------------------------------------------------

class TestExtractTextFromAdf:
    def test_none_returns_empty(self):
        assert _extract_text_from_adf(None) == ""

    def test_string_passthrough(self):
        assert _extract_text_from_adf("hello") == "hello"

    def test_text_node(self):
        assert _extract_text_from_adf({"type": "text", "text": "hello"}) == "hello"

    def test_hard_break(self):
        assert _extract_text_from_adf({"type": "hardBreak"}) == "\n"

    def test_paragraph_adds_newline(self):
        node = {"type": "paragraph", "content": [{"type": "text", "text": "hello"}]}
        result = _extract_text_from_adf(node)
        assert result == "hello\n"

    def test_nested_doc(self):
        doc = make_adf_doc("test content")
        result = _extract_text_from_adf(doc)
        assert "test content" in result

    def test_bullet_list(self):
        node = {
            "type": "bulletList",
            "content": [
                {
                    "type": "listItem",
                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": "item"}]}],
                }
            ],
        }
        result = _extract_text_from_adf(node)
        assert "item" in result

    def test_empty_content(self):
        assert _extract_text_from_adf({"type": "paragraph", "content": []}) == "\n"

    def test_missing_text_key(self):
        assert _extract_text_from_adf({"type": "text"}) == ""

    def test_unknown_node_type_passes_through(self):
        node = {"type": "customNode", "content": [{"type": "text", "text": "hi"}]}
        assert _extract_text_from_adf(node) == "hi"


# ---------------------------------------------------------------------------
# _format_adf_field
# ---------------------------------------------------------------------------

class TestFormatAdfField:
    def test_adf_doc(self):
        result = _format_adf_field(make_adf_doc("hello world"))
        assert "hello world" in result

    def test_plain_string(self):
        assert _format_adf_field("plain text") == "plain text"

    def test_none_returns_empty(self):
        assert _format_adf_field(None) == ""

    def test_non_string_falls_back_to_str(self):
        assert _format_adf_field(42) == "42"

    def test_dict_without_doc_type(self):
        # dicts that are not ADF docs fall through to str()
        result = _format_adf_field({"type": "other"})
        assert isinstance(result, str)


# ---------------------------------------------------------------------------
# _format_date
# ---------------------------------------------------------------------------

class TestFormatDate:
    def test_none_returns_unknown(self):
        assert _format_date(None) == "Unknown"

    def test_empty_string_returns_unknown(self):
        assert _format_date("") == "Unknown"

    def test_valid_iso_date(self):
        result = _format_date("2024-03-15T10:30:00+00:00")
        assert "2024-03-15" in result
        assert "UTC" in result

    def test_z_suffix(self):
        result = _format_date("2024-03-15T10:30:00Z")
        assert "2024-03-15" in result

    def test_unparseable_returns_original(self):
        assert _format_date("not-a-date") == "not-a-date"


# ---------------------------------------------------------------------------
# _build_issue_document
# ---------------------------------------------------------------------------

class TestBuildIssueDocument:
    def _build(self, issue=None, comments=None, **kwargs):
        return _build_issue_document(
            issue=issue or make_issue(),
            comments=comments or [],
            jira_url="https://example.atlassian.net",
            datasource_id="jira-project-proj",
            ingestor_id="jira:default_jira",
            **kwargs,
        )

    def test_returns_document(self):
        from langchain_core.documents import Document
        doc = self._build()
        assert isinstance(doc, Document)

    def test_content_contains_key_and_summary(self):
        doc = self._build(issue=make_issue(key="PROJ-42", summary="Fix the bug"))
        assert "PROJ-42" in doc.page_content
        assert "Fix the bug" in doc.page_content

    def test_content_contains_metadata_fields(self):
        doc = self._build(issue=make_issue(status="In Progress", priority="High", assignee="Alice"))
        assert "In Progress" in doc.page_content
        assert "High" in doc.page_content
        assert "Alice" in doc.page_content

    def test_resolved_date_included_when_present(self):
        doc = self._build(issue=make_issue(resolutiondate="2024-02-01T00:00:00+00:00"))
        assert "Resolved" in doc.page_content

    def test_resolved_date_omitted_when_none(self):
        doc = self._build(issue=make_issue(resolutiondate=None))
        assert "Resolved" not in doc.page_content

    def test_labels_included(self):
        doc = self._build(issue=make_issue(labels=["backend", "urgent"]))
        assert "backend" in doc.page_content
        assert "urgent" in doc.page_content

    def test_components_included(self):
        doc = self._build(issue=make_issue(components=["API", "Auth"]))
        assert "API" in doc.page_content
        assert "Auth" in doc.page_content

    def test_description_included(self):
        doc = self._build(issue=make_issue(description=make_adf_doc("Steps to reproduce")))
        assert "Steps to reproduce" in doc.page_content

    def test_comments_included(self):
        comments = [make_comment(author="Dave", body="This is a comment")]
        doc = self._build(comments=comments)
        assert "Dave" in doc.page_content
        assert "This is a comment" in doc.page_content

    def test_linked_issues_included(self):
        links = [
            {
                "type": {"name": "blocks"},
                "outwardIssue": {
                    "key": "PROJ-99",
                    "fields": {"summary": "Linked issue", "status": {"name": "Open"}},
                },
            }
        ]
        doc = self._build(issue=make_issue(issuelinks=links))
        assert "PROJ-99" in doc.page_content
        assert "Linked issue" in doc.page_content

    def test_metadata_document_id(self):
        doc = self._build(issue=make_issue(key="PROJ-7"))
        assert doc.metadata["document_id"] == "jira-issue-PROJ-7"

    def test_metadata_source_uri(self):
        doc = self._build(issue=make_issue(key="PROJ-7"))
        assert doc.metadata["metadata"]["source_uri"] == "https://example.atlassian.net/browse/PROJ-7"

    def test_metadata_issue_key(self):
        doc = self._build(issue=make_issue(key="PROJ-7"))
        assert doc.metadata["metadata"]["issue_key"] == "PROJ-7"

    def test_metadata_datasource_id(self):
        doc = self._build()
        assert doc.metadata["datasource_id"] == "jira-project-proj"

    def test_none_assignee_falls_back(self):
        issue = make_issue()
        issue["fields"]["assignee"] = None
        doc = self._build(issue=issue)
        assert "Unassigned" in doc.page_content

    def test_none_priority_falls_back(self):
        issue = make_issue()
        issue["fields"]["priority"] = None
        doc = self._build(issue=issue)
        assert "Unknown" in doc.page_content

    def test_custom_fields_included(self):
        issue = make_issue(extra_fields={"customfield_10200": "P1"})
        doc = _build_issue_document(
            issue=issue,
            comments=[],
            jira_url="https://example.atlassian.net",
            datasource_id="jira-project-proj",
            ingestor_id="jira:default_jira",
            custom_fields={"slo_impact": "customfield_10200"},
        )
        assert "P1" in doc.page_content
        assert "Slo Impact" in doc.page_content


# ---------------------------------------------------------------------------
# JiraClient
# ---------------------------------------------------------------------------

class TestJiraClient:
    def test_pagination_fetches_all_pages(self):
        """Verifies JiraClient.search_issues pages through multiple batches until isLast=True."""
        from ingestors.jira.ingestor import JiraClient

        jira = JiraClient("https://example.atlassian.net", "test@example.com", "token")

        page1 = {
            "issues": [make_issue(key="PROJ-1", updated="2024-01-01T00:00:00+00:00")],
            "isLast": False,
            "nextPageToken": "token-page-2",
        }
        page2 = {
            "issues": [make_issue(key="PROJ-2", updated="2024-01-01T00:00:00+00:00")],
            "isLast": True,
        }

        with patch.object(jira, "_get", side_effect=[page1, page2]) as mock_get:
            results = jira.search_issues("project = PROJ", ["summary"])

        assert len(results) == 2
        assert results[0]["key"] == "PROJ-1"
        assert results[1]["key"] == "PROJ-2"
        assert mock_get.call_count == 2
        # Second call must include the nextPageToken from page1
        second_call_params = mock_get.call_args_list[1][1]["params"]
        assert second_call_params["nextPageToken"] == "token-page-2"
