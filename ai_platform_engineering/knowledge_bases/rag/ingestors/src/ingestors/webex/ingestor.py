#!/usr/bin/env python3
"""
Webex message ingestor for RAG.
Fetches messages from configured Webex spaces and ingests them as documents.
Each space becomes a datasource, and messages are grouped into thread-based documents.
"""

import os
import json
import time
import traceback
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from langchain_core.documents import Document

from common.ingestor import IngestorBuilder, Client
from common.ingestor_listener import (
  configured_reload_interval,
  reload_persisted_datasources,
  run_ingestor_listener,
)
from common.models.rag import DataSourceInfo, DocumentMetadata
from common.models.server import (
  WebexIngestRequest,
  WebexIngestorCommand,
  WebexReloadRequest,
)
from common.job_manager import JobStatus, JobManager
from common.utils import get_logger, get_fresh_until

logger = get_logger(__name__)


init_delay = int(os.environ.get("INIT_DELAY_SECONDS", "0"))

# Webex API base URL
WEBEX_API_BASE = "https://webexapis.com/v1"

MAX_INGESTION_TASKS = int(os.environ.get("WEBEX_MAX_INGESTION_TASKS", "5"))


def configured_spaces() -> Dict[str, Dict[str, Any]]:
  """Return the legacy WEBEX_SPACES mapping, or an empty mapping."""
  try:
    parsed = json.loads(os.environ.get("WEBEX_SPACES", "{}"))
  except json.JSONDecodeError:
    return {}
  return parsed if isinstance(parsed, dict) else {}


def iso_to_timestamp(iso_string: str) -> int:
  """Convert ISO 8601 timestamp to Unix timestamp."""
  try:
    dt = datetime.fromisoformat(iso_string.replace("Z", "+00:00"))
    return int(dt.timestamp())
  except (ValueError, TypeError):
    return 0


def timestamp_to_iso(timestamp: int) -> str:
  """Convert Unix timestamp to ISO 8601 string."""
  dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
  return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def iso_to_readable(iso_string: str) -> str:
  """Convert ISO 8601 timestamp to human-readable datetime string."""
  try:
    dt = datetime.fromisoformat(iso_string.replace("Z", "+00:00"))
    return dt.strftime("%Y-%m-%d %H:%M:%S")
  except (ValueError, TypeError):
    return "invalid"


class WebexSpaceSyncer:
  """Handles syncing messages from Webex spaces"""

  def __init__(self, access_token: str):
    self.access_token = access_token
    self.session = self._create_session()
    self.headers = {"Authorization": f"Bearer {self.access_token}", "Content-Type": "application/json"}

  def _create_session(self) -> requests.Session:
    """Create a requests session with retry logic."""
    session = requests.Session()
    retry_strategy = Retry(total=5, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504], allowed_methods=["GET", "POST"])
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("https://", adapter)
    return session

  def _make_request(self, method: str, endpoint: str, params: Optional[Dict] = None, json_data: Optional[Dict] = None) -> Dict:
    """Make a request to Webex API with error handling."""
    url = f"{WEBEX_API_BASE}/{endpoint}"

    try:
      if method.upper() == "GET":
        response = self.session.get(url, headers=self.headers, params=params, timeout=30)
      elif method.upper() == "POST":
        response = self.session.post(url, headers=self.headers, params=params, json=json_data, timeout=30)
      else:
        raise ValueError(f"Unsupported HTTP method: {method}")

      response.raise_for_status()
      return response.json()

    except requests.exceptions.HTTPError as e:
      if e.response.status_code == 429:
        # Rate limit - get retry-after header
        retry_after = int(e.response.headers.get("Retry-After", 60))
        logger.warning(f"Rate limited. Waiting {retry_after}s before retry")
        time.sleep(retry_after)
        # Retry once after rate limit
        response = self.session.request(method, url, headers=self.headers, params=params, json=json_data, timeout=30)
        response.raise_for_status()
        return response.json()
      else:
        logger.error(f"HTTP error: {e}")
        raise
    except requests.exceptions.RequestException as e:
      logger.error(f"Request error: {e}")
      raise

  def get_space_details(self, space_id: str) -> Dict:
    """Get details about a specific space."""
    return self._make_request("GET", f"rooms/{space_id}")

  def fetch_space_messages(
    self,
    space_id: str,
    space_name: str,
    last_message_time: Optional[str] = None,
    raise_on_error: bool = False,
  ) -> tuple[List[Dict], str]:
    """
    Fetch new messages from a Webex space since last sync.
    Note: Webex API doesn't support 'since' parameter, so we fetch latest messages
    and filter client-side. This is inefficient but necessary due to API limitations.
    """
    messages = []

    # Build query parameters - fetch most recent messages
    params = {
      "roomId": space_id,
      "max": 100,  # Webex max is 100 per request
    }

    if last_message_time:
      logger.info(f"Incremental sync for '{space_name}' since {iso_to_readable(last_message_time)}")
    else:
      logger.info(f"First sync for '{space_name}' - fetching recent messages only")

    try:
      # Verify space exists and bot has access
      try:
        space_info = self.get_space_details(space_id)
        logger.debug(f"Space verified - title: {space_info.get('title')}, type: {space_info.get('type')}")
      except Exception as e:
        logger.warning(f"Space verification failed: {e}")

      # Fetch messages (most recent first)
      newest_time = last_message_time or ""

      # Only fetch a few pages to avoid overwhelming memory
      max_pages = 10
      page_count = 0

      while page_count < max_pages:
        response = self._make_request("GET", "messages", params=params)
        batch_messages = response.get("items", [])

        if not batch_messages:
          break

        logger.debug(f"Fetched {len(batch_messages)} messages in batch {page_count + 1}")

        # Filter messages by time if doing incremental sync
        if last_message_time:
          new_messages = [msg for msg in batch_messages if msg.get("created", "") > last_message_time]
          messages.extend(new_messages)

          # Stop if we've reached messages older than last sync
          if len(new_messages) < len(batch_messages):
            logger.debug("Reached messages from previous sync, stopping pagination")
            break
        else:
          messages.extend(batch_messages)

        # Track newest timestamp
        for msg in batch_messages:
          msg_time = msg.get("created", "")
          if msg_time > newest_time:
            newest_time = msg_time

        # Check for more pages
        if len(batch_messages) >= 100:
          # Get oldest message in this batch for pagination
          oldest_msg = min(batch_messages, key=lambda m: m.get("created", ""))
          params["before"] = oldest_msg.get("created")
          page_count += 1
        else:
          break

      logger.info(f"Fetched {len(messages)} new messages from '{space_name}'")
      return messages, newest_time

    except Exception as e:
      logger.error(f"Error fetching messages from '{space_name}': {e}")
      if raise_on_error:
        raise
      return [], last_message_time or ""

  def get_message_details(self, message_id: str) -> Dict:
    """Get detailed information about a message."""
    return self._make_request("GET", f"messages/{message_id}")

  def group_messages_into_documents(self, messages: List[Dict], space_id: str, space_name: str, include_bots: bool, datasource_id: str, ingestor_id: str) -> List[Document]:
    """
    Group messages into documents for RAG ingestion.
    Messages are grouped by thread - all replies with the same parentId are combined into one document.
    """
    documents = []

    # Filter out bot messages if needed
    filtered_messages = []
    for msg in messages:
      person_email = msg.get("personEmail", "")
      if not include_bots and "@webex.bot" in person_email:
        continue
      filtered_messages.append(msg)

    # Build thread structure: parent_id -> [child messages]
    threads = {}  # parent_id -> list of replies
    standalone_messages = []  # messages with no parent and no children

    # First pass: identify all parent messages that have replies
    parent_ids = set()
    for msg in filtered_messages:
      parent_id = msg.get("parentId")
      if parent_id:
        parent_ids.add(parent_id)
        if parent_id not in threads:
          threads[parent_id] = []
        threads[parent_id].append(msg)

    # Second pass: categorize messages
    parent_messages = {}  # parent_id -> parent message
    for msg in filtered_messages:
      msg_id = msg.get("id")
      parent_id = msg.get("parentId")

      if not parent_id:
        # This is a top-level message
        if msg_id in threads:
          # This message has replies, store it as a parent
          parent_messages[msg_id] = msg
        else:
          # Standalone message with no replies
          standalone_messages.append(msg)

    # Create documents for threads (parent + all replies)
    for parent_id, replies in threads.items():
      parent_msg = parent_messages.get(parent_id)
      if parent_msg:
        # Sort replies chronologically
        sorted_replies = sorted(replies, key=lambda m: m.get("created", ""))
        doc = self._create_thread_document(parent_msg, sorted_replies, space_id, space_name, datasource_id, ingestor_id)
        if doc:
          documents.append(doc)
      else:
        # Parent message not found (might be outside our fetch window)
        # Treat replies as standalone messages
        for reply in replies:
          doc = self._create_message_document(reply, space_id, space_name, datasource_id, ingestor_id)
          if doc:
            documents.append(doc)

    # Create documents for standalone messages
    for msg in standalone_messages:
      doc = self._create_message_document(msg, space_id, space_name, datasource_id, ingestor_id)
      if doc:
        documents.append(doc)

    return documents

  def _create_thread_document(self, parent_msg: Dict, replies: List[Dict], space_id: str, space_name: str, datasource_id: str, ingestor_id: str) -> Optional[Document]:
    """Create a document from a parent message and all its replies."""
    parent_id = parent_msg.get("id", "")
    parent_email = parent_msg.get("personEmail", "Unknown")
    parent_text = parent_msg.get("text", "") or parent_msg.get("html", "")
    parent_created = parent_msg.get("created", "")

    if not parent_text:
      return None

    # Build thread content
    formatted_lines = []
    formatted_lines.append(f"# Thread in {space_name}\n\n")
    formatted_lines.append(f"**Started by:** {parent_email}\n")
    formatted_lines.append(f"**Time:** {iso_to_readable(parent_created)}\n")
    formatted_lines.append(f"**Replies:** {len(replies)}\n\n")

    # Parent message
    formatted_lines.append("## Original Message\n\n")
    formatted_lines.append(f"{parent_text}\n\n")

    # Add parent attachments
    parent_files = parent_msg.get("files", [])
    if parent_files:
      formatted_lines.append(f"**Attachments:** {len(parent_files)} file(s)\n\n")

    # Add replies
    if replies:
      formatted_lines.append("## Replies\n\n")
      for idx, reply in enumerate(replies, 1):
        reply_email = reply.get("personEmail", "Unknown")
        reply_text = reply.get("text", "") or reply.get("html", "")
        reply_created = reply.get("created", "")
        reply_files = reply.get("files", [])

        formatted_lines.append(f"### Reply {idx} by {reply_email}\n")
        formatted_lines.append(f"*{iso_to_readable(reply_created)}*\n\n")
        formatted_lines.append(f"{reply_text}\n\n")

        if reply_files:
          formatted_lines.append(f"**Attachments:** {len(reply_files)} file(s)\n\n")

    content = "".join(formatted_lines)

    # Create metadata
    thread_preview = parent_text[:100] if len(parent_text) > 100 else parent_text
    latest_time = max([r.get("created", "") for r in replies] + [parent_created])

    metadata = DocumentMetadata(
      datasource_id=datasource_id,
      ingestor_id=ingestor_id,
      document_type="webex_thread",
      document_ingested_at=int(time.time()),
      document_id=f"webex-thread-{space_id}-{parent_id}",
      title=f"Thread: {thread_preview}",
      description=f"Webex thread started by {parent_email} with {len(replies)} replies",
      is_structured_entity=False,
      fresh_until=0,
      metadata={
        "space_name": space_name,
        "space_id": space_id,
        "parent_id": parent_id,
        "parent_email": parent_email,
        "reply_count": len(replies),
        "created": parent_created,
        "latest_reply": latest_time,
        "has_files": len(parent_files) > 0,
        "type": "webex_thread",
        "source_uri": f"https://web.webex.com/spaces/{space_id}",
        "last_modified": iso_to_timestamp(latest_time),
      },
    )

    return Document(page_content=content, metadata=metadata.model_dump())

  def _create_message_document(self, msg: Dict, space_id: str, space_name: str, datasource_id: str, ingestor_id: str) -> Optional[Document]:
    """Create a document from a Webex message."""
    message_id = msg.get("id", "")
    person_email = msg.get("personEmail", "Unknown")
    text = msg.get("text", "")
    html = msg.get("html", "")
    created = msg.get("created", "")

    if not text and not html:
      return None

    # Use text content, fallback to HTML if text not available
    content_text = text or html

    # Format document content
    formatted_lines = []
    formatted_lines.append(f"# Message in {space_name}\n\n")
    formatted_lines.append(f"**From:** {person_email}\n")
    formatted_lines.append(f"**Time:** {iso_to_readable(created)}\n\n")
    formatted_lines.append(f"{content_text}\n\n")

    # Add file attachments info if present
    files = msg.get("files", [])
    if files:
      formatted_lines.append(f"**Attachments:** {len(files)} file(s)\n")
      for file_url in files:
        formatted_lines.append(f"- {file_url}\n")

    content = "".join(formatted_lines)

    # Create metadata
    message_preview = content_text[:100] if len(content_text) > 100 else content_text
    metadata = DocumentMetadata(
      datasource_id=datasource_id,
      ingestor_id=ingestor_id,
      document_type="webex_message",
      document_ingested_at=int(time.time()),
      document_id=f"webex-message-{space_id}-{message_id}",
      title=f"Message: {message_preview}",
      description=f"Webex message from {person_email}",
      is_structured_entity=False,
      fresh_until=0,
      metadata={"space_name": space_name, "space_id": space_id, "message_id": message_id, "person_email": person_email, "created": created, "has_files": len(files) > 0, "type": "webex_message", "source_uri": f"https://web.webex.com/spaces/{space_id}", "last_modified": iso_to_timestamp(created)},
    )

    return Document(page_content=content, metadata=metadata.model_dump())


async def sync_webex_spaces(client: Client):
  """Bootstrap and sync Webex spaces still managed by legacy env config."""

  # Read config first so DB-managed sources do not require WEBEX_SPACES.
  bot_name = os.environ.get("WEBEX_BOT_NAME", "webex")
  spaces = configured_spaces()
  if not spaces:
    logger.warning("No spaces configured (WEBEX_SPACES not set or empty) — skipping sync")
    return

  webex_token = os.environ.get("WEBEX_ACCESS_TOKEN")
  if not webex_token:
    logger.warning("WEBEX_ACCESS_TOKEN not set — skipping sync")
    return

  # Initialize Webex syncer
  syncer = WebexSpaceSyncer(webex_token)

  # Load timestamps from previous runs (stored in datasource metadata)
  existing_datasources = await client.list_datasources(ingestor_id=client.ingestor_id)
  existing_by_id = {ds.datasource_id: ds for ds in existing_datasources}
  timestamp_map = {}
  for ds in existing_datasources:
    if ds.metadata and "last_message_time" in ds.metadata:
      # Extract space_id from datasource_id (format: webex-space-{space_id})
      space_id = ds.datasource_id.replace("webex-space-", "")
      timestamp_map[space_id] = ds.metadata["last_message_time"]

  # Process each space
  for space_id, config in spaces.items():
    space_name = config.get("name", space_id)
    include_bots = config.get("include_bots", False)

    logger.info(f"Processing space: '{space_name}' (ID: {space_id})")

    # Create or update datasource
    datasource_id = f"webex-space-{space_id}"
    existing = existing_by_id.get(datasource_id)
    if existing and (existing.metadata or {}).get("config_managed") is True:
      logger.debug(
        f"Skipping legacy WEBEX_SPACES config for database-managed datasource {datasource_id}"
      )
      continue
    reload_interval = configured_reload_interval(config, existing)
    if (
      existing
      and existing.last_updated
      and int(time.time()) - existing.last_updated < reload_interval
    ):
      logger.debug(f"Skipping '{space_name}': datasource refresh is not due")
      continue
    last_message_time = timestamp_map.get(space_id)

    # Fetch messages
    messages, newest_time = syncer.fetch_space_messages(space_id, space_name, last_message_time)

    # Always persist the check, including when the space has no new messages,
    # so smart scheduling does not continuously treat it as overdue.
    datasource = DataSourceInfo(
      datasource_id=datasource_id,
      name=f"Webex: {space_name}",
      ingestor_id=client.ingestor_id or "",
      description=f"Webex messages from space '{space_name}'",
      source_type="webex",
      last_updated=int(time.time()),
      default_chunk_size=existing.default_chunk_size if existing else 10000,
      default_chunk_overlap=existing.default_chunk_overlap if existing else 2000,
      reload_interval=reload_interval,
      creator_subject=existing.creator_subject if existing else None,
      owner_subject=existing.owner_subject if existing else None,
      owner_team_slug=existing.owner_team_slug if existing else None,
      shared_with_teams=existing.shared_with_teams if existing else [],
      search_with_teams=existing.search_with_teams if existing else [],
      metadata={
        **((existing.metadata or {}) if existing else {}),
        "space_id": space_id,
        "space_name": space_name,
        "last_message_time": newest_time if newest_time else last_message_time,
        "bot_name": bot_name,
        "include_bots": include_bots,
      },
    )
    await client.upsert_datasource(datasource)

    if not messages:
      logger.info(f"No new messages for space '{space_name}'")
      continue

    # Convert messages to documents
    documents = syncer.group_messages_into_documents(messages, space_id, space_name, include_bots, datasource_id, client.ingestor_id or "")

    if not documents:
      logger.info(f"No documents created for space '{space_name}'")
      continue

    logger.info(f"Created {len(documents)} documents for space '{space_name}'")

    # Create job
    job_response = await client.create_job(datasource_id=datasource_id, job_status=JobStatus.IN_PROGRESS, message=f"Ingesting {len(documents)} messages from space '{space_name}'", total=len(documents))
    job_id = job_response["job_id"]

    try:
      fresh_until = get_fresh_until(reload_interval)
      await client.ingest_documents(job_id=job_id, datasource_id=datasource_id, documents=documents, fresh_until=fresh_until)

      # Update job status
      await client.update_job(job_id=job_id, job_status=JobStatus.COMPLETED, message=f"Successfully ingested {len(documents)} documents from space '{space_name}'")

      logger.info(f"✓ Successfully ingested {len(documents)} documents from space '{space_name}'")

    except Exception as e:
      logger.error(f"Error ingesting documents for space '{space_name}': {e}")
      await client.add_job_error(job_id, [str(e)])
      await client.update_job(job_id=job_id, job_status=JobStatus.FAILED, message=f"Failed to ingest documents: {str(e)}")


async def process_space_ingestion(
  client: Client,
  job_manager: JobManager,
  ingest_request: WebexIngestRequest,
  job_id: str,
) -> None:
  """Process on-demand space ingestion from Redis (server already created datasource+job)."""
  try:
    datasource_id = f"webex-space-{ingest_request.space_id}"

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

    space_name = ingest_request.space_name or (datasource_info.metadata or {}).get("space_name", ingest_request.space_id)

    await job_manager.upsert_job(job_id=job_id, status=JobStatus.IN_PROGRESS, message=f"Starting Webex space ingestion for '{space_name}'")
    logger.info(f"Processing job: {job_id} for datasource: {datasource_id}")

    webex_token = os.environ.get("WEBEX_ACCESS_TOKEN")
    if not webex_token:
      error_msg = "WEBEX_ACCESS_TOKEN not set"
      logger.error(error_msg)
      await job_manager.upsert_job(job_id=job_id, status=JobStatus.FAILED, message=error_msg)
      return

    syncer = WebexSpaceSyncer(webex_token)

    messages, newest_time = syncer.fetch_space_messages(
      ingest_request.space_id,
      space_name,
      None,
      raise_on_error=True,
    )

    datasource_info.last_updated = int(time.time())
    if datasource_info.metadata is None:
      datasource_info.metadata = {}
    datasource_info.metadata.update(
      {
        "space_id": ingest_request.space_id,
        "space_name": space_name,
        "last_message_time": newest_time,
        "include_bots": ingest_request.include_bots,
      }
    )
    await client.upsert_datasource(datasource_info)

    if not messages:
      await job_manager.upsert_job(job_id=job_id, status=JobStatus.COMPLETED, message=f"No messages found for '{space_name}'")
      return

    documents = syncer.group_messages_into_documents(messages, ingest_request.space_id, space_name, ingest_request.include_bots, datasource_id, client.ingestor_id or "")

    if not documents:
      await job_manager.upsert_job(job_id=job_id, status=JobStatus.COMPLETED, message=f"No documents created for '{space_name}'")
      return

    await job_manager.upsert_job(job_id=job_id, total=len(documents), message=f"Ingesting {len(documents)} messages from '{space_name}'")

    fresh_until = get_fresh_until(datasource_info.reload_interval)
    await client.ingest_documents(job_id=job_id, datasource_id=datasource_id, documents=documents, fresh_until=fresh_until)

    await job_manager.upsert_job(job_id=job_id, status=JobStatus.COMPLETED, message=f"Successfully ingested {len(documents)} documents from '{space_name}'")
    logger.info(f"✓ Successfully ingested {len(documents)} documents from '{space_name}'")

  except Exception as e:
    error_msg = f"Error processing Webex space {ingest_request.space_id}: {str(e)}"
    logger.error(error_msg)
    logger.error(traceback.format_exc())

    try:
      if job_id:
        await job_manager.add_error_msg(job_id, error_msg)
    except Exception as status_error:
      logger.warning(
        f"Failed to record the Webex ingestion error for job {job_id}: {status_error}"
      )

    raise


async def reload_datasource(
  client: Client,
  job_manager: JobManager,
  datasource_info: DataSourceInfo,
  job_id: str | None = None,
) -> None:
  """Reload a single Webex space datasource (incremental sync since its stored last_message_time)."""
  try:
    metadata = datasource_info.metadata or {}
    space_id = metadata.get("space_id", datasource_info.datasource_id.replace("webex-space-", ""))
    space_name = metadata.get("space_name", space_id)
    last_message_time = metadata.get("last_message_time")
    include_bots = metadata.get("include_bots", False)

    webex_token = os.environ.get("WEBEX_ACCESS_TOKEN")
    if not webex_token:
      raise RuntimeError("WEBEX_ACCESS_TOKEN not set")

    logger.info(f"Reloading Webex space datasource: {datasource_info.datasource_id}")
    if job_id is not None:
      await job_manager.upsert_job(
        job_id,
        status=JobStatus.IN_PROGRESS,
        message=f"Reloading Webex space '{space_name}'",
      )

    syncer = WebexSpaceSyncer(webex_token)

    messages, newest_time = syncer.fetch_space_messages(
      space_id,
      space_name,
      last_message_time,
      raise_on_error=job_id is not None,
    )

    datasource_info.last_updated = int(time.time())
    datasource_info.metadata = {**metadata, "last_message_time": newest_time if newest_time else last_message_time}
    await client.upsert_datasource(datasource_info)

    if not messages:
      logger.info(f"No new messages for '{space_name}' during reload")
      if job_id is not None:
        await job_manager.upsert_job(
          job_id,
          status=JobStatus.COMPLETED,
          message=f"No new messages found for '{space_name}'",
        )
      return

    documents = syncer.group_messages_into_documents(messages, space_id, space_name, include_bots, datasource_info.datasource_id, client.ingestor_id or "")

    if not documents:
      logger.info(f"No documents created for '{space_name}' during reload")
      if job_id is not None:
        await job_manager.upsert_job(
          job_id,
          status=JobStatus.COMPLETED,
          message=f"No new documents created for '{space_name}'",
        )
      return

    if job_id is None:
      job_response = await client.create_job(datasource_id=datasource_info.datasource_id, job_status=JobStatus.IN_PROGRESS, message=f"Reloading {len(documents)} messages from '{space_name}'", total=len(documents))
      job_id = job_response["job_id"]
    else:
      await job_manager.upsert_job(
        job_id,
        total=len(documents),
        message=f"Reloading {len(documents)} messages from '{space_name}'",
      )

    fresh_until = get_fresh_until(datasource_info.reload_interval)
    await client.ingest_documents(job_id=job_id, datasource_id=datasource_info.datasource_id, documents=documents, fresh_until=fresh_until)
    await client.update_job(job_id=job_id, job_status=JobStatus.COMPLETED, message=f"Successfully reloaded {len(documents)} documents from '{space_name}'")
    logger.info(f"✓ Successfully reloaded {len(documents)} documents from '{space_name}'")

  except Exception as e:
    logger.error(f"Error reloading {datasource_info.datasource_id}: {e}")
    logger.error(traceback.format_exc())
    if job_id:
      await job_manager.add_error_msg(job_id, str(e))
    raise


async def redis_listener(client: Client):
  """Run Webex commands through the shared per-ingestor listener."""

  async def reconcile_legacy_config() -> None:
    """Expose legacy connector options immediately for config migration."""
    spaces = configured_spaces()
    if not spaces:
      return
    bot_name = os.environ.get("WEBEX_BOT_NAME", "webex")
    for datasource in await client.list_datasources(ingestor_id=client.ingestor_id):
      metadata = datasource.metadata or {}
      if metadata.get("config_managed") is True:
        continue
      space_id = metadata.get("space_id") or datasource.datasource_id.removeprefix(
        "webex-space-"
      )
      config = spaces.get(space_id)
      if not isinstance(config, dict):
        continue
      datasource.reload_interval = configured_reload_interval(config, datasource)
      datasource.metadata = {
        **metadata,
        "space_id": space_id,
        "space_name": config.get("name", space_id),
        "bot_name": bot_name,
        "include_bots": config.get("include_bots", False),
      }
      await client.upsert_datasource(datasource)

  await run_ingestor_listener(
    client,
    ingest_command=WebexIngestorCommand.INGEST_SPACE,
    ingest_model=WebexIngestRequest,
    ingest_handler=process_space_ingestion,
    reload_all_command=WebexIngestorCommand.RELOAD_ALL,
    reload_all_handler=reload_all_webex_spaces,
    reload_datasource_command=WebexIngestorCommand.RELOAD_DATASOURCE,
    reload_model=WebexReloadRequest,
    reload_handler=reload_datasource,
    max_tasks=MAX_INGESTION_TASKS,
    describe_ingest=lambda request: f"Webex space ingestion: {request.space_id}",
    on_startup=reconcile_legacy_config,
  )


async def periodic_reload(client: Client) -> None:
  """Refresh both legacy env sources and UI/database-managed sources."""
  await sync_webex_spaces(client)
  await reload_persisted_datasources(
    client,
    reload_datasource,
    config_managed_only=True,
  )


async def reload_all_webex_spaces(client: Client) -> None:
  """Force a reload of every Webex datasource assigned to this worker."""
  await reload_persisted_datasources(client, reload_datasource, due_only=False)


def main():
  """Main entry point for the Webex ingestor"""

  bot_name = os.environ.get("WEBEX_BOT_NAME", "webex")
  spaces = configured_spaces()

  # The on-demand queue and persisted per-datasource schedules are independent
  # from deployment configuration.
  (
    IngestorBuilder()
    .name(f"webex-{bot_name}")
    .type("webex")
    .description(f"Webex ingestor for bot {bot_name}")
    .metadata({"bot_name": bot_name, "init_delay": init_delay, "spaces": spaces})
    .sync_with_fn(periodic_reload)
    .with_startup(redis_listener)
    .schedule_from_datasources()
    .with_init_delay(init_delay)
    .run()
  )


if __name__ == "__main__":
  main()
