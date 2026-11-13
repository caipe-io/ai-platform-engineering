import os
import time
import logging
import requests
from typing import List, Dict, Optional

from common.ingestor_listener import run_standalone_ingestion
from common.ingestor import IngestorBuilder, Client
from common.models.rag import StructuredEntity
from common.models.rag import DataSourceInfo
from common.job_manager import JobStatus
import common.utils as utils

"""
Backstage Ingestor - Ingests entities from Backstage catalog into the RAG system.
Uses the IngestorBuilder pattern for simplified ingestor creation with automatic job management and batching.
"""

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL)

# Backstage configuration
BACKSTAGE_URL = os.getenv("BACKSTAGE_URL")
IGNORE_TYPES = os.getenv("IGNORE_TYPES", "template,api,resource").lower().split(",")
SYNC_INTERVAL = int(os.getenv("SYNC_INTERVAL", 86400))  # sync every day by default

# Auth mode selection — default "static" preserves existing behaviour
BACKSTAGE_AUTH_MODE = os.getenv("BACKSTAGE_AUTH_MODE", "static").lower()

# static mode (existing)
BACKSTAGE_API_TOKEN = os.getenv("BACKSTAGE_API_TOKEN")

# oauth2 mode — client_credentials grant
BACKSTAGE_OIDC_TOKEN_URL = os.getenv("BACKSTAGE_OIDC_TOKEN_URL")
BACKSTAGE_OIDC_CLIENT_ID = os.getenv("BACKSTAGE_OIDC_CLIENT_ID")
BACKSTAGE_OIDC_CLIENT_SECRET = os.getenv("BACKSTAGE_OIDC_CLIENT_SECRET")
BACKSTAGE_OIDC_SCOPES = os.getenv("BACKSTAGE_OIDC_SCOPES", "openid")

# Startup validation is mode-aware instead of always requiring BACKSTAGE_API_TOKEN
if BACKSTAGE_URL is None:
  raise ValueError("BACKSTAGE_URL environment variable must be set")

if BACKSTAGE_AUTH_MODE == "static":
  if not BACKSTAGE_API_TOKEN:
    raise ValueError("BACKSTAGE_API_TOKEN must be set when BACKSTAGE_AUTH_MODE=static")
elif BACKSTAGE_AUTH_MODE == "oauth2":
  missing = [
    name
    for name, val in [
      ("BACKSTAGE_OIDC_TOKEN_URL", BACKSTAGE_OIDC_TOKEN_URL),
      ("BACKSTAGE_OIDC_CLIENT_ID", BACKSTAGE_OIDC_CLIENT_ID),
      ("BACKSTAGE_OIDC_CLIENT_SECRET", BACKSTAGE_OIDC_CLIENT_SECRET),
    ]
    if not val
  ]
  if missing:
    raise ValueError(f"BACKSTAGE_AUTH_MODE=oauth2 requires: {', '.join(missing)}")
else:
  raise ValueError(f"Unknown BACKSTAGE_AUTH_MODE: {BACKSTAGE_AUTH_MODE!r}. Valid values: static, oauth2")

backstage_instance_name = "backstage_" + BACKSTAGE_URL.replace("://", "_").replace("/", "_")

# ── Auth helpers ──────────────────────────────────────────────────────────────

# In-process token cache for oauth2 mode
_oauth2_token_cache: Dict[str, object] = {"token": None, "expires_at": 0.0}


def _get_oauth2_token() -> str:
  """
  Obtain or refresh an OAuth2 client_credentials token.
  Caches the token in memory and refreshes it 60 seconds before expiry.
  """
  now = time.time()
  cached_token: Optional[str] = _oauth2_token_cache["token"]
  expires_at: float = _oauth2_token_cache["expires_at"]

  if cached_token and now < expires_at - 60:
    return cached_token

  logging.info("Requesting new OAuth2 token from %s", BACKSTAGE_OIDC_TOKEN_URL)
  response = requests.post(
    BACKSTAGE_OIDC_TOKEN_URL,
    data={
      "grant_type": "client_credentials",
      "client_id": BACKSTAGE_OIDC_CLIENT_ID,
      "client_secret": BACKSTAGE_OIDC_CLIENT_SECRET,
      "scope": BACKSTAGE_OIDC_SCOPES,
    },
    timeout=10,
  )
  response.raise_for_status()
  token_data = response.json()
  token = token_data["access_token"]
  expires_in = token_data.get("expires_in", 300)
  _oauth2_token_cache["token"] = token
  _oauth2_token_cache["expires_at"] = now + expires_in
  return token


def get_auth_headers() -> Dict[str, str]:
  """Return Authorization header for the active auth mode."""
  if BACKSTAGE_AUTH_MODE == "oauth2":
    return {"Authorization": f"Bearer {_get_oauth2_token()}"}
  if BACKSTAGE_AUTH_MODE == "static":
    return {"Authorization": f"Bearer {BACKSTAGE_API_TOKEN}"}
  raise ValueError(f"Unknown BACKSTAGE_AUTH_MODE: {BACKSTAGE_AUTH_MODE!r}. Valid values: static, oauth2")


# ── Ingestor logic (unchanged from upstream) ─────────────────────────────────


def fetch_backstage_entities() -> List[dict]:
  """
  Fetch all entities from Backstage catalog, handling pagination.

  Returns:
      list: A list of all entities from the Backstage catalog.
  """
  url = f"{BACKSTAGE_URL}/api/catalog/entities/by-query"
  headers = get_auth_headers()
  params = {"limit": 250, "fields": "metadata,kind,spec"}
  all_items = []
  cursor = None

  logging.info(f"Fetching entities from Backstage API: {url}")

  while True:
    if cursor:
      params["cursor"] = cursor

    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()
    print(response.text)
    data = response.json()

    items = data.get("items", [])
    all_items.extend(items)
    logging.debug(f"Fetched {len(items)} items, total so far: {len(all_items)}")

    cursor = data.get("pageInfo", {}).get("nextCursor")
    if not cursor:
      break

  logging.info(f"Fetched total of {len(all_items)} entities from Backstage")
  return all_items


async def sync_backstage_entities(client: Client):
  """
  Sync function that fetches Backstage entities and ingests them with job tracking.
  This function is called periodically by the IngestorBuilder.
  """
  logging.info("Starting Backstage entity sync...")

  # Fetch all entities from Backstage
  items = fetch_backstage_entities()

  # Filter out ignored types
  filtered_items = []
  for item in items:
    kind = item.get("kind", "").lower()
    if kind in IGNORE_TYPES:
      logging.debug(f"Skipping entity of type '{kind}' (in ignore list)")
      continue
    filtered_items.append(item)

  logging.info(f"Processing {len(filtered_items)} entities (filtered from {len(items)} total)")

  if not filtered_items:
    logging.info("No entities to process after filtering")
    return

  datasource_id = backstage_instance_name

  # 1. Create/Update the datasource
  datasource_info = DataSourceInfo(
    datasource_id=datasource_id,
    name="Backstage Catalog",
    ingestor_id=client.ingestor_id or "",
    description="Backstage catalog entities",
    source_type="backstage",
    last_updated=int(time.time()),
    default_chunk_size=0,  # Skip chunking for graph entities
    default_chunk_overlap=0,
    reload_interval=SYNC_INTERVAL,
    metadata={
      "backstage_url": BACKSTAGE_URL,
      "ignored_types": IGNORE_TYPES,
    },
  )
  async def sync_datasource() -> None:
    await client.upsert_datasource(datasource_info)
    logging.info(f"Created/updated datasource: {datasource_id}")

    # 2. Create a job for this ingestion
    job_response = await client.create_job(datasource_id=datasource_id, job_status=JobStatus.IN_PROGRESS, message="Starting Backstage entity ingestion", total=len(filtered_items))
    job_id = job_response["job_id"]
    logging.info(f"Created job {job_id} for datasource={datasource_id} with {len(filtered_items)} entities")

    # 3. Convert Backstage items to StructuredEntity objects
    entities = []
    for item in filtered_items:
      try:
        kind = item.get("kind", "Unknown")
        # Copy item properties
        props = item.copy()

        # Create StructuredEntity with proper primary and additional keys using dot notation
        entity = StructuredEntity(entity_type=f"Backstage{kind}", all_properties=props, primary_key_properties=["metadata.uid"], additional_key_properties=[["metadata.name"]])
        entities.append(entity)

      except Exception as e:
        logging.error(f"Error converting Backstage item to StructuredEntity: {e}", exc_info=True)
        await client.add_job_error(job_id, [f"Error converting item: {str(e)}"])
        await client.increment_job_failure(job_id, 1)

    logging.info(f"Converted {len(entities)} Backstage items to StructuredEntity objects")

    # 4. Ingest entities using automatic batching
    try:
      if entities:
        logging.info(f"Ingesting {len(entities)} entities with automatic batching")

        # Use the client's ingest_entities method which handles batching automatically
        await client.ingest_entities(job_id=job_id, datasource_id=datasource_id, entities=entities, fresh_until=utils.get_fresh_until(SYNC_INTERVAL))

        # Update job progress to reflect all entities processed
        await client.increment_job_progress(job_id, len(entities))

        # Mark job as complete
        await client.update_job(job_id=job_id, job_status=JobStatus.COMPLETED, message=f"Successfully ingested {len(entities)} entities")
        logging.info(f"Successfully completed ingestion of {len(entities)} entities")
      else:
        # No entities to ingest
        await client.update_job(job_id=job_id, job_status=JobStatus.COMPLETED, message="No entities to ingest after filtering")
        logging.info("No entities to ingest")

    except Exception as e:
      # Mark job as failed
      error_msg = f"StructuredEntity ingestion failed: {str(e)}"
      await client.add_job_error(job_id, [error_msg])
      await client.update_job(job_id=job_id, job_status=JobStatus.FAILED, message=error_msg)
      logging.error(error_msg, exc_info=True)
      raise

  await run_standalone_ingestion(datasource_info.datasource_id, sync_datasource)


if __name__ == "__main__":
  try:
    logging.info("Starting Backstage ingestor using IngestorBuilder...")

    # Use IngestorBuilder for simplified ingestor creation
    IngestorBuilder().name(backstage_instance_name).type("backstage").description("Ingestor for Backstage catalog entities").metadata({"backstage_url": BACKSTAGE_URL, "ignored_types": IGNORE_TYPES, "sync_interval": SYNC_INTERVAL}).sync_with_fn(sync_backstage_entities).every(
      SYNC_INTERVAL
    ).with_init_delay(int(os.getenv("INIT_DELAY_SECONDS", "0"))).run()

  except KeyboardInterrupt:
    logging.info("Backstage ingestor execution interrupted by user")
  except Exception as e:
    logging.error(f"Backstage ingestor failed: {e}", exc_info=True)
