#!/usr/bin/env python3
"""Jira issue ingestor for persisted and on-demand RAG datasources."""

import os
import asyncio
import time
import traceback
from datetime import datetime
from typing import Any, Dict, List, Optional
import requests
from requests.auth import HTTPBasicAuth
from langchain_core.documents import Document

from common.ingestor import IngestorBuilder, Client
from common.ingestor_listener import reload_persisted_datasources, run_ingestor_listener
from common.models.rag import DataSourceInfo, DocumentMetadata
from common.models.server import (
    JiraIngestRequest,
    JiraIngestorCommand,
    JiraReloadRequest,
)
from common.job_manager import JobStatus, JobManager
from common import utils

logger = utils.get_logger(__name__)

init_delay = int(os.environ.get("INIT_DELAY_SECONDS", "0"))

MAX_INGESTION_TASKS = int(os.environ.get("JIRA_MAX_INGESTION_TASKS", "5"))
PREVIEW_MAX_ITEMS = max(1, min(int(os.getenv("INGESTOR_PREVIEW_MAX_ITEMS", "100")), 100))

# Jira configuration
JIRA_URL = os.environ.get("JIRA_URL")
if not JIRA_URL:
    raise ValueError("JIRA_URL environment variable is required (e.g. https://your-org.atlassian.net)")

JIRA_EMAIL = os.environ.get("JIRA_EMAIL")
if not JIRA_EMAIL:
    raise ValueError("JIRA_EMAIL environment variable is required")

# Use ATLASSIAN_TOKEN to match the convention used by Jira/Confluence agents, CI, and Helm secrets
JIRA_API_TOKEN = os.environ.get("ATLASSIAN_TOKEN")
if not JIRA_API_TOKEN:
    raise ValueError("ATLASSIAN_TOKEN environment variable is required")

# Max results per page for Jira API pagination
PAGE_SIZE = int(os.environ.get("JIRA_PAGE_SIZE", "100"))


class JiraClient:
    """Thin client for the Jira Cloud REST API v3."""

    def __init__(self, base_url: str, email: str, api_token: str):
        self.base_url = base_url.rstrip("/")
        if not self.base_url.startswith("http"):
            self.base_url = f"https://{self.base_url}"
        self.auth = HTTPBasicAuth(email, api_token)
        self.headers = {"Accept": "application/json", "Content-Type": "application/json"}

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        url = f"{self.base_url}{path}"
        response = requests.get(url, auth=self.auth, headers=self.headers, params=params, timeout=30)
        response.raise_for_status()
        return response.json()

    def search_issues(self, jql: str, fields: List[str]) -> List[Dict[str, Any]]:
        """Run a JQL search and return all matching issues, handling pagination internally."""
        all_issues: List[Dict[str, Any]] = []
        next_page_token: Optional[str] = None
        while True:
            params: Dict[str, Any] = {
                "jql": jql,
                "maxResults": PAGE_SIZE,
                "fields": ",".join(fields),
            }
            if next_page_token:
                params["nextPageToken"] = next_page_token
            result = self._get("/rest/api/3/search/jql", params=params)
            batch = result.get("issues", [])
            all_issues.extend(batch)
            if result.get("isLast", True) or not batch:
                break
            next_page_token = result.get("nextPageToken")
        return all_issues

    def preview_issues(
        self,
        jql: str,
        limit: int,
    ) -> tuple[List[Dict[str, Any]], bool]:
        """Return one bounded Jira search page and whether more matches exist."""
        result = self._get(
            "/rest/api/3/search/jql",
            params={
                "jql": jql,
                "maxResults": limit,
                "fields": "summary,status,issuetype",
            },
        )
        issues = result.get("issues", [])
        return issues[:limit], result.get("isLast", True) is not True

    def get_issue_comments(self, issue_key: str) -> List[Dict[str, Any]]:
        """Fetch all comments for a given issue key."""
        try:
            result = self._get(f"/rest/api/3/issue/{issue_key}/comment", params={"maxResults": 100})
            return result.get("comments", [])
        except requests.HTTPError as e:
            logger.warning(f"Could not fetch comments for {issue_key}: {e}")
            return []


def _extract_text_from_adf(node: Any, depth: int = 0) -> str:
    """
    Recursively extract plain text from Atlassian Document Format (ADF) nodes.
    ADF is the structured rich-text format used in Jira Cloud description/comment fields.
    """
    if node is None:
        return ""
    if isinstance(node, str):
        return node

    node_type = node.get("type", "")
    text_parts: List[str] = []

    # Leaf node — return the text directly
    if node_type == "text":
        return node.get("text", "")

    # Hard line break
    if node_type == "hardBreak":
        return "\n"

    # Recurse into content children
    for child in node.get("content", []):
        text_parts.append(_extract_text_from_adf(child, depth + 1))

    joined = "".join(text_parts)

    # Add appropriate whitespace/newlines for block-level nodes
    block_types = {"paragraph", "heading", "bulletList", "orderedList", "listItem", "blockquote", "codeBlock", "rule"}
    if node_type in block_types:
        return joined.strip() + "\n"

    return joined


def _format_adf_field(value: Any) -> str:
    """Convert an ADF field value to plain text. Falls back to str() for non-ADF values."""
    if isinstance(value, dict) and value.get("type") == "doc":
        return _extract_text_from_adf(value).strip()
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return str(value)


def _format_date(date_str: Optional[str]) -> str:
    """Format an ISO 8601 date string to a human-readable form."""
    if not date_str:
        return "Unknown"
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M UTC")
    except (ValueError, AttributeError):
        return date_str


def _build_issue_document(
    issue: Dict[str, Any],
    comments: List[Dict[str, Any]],
    jira_url: str,
    datasource_id: str,
    ingestor_id: str,
    custom_fields: Optional[Dict[str, str]] = None,
    include_comments: bool = True,
    include_links: bool = True,
    reload_interval: int = 86400,
) -> Document:
    """
    Build a RAG Document from a Jira issue dict.

    The document content includes:
    - Issue key, summary, type, status, priority
    - Description (ADF rendered to plain text)
    - Custom fields (e.g. per-product SLOs, affected systems)
    - Linked issues (for action items, related tickets)
    - Comments
    """
    fields = issue.get("fields", {})
    key = issue.get("key", "UNKNOWN")
    issue_url = f"{jira_url}/browse/{key}"

    summary = fields.get("summary", "")
    issue_type = (fields.get("issuetype") or {}).get("name", "Unknown")
    status = (fields.get("status") or {}).get("name", "Unknown")
    priority = (fields.get("priority") or {}).get("name", "Unknown")
    assignee_obj = fields.get("assignee") or {}
    assignee = assignee_obj.get("displayName", "Unassigned")
    reporter_obj = fields.get("reporter") or {}
    reporter = reporter_obj.get("displayName", "Unknown")
    created = _format_date(fields.get("created"))
    updated = _format_date(fields.get("updated"))
    resolved = _format_date(fields.get("resolutiondate"))
    labels = ", ".join(fields.get("labels") or []) or "None"
    components = ", ".join(c.get("name", "") for c in (fields.get("components") or [])) or "None"

    description_text = _format_adf_field(fields.get("description"))

    # Build content lines
    lines: List[str] = [
        f"# [{key}] {summary}",
        "",
        f"**URL:** {issue_url}",
        f"**Type:** {issue_type}",
        f"**Status:** {status}",
        f"**Priority:** {priority}",
        f"**Assignee:** {assignee}",
        f"**Reporter:** {reporter}",
        f"**Created:** {created}",
        f"**Updated:** {updated}",
    ]

    if resolved and resolved != "Unknown":
        lines.append(f"**Resolved:** {resolved}")

    if labels != "None":
        lines.append(f"**Labels:** {labels}")

    if components != "None":
        lines.append(f"**Components:** {components}")

    # Custom fields
    for friendly_name, field_id in (custom_fields or {}).items():
        value = fields.get(field_id)
        if value is not None:
            text = _format_adf_field(value)
            if text:
                lines.append(f"**{friendly_name.replace('_', ' ').title()}:** {text}")

    # Description
    if description_text:
        lines.append("")
        lines.append("## Description")
        lines.append(description_text)

    # Linked issues (action items, related incidents, etc.)
    issue_links = fields.get("issuelinks") or []
    if include_links and issue_links:
        lines.append("")
        lines.append("## Linked Issues")
        for link in issue_links:
            link_type = (link.get("type") or {}).get("name", "")
            inward = link.get("inwardIssue")
            outward = link.get("outwardIssue")
            if inward:
                inward_key = inward.get("key", "")
                inward_summary = (inward.get("fields") or {}).get("summary", "")
                inward_status = ((inward.get("fields") or {}).get("status") or {}).get("name", "")
                lines.append(f"- **{link_type} (inward):** [{inward_key}] {inward_summary} ({inward_status})")
            if outward:
                outward_key = outward.get("key", "")
                outward_summary = (outward.get("fields") or {}).get("summary", "")
                outward_status = ((outward.get("fields") or {}).get("status") or {}).get("name", "")
                lines.append(f"- **{link_type} (outward):** [{outward_key}] {outward_summary} ({outward_status})")

    # Comments
    if include_comments and comments:
        lines.append("")
        lines.append("## Comments")
        for comment in comments:
            author = (comment.get("author") or {}).get("displayName", "Unknown")
            created_at = _format_date(comment.get("created"))
            body = _format_adf_field(comment.get("body"))
            if body:
                lines.append(f"**[{created_at}] {author}:**")
                lines.append(body)
                lines.append("")

    content = "\n".join(lines)

    metadata = DocumentMetadata(
        datasource_id=datasource_id,
        ingestor_id=ingestor_id,
        document_type="jira_issue",
        document_ingested_at=int(time.time()),
        document_id=f"jira-issue-{key}",
        fresh_until=utils.get_fresh_until(reload_interval),
        title=f"[{key}] {summary}",
        metadata={
            "issue_key": key,
            "issue_type": issue_type,
            "status": status,
            "priority": priority,
            "assignee": assignee,
            "reporter": reporter,
            "created": fields.get("created", ""),
            "updated": fields.get("updated", ""),
            "source_uri": issue_url,
            "last_modified": int(
                datetime.fromisoformat((fields.get("updated") or "1970-01-01T00:00:00+00:00").replace("Z", "+00:00")).timestamp()
            ),
        },
    )

    return Document(page_content=content, metadata=metadata.model_dump())


async def _fetch_and_build_documents(
    jira: "JiraClient",
    jql: str,
    datasource_id: str,
    ingestor_id: str,
    custom_fields: Optional[Dict[str, str]],
    include_comments: bool,
    include_links: bool,
    reload_interval: int,
) -> List[Document]:
    """Run a JQL search and build RAG documents for the resulting issues."""
    standard_fields = [
        "summary",
        "issuetype",
        "status",
        "priority",
        "assignee",
        "reporter",
        "created",
        "updated",
        "resolutiondate",
        "description",
        "labels",
        "components",
        "issuelinks",
    ]
    all_fields = standard_fields + list((custom_fields or {}).values())

    all_issues = jira.search_issues(jql, all_fields)
    logger.info(f"Fetched {len(all_issues)} issues for datasource {datasource_id}")

    documents: List[Document] = []
    for issue in all_issues:
        key = issue.get("key", "UNKNOWN")
        comments: List[Dict[str, Any]] = []
        if include_comments:
            comments = jira.get_issue_comments(key)

        try:
            doc = _build_issue_document(
                issue=issue,
                comments=comments,
                jira_url=JIRA_URL,
                datasource_id=datasource_id,
                ingestor_id=ingestor_id,
                custom_fields=custom_fields,
                include_comments=include_comments,
                include_links=include_links,
                reload_interval=reload_interval,
            )
            documents.append(doc)
        except Exception as e:
            logger.warning(f"Failed to build document for {key}: {e}")

    return documents


async def process_project_ingestion(
    client: Client,
    job_manager: JobManager,
    ingest_request: JiraIngestRequest,
    job_id: str,
) -> None:
    """Process on-demand project ingestion from Redis (server already created datasource+job)."""
    try:
        datasource_id = f"jira-{ingest_request.project_key.lower()}-{ingest_request.source_slug}"

        datasources = await client.list_datasources(ingestor_id=client.ingestor_id)
        datasource_info = next((ds for ds in datasources if ds.datasource_id == datasource_id), None)

        if not datasource_info:
            error_msg = f"Datasource not found: {datasource_id}"
            logger.error(error_msg)
            raise ValueError(error_msg)

        job = await job_manager.get_job(job_id)
        if not job or job.datasource_id != datasource_id:
            raise ValueError(f"Job {job_id} does not belong to datasource {datasource_id}")

        if job.status == JobStatus.TERMINATED:
            logger.info(f"Job {job_id} was already terminated, skipping processing")
            return

        await job_manager.upsert_job(job_id=job_id, status=JobStatus.IN_PROGRESS, message=f"Starting Jira ingestion for {ingest_request.name} ({ingest_request.project_key})")
        logger.info(f"Processing job: {job_id} for datasource: {datasource_id}")

        jira = JiraClient(JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN)
        documents = await _fetch_and_build_documents(
            jira=jira,
            jql=ingest_request.jql,
            datasource_id=datasource_id,
            ingestor_id=client.ingestor_id or "",
            custom_fields=ingest_request.custom_fields,
            include_comments=ingest_request.include_comments,
            include_links=ingest_request.include_links,
            reload_interval=datasource_info.reload_interval,
        )

        datasource_info.last_updated = int(time.time())
        if datasource_info.metadata is None:
            datasource_info.metadata = {}
        datasource_info.metadata.update(
            {
                "project_key": ingest_request.project_key,
                "datasource_name": ingest_request.name,
                "jira_url": JIRA_URL,
                "jql": ingest_request.jql,
                "issue_count": len(documents),
                "custom_fields": ingest_request.custom_fields,
                "include_comments": ingest_request.include_comments,
                "include_links": ingest_request.include_links,
            }
        )
        await client.upsert_datasource(datasource_info)

        if not documents:
            await job_manager.upsert_job(job_id=job_id, status=JobStatus.COMPLETED, message=f"No documents created for {ingest_request.name}")
            return

        await job_manager.upsert_job(job_id=job_id, total=len(documents), message=f"Ingesting {len(documents)} issues from {ingest_request.name}")

        await client.ingest_documents(job_id=job_id, datasource_id=datasource_id, documents=documents, fresh_until=utils.get_fresh_until(datasource_info.reload_interval))

        await job_manager.upsert_job(job_id=job_id, status=JobStatus.COMPLETED, message=f"Successfully ingested {len(documents)} issues from {ingest_request.name}")
        logger.info(f"✓ Successfully ingested {len(documents)} documents from {ingest_request.name}")

    except Exception as e:
        error_msg = f"Error processing Jira project {ingest_request.project_key}/{ingest_request.source_slug}: {str(e)}"
        logger.error(error_msg)
        logger.error(traceback.format_exc())

        try:
            if job_id:
                await job_manager.add_error_msg(job_id, error_msg)
        except Exception as status_error:
            logger.warning(
                f"Failed to record the Jira ingestion error for job {job_id}: {status_error}"
            )

        raise


async def preview_project_ingestion(
    _client: Client,
    ingest_request: JiraIngestRequest,
) -> dict[str, object]:
    """Execute the submitted JQL without fetching comments or ingesting."""
    jira = JiraClient(JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN)
    issues, has_more = await asyncio.to_thread(
        jira.preview_issues,
        ingest_request.jql,
        PREVIEW_MAX_ITEMS,
    )
    items: List[Dict[str, str]] = []
    for issue in issues:
        key = str(issue.get("key") or "")
        fields = issue.get("fields") or {}
        summary = str(fields.get("summary") or key or "Untitled issue")
        status_name = str((fields.get("status") or {}).get("name") or "")
        issue_type = str((fields.get("issuetype") or {}).get("name") or "")
        items.append(
            {
                "id": key or summary,
                "title": f"{key}: {summary}" if key else summary,
                "url": f"{JIRA_URL.rstrip('/')}/browse/{key}" if key else JIRA_URL,
                "detail": " · ".join(value for value in [issue_type, status_name] if value),
            }
        )
    return {
        "items": items,
        "total_discovered": len(items) + (1 if has_more else 0),
        "truncated": has_more,
        "warnings": [],
        "summary": {
            "project_key": ingest_request.project_key,
            "jql": ingest_request.jql,
            "preview_limit": PREVIEW_MAX_ITEMS,
        },
    }


async def reload_datasource(
    client: Client,
    job_manager: JobManager,
    datasource_info: DataSourceInfo,
    job_id: str | None = None,
) -> None:
    """Reload a single Jira project datasource, re-running its stored JQL."""
    try:
        metadata = datasource_info.metadata or {}
        jql = metadata.get("jql")
        if not jql:
            raise ValueError(f"No jql in metadata for {datasource_info.datasource_id}")

        ds_name = metadata.get("datasource_name", datasource_info.datasource_id)
        custom_fields = metadata.get("custom_fields")
        include_comments = metadata.get("include_comments", True)
        include_links = metadata.get("include_links", True)

        logger.info(f"Reloading Jira datasource: {datasource_info.datasource_id}")
        if job_id is not None:
            await job_manager.upsert_job(
                job_id,
                status=JobStatus.IN_PROGRESS,
                message=f"Reloading Jira datasource {ds_name}",
            )

        jira = JiraClient(JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN)
        documents = await _fetch_and_build_documents(
            jira=jira,
            jql=jql,
            datasource_id=datasource_info.datasource_id,
            ingestor_id=client.ingestor_id or "",
            custom_fields=custom_fields,
            include_comments=include_comments,
            include_links=include_links,
            reload_interval=datasource_info.reload_interval,
        )

        datasource_info.last_updated = int(time.time())
        datasource_info.metadata = {**metadata, "issue_count": len(documents)}
        await client.upsert_datasource(datasource_info)

        if not documents:
            logger.info(f"No documents created for {ds_name} during reload")
            if job_id is not None:
                await job_manager.upsert_job(
                    job_id,
                    status=JobStatus.COMPLETED,
                    message=f"No documents created for {ds_name}",
                )
            return

        if job_id is None:
            job_response = await client.create_job(datasource_id=datasource_info.datasource_id, job_status=JobStatus.IN_PROGRESS, message=f"Reloading {len(documents)} issues from {ds_name}", total=len(documents))
            job_id = job_response["job_id"]
        else:
            await job_manager.upsert_job(
                job_id,
                total=len(documents),
                message=f"Reloading {len(documents)} issues from {ds_name}",
            )

        await client.ingest_documents(job_id=job_id, datasource_id=datasource_info.datasource_id, documents=documents, fresh_until=utils.get_fresh_until(datasource_info.reload_interval))
        await client.update_job(job_id=job_id, job_status=JobStatus.COMPLETED, message=f"Successfully reloaded {len(documents)} issues from {ds_name}")
        logger.info(f"✓ Successfully reloaded {len(documents)} documents from {ds_name}")

    except Exception as e:
        logger.error(f"Error reloading {datasource_info.datasource_id}: {e}")
        logger.error(traceback.format_exc())
        if job_id:
            await job_manager.add_error_msg(job_id, str(e))
        raise


async def redis_listener(client: Client):
    """Run Jira commands through the shared per-ingestor listener."""

    await run_ingestor_listener(
        client,
        ingest_command=JiraIngestorCommand.INGEST_PROJECT,
        ingest_model=JiraIngestRequest,
        ingest_handler=process_project_ingestion,
        reload_all_command=JiraIngestorCommand.RELOAD_ALL,
        reload_all_handler=reload_all_jira_projects,
        reload_datasource_command=JiraIngestorCommand.RELOAD_DATASOURCE,
        reload_model=JiraReloadRequest,
        reload_handler=reload_datasource,
        max_tasks=MAX_INGESTION_TASKS,
        describe_ingest=lambda request: f"Jira project ingestion: {request.project_key}/{request.source_slug}",
        preview_command=JiraIngestorCommand.PREVIEW_PROJECT,
        preview_model=JiraIngestRequest,
        preview_handler=preview_project_ingestion,
    )


async def periodic_reload(client: Client) -> None:
    """Refresh persisted Jira datasources whose interval is due."""
    await reload_persisted_datasources(client, reload_datasource)


async def reload_all_jira_projects(client: Client) -> None:
    """Force a reload of every Jira datasource assigned to this worker."""
    await reload_persisted_datasources(client, reload_datasource, due_only=False)


def main() -> None:
    """Main entry point for the Jira ingestor."""
    IngestorBuilder() \
        .name("default_jira") \
        .type("jira") \
        .description(f"Jira issue ingestor for {JIRA_URL}") \
        .metadata({
            "jira_url": JIRA_URL,
            "init_delay": init_delay,
        }) \
        .sync_with_fn(periodic_reload) \
        .with_startup(redis_listener) \
        .schedule_from_datasources() \
        .with_init_delay(init_delay) \
        .run()


if __name__ == "__main__":
    main()
