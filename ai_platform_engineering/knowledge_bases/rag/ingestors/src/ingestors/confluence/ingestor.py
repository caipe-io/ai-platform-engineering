"""Confluence RAG ingestor - syncs pages from Confluence spaces.

Mirrors the webloader ingestor pattern:
- Redis listener handles on-demand page ingestion
- Periodic reload refreshes all configured spaces
- UI sources use one root page per datasource; legacy config can still model a
  whole space as one datasource
"""

import os
import json
import re
import time
import traceback
from typing import List, Dict, Optional, Any
from redis.asyncio import Redis
from common.ingestor import IngestorBuilder, Client
from common.ingestor_listener import reload_persisted_datasources, run_ingestor_listener
from common.models.rag import DataSourceInfo
from common.models.server import (
  ConfluenceIngestRequest,
  ConfluenceIngestorCommand,
  ConfluenceReloadRequest,
)
from common.job_manager import JobStatus, JobManager
from common.constants import (
  CONFLUENCE_INGESTOR_NAME,
  CONFLUENCE_INGESTOR_TYPE,
  DEFAULT_RELOAD_INTERVAL,
)
from common.utils import get_logger
from loader import ConfluenceLoader, generate_datasource_id

logger = get_logger(__name__)

# Redis configuration
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
redis_client = Redis.from_url(REDIS_URL, decode_responses=True)

# Confluence configuration
CONFLUENCE_URL = os.environ.get("CONFLUENCE_URL")
if not CONFLUENCE_URL:
  raise ValueError("CONFLUENCE_URL environment variable is required")

CONFLUENCE_USERNAME = os.environ.get("CONFLUENCE_USERNAME")
if not CONFLUENCE_USERNAME:
  raise ValueError("CONFLUENCE_USERNAME environment variable is required")

CONFLUENCE_TOKEN = os.environ.get("CONFLUENCE_TOKEN") or os.environ.get("CONFLUENCE_API_TOKEN")
if not CONFLUENCE_TOKEN:
  raise ValueError("CONFLUENCE_TOKEN (or CONFLUENCE_API_TOKEN) environment variable is required")

CONFLUENCE_SSL_VERIFY = os.environ.get("CONFLUENCE_SSL_VERIFY", "true").lower() == "true"
CONFLUENCE_SPACES = os.environ.get("CONFLUENCE_SPACES", "")
MAX_CONCURRENCY = int(os.environ.get("CONFLUENCE_MAX_CONCURRENCY", "5"))
MAX_INGESTION_TASKS = int(os.environ.get("CONFLUENCE_MAX_INGESTION_TASKS", "5"))
PREVIEW_MAX_ITEMS = max(1, min(int(os.getenv("INGESTOR_PREVIEW_MAX_ITEMS", "100")), 500))


def _get_title_patterns(metadata: Optional[Dict[str, Any]]) -> Dict[str, List[str]]:
  """Extract title filter patterns from datasource metadata.

  Checks both the top-level metadata and the nested confluence_ingest_request.

  Returns:
      Dict with 'allowed_title_patterns' and 'denied_title_patterns' lists.
  """
  if not metadata:
    return {"allowed_title_patterns": [], "denied_title_patterns": []}

  # Patterns can live at top level or inside the stored ingest request
  allowed = metadata.get("allowed_title_patterns") or []
  denied = metadata.get("denied_title_patterns") or []

  # Also check the stored ingest request (server stores the full request model)
  ingest_req = metadata.get("confluence_ingest_request", {})
  if ingest_req:
    allowed = allowed or ingest_req.get("allowed_title_patterns") or []
    denied = denied or ingest_req.get("denied_title_patterns") or []

  return {"allowed_title_patterns": allowed, "denied_title_patterns": denied}


def _create_datasource_info(
  datasource_id: str,
  ingestor_id: str,
  space_key: str,
  description: str,
  page_configs: Optional[List[Dict[str, Any]]] = None,
  allowed_title_patterns: Optional[List[str]] = None,
  denied_title_patterns: Optional[List[str]] = None,
) -> DataSourceInfo:
  """Create DataSourceInfo with page_configs metadata structure."""
  metadata: Dict[str, Any] = {
    "space_key": space_key,
    "page_configs": page_configs or [],
    "confluence_url": CONFLUENCE_URL,
  }
  if allowed_title_patterns:
    metadata["allowed_title_patterns"] = allowed_title_patterns
  if denied_title_patterns:
    metadata["denied_title_patterns"] = denied_title_patterns

  return DataSourceInfo(
    datasource_id=datasource_id,
    name=f"Confluence: {space_key}",
    ingestor_id=ingestor_id,
    description=description,
    source_type="confluence",
    metadata=metadata,
    last_updated=int(time.time()),
    default_chunk_size=1000,
    default_chunk_overlap=200,
    reload_interval=DEFAULT_RELOAD_INTERVAL,
  )


def parse_confluence_spaces_json(spaces_config: str) -> Dict[str, List[Dict[str, Any]]]:
  """Parse CONFLUENCE_SPACES environment variable as JSON.

  Format: JSON object mapping space keys to page configurations.
  {
      "SPACE_KEY": [
          {"page_id": 123, "source": "url", "get_child_pages": false},
          {"page_id": 456, "get_child_pages": true}
      ],
      "SPACE2": []
  }

  Empty array = fetch entire space.

  Returns:
      Dict[space_key, List[page_configs]]

  Raises:
      ValueError: If JSON is invalid or schema doesn't match
  """
  if not spaces_config:
    return {}

  try:
    config = json.loads(spaces_config)
  except json.JSONDecodeError as e:
    raise ValueError(f"CONFLUENCE_SPACES must be valid JSON: {e}")

  if not isinstance(config, dict):
    raise ValueError("CONFLUENCE_SPACES must be a JSON object")

  # Validate structure
  for space_key, page_configs in config.items():
    if page_configs is None:
      # Convert None to empty list
      config[space_key] = []
    elif isinstance(page_configs, list):
      for idx, page_config in enumerate(page_configs):
        if not isinstance(page_config, dict):
          raise ValueError(f"Space {space_key} page {idx}: must be object, got {type(page_config)}")

        # Validate required fields
        if "page_id" not in page_config:
          raise ValueError(f"Space {space_key} page {idx}: missing required 'page_id' field")

        # Coerce page_id to string
        page_config["page_id"] = str(page_config["page_id"])

        # Set defaults for optional fields
        if "get_child_pages" not in page_config:
          page_config["get_child_pages"] = False

        if "source" not in page_config:
          page_config["source"] = None
    else:
      raise ValueError(f"Space {space_key}: value must be list or null, got {type(page_configs)}")

  return config


async def track_fetch_failures(job_manager: JobManager, job_id: str, failed_pages: List[tuple[str, str]]) -> None:
  """Track fetch failures in job manager without incrementing progress.

  Progress is tracked separately when pages are processed.

  Args:
      job_manager: Job manager instance
      job_id: Job ID to update
      failed_pages: List of (page_id, error_msg) tuples
  """
  for failed_page_id, error_msg in failed_pages:
    await job_manager.increment_failure(job_id=job_id, message=error_msg)


async def process_page_ingestion(
  client: Client,
  job_manager: JobManager,
  ingest_request: ConfluenceIngestRequest,
  job_id: str,
) -> None:
  """Process on-demand page ingestion from Redis (server already created datasource)."""
  try:
    # Parse URL to extract space_key and page_id
    confluence_match = re.search(r"/spaces/([^/]+)/pages/(\d+)", ingest_request.url)
    if not confluence_match:
      raise ValueError(f"Invalid Confluence URL format: {ingest_request.url}")

    space_key = confluence_match.group(1)
    page_id = confluence_match.group(2)

    # UI-created sources are page-scoped. The explicit ID keeps retrying an
    # existing legacy space-level source compatible after page-scoped IDs were
    # introduced.
    datasource_id = (
      ingest_request.preprovisioned_datasource_id
      or generate_datasource_id(CONFLUENCE_URL, space_key, page_id)
    )

    # Fetch the exact page-scoped or legacy space-level datasource.
    datasources = await client.list_datasources(ingestor_id=client.ingestor_id)
    datasource_info = next((ds for ds in datasources if ds.datasource_id == datasource_id), None)

    if not datasource_info:
      error_msg = f"Datasource not found: {datasource_id}"
      logger.error(error_msg)
      raise ValueError(error_msg)

    job = await job_manager.get_job(job_id)
    if not job or job.datasource_id != datasource_id:
      raise ValueError(f"Job {job_id} does not belong to datasource {datasource_id}")

    # Check if job was terminated before we started
    if job.status == JobStatus.TERMINATED:
      logger.info(f"Job {job_id} was already terminated, skipping processing")
      return

    # Update job status to IN_PROGRESS
    await job_manager.upsert_job(
      job_id=job_id,
      status=JobStatus.IN_PROGRESS,
      message=f"Starting Confluence page ingestion for {ingest_request.url}",
    )
    logger.info(f"Processing job: {job_id} for datasource: {datasource_id}")

    # Extract title patterns from datasource metadata and ingest request
    title_patterns = _get_title_patterns(datasource_info.metadata)
    # Ingest request patterns take precedence (they're the latest user intent)
    allowed = ingest_request.allowed_title_patterns or title_patterns["allowed_title_patterns"]
    denied = ingest_request.denied_title_patterns or title_patterns["denied_title_patterns"]

    # Use loader to fetch and ingest pages
    async with ConfluenceLoader(
      rag_client=client,
      job_manager=job_manager,
      datasource_info=datasource_info,
      confluence_url=CONFLUENCE_URL,
      username=CONFLUENCE_USERNAME,
      token=CONFLUENCE_TOKEN,
      verify_ssl=CONFLUENCE_SSL_VERIFY,
      max_concurrency=MAX_CONCURRENCY,
      allowed_title_patterns=allowed,
      denied_title_patterns=denied,
    ) as loader:
      # Build page config for this ingestion
      page_configs = [{"page_id": page_id, "get_child_pages": ingest_request.get_child_pages}]
      pages, failed_pages = await loader.load_pages(space_key, page_configs)

      # Update job with total count (successful + failed)
      total_count = len(pages) + len(failed_pages)
      await job_manager.upsert_job(
        job_id=job_id,
        total=total_count,
        message=f"Loaded {len(pages)} pages, {len(failed_pages)} failed",
      )

      # Track fetch failures
      await track_fetch_failures(job_manager, job_id, failed_pages)

      # If no pages succeeded, mark job as failed
      if not pages:
        await job_manager.upsert_job(
          job_id=job_id,
          status=JobStatus.FAILED,
          message=f"All page fetches failed for {ingest_request.url}",
        )
        logger.warning(f"All page fetches failed for {ingest_request.url}")
        return

      # Ingest the pages
      await loader.ingest_pages(pages, job_id)

    # Update datasource last_updated timestamp
    datasource_info.last_updated = int(time.time())
    await client.upsert_datasource(datasource_info)

    logger.info(f"Completed page ingestion for {ingest_request.url}")

  except Exception as e:
    error_msg = f"Error processing Confluence page {ingest_request.url}: {str(e)}"
    logger.error(error_msg)
    logger.error(traceback.format_exc())

    # Try to update job with error if we have job_id
    try:
      if "job_id" in locals():
        await job_manager.add_error_msg(job_id, error_msg)
    except Exception as status_error:
      logger.warning(
        f"Failed to record the Confluence ingestion error for job "
        f"{locals().get('job_id')}: {status_error}"
      )

    raise


async def preview_page_ingestion(
  client: Client,
  ingest_request: ConfluenceIngestRequest,
) -> dict[str, object]:
  """Resolve the real page selection and title filters without ingesting."""
  confluence_match = re.search(r"/spaces/([^/]+)/pages/(\d+)", ingest_request.url)
  if not confluence_match:
    raise ValueError(f"Invalid Confluence URL format: {ingest_request.url}")
  space_key = confluence_match.group(1)
  page_id = confluence_match.group(2)
  datasource_info = DataSourceInfo(
    datasource_id=(
      ingest_request.preprovisioned_datasource_id
      or generate_datasource_id(CONFLUENCE_URL, space_key, page_id)
    ),
    ingestor_id=client.ingestor_id or "",
    source_type="confluence",
    last_updated=None,
    default_chunk_size=ingest_request.default_chunk_size,
    default_chunk_overlap=ingest_request.default_chunk_overlap,
    reload_interval=ingest_request.reload_interval,
  )
  async with ConfluenceLoader(
    rag_client=client,
    job_manager=JobManager(redis_client),
    datasource_info=datasource_info,
    confluence_url=CONFLUENCE_URL,
    username=CONFLUENCE_USERNAME,
    token=CONFLUENCE_TOKEN,
    verify_ssl=CONFLUENCE_SSL_VERIFY,
    max_concurrency=MAX_CONCURRENCY,
    allowed_title_patterns=ingest_request.allowed_title_patterns,
    denied_title_patterns=ingest_request.denied_title_patterns,
  ) as loader:
    pages, failed_pages = await loader.load_pages(
      space_key,
      [{"page_id": page_id, "get_child_pages": ingest_request.get_child_pages}],
      # Fetch one visible item beyond the UI limit. ``load_pages`` also peeks
      # one child beyond this bound, so a large page tree remains bounded while
      # the response can accurately report that more candidates exist.
      max_pages=PREVIEW_MAX_ITEMS + 1,
    )
    selection_truncated = loader.last_load_truncated

  items: list[dict[str, str]] = []
  for page in pages[:PREVIEW_MAX_ITEMS]:
    found_page_id = str(page.get("id") or "")
    relative_url = page.get("_links", {}).get("webui", "")
    page_url = f"{CONFLUENCE_URL}{relative_url}" if relative_url else ingest_request.url
    items.append(
      {
        "id": found_page_id or page_url,
        "title": str(page.get("title") or found_page_id or page_url),
        "url": page_url,
      }
    )
  return {
    "items": items,
    "total_discovered": len(pages),
    "truncated": selection_truncated or len(pages) > PREVIEW_MAX_ITEMS,
    "warnings": [message for _, message in failed_pages[:10]],
    "summary": {
      "space_key": space_key,
      "root_page_id": page_id,
      "include_child_pages": ingest_request.get_child_pages,
      "failed_pages": len(failed_pages),
      "preview_limit": PREVIEW_MAX_ITEMS,
    },
  }


async def reload_datasource(
  client: Client,
  job_manager: JobManager,
  datasource_info: DataSourceInfo,
  job_id: str | None = None,
) -> None:
  """Reload a single Confluence datasource.

  Fetches pages based on page_ids in metadata:
  - If page_ids is [] or None: fetch all pages in the space
  - If page_ids is [id1, id2, ...]: fetch only those specific pages
  """

  try:
    # Extract metadata
    if not datasource_info.metadata:
      message = f"No metadata for {datasource_info.datasource_id}"
      if job_id is not None:
        raise ValueError(message)
      logger.warning(message)
      return

    space_key = datasource_info.metadata.get("space_key")
    if not space_key:
      message = f"No space_key in metadata for {datasource_info.datasource_id}"
      if job_id is not None:
        raise ValueError(message)
      logger.warning(message)
      return

    page_configs = datasource_info.metadata.get("page_configs", [])
    title_patterns = _get_title_patterns(datasource_info.metadata)
    logger.info(f"Reloading datasource: {datasource_info.datasource_id} with page_configs: {page_configs}")
    if job_id is not None:
      await job_manager.upsert_job(
        job_id,
        status=JobStatus.IN_PROGRESS,
        message=f"Reloading Confluence space {space_key}",
      )

    try:
      # Use loader to fetch and ingest pages
      async with ConfluenceLoader(
        rag_client=client,
        job_manager=job_manager,
        datasource_info=datasource_info,
        confluence_url=CONFLUENCE_URL,
        username=CONFLUENCE_USERNAME,
        token=CONFLUENCE_TOKEN,
        verify_ssl=CONFLUENCE_SSL_VERIFY,
        max_concurrency=MAX_CONCURRENCY,
        allowed_title_patterns=title_patterns["allowed_title_patterns"],
        denied_title_patterns=title_patterns["denied_title_patterns"],
      ) as loader:
        # Load pages
        pages, failed_pages = await loader.load_pages(space_key, page_configs)

        # Periodic reloads create their own job. On-demand reloads update the
        # exact server-created job carried on the Redis command.
        total_count = len(pages) + len(failed_pages)
        if job_id is None:
          job_response = await client.create_job(
            datasource_id=datasource_info.datasource_id,
            job_status=JobStatus.IN_PROGRESS,
            message=f"Reloading {len(pages)} pages from {space_key}, {len(failed_pages)} failed to load",
            total=total_count,
          )
          job_id = job_response["job_id"]
        else:
          await job_manager.upsert_job(
            job_id,
            total=total_count,
            message=f"Reloading {len(pages)} pages from {space_key}, {len(failed_pages)} failed to load",
          )

        # Track fetch failures
        await track_fetch_failures(job_manager, job_id, failed_pages)

        # If no pages succeeded, mark job as failed
        if not pages:
          await job_manager.upsert_job(
            job_id=job_id,
            status=JobStatus.FAILED,
            message=f"All page loads failed for {space_key}",
          )
          logger.warning(f"All page loads failed for {space_key}")
          return

        # Ingest pages
        await loader.ingest_pages(pages, job_id)

      # Update datasource last_updated timestamp after successful reload
      datasource_info.last_updated = int(time.time())
      await client.upsert_datasource(datasource_info)

    except Exception as e:
      logger.error(f"Error reloading {datasource_info.datasource_id}: {e}")
      logger.error(traceback.format_exc())
      await job_manager.add_error_msg(job_id, str(e))
      raise

  except Exception as e:
    logger.error(f"Error in reload_datasource: {e}")
    logger.error(traceback.format_exc())
    raise


async def periodic_reload(client: Client):
  """Periodically reload all configured Confluence spaces."""
  logger.info("Starting periodic Confluence reload...")
  job_manager = JobManager(redis_client)

  try:
    # First, process any configured spaces from CONFLUENCE_SPACES env var
    if CONFLUENCE_SPACES:
      spaces_config = parse_confluence_spaces_json(CONFLUENCE_SPACES)
      logger.info(f"Processing {len(spaces_config)} configured Confluence spaces")
      logger.debug(f"Full configuration: {spaces_config}")

      # Process each configured space
      for space_key, page_configs in spaces_config.items():
        try:
          # Generate datasource ID
          datasource_id = generate_datasource_id(CONFLUENCE_URL, space_key)

          # Fetch or create datasource
          datasources = await client.list_datasources(ingestor_id=client.ingestor_id)
          datasource_info = next(
            (ds for ds in datasources if ds.datasource_id == datasource_id),
            None,
          )

          if datasource_info and (datasource_info.metadata or {}).get("config_managed") is True:
            logger.debug(
              f"Skipping legacy CONFLUENCE_SPACES config for database-managed datasource {datasource_id}"
            )
            continue

          if (
            datasource_info
            and datasource_info.last_updated
            and int(time.time()) - datasource_info.last_updated
            < datasource_info.reload_interval
          ):
            logger.debug(
              f"Skipping {space_key}: datasource refresh is not due"
            )
            continue

          if not datasource_info:
            # Create datasource
            logger.info(f"Creating datasource for configured space: {datasource_id}")
            datasource_info = _create_datasource_info(
              datasource_id=datasource_id,
              ingestor_id=client.ingestor_id,
              space_key=space_key,
              description=f"Auto-synced Confluence space {space_key}",
              page_configs=page_configs,
            )
            await client.upsert_datasource(datasource_info)
          else:
            datasource_info.metadata = {
              **(datasource_info.metadata or {}),
              "space_key": space_key,
              "page_configs": page_configs,
              "confluence_url": CONFLUENCE_URL,
            }

          title_patterns = _get_title_patterns(datasource_info.metadata)

          # Use loader to fetch and ingest pages
          async with ConfluenceLoader(
            rag_client=client,
            job_manager=job_manager,
            datasource_info=datasource_info,
            confluence_url=CONFLUENCE_URL,
            username=CONFLUENCE_USERNAME,
            token=CONFLUENCE_TOKEN,
            verify_ssl=CONFLUENCE_SSL_VERIFY,
            max_concurrency=MAX_CONCURRENCY,
            allowed_title_patterns=title_patterns["allowed_title_patterns"],
            denied_title_patterns=title_patterns["denied_title_patterns"],
          ) as loader:
            # Load pages
            pages, failed_pages = await loader.load_pages(space_key, page_configs)

            # Create job with total (successful + failed)
            total_count = len(pages) + len(failed_pages)
            job_response = await client.create_job(
              datasource_id=datasource_id,
              job_status=JobStatus.IN_PROGRESS,
              message=f"Auto-syncing {len(pages)} pages from {space_key}, {len(failed_pages)} failed to load",
              total=total_count,
            )
            job_id = job_response["job_id"]

            # Track fetch failures
            await track_fetch_failures(job_manager, job_id, failed_pages)

            # If no pages succeeded, mark job as failed and continue to next space
            if not pages:
              await job_manager.upsert_job(
                job_id=job_id,
                status=JobStatus.FAILED,
                message=f"All page loads failed for {space_key}",
              )
              logger.warning(f"All page loads failed for {space_key}")
              continue

            logger.info(f"Auto-syncing {len(pages)} pages from configured space {space_key}")

            # Ingest pages
            await loader.ingest_pages(pages, job_id)

          # Update datasource last_updated
          datasource_info.last_updated = int(time.time())
          await client.upsert_datasource(datasource_info)

          logger.info(f"Completed auto-sync for space {space_key}")

        except Exception as e:
          logger.error(f"Error auto-syncing space {space_key}: {e}")
          logger.error(traceback.format_exc())

    # Refresh UI/database-managed sources too, honoring each source's own
    # reload interval instead of the connector-wide legacy interval.
    await reload_persisted_datasources(
      client,
      reload_datasource,
      config_managed_only=True,
      job_manager=job_manager,
    )

    logger.info("Periodic reload completed")

  except Exception as e:
    logger.error(f"Error in periodic reload: {e}")
    logger.error(traceback.format_exc())


async def redis_listener(client: Client):
  """Run Confluence commands through the shared per-ingestor listener."""

  async def reconcile_legacy_config() -> None:
    """Expose legacy connector options immediately for config migration."""
    if not CONFLUENCE_SPACES:
      return
    spaces = parse_confluence_spaces_json(CONFLUENCE_SPACES)
    datasources = {
      datasource.datasource_id: datasource
      for datasource in await client.list_datasources(ingestor_id=client.ingestor_id)
    }
    for space_key, page_configs in spaces.items():
      datasource = datasources.get(generate_datasource_id(CONFLUENCE_URL, space_key))
      if not datasource:
        continue
      metadata = datasource.metadata or {}
      if metadata.get("config_managed") is True:
        continue
      datasource.metadata = {
        **metadata,
        "space_key": space_key,
        "page_configs": page_configs,
        "confluence_url": CONFLUENCE_URL,
      }
      await client.upsert_datasource(datasource)

  await run_ingestor_listener(
    client,
    ingest_command=ConfluenceIngestorCommand.INGEST_PAGE,
    ingest_model=ConfluenceIngestRequest,
    ingest_handler=process_page_ingestion,
    reload_all_command=ConfluenceIngestorCommand.RELOAD_ALL,
    reload_all_handler=reload_all_confluence_spaces,
    reload_datasource_command=ConfluenceIngestorCommand.RELOAD_DATASOURCE,
    reload_model=ConfluenceReloadRequest,
    reload_handler=reload_datasource,
    max_tasks=MAX_INGESTION_TASKS,
    describe_ingest=lambda request: f"Confluence page ingestion: {request.url}",
    on_startup=reconcile_legacy_config,
    on_shutdown=redis_client.aclose,
    preview_command=ConfluenceIngestorCommand.PREVIEW_PAGE,
    preview_model=ConfluenceIngestRequest,
    preview_handler=preview_page_ingestion,
  )


async def reload_all_confluence_spaces(client: Client) -> None:
  """Force a reload of every Confluence datasource assigned to this worker."""
  await reload_persisted_datasources(
    client,
    reload_datasource,
    due_only=False,
    job_manager=JobManager(redis_client),
  )


if __name__ == "__main__":
  try:
    logger.info("Starting Confluence Ingestor...")
    logger.info(f"Confluence URL: {CONFLUENCE_URL}")
    logger.info(f"Configured spaces: {CONFLUENCE_SPACES or '(none)'}")

    # Build and run the ingestor (same pattern as webloader)
    configured_spaces = (
      parse_confluence_spaces_json(CONFLUENCE_SPACES) if CONFLUENCE_SPACES else {}
    )
    (
      IngestorBuilder()
      .name(CONFLUENCE_INGESTOR_NAME)
      .type(CONFLUENCE_INGESTOR_TYPE)
      .description(f"Confluence wiki page ingestor for {CONFLUENCE_URL}")
      .metadata(
        {
          "confluence_url": CONFLUENCE_URL,
          "spaces": configured_spaces,
        }
      )
      .sync_with_fn(periodic_reload)
      .with_startup(redis_listener)
      .schedule_from_datasources()
      .run()
    )

  except KeyboardInterrupt:
    logger.info("Confluence ingestor interrupted by user")
  except Exception as e:
    logger.error(f"Confluence ingestor failed: {e}", exc_info=True)
    raise
