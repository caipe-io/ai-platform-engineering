#!/usr/bin/env python3
"""Slack conversation ingestor for persisted and on-demand RAG datasources."""

import os
import time
import traceback
from datetime import datetime
from typing import Dict, List, Optional
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
from langchain_core.documents import Document

from common.ingestor import IngestorBuilder, Client
from common.ingestor_listener import reload_persisted_datasources, run_ingestor_listener
from common.models.rag import DataSourceInfo, DocumentMetadata
from common.models.server import (
  SlackIngestRequest,
  SlackIngestorCommand,
  SlackReloadRequest,
)
from common.job_manager import JobStatus, JobManager
from common.utils import get_fresh_until, get_logger

logger = get_logger(__name__)


init_delay = int(os.environ.get("INIT_DELAY_SECONDS", "0"))

MAX_INGESTION_TASKS = int(os.environ.get("SLACK_MAX_INGESTION_TASKS", "5"))


def get_message_fresh_until(message_ts: str, lookback_days: int) -> int:
  """Calculate fresh_until based on when the message was posted.

  A message should remain in the system until it falls outside the lookback window.
  For example, with lookback_days=30, a message posted 5 days ago expires in 25 days.
  """
  return int(float(message_ts)) + (lookback_days * 86400)


def ts_to_readable(timestamp):
  """Convert Unix timestamp to human-readable datetime string."""
  try:
    if isinstance(timestamp, str):
      timestamp = float(timestamp)
    dt = datetime.fromtimestamp(timestamp)
    return dt.strftime("%Y-%m-%d %H:%M:%S")
  except (ValueError, TypeError):
    return "invalid"


class SlackChannelSyncer:
  """Handles syncing messages from a single Slack channel"""

  def __init__(self, slack_client: WebClient, workspace_url: str):
    self.slack_client = slack_client
    self.workspace_url = workspace_url
    self.timestamps: Dict[str, str] = {}

  def _api_call_with_retry(self, api_func, max_retries=10, base_delay=1.0, **kwargs):
    """Make Slack API calls with exponential backoff retry on rate limits."""
    api_name = api_func.__name__
    for attempt in range(max_retries + 1):
      try:
        response = api_func(**kwargs)
        return response
      except SlackApiError as e:
        error_code = e.response.get("error", "")
        if error_code == "ratelimited" and attempt < max_retries:
          retry_after = int(e.response.headers.get("Retry-After", base_delay * (2**attempt)))
          logger.warning(f"{api_name} rate limited. Waiting {retry_after}s before retry {attempt + 1}/{max_retries}")
          time.sleep(retry_after)
          continue
        raise
    raise SlackApiError(f"Max retries exceeded for {api_name}", response={})

  def fetch_channel_messages(
    self,
    channel_id: str,
    channel_name: str,
    lookback_days: int,
    last_ts: Optional[str] = None,
    raise_on_error: bool = False,
  ) -> tuple[List[Dict], str]:
    """Fetch messages from a Slack channel since last sync."""
    messages = []

    # Calculate lookback timestamp
    if last_ts:
      oldest_ts = last_ts
      logger.info(f"Incremental sync for #{channel_name} - using timestamp: {oldest_ts} ({ts_to_readable(oldest_ts)})")
    elif lookback_days > 0:
      lookback_seconds = lookback_days * 24 * 60 * 60
      current_time = round(time.time(), 6)
      oldest_ts = str(round(current_time - lookback_seconds, 6))
      logger.info(f"First sync for #{channel_name} - looking back {lookback_days} days")
    else:
      oldest_ts = "0"
      logger.info(f"First sync for #{channel_name} - fetching all history")

    try:
      # Verify bot has access to channel
      try:
        channel_info = self.slack_client.conversations_info(channel=channel_id)
        if channel_info.get("ok"):
          channel = channel_info.get("channel", {})
          logger.debug(f"Channel verified - name: {channel.get('name')}, is_member: {channel.get('is_member')}")
      except Exception as e:
        logger.warning(f"Channel verification failed: {e}")

      # Fetch conversations
      cursor = None
      newest_ts = oldest_ts

      while True:
        response = self._api_call_with_retry(self.slack_client.conversations_history, channel=channel_id, oldest=oldest_ts, limit=200, cursor=cursor)

        batch_messages = response.get("messages", [])
        logger.debug(f"Fetched {len(batch_messages)} messages in this batch")

        messages.extend(batch_messages)

        # Track newest timestamp
        for msg in batch_messages:
          if msg.get("ts", "0") > newest_ts:
            newest_ts = msg["ts"]

        # Check if there are more messages
        response_metadata = response.get("response_metadata", {})
        cursor = response_metadata.get("next_cursor")
        if not cursor:
          break

      logger.info(f"Fetched {len(messages)} messages from #{channel_name}")

      # Fetch thread replies for messages that have them
      enriched_messages = []
      for msg in messages:
        enriched_msg = msg.copy()

        if msg.get("thread_ts") and msg.get("thread_ts") == msg.get("ts"):
          # This is a parent message with replies
          try:
            replies_response = self._api_call_with_retry(self.slack_client.conversations_replies, channel=channel_id, ts=msg["ts"])
            enriched_msg["thread_replies"] = replies_response.get("messages", [])[1:]  # Exclude parent
            logger.debug(f"Fetched {len(enriched_msg['thread_replies'])} thread replies for message {msg['ts']}")
          except SlackApiError as e:
            logger.warning(f"Could not fetch thread replies: {e}")

        enriched_messages.append(enriched_msg)

      return enriched_messages, newest_ts

    except SlackApiError as e:
      logger.error(f"Error fetching messages from {channel_name}: {e}")
      if raise_on_error:
        raise
      return [], oldest_ts

  def group_messages_by_thread(self, messages: List[Dict], channel_id: str, channel_name: str, include_bots: bool, datasource_id: str, ingestor_id: str, lookback_days: int = 30) -> List[Document]:
    """Group messages into thread documents for RAG ingestion."""
    documents = []

    # Separate thread parent messages from standalone messages
    threads = {}  # thread_ts -> list of messages
    standalone = []  # messages without threads

    for msg in sorted(messages, key=lambda m: m.get("ts", "0")):
      # Skip system messages
      if msg.get("subtype") in ["channel_join", "channel_leave"]:
        continue

      # Skip bot messages if not included for this channel
      if not include_bots and (msg.get("bot_id") or msg.get("subtype") == "bot_message"):
        continue

      thread_ts = msg.get("thread_ts")

      # Check if this is a parent message with replies
      if msg.get("thread_replies"):
        # This is a thread parent with replies - use the enriched thread_replies
        parent_thread_ts = msg.get("ts")
        threads[parent_thread_ts] = [msg] + msg.get("thread_replies", [])
      elif thread_ts:
        # Part of a thread (but not the parent)
        if thread_ts not in threads:
          threads[thread_ts] = []
        threads[thread_ts].append(msg)
      else:
        # Standalone message
        standalone.append(msg)

    # Create documents for threads
    for thread_ts, thread_messages in threads.items():
      doc = self._create_thread_document(thread_messages, channel_id, channel_name, thread_ts, datasource_id, ingestor_id, lookback_days)
      if doc:
        documents.append(doc)

    # Create documents for standalone messages
    for msg in standalone:
      doc = self._create_standalone_document(msg, channel_id, channel_name, datasource_id, ingestor_id, lookback_days)
      if doc:
        documents.append(doc)

    return documents

  def _create_thread_document(self, thread_messages: List[Dict], channel_id: str, channel_name: str, thread_ts: str, datasource_id: str, ingestor_id: str, lookback_days: int = 30) -> Optional[Document]:
    """Create a document from a thread of messages."""
    if not thread_messages:
      return None

    # Format thread content
    formatted_lines = []
    parent_msg = thread_messages[0]

    # Thread title/summary
    parent_text = parent_msg.get("text", "")[:100]  # First 100 chars as title
    formatted_lines.append(f"# Thread in #{channel_name}: {parent_text}\n\n")

    # Format each message in the thread
    for msg in thread_messages:
      user = msg.get("user", "Unknown")
      text = msg.get("text", "")
      ts = msg.get("ts", "0")
      dt = datetime.fromtimestamp(float(ts))

      # Build Slack message URL
      ts_clean = ts.replace(".", "")
      slack_url = f"{self.workspace_url}/archives/{channel_id}/p{ts_clean}"

      formatted_lines.append(f"**[{dt.strftime('%Y-%m-%d %H:%M:%S')}] {user}:**\n")
      formatted_lines.append(f"{text}\n")
      formatted_lines.append(f"[View in Slack]({slack_url})\n\n")

    content = "".join(formatted_lines)

    # Build thread URL (points to parent message)
    thread_ts_clean = thread_ts.replace(".", "")
    thread_url = f"{self.workspace_url}/archives/{channel_id}/p{thread_ts_clean}"

    # Create metadata
    metadata = DocumentMetadata(
      datasource_id=datasource_id,
      ingestor_id=ingestor_id,
      document_type="slack_thread",
      document_ingested_at=int(time.time()),
      document_id=f"slack-thread-{channel_id}-{thread_ts}",
      fresh_until=get_message_fresh_until(thread_messages[-1].get("ts", "0"), lookback_days),
      title=f"Thread: {parent_text}",
      metadata={
        "channel_name": channel_name,
        "channel_id": channel_id,
        "thread_ts": thread_ts,
        "message_count": len(thread_messages),
        "type": "slack_thread",
        "source_uri": thread_url,
        "last_modified": int(float(thread_messages[-1].get("ts", "0"))),
      },
    )

    logger.debug(f"Creating thread document for {channel_id} {thread_ts}: \n {metadata.model_dump()}")

    return Document(page_content=content, metadata=metadata.model_dump())

  def _create_standalone_document(self, msg: Dict, channel_id: str, channel_name: str, datasource_id: str, ingestor_id: str, lookback_days: int = 30) -> Optional[Document]:
    """Create a document from a standalone message."""
    user = msg.get("user", "Unknown")
    text = msg.get("text", "")
    ts = msg.get("ts", "0")

    if not text:
      return None

    dt = datetime.fromtimestamp(float(ts))

    # Build Slack message URL
    ts_clean = ts.replace(".", "")
    slack_url = f"{self.workspace_url}/archives/{channel_id}/p{ts_clean}"

    # Format content
    content = f"# Message in #{channel_name}\n\n"
    content += f"**[{dt.strftime('%Y-%m-%d %H:%M:%S')}] {user}:**\n"
    content += f"{text}\n"
    content += f"[View in Slack]({slack_url})\n"

    # Create metadata
    message_preview = text[:100] if len(text) > 100 else text
    metadata = DocumentMetadata(
      datasource_id=datasource_id,
      ingestor_id=ingestor_id,
      document_type="slack_message",
      document_ingested_at=int(time.time()),
      document_id=f"slack-message-{channel_id}-{ts}",
      title=f"Message: {message_preview}",
      fresh_until=get_message_fresh_until(ts, lookback_days),
      metadata={
        "channel_name": channel_name,
        "channel_id": channel_id,
        "ts": ts,
        "type": "slack_message",
        "source_uri": slack_url,
        "last_modified": int(float(ts)),
      },
    )

    return Document(page_content=content, metadata=metadata.model_dump())


async def process_channel_ingestion(
  client: Client,
  job_manager: JobManager,
  ingest_request: SlackIngestRequest,
  job_id: str,
) -> None:
  """Process on-demand channel ingestion from Redis (server already created datasource+job)."""
  try:
    datasource_id = f"slack-channel-{ingest_request.channel_id}"

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

    channel_name = ingest_request.channel_name or (datasource_info.metadata or {}).get("channel_name", ingest_request.channel_id)

    await job_manager.upsert_job(job_id=job_id, status=JobStatus.IN_PROGRESS, message=f"Starting Slack channel ingestion for #{channel_name}")
    logger.info(f"Processing job: {job_id} for datasource: {datasource_id}")

    slack_token = os.environ.get("SLACK_BOT_TOKEN")
    if not slack_token:
      error_msg = "SLACK_BOT_TOKEN not set"
      logger.error(error_msg)
      await job_manager.upsert_job(job_id=job_id, status=JobStatus.FAILED, message=error_msg)
      return

    workspace_url = os.environ.get("SLACK_WORKSPACE_URL", "https://slack.com")
    slack_client = WebClient(token=slack_token)
    syncer = SlackChannelSyncer(slack_client, workspace_url)

    messages, newest_ts = syncer.fetch_channel_messages(
      ingest_request.channel_id,
      channel_name,
      ingest_request.lookback_days,
      None,
      raise_on_error=True,
    )

    datasource_info.last_updated = int(time.time())
    if datasource_info.metadata is None:
      datasource_info.metadata = {}
    datasource_info.metadata.update(
      {
        "channel_id": ingest_request.channel_id,
        "channel_name": channel_name,
        "last_ts": newest_ts,
        "workspace_url": workspace_url,
        "lookback_days": ingest_request.lookback_days,
        "include_bots": ingest_request.include_bots,
      }
    )
    await client.upsert_datasource(datasource_info)

    if not messages:
      await job_manager.upsert_job(job_id=job_id, status=JobStatus.COMPLETED, message=f"No messages found for #{channel_name}")
      return

    documents = syncer.group_messages_by_thread(messages, ingest_request.channel_id, channel_name, ingest_request.include_bots, datasource_id, client.ingestor_id or "", ingest_request.lookback_days)

    if not documents:
      await job_manager.upsert_job(job_id=job_id, status=JobStatus.COMPLETED, message=f"No documents created for #{channel_name}")
      return

    await job_manager.upsert_job(job_id=job_id, total=len(documents), message=f"Ingesting {len(documents)} threads/messages from #{channel_name}")

    fresh_until = get_fresh_until(datasource_info.reload_interval)
    await client.ingest_documents(job_id=job_id, datasource_id=datasource_id, documents=documents, fresh_until=fresh_until)

    await job_manager.upsert_job(job_id=job_id, status=JobStatus.COMPLETED, message=f"Successfully ingested {len(documents)} documents from #{channel_name}")
    logger.info(f"✓ Successfully ingested {len(documents)} documents from #{channel_name}")

  except Exception as e:
    error_msg = f"Error processing Slack channel {ingest_request.channel_id}: {str(e)}"
    logger.error(error_msg)
    logger.error(traceback.format_exc())

    try:
      if job_id:
        await job_manager.add_error_msg(job_id, error_msg)
    except Exception as status_error:
      logger.warning(
        f"Failed to record the Slack ingestion error for job {job_id}: {status_error}"
      )

    raise


async def reload_datasource(
  client: Client,
  job_manager: JobManager,
  datasource_info: DataSourceInfo,
  job_id: str | None = None,
) -> None:
  """Reload a single Slack channel datasource (incremental sync since its stored last_ts)."""
  try:
    metadata = datasource_info.metadata or {}
    channel_id = metadata.get("channel_id", datasource_info.datasource_id.replace("slack-channel-", ""))
    channel_name = metadata.get("channel_name", channel_id)
    lookback_days = metadata.get("lookback_days", 30)
    last_ts = metadata.get("last_ts")
    include_bots = metadata.get("include_bots", False)
    workspace_url = metadata.get("workspace_url") or os.environ.get("SLACK_WORKSPACE_URL", "https://slack.com")

    slack_token = os.environ.get("SLACK_BOT_TOKEN")
    if not slack_token:
      raise RuntimeError("SLACK_BOT_TOKEN not set")

    logger.info(f"Reloading Slack channel datasource: {datasource_info.datasource_id}")
    if job_id is not None:
      await job_manager.upsert_job(
        job_id,
        status=JobStatus.IN_PROGRESS,
        message=f"Reloading Slack channel #{channel_name}",
      )

    slack_client = WebClient(token=slack_token)
    syncer = SlackChannelSyncer(slack_client, workspace_url)

    messages, newest_ts = syncer.fetch_channel_messages(
      channel_id,
      channel_name,
      lookback_days,
      last_ts,
      raise_on_error=job_id is not None,
    )

    datasource_info.last_updated = int(time.time())
    datasource_info.metadata = {**metadata, "last_ts": newest_ts if newest_ts else last_ts}
    await client.upsert_datasource(datasource_info)

    if not messages:
      logger.info(f"No new messages for #{channel_name} during reload")
      if job_id is not None:
        await job_manager.upsert_job(
          job_id,
          status=JobStatus.COMPLETED,
          message=f"No new messages found for #{channel_name}",
        )
      return

    documents = syncer.group_messages_by_thread(messages, channel_id, channel_name, include_bots, datasource_info.datasource_id, client.ingestor_id or "", lookback_days)

    if not documents:
      logger.info(f"No documents created for #{channel_name} during reload")
      if job_id is not None:
        await job_manager.upsert_job(
          job_id,
          status=JobStatus.COMPLETED,
          message=f"No new documents created for #{channel_name}",
        )
      return

    if job_id is None:
      job_response = await client.create_job(datasource_id=datasource_info.datasource_id, job_status=JobStatus.IN_PROGRESS, message=f"Reloading {len(documents)} threads/messages from #{channel_name}", total=len(documents))
      job_id = job_response["job_id"]
    else:
      await job_manager.upsert_job(
        job_id,
        total=len(documents),
        message=f"Reloading {len(documents)} threads/messages from #{channel_name}",
      )

    fresh_until = get_fresh_until(datasource_info.reload_interval)
    await client.ingest_documents(job_id=job_id, datasource_id=datasource_info.datasource_id, documents=documents, fresh_until=fresh_until)
    await client.update_job(job_id=job_id, job_status=JobStatus.COMPLETED, message=f"Successfully reloaded {len(documents)} documents from #{channel_name}")
    logger.info(f"✓ Successfully reloaded {len(documents)} documents from #{channel_name}")

  except Exception as e:
    logger.error(f"Error reloading {datasource_info.datasource_id}: {e}")
    logger.error(traceback.format_exc())
    if job_id:
      await job_manager.add_error_msg(job_id, str(e))
    raise


async def redis_listener(client: Client):
  """Run Slack commands through the shared per-ingestor listener."""

  await run_ingestor_listener(
    client,
    ingest_command=SlackIngestorCommand.INGEST_CHANNEL,
    ingest_model=SlackIngestRequest,
    ingest_handler=process_channel_ingestion,
    reload_all_command=SlackIngestorCommand.RELOAD_ALL,
    reload_all_handler=reload_all_slack_channels,
    reload_datasource_command=SlackIngestorCommand.RELOAD_DATASOURCE,
    reload_model=SlackReloadRequest,
    reload_handler=reload_datasource,
    max_tasks=MAX_INGESTION_TASKS,
    describe_ingest=lambda request: f"Slack channel ingestion: {request.channel_id}",
  )


async def periodic_reload(client: Client) -> None:
  """Refresh persisted Slack datasources whose interval is due."""
  await reload_persisted_datasources(client, reload_datasource)


async def reload_all_slack_channels(client: Client) -> None:
  """Force a reload of every Slack datasource assigned to this worker."""
  await reload_persisted_datasources(client, reload_datasource, due_only=False)


def main():
  """Main entry point for the Slack ingestor"""

  bot_name = os.environ.get("SLACK_BOT_NAME", "slack")
  workspace_url = os.environ.get("SLACK_WORKSPACE_URL", "https://slack.com")

  # The on-demand queue and persisted per-datasource schedules share one worker.
  (
    IngestorBuilder()
    .name(f"slack-{bot_name}")
    .type("slack")
    .description(f"Slack ingestor for {workspace_url}")
    .metadata(
      {
        "workspace_url": workspace_url,
        "bot_name": bot_name,
        "init_delay": init_delay,
      }
    )
    .sync_with_fn(periodic_reload)
    .with_startup(redis_listener)
    .schedule_from_datasources()
    .with_init_delay(init_delay)
    .run()
  )


if __name__ == "__main__":
  main()
