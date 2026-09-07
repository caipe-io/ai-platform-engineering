from contextlib import asynccontextmanager
import asyncio
from io import BytesIO
import hashlib
import json
import re
import traceback
import uuid
from urllib.parse import unquote, urlparse
from common import utils
from fastapi import FastAPI, status, HTTPException, Query, Depends, Response, UploadFile, File, Form
from fastapi.responses import JSONResponse
from fastapi.encoders import jsonable_encoder
from fastmcp import FastMCP
from server.tools import AgentTools, BUILTIN_MCP_TOOL_IDS
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import PlainTextResponse, StreamingResponse
from starlette.background import BackgroundTask
from typing import Dict, List, Optional
import logging
from langchain_core.documents import Document
from common.metadata_storage import MetadataStorage
from common.job_manager import JobManager, JobStatus, is_stale_pending_job
from common.models.server import (
  ExploreNeighborhoodRequest,
  DocumentIngestRequest,
  IngestorPingRequest,
  IngestorPingResponse,
  UrlIngestRequest,
  IngestorRequest,
  WebIngestorCommand,
  ConfluenceIngestorCommand,
  UrlReloadRequest,
  ConfluenceIngestRequest,
  ConfluenceReloadRequest,
  SlackIngestRequest,
  SlackReloadRequest,
  SlackIngestorCommand,
  JiraIngestRequest,
  JiraReloadRequest,
  JiraIngestorCommand,
  WebexIngestRequest,
  WebexReloadRequest,
  WebexIngestorCommand,
  JobsBatchRequest,
  MCPToolInvokeRequest,
  MCPToolInvokeResponse,
  DatasourceDocumentsResponse,
  DocumentInfo,
  ChunkInfo,
  ChunkContentResponse,
  CleanupResponse,
  QueryRequest,
  QueryResult,
  ScrapySettings,
)
from common.models.rag import (
  DataSourceInfo,
  IngestorInfo,
  MCPBuiltinToolsConfig,
  MCPToolConfig,
  StructuredEntity,
  StructuredEntityId,
)
from common.models.graph import Relation
from common.models.rbac import Role, UserContext, UserInfoResponse
from contextvars import ContextVar
from server.rbac import (
  require_authenticated_user,
  require_role,
  get_permissions,
  get_auth_manager,
  _authenticate_from_token,
  authorize_mcp_tool_create,
  authorize_mcp_tool_call,
  authorize_mcp_tool_manage,
  authorize_datasource_create,
  authorize_org_admin,
  authorize_search,
  write_datasource_ownership,
  check_datasource_access,
  check_datasource_management_access,
  check_publication_request_apply_access,
  check_connector_configuration_access,
  check_datasource_or_source_access,
  check_ingestion_source_access,
  get_accessible_datasource_ids,
  get_accessible_ingestion_source_ids,
  get_accessible_mcp_tool_ids,
  inject_kb_filter,
  is_trusted_ingestor_service,
)
from common.graph_db.neo4j.graph_db import Neo4jDB
from common.graph_db.base import GraphDB
from common.constants import (
  DATASOURCE_ID_KEY,
  WEBLOADER_INGESTOR_TYPE,
  CONFLUENCE_INGESTOR_TYPE,
  SLACK_INGESTOR_TYPE,
  JIRA_INGESTOR_TYPE,
  WEBEX_INGESTOR_TYPE,
  REDIS_INGESTOR_PREVIEW_RESPONSE_PREFIX,
  ingestor_request_queue,
  DEFAULT_DATA_LABEL,
  DEFAULT_SCHEMA_LABEL,
)
from common.embeddings_factory import EmbeddingsFactory
import redis.asyncio as redis
from langchain_milvus import BM25BuiltInFunction, Milvus
from pymilvus import MilvusClient
import time
import os
import httpx
from server.query_service import VectorDBQueryService
from server.doc_acl import merge_acl_filter
from langchain_core.globals import set_verbose as set_langchain_verbose
from server.ingestion import DocumentProcessor
from common.utils import get_fresh_until, sanitize_url
from pypdf import PdfReader
from pydantic import BaseModel, Field

mcp_user_context_var: ContextVar[Optional[UserContext]] = ContextVar("mcp_user_context", default=None)

metadata_storage: Optional[MetadataStorage] = None
vector_db: Optional[Milvus] = None
jobmanager: Optional[JobManager] = None
data_graph_db: Optional[GraphDB] = None
ontology_graph_db: Optional[GraphDB] = None
agent_tools: Optional[AgentTools] = None
vector_db_query_service: Optional[VectorDBQueryService] = None

# Initialize logger
logger = utils.get_logger(__name__)
logger.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
print(f"LOG LEVEL set to {logger.level}")
if logger.level == logging.DEBUG:  # enable langchain verbose logging
  set_langchain_verbose(True)

# Read configuration from environment variables
clean_up_interval = int(os.getenv("CLEANUP_INTERVAL", 3 * 60 * 60))  # Default to 3 hours
cleanup_enabled = os.getenv("CLEANUP_ENABLED", "true").lower() in ("true", "1", "yes")
ontology_agent_client = httpx.AsyncClient(base_url=os.getenv("ONTOLOGY_AGENT_RESTAPI_ADDR", "http://localhost:8098"))
graph_rag_enabled = os.getenv("ENABLE_GRAPH_RAG", "true").lower() in ("true", "1", "yes")
redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
milvus_uri = os.getenv("MILVUS_URI", "http://localhost:19530")
embeddings_model = os.getenv("EMBEDDINGS_MODEL", "text-embedding-3-small")
neo4j_addr = os.getenv("NEO4J_ADDR", "bolt://localhost:7687")
skip_init_tests = os.getenv("SKIP_INIT_TESTS", "false").lower() in ("true", "1", "yes")  # used when debugging to skip connection tests
max_ingestion_concurrency = int(os.getenv("MAX_INGESTION_CONCURRENCY", 30))  # max concurrent tasks during ingestion for one datasource
ui_url = os.getenv("UI_URL", "http://localhost:9447")
mcp_enabled = os.getenv("ENABLE_MCP", "true").lower() in ("true", "1", "yes")
mcp_auth_enabled = os.getenv("MCP_AUTH_ENABLED", "true").lower() in ("true", "1", "yes")
sleep_on_init_failure = int(os.getenv("SLEEP_ON_INIT_FAILURE_SECONDS", 0))  # seconds to sleep on init failure before shutdown
max_documents_per_ingest = int(os.getenv("MAX_DOCUMENTS_PER_INGEST", 1000))  # max number of documents to ingest per ingestion request
max_local_file_upload_bytes = int(os.getenv("MAX_LOCAL_FILE_UPLOAD_BYTES", str(10 * 1024 * 1024)))
max_local_file_total_upload_bytes = int(os.getenv("MAX_LOCAL_FILE_TOTAL_UPLOAD_BYTES", str(25 * 1024 * 1024)))
max_local_file_pdf_pages = int(os.getenv("MAX_LOCAL_FILE_PDF_PAGES", 100))
max_local_file_extracted_chars = int(os.getenv("MAX_LOCAL_FILE_EXTRACTED_CHARS", str(2 * 1024 * 1024)))
max_results_per_query = int(os.getenv("MAX_RESULTS_PER_QUERY", 100))  # max results per query (matches QueryRequest.limit le=100)
confluence_url = os.getenv("CONFLUENCE_URL")  # optional - base URL for Confluence instance (e.g., https://company.atlassian.net/wiki)

default_collection_name_docs = "rag_default"
dense_index_params = {"index_type": "HNSW", "metric_type": "COSINE"}
sparse_index_params = {"index_type": "SPARSE_INVERTED_INDEX", "metric_type": "BM25"}

milvus_connection_args = {"uri": milvus_uri}

if graph_rag_enabled:
  logger.warning("Graph RAG is ENABLED ✅")
else:
  logger.warning("Graph RAG is DISABLED ❌")

if cleanup_enabled:
  logger.info(f"Periodic cleanup is ENABLED (interval: {clean_up_interval}s / {clean_up_interval / 3600:.1f}h)")
else:
  logger.info("Periodic cleanup is DISABLED")

# Background task handle for periodic cleanup
cleanup_task: asyncio.Task | None = None
# Track last cleanup timestamp (Unix seconds)
last_cleanup_timestamp: int | None = None


async def run_safe_bulk_cleanup() -> tuple[int, int, int]:
  """
  Run a safe bulk cleanup that:
  1. Iterates over each datasource
  2. Skips cleanup if latest job has failed
  3. Cleans up stale data for datasources with successful jobs
  4. Cleans up orphaned documents where datasource_id doesn't exist

  Returns tuple of (datasources_cleaned, datasources_skipped, orphaned_cleaned).
  """
  if not vector_db or not metadata_storage or not jobmanager:
    raise RuntimeError("Server not initialized")

  now = int(time.time())
  datasources_cleaned = 0
  datasources_skipped = 0

  # Get all datasources
  datasources = await metadata_storage.fetch_all_datasource_info()
  datasource_ids = {ds.datasource_id for ds in datasources}

  logger.info(f"Safe bulk cleanup: checking {len(datasources)} datasources")

  # Process each datasource
  for ds in datasources:
    try:
      # Get the latest job for this datasource
      jobs = await jobmanager.get_jobs_by_datasource(ds.datasource_id)
      latest_job = jobs[0] if jobs else None

      # Skip cleanup if latest job has failed
      if latest_job and latest_job.status == JobStatus.FAILED:
        logger.warning(f"Skipping cleanup for datasource {ds.datasource_id} - latest job {latest_job.job_id} has status FAILED")
        datasources_skipped += 1
        continue

      logger.debug(f"Cleaning up stale data for datasource {ds.datasource_id}")

      # Clean up stale Milvus chunks for this datasource
      expr = f"datasource_id == {VectorDBQueryService._quote_string(ds.datasource_id)} and fresh_until < {now}"
      try:
        await vector_db.adelete(expr=expr)
      except Exception as e:
        logger.error(f"Failed to delete stale chunks for datasource {ds.datasource_id}: {e}")
        continue

      # Clean up stale Neo4j entities for this datasource
      if graph_rag_enabled and data_graph_db:
        try:
          await data_graph_db.remove_stale_entities(datasource_id=ds.datasource_id)
        except Exception as e:
          logger.warning(f"Failed to delete stale structured entities for datasource {ds.datasource_id}: {e}")
          # Don't fail the whole operation if graph cleanup fails

      datasources_cleaned += 1
      logger.debug(f"Cleanup completed for datasource {ds.datasource_id}")

    except Exception as e:
      logger.error(f"Error cleaning up datasource {ds.datasource_id}: {e}")
      datasources_skipped += 1

  # Clean up orphaned documents (where datasource_id doesn't exist in metadata storage)
  orphaned_cleaned = 0
  try:
    # Query Milvus to get distinct datasource_ids that have stale chunks
    # We can't easily get distinct values, so we delete orphans by checking
    # chunks where datasource_id is not in our known set
    # Build a NOT IN expression for orphan cleanup
    if datasource_ids:
      # Milvus doesn't support NOT IN directly, so we need to find orphans differently
      # Query all stale chunks and filter client-side, then delete
      results = vector_db.client.query(
        collection_name=default_collection_name_docs,
        filter=f"fresh_until < {now}",
        output_fields=["id", "datasource_id"],
        limit=16383,  # Milvus max
      )

      # Find orphaned chunk IDs (where datasource_id is not in known datasources)
      orphan_ids = [r["id"] for r in results if r.get("datasource_id") not in datasource_ids]

      if orphan_ids:
        logger.info(f"Found {len(orphan_ids)} orphaned stale chunks to delete")
        # Delete in batches to avoid hitting limits
        batch_size = 1000
        for i in range(0, len(orphan_ids), batch_size):
          batch = orphan_ids[i : i + batch_size]
          await vector_db.adelete(ids=batch)
        orphaned_cleaned = len(orphan_ids)

  except Exception as e:
    logger.error(f"Failed to cleanup orphaned documents: {e}")

  logger.info(f"Safe bulk cleanup completed: {datasources_cleaned} datasources cleaned, {datasources_skipped} skipped, {orphaned_cleaned} orphaned chunks removed")
  return datasources_cleaned, datasources_skipped, orphaned_cleaned


async def periodic_cleanup_task():
  """
  Background task that periodically removes stale chunks from Milvus and Neo4j.
  Uses safe bulk cleanup that skips datasources with failed latest jobs.
  """
  global last_cleanup_timestamp
  logger.info(f"Starting periodic cleanup task (interval: {clean_up_interval}s)")
  while True:
    try:
      await asyncio.sleep(clean_up_interval)
      logger.info("Running periodic cleanup...")

      await run_safe_bulk_cleanup()

      # Update last cleanup timestamp
      last_cleanup_timestamp = int(time.time())
      logger.info("Periodic cleanup completed")

    except asyncio.CancelledError:
      logger.info("Periodic cleanup task cancelled")
      break
    except Exception as e:
      logger.error(f"Periodic cleanup task error: {e}")
      # Continue running despite errors


# Application lifespan management - initalization and cleanup
@asynccontextmanager
async def app_lifespan(app: FastAPI):
  """Manage application lifespan events"""
  # Startup
  logging.info("Starting up the app...")
  logging.info("setting up dbs")

  global metadata_storage
  global jobmanager
  global data_graph_db
  global ontology_graph_db
  global vector_db
  global redis_client
  global vector_db_query_service
  global ingestor

  redis_client = redis.from_url(redis_url, decode_responses=True)
  metadata_storage = MetadataStorage(redis_client=redis_client)
  jobmanager = JobManager(redis_client=redis_client)

  # Use EmbeddingsFactory to get embeddings based on EMBEDDINGS_PROVIDER env var
  embeddings = EmbeddingsFactory.get_embeddings()

  logger.info("SKIP_INIT_TESTS=" + str(skip_init_tests))
  if not skip_init_tests:
    try:
      # Do some inital tests to ensure the connections are all working
      await init_tests(logger=logger, redis_client=redis_client, embeddings=EmbeddingsFactory(), milvus_uri=milvus_uri)
    except Exception as e:
      logger.error(traceback.format_exc())
      logger.error("Initial connection tests failed, shutting down the app.")
      logger.error(f"Error in init test, sleeping {sleep_on_init_failure} seconds before shutdown...")
      logger.error("Press Ctrl+C to exit immediately...")
      try:
        for remaining in range(sleep_on_init_failure, 0, -1):
          logger.info(f"Shutting down in {remaining} seconds...")
          time.sleep(1)
      except KeyboardInterrupt:
        logger.info("Shutdown interrupted by user (Ctrl+C)")
      raise e

  # Setup vector db for document data
  vector_db = Milvus(
    embedding_function=embeddings,
    collection_name=default_collection_name_docs,
    connection_args=milvus_connection_args,
    index_params=[dense_index_params, sparse_index_params],
    builtin_function=BM25BuiltInFunction(output_field_names="sparse"),
    vector_field=["dense", "sparse"],
    enable_dynamic_field=True,  # allow for dynamic metadata fields
  )

  # Ensure the collection exists (required for upsert operations)
  # The Milvus langchain wrapper only auto-creates collections on add_documents, not upsert
  if not vector_db.client.has_collection(default_collection_name_docs):
    logger.info(f"Collection {default_collection_name_docs} does not exist, creating it...")
    # Add a dummy document to trigger collection creation with proper schema
    dummy_doc = Document(page_content="__init__", metadata={"_init": True})
    vector_db.add_documents(documents=[dummy_doc], ids=["__init_doc__"])
    # Delete the dummy document
    vector_db.delete(ids=["__init_doc__"])
    logger.info(f"Collection {default_collection_name_docs} created successfully")
  else:
    logger.info(f"Collection {default_collection_name_docs} already exists")

  vector_db_query_service = VectorDBQueryService(vector_db=vector_db)

  if graph_rag_enabled:
    # Setup graph dbs - both use the same Neo4j instance with different tenant labels
    data_graph_db = Neo4jDB(tenant_label=DEFAULT_DATA_LABEL, uri=neo4j_addr)
    await data_graph_db.setup()
    ontology_graph_db = Neo4jDB(tenant_label=DEFAULT_SCHEMA_LABEL, uri=neo4j_addr)
    await ontology_graph_db.setup()

    # setup ingestor with graph db
    ingestor = DocumentProcessor(vstore=vector_db, graph_rag_enabled=graph_rag_enabled, job_manager=jobmanager, data_graph_db=data_graph_db, batch_size=max_documents_per_ingest)
  else:
    # setup ingestor without graph db
    ingestor = DocumentProcessor(vstore=vector_db, job_manager=jobmanager, graph_rag_enabled=graph_rag_enabled, batch_size=max_documents_per_ingest)

  # Start periodic cleanup background task
  global cleanup_task
  if cleanup_enabled:
    cleanup_task = asyncio.create_task(periodic_cleanup_task())
    logger.info("Periodic cleanup task started")

  yield

  # Shutdown
  logging.info("Shutting down the app...")

  # Cancel the cleanup task
  if cleanup_task:
    cleanup_task.cancel()
    try:
      await cleanup_task
    except asyncio.CancelledError:
      pass
    logger.info("Periodic cleanup task stopped")


if mcp_enabled:
  # Initialize MCP server
  mcp = FastMCP("RAG Tools")
  mcp_app = mcp.http_app(path="/mcp")


# Tool IDs that map to the built-in seeded search tool (can update, cannot create/delete)
# Tool IDs permanently blocked from custom tool creation (shadow built-in tools)
RESERVED_TOOL_IDS = BUILTIN_MCP_TOOL_IDS


# Combine both lifespans - App and MCP (if enabled)
@asynccontextmanager
async def combined_lifespan(app: FastAPI):
  async with app_lifespan(app):
    if not mcp_enabled:
      yield  # Skip MCP setup
    else:
      if not metadata_storage:
        raise HTTPException(status_code=500, detail="Cannot initialize MCP server - metadata storage not initialized")

      global agent_tools

      # Seed default configs if not already present in Redis
      if not await metadata_storage.get_mcp_builtin_config():
        await metadata_storage.store_mcp_builtin_config(MCPBuiltinToolsConfig())
        logger.info("Seeded default MCPBuiltinToolsConfig")

      # Initialize MCP server tools
      agent_tools = AgentTools(
        vector_db_query_service=vector_db_query_service,
        redis_client=redis_client,
        metadata_storage=metadata_storage,
        data_graph_db=data_graph_db,
        ontology_graph_db=ontology_graph_db,
      )

      # Load configs from Redis and register tools
      builtin_config = await metadata_storage.get_mcp_builtin_config() or MCPBuiltinToolsConfig()
      tool_configs = await metadata_storage.fetch_all_mcp_tool_configs()
      await agent_tools.register_tools(mcp, graph_rag_enabled=graph_rag_enabled, builtin_config=builtin_config, tool_configs=tool_configs)

      # Register MCP app lifespan
      async with mcp_app.lifespan(app):
        yield


# Initialize FastAPI app
class MCPAuthMiddleware(BaseHTTPMiddleware):
  """
  Middleware that enforces authentication on /mcp* routes.

  FastMCP routes are registered outside FastAPI's dependency injection system
  so they cannot use Depends()-based auth guards. This middleware intercepts
  requests to /mcp* paths and applies the same auth logic as require_authenticated_user():
    1. Valid Bearer JWT -> allowed through
    2. Anything else -> 401

  Non-MCP routes are unaffected and continue to use their own Depends() guards.
  """

  async def dispatch(self, request: Request, call_next):
    if not request.url.path.startswith("/mcp"):
      return await call_next(request)

    if request.method == "OPTIONS":
      return await call_next(request)

    auth_header = request.headers.get("Authorization")
    if auth_header:
      if not auth_header.startswith("Bearer "):
        return self._unauthorized("Invalid Authorization header format. Expected 'Bearer <token>'.", request)
      auth_manager = get_auth_manager()
      user = await _authenticate_from_token(request, auth_manager)
      if user:
        request.state.user = user
        token = mcp_user_context_var.set(user)
        try:
          return await call_next(request)
        finally:
          mcp_user_context_var.reset(token)
      return self._unauthorized("Invalid or expired token.", request)

    return self._unauthorized("Missing or malformed Authorization header.", request)

  def _unauthorized(self, reason: str, request: Request):
    accept = request.headers.get("accept", "")
    if "text/event-stream" in accept:
      return PlainTextResponse(f"error unauthorized: {reason}", status_code=401, media_type="text/event-stream")
    return JSONResponse({"error": "unauthorized", "reason": reason}, status_code=401)


if mcp_enabled:
  app = FastAPI(
    title="CAIPE RAG API",
    description="API for indexing and querying knowledge base for CAIPE",
    version="2.0.0",
    lifespan=combined_lifespan,
    routes=[*mcp_app.routes],  # Include MCP routes
  )
  if mcp_auth_enabled:
    app.add_middleware(MCPAuthMiddleware)
    logger.info("MCP authentication is ENABLED")
  else:
    logger.info("MCP authentication is DISABLED")
else:
  app = FastAPI(
    title="CAIPE RAG API",
    description="API for indexing and querying knowledge base for CAIPE",
    version="2.0.0",
    lifespan=combined_lifespan,
  )


def generate_ingestor_id(ingestor_name: str, ingestor_type: str) -> str:
  """Generate a unique ingestor ID for webloader ingestor"""
  return f"{ingestor_type}:{ingestor_name}"


async def resolve_live_ingestor_id(ingestor_type: str) -> str:
  """Resolve the `ingestor_id` of the currently-running ingestor of a given
  type, from its heartbeat registration rather than a guessed name.

  Ingestor names may be derived at runtime, so command routing must use a
  fresh heartbeat registration rather than a guessed default name.
  """
  candidates = await resolve_live_ingestor_ids(ingestor_type)
  if not candidates:
    raise HTTPException(
      status_code=503,
      detail=f"No {ingestor_type} ingestor is currently registered. Ensure the {ingestor_type} ingestor is running.",
    )
  if len(candidates) > 1:
    logger.warning(f"Multiple {ingestor_type} ingestors registered ({[c.ingestor_id for c in candidates]}); using the most recently seen")
  return candidates[0].ingestor_id


async def resolve_live_ingestor_ids(ingestor_type: str) -> List[IngestorInfo]:
  """Return fresh logical ingestors of a type, newest heartbeat first."""
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  max_age = int(os.getenv("INGESTOR_HEARTBEAT_MAX_AGE_SECONDS", "300"))
  cutoff = int(time.time()) - max_age
  candidates = [
    item
    for item in await metadata_storage.fetch_all_ingestor_info()
    if item.ingestor_type == ingestor_type and (item.last_seen or 0) >= cutoff
  ]
  candidates.sort(key=lambda item: item.last_seen or 0, reverse=True)
  return candidates


async def resolve_datasource_ingestor(datasource: DataSourceInfo, ingestor_type: str) -> str:
  """Resolve a datasource assignment and repair a stale logical worker id."""
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  live = await resolve_live_ingestor_ids(ingestor_type)
  if not live:
    raise HTTPException(
      status_code=503,
      detail=f"No {ingestor_type} ingestor is currently registered. Ensure the {ingestor_type} ingestor is running.",
    )
  live_ids = {item.ingestor_id for item in live}
  if datasource.ingestor_id in live_ids:
    return datasource.ingestor_id
  previous = datasource.ingestor_id
  datasource.ingestor_id = live[0].ingestor_id
  await metadata_storage.store_datasource_info(datasource)
  logger.warning(
    "Rebound datasource %s from stale ingestor %s to %s",
    datasource.datasource_id,
    previous,
    datasource.ingestor_id,
  )
  return datasource.ingestor_id


async def enqueue_ingestor_request(
  *,
  ingestor_type: str,
  ingestor_id: str,
  command: str,
  payload: object,
  job_id: Optional[str] = None,
  response_key: Optional[str] = None,
) -> None:
  """Send a command to the queue owned by one logical ingestor id."""
  if redis_client is None:
    raise HTTPException(status_code=500, detail="Server not initialized")
  request = IngestorRequest(
    ingestor_id=ingestor_id,
    command=command,
    payload=payload,
    job_id=job_id,
    response_key=response_key,
  )
  queue = ingestor_request_queue(ingestor_type, ingestor_id)
  try:
    await redis_client.rpush(queue, request.model_dump_json())  # type: ignore
  except Exception as error:
    if job_id and jobmanager:
      await jobmanager.add_error_msg(job_id, f"Failed to enqueue command: {error}")
      await jobmanager.upsert_job(
        job_id,
        status=JobStatus.FAILED,
        message="Failed to enqueue command for ingestor",
      )
    raise HTTPException(status_code=503, detail="Failed to enqueue ingestion command") from error
  logger.info(f"Queued {command} for {ingestor_id} on {queue}")


async def request_ingestor_preview(
  *,
  ingestor_type: str,
  command: str,
  payload: object,
) -> Dict:
  """Run a bounded, non-persisting preview on a live connector worker."""
  if redis_client is None:
    raise HTTPException(status_code=500, detail="Server not initialized")
  ingestor_id = await resolve_live_ingestor_id(ingestor_type)
  preview_id = str(uuid.uuid4())
  response_key = f"{REDIS_INGESTOR_PREVIEW_RESPONSE_PREFIX}{preview_id}"
  await enqueue_ingestor_request(
    ingestor_type=ingestor_type,
    ingestor_id=ingestor_id,
    command=command,
    payload=payload,
    response_key=response_key,
  )
  timeout_seconds = max(5, min(int(os.getenv("INGESTOR_PREVIEW_TIMEOUT_SECONDS", "120")), 300))
  try:
    result = await redis_client.blpop([response_key], timeout=timeout_seconds)
  except Exception as error:
    raise HTTPException(
      status_code=503,
      detail="The ingestion preview service is temporarily unavailable",
    ) from error
  if result is None:
    raise HTTPException(
      status_code=504,
      detail=f"The {ingestor_type} preview did not finish within {timeout_seconds} seconds",
    )
  _, raw_response = result
  try:
    response = json.loads(raw_response)
  except (TypeError, json.JSONDecodeError) as error:
    raise HTTPException(status_code=502, detail="The ingestor returned an invalid preview") from error
  if not isinstance(response, dict) or response.get("ok") is not True:
    detail = response.get("error") if isinstance(response, dict) else None
    raise HTTPException(status_code=422, detail=detail or "The ingestion preview failed")
  data = response.get("data")
  if not isinstance(data, dict):
    raise HTTPException(status_code=502, detail="The ingestor returned an invalid preview")
  return data


async def create_reload_job(datasource_id: str, resource_label: str) -> str:
  """Create the exact PENDING job a single-datasource reload will execute."""
  if not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")
  await reject_if_ingestion_job_blocking(datasource_id, resource_label)
  job_id = str(uuid.uuid4())
  created = await jobmanager.upsert_job(
    job_id,
    status=JobStatus.PENDING,
    message="Waiting for ingestor to process reload...",
    total=0,
    datasource_id=datasource_id,
  )
  if not created:
    raise HTTPException(status_code=500, detail="Failed to create reload job")
  return job_id


async def queue_datasource_reload(
  *,
  datasource_id: str,
  resource_label: str,
  ingestor_type: str,
  command: str,
  payload: object,
  user: UserContext,
) -> str:
  """Shared authorization, live-worker resolution, job creation and enqueue."""
  if not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")
  datasource = await metadata_storage.get_datasource_info(datasource_id)
  if not datasource:
    raise HTTPException(status_code=404, detail="Datasource not found")
  await check_datasource_management_access(user, datasource_id)
  ingestor_id = await resolve_datasource_ingestor(datasource, ingestor_type)
  job_id = await create_reload_job(datasource_id, resource_label)
  await enqueue_ingestor_request(
    ingestor_type=ingestor_type,
    ingestor_id=ingestor_id,
    command=command,
    payload=payload,
    job_id=job_id,
  )
  return job_id


async def queue_reload_all(*, ingestor_type: str, command: str) -> int:
  """Fan a reload-all command out to every live logical ingestor."""
  live = await resolve_live_ingestor_ids(ingestor_type)
  if not live:
    raise HTTPException(
      status_code=503,
      detail=f"No {ingestor_type} ingestor is currently registered. Ensure the {ingestor_type} ingestor is running.",
    )
  for item in live:
    await enqueue_ingestor_request(
      ingestor_type=ingestor_type,
      ingestor_id=item.ingestor_id,
      command=command,
      payload={},
    )
  return len(live)


async def authorize_ingestor_transport(
  user: UserContext,
  datasource_id: str,
  claimed_ingestor_id: Optional[str] = None,
  *,
  allow_create: bool = False,
) -> None:
  """Authorize the first-party ingestion transport or a normal DS ingestor.

  The configured service identity may push documents only through these
  write-only endpoints. When a request claims an ingestor id, it must match
  the datasource assignment so the shared credential cannot spoof a
  different connector.
  """
  if is_trusted_ingestor_service(user):
    if claimed_ingestor_id is not None:
      if not metadata_storage:
        raise HTTPException(status_code=500, detail="Server not initialized")
      datasource = await metadata_storage.get_datasource_info(datasource_id)
      if datasource is None:
        if not allow_create:
          raise HTTPException(status_code=404, detail="Datasource not found")
        registered = await metadata_storage.get_ingestor_info(claimed_ingestor_id)
        max_age = int(os.getenv("INGESTOR_HEARTBEAT_MAX_AGE_SECONDS", "300"))
        if not registered or (registered.last_seen or 0) < int(time.time()) - max_age:
          raise HTTPException(status_code=403, detail="Ingestor is not currently registered")
        return
      if datasource.ingestor_id != claimed_ingestor_id:
        raise HTTPException(status_code=403, detail="Ingestor is not assigned to this datasource")
    return
  await check_datasource_access(user, datasource_id, "ingest")


async def authorize_source_ingestion(
  request: Request,
  user: UserContext,
  datasource_id: str,
  owner_team_slug: Optional[str],
  ownership_preprovisioned: bool,
  existing_datasource: Optional[DataSourceInfo],
) -> None:
  """Authorize connector ingestion without coupling management and search grants.

  A DB-backed source is preprovisioned before its first ingestion. At that
  point an ordinary member of the selected owner team may be the creator even
  though only team admins receive ``ingestion_source#can_manage``. Requiring
  both configuration visibility on that exact source and the normal create
  capability lets the creator perform the initial ingest without granting
  ongoing Owner access.
  Existing datasources continue through the normal connector/config gate.
  """
  if existing_datasource is not None:
    await check_connector_configuration_access(user, datasource_id)
  elif ownership_preprovisioned:
    await check_ingestion_source_access(user, datasource_id, "can_read")
    await authorize_datasource_create(request, user, datasource_id, owner_team_slug)
  else:
    await authorize_datasource_create(request, user, datasource_id, owner_team_slug)


async def provision_legacy_datasource_ownership(
  datasource_id: str,
  owner_team_slug: Optional[str],
  search_team_slugs: List[str],
  search_user_subjects: List[str],
  user: UserContext,
  ownership_preprovisioned: bool,
  existing_datasource: Optional[DataSourceInfo],
) -> None:
  """Project policy for direct creates before any local state is persisted.

  UI-created sources reconcile the independent Owner and Search
  graphs before calling RAG, so they must not be coupled here.
  Legacy/direct callers still need the server to establish the initial KB and
  datasource ownership atomically enough to fail closed on a PDP outage.
  """
  if existing_datasource is None and not ownership_preprovisioned:
    if (
      (search_team_slugs or search_user_subjects)
      and not is_trusted_ingestor_service(user)
    ):
      raise HTTPException(
        status_code=403,
        detail=(
          "Search publication for additional people or teams must be requested "
          "through the platform publication workflow"
        ),
      )
    await write_datasource_ownership(
      datasource_id,
      owner_team_slug,
      user,
      shared_team_slugs=search_team_slugs,
      shared_user_subjects=search_user_subjects,
    )


async def authorize_job_access(user: UserContext, datasource_id: str, *, write: bool) -> None:
  """Authorize job metadata without granting Owners indexed-data access."""
  if is_trusted_ingestor_service(user):
    return
  if write:
    await check_datasource_management_access(user, datasource_id)
    return
  await check_datasource_or_source_access(
    user,
    datasource_id,
    "read",
    source_relation="can_read",
  )


async def authorize_ingestor_job_transport(
  request: Request,
  user: UserContext,
  datasource_id: str,
) -> None:
  """Require the assigned first-party ingestor for internal job mutation.

  Owners may start, retry, inspect, or terminate lifecycle work through their
  dedicated endpoints. Search users may inspect readable job metadata only.
  Neither grant authorizes forging worker progress, errors, totals, or status.
  """
  if not is_trusted_ingestor_service(user):
    raise HTTPException(
      status_code=403,
      detail="Only the assigned ingestor service may mutate job progress",
    )
  ingestor_type = request.headers.get("X-Ingestor-Type", "").strip()
  ingestor_name = request.headers.get("X-Ingestor-Name", "").strip()
  if not ingestor_type or not ingestor_name:
    raise HTTPException(status_code=403, detail="Ingestor identity headers are required")
  claimed_ingestor_id = generate_ingestor_id(ingestor_name, ingestor_type)
  await authorize_ingestor_transport(
    user,
    datasource_id,
    claimed_ingestor_id,
  )


async def reject_if_ingestion_job_blocking(datasource_id: str, resource_label: str) -> None:
  """
  Raises 400 if a datasource already has an active ingestion job.

  A PENDING job stuck past `is_stale_pending_job`'s threshold means the
  ingestor pod that should have dequeued it never did (crash, downtime, a
  Redis message it silently dropped) - it is failed here so it stops
  permanently blocking every future retry for this datasource.
  """
  if not jobmanager:
    return
  existing_jobs = await jobmanager.get_jobs_by_datasource(datasource_id)
  if not existing_jobs:
    return

  blocking_jobs = []
  for job in existing_jobs:
    if job.status == JobStatus.IN_PROGRESS:
      blocking_jobs.append(job)
    elif job.status == JobStatus.PENDING:
      if is_stale_pending_job(job):
        failed = await jobmanager.fail_stale_pending_job(job.job_id)
        if not failed:
          current = await jobmanager.get_job(job.job_id)
          if current and current.status in {JobStatus.PENDING, JobStatus.IN_PROGRESS}:
            blocking_jobs.append(current)
      else:
        blocking_jobs.append(job)

  if blocking_jobs:
    logger.info(f"An ingestion job is already in progress or pending for datasource {datasource_id}, job ID: {blocking_jobs[0].job_id}")
    raise HTTPException(status_code=400, detail=f"An ingestion job is already in progress or pending for this {resource_label} (job ID: {blocking_jobs[0].job_id})")


# ============================================================================
# User Info Endpoint
# ============================================================================


@app.get(
  "/v1/user/info",
  response_model=UserInfoResponse,
  tags=["Authentication"],
  summary="Get current user information",
  description="""
    Retrieve the current user's authentication status, role, and permissions.
    
    This endpoint is used by the UI to:
    - Display the logged-in user's email and role
    - Show/hide features based on role-based permissions
    - Enable/disable action buttons based on what the user can do
    
    **Authentication required** - callers must provide a valid bearer token.
    Authenticated users will see their email and baseline role.
    
    **Permissions list:**
    - `read`: Can query and view data (READONLY, INGESTONLY, ADMIN)
    - `ingest`: Can ingest new data and manage ingestion jobs (INGESTONLY, ADMIN)
    - `delete`: Can delete resources and perform bulk operations (ADMIN only)
    """,
  responses={
    200: {
      "description": "Successfully retrieved user information",
      "content": {
        "application/json": {
          "examples": {
            "authenticated": {"summary": "Authenticated user", "value": {"email": "user@example.com", "role": "readonly", "is_authenticated": True, "permissions": ["read"]}},
          }
        }
      },
    }
  },
)
async def get_user_info(request: Request, user: UserContext = Depends(require_authenticated_user)):
  """Get current user's authentication and role information."""
  return UserInfoResponse(email=user.email, role=user.role, is_authenticated=user.is_authenticated, permissions=get_permissions(user.role))


# ============================================================================
# Ingestor Endpoints
# ============================================================================


@app.get("/v1/ingestors")
async def list_ingestors(user: UserContext = Depends(require_role(Role.READONLY))):
  """
  List registered ingestors.

  The connector type/health catalog is needed by self-service source authors,
  but worker descriptions and metadata can contain deployment URLs and
  connector-specific diagnostics. Only organization administrators receive
  those fields. A denied or unavailable admin check degrades to the
  least-privileged catalog instead of leaking details or making source
  creation depend on admin access.
  """
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  logger.debug("Listing ingestors")
  ingestors = await metadata_storage.fetch_all_ingestor_info()
  include_metadata = False
  try:
    await authorize_org_admin(user)
    include_metadata = True
  except HTTPException as exc:
    if exc.status_code not in (status.HTTP_403_FORBIDDEN, status.HTTP_503_SERVICE_UNAVAILABLE):
      raise

  payload = []
  for ingestor in ingestors:
    item = ingestor.model_dump()
    if not include_metadata:
      item["description"] = ""
      item["metadata"] = {}
    payload.append(item)
  return JSONResponse(status_code=status.HTTP_200_OK, content=jsonable_encoder(payload))


@app.post("/v1/ingestor/heartbeat", response_model=IngestorPingResponse, status_code=status.HTTP_200_OK)
async def ping_ingestor(ingestor_ping: IngestorPingRequest, user: UserContext = Depends(require_authenticated_user)):
  """
  Registers a heartbeat from a ingestor, creating or updating its entry
  """
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  if not is_trusted_ingestor_service(user):
    raise HTTPException(status_code=403, detail="Only the configured ingestor service may register heartbeats")
  logger.info(f"Received heartbeat from ingestor: name={ingestor_ping.ingestor_name} type={ingestor_ping.ingestor_type} (by {user.email})")
  ingestor_id = generate_ingestor_id(ingestor_ping.ingestor_name, ingestor_ping.ingestor_type)
  ingestor_info = IngestorInfo(ingestor_id=ingestor_id, ingestor_type=ingestor_ping.ingestor_type, ingestor_name=ingestor_ping.ingestor_name, description=ingestor_ping.description, metadata=ingestor_ping.metadata, last_seen=int(time.time()))
  await metadata_storage.store_ingestor_info(ingestor_info=ingestor_info)
  return IngestorPingResponse(ingestor_id=ingestor_id, message="Ingestor heartbeat registered", max_documents_per_ingest=max_documents_per_ingest)


@app.delete("/v1/ingestor/delete")
async def delete_ingestor(ingestor_id: str, user: UserContext = Depends(require_role(Role.ADMIN))):
  """
  Deletes an ingestor from metadata storage, does not delete any associated datasources or data
  """
  if not vector_db or not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  if graph_rag_enabled and not data_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized")

  # Fetch ingestor info - check if it exists
  ingestor_info = await metadata_storage.get_ingestor_info(ingestor_id)

  if not ingestor_info:
    raise HTTPException(status_code=404, detail="Ingestor not found")

  logger.warning(f"Deleting ingestor: {ingestor_id} (by {user.email})")
  await metadata_storage.delete_ingestor_info(ingestor_id)  # remove metadata


# ============================================================================
# Datasources Endpoints
# ============================================================================


@app.post("/v1/datasource", status_code=status.HTTP_202_ACCEPTED)
async def upsert_datasource(
  datasource_info: DataSourceInfo,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Create or update datasource metadata entry."""
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")

  if is_trusted_ingestor_service(user):
    await authorize_ingestor_transport(
      user,
      datasource_info.datasource_id,
      datasource_info.ingestor_id,
      allow_create=True,
    )
    existing = await metadata_storage.get_datasource_info(datasource_info.datasource_id)
    if existing:
      # Connector workers own ingestion state, not authorization policy. A
      # legacy periodic worker that rebuilds DataSourceInfo must never erase
      # or replace access metadata selected in the UI migration flow.
      datasource_info.creator_subject = existing.creator_subject
      datasource_info.owner_subject = existing.owner_subject
      datasource_info.owner_team_slug = existing.owner_team_slug
      datasource_info.shared_with_teams = existing.shared_with_teams
      datasource_info.search_with_teams = existing.search_with_teams
      datasource_info.search_with_users = existing.search_with_users
  else:
    # This endpoint replaces the entire DataSourceInfo record, including its
    # connector assignment and source metadata. Only trusted connector workers
    # may replace this record. Human callers use the narrow PATCH endpoint; the
    # only normal non-ingestor caller here is the org-admin migration flow.
    await authorize_org_admin(user)
  await metadata_storage.store_datasource_info(datasource_info)

  return status.HTTP_202_ACCEPTED


@app.get("/v1/datasource/{datasource_id}/exists")
async def datasource_exists(
  datasource_id: str,
  request: Request,
  owner_team_slug: Optional[str] = None,
  user: UserContext = Depends(require_authenticated_user),
):
  """Report whether a datasource id is already in use, regardless of the
  caller's read access to it.

  `GET /v1/datasources` filters to the caller's accessible set, so a
  collision probe against that list cannot see datasources the caller
  cannot read — letting a source-create flow "create" a deterministic id
  that already has hidden data and inherit access to it. This endpoint
  reveals existence only (no metadata), but even that one-bit result is
  limited to an existing source manager or a caller authorized to create a
  source for the supplied owner team. This prevents arbitrary authenticated
  users from enumerating predictable Jira/Confluence datasource ids.
  """
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  try:
    await check_ingestion_source_access(user, datasource_id, "can_manage")
  except HTTPException as exc:
    if exc.status_code != 403:
      raise
    await authorize_datasource_create(
      request,
      user,
      datasource_id,
      owner_team_slug,
    )
  existing = await metadata_storage.get_datasource_info(datasource_id)
  return {"datasource_id": datasource_id, "exists": existing is not None}


class DatasourceUpdateRequest(BaseModel):
  """Mutable source configuration mirrored from the UI's Mongo record."""

  name: Optional[str] = Field(None, min_length=1, max_length=120)
  description: Optional[str] = Field(None, max_length=2000)
  default_chunk_size: Optional[int] = Field(None, ge=100, le=100000)
  default_chunk_overlap: Optional[int] = Field(None, ge=0, le=10000)
  reload_interval: Optional[int] = Field(None, ge=60)
  lookback_days: Optional[int] = Field(None, ge=0)
  include_bots: Optional[bool] = None
  jql: Optional[str] = Field(None, min_length=1)
  include_comments: Optional[bool] = None
  include_links: Optional[bool] = None
  custom_fields: Optional[Dict[str, str]] = None
  get_child_pages: Optional[bool] = None
  allowed_title_patterns: Optional[List[str]] = None
  denied_title_patterns: Optional[List[str]] = None
  settings: Optional[ScrapySettings] = None


class DatasourceOwnerTeamUpdateRequest(BaseModel):
  """Narrow persisted access-policy update used by the BFF access flow."""

  owner_team_slug: Optional[str] = Field(None, min_length=1, max_length=192)
  owner_subject: Optional[str] = Field(None, min_length=1, max_length=192)
  search_with_teams: Optional[List[str]] = Field(None, max_length=50)
  search_with_users: Optional[List[str]] = Field(None, max_length=50)


@app.get("/v1/datasource/{datasource_id}/publication-state")
async def get_datasource_publication_state(
  datasource_id: str,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
) -> Dict[str, Optional[str]]:
  """Return the ownership fields needed to validate an approved publication.

  Owners may read this narrow projection directly. A delegated
  publication approver may read it only while applying the request-scoped
  capability for this exact datasource. The endpoint intentionally omits
  connector credentials and source configuration.
  """
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")

  try:
    await check_datasource_management_access(user, datasource_id)
  except HTTPException as source_manager_error:
    if source_manager_error.status_code != status.HTTP_403_FORBIDDEN:
      raise
    await check_publication_request_apply_access(
      user,
      request.headers.get("X-Publication-Authorization-Id"),
      "rag_datasource",
      datasource_id,
    )

  existing = await metadata_storage.get_datasource_info(datasource_id)
  if not existing:
    raise HTTPException(status_code=404, detail="Datasource not found")
  return {
    "datasource_id": datasource_id,
    "owner_team_slug": existing.owner_team_slug,
    "owner_subject": existing.owner_subject,
    "creator_subject": existing.creator_subject,
  }


@app.patch("/v1/datasource/{datasource_id}/owner-team", status_code=status.HTTP_200_OK)
async def update_datasource_owner_team(
  datasource_id: str,
  body: DatasourceOwnerTeamUpdateRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Persist the Owner and/or independent Search teams.

  The independent Owner may mirror these fields after reconciling
  OpenFGA. Legacy datasources remain supported through the management helper's
  fallback only when no ``ingestion_source`` policy exists. This endpoint
  changes metadata only; enforcement remains in the independent policy graphs.
  """
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")

  try:
    await check_datasource_management_access(user, datasource_id)
  except HTTPException as source_manager_error:
    if source_manager_error.status_code != status.HTTP_403_FORBIDDEN:
      raise
    # A publication request may include an ownership transfer that was held
    # back with a material broad-publication change. The request-scoped
    # capability is bound to this exact datasource and exists only while the
    # BFF is atomically applying the approved state.
    await check_publication_request_apply_access(
      user,
      request.headers.get("X-Publication-Authorization-Id"),
      "rag_datasource",
      datasource_id,
    )
  existing = await metadata_storage.get_datasource_info(datasource_id)
  if not existing:
    raise HTTPException(status_code=404, detail="Datasource not found")

  owner_changed = False
  if (
    "owner_team_slug" in body.model_fields_set
    and "owner_subject" in body.model_fields_set
    and body.owner_team_slug
    and body.owner_subject
  ):
    raise HTTPException(
      status_code=400,
      detail="A datasource can have either an owner team or a personal owner, not both",
    )

  if "owner_team_slug" in body.model_fields_set:
    owner_team_slug = body.owner_team_slug.strip() if body.owner_team_slug else None
    if owner_team_slug and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}", owner_team_slug):
      raise HTTPException(status_code=400, detail="owner_team_slug must be a valid team slug")
    owner_changed = owner_changed or existing.owner_team_slug != owner_team_slug
    existing.owner_team_slug = owner_team_slug
    if owner_team_slug:
      # Team ownership replaces the personal management/query owner. The
      # creator remains audit-only after an explicit transfer.
      existing.owner_subject = None
    elif "owner_subject" not in body.model_fields_set and existing.owner_subject is None:
      existing.owner_subject = existing.creator_subject

  if "owner_subject" in body.model_fields_set:
    owner_subject = body.owner_subject.strip() if body.owner_subject else None
    if owner_subject and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}", owner_subject):
      raise HTTPException(status_code=400, detail="owner_subject must be a valid user subject")
    owner_changed = owner_changed or existing.owner_subject != owner_subject
    existing.owner_subject = owner_subject
    if owner_subject:
      existing.owner_team_slug = None

  search_changed = False
  if "search_with_teams" in body.model_fields_set:
    normalized_search_teams: List[str] = []
    seen_search_teams: set[str] = set()
    for raw_slug in body.search_with_teams or []:
      slug = raw_slug.strip()
      if not slug or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}", slug):
        raise HTTPException(status_code=400, detail="search_with_teams must contain valid team slugs")
      if slug in seen_search_teams:
        continue
      seen_search_teams.add(slug)
      normalized_search_teams.append(slug)
    search_changed = existing.search_with_teams != normalized_search_teams
    existing.search_with_teams = normalized_search_teams

  if "search_with_users" in body.model_fields_set:
    normalized_search_users: List[str] = []
    seen_search_users: set[str] = set()
    for raw_subject in body.search_with_users or []:
      subject = raw_subject.strip()
      if not subject or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}", subject):
        raise HTTPException(status_code=400, detail="search_with_users must contain valid user subjects")
      if subject in seen_search_users:
        continue
      seen_search_users.add(subject)
      normalized_search_users.append(subject)
    search_changed = search_changed or existing.search_with_users != normalized_search_users
    existing.search_with_users = normalized_search_users

  if not body.model_fields_set.intersection(
    {"owner_team_slug", "owner_subject", "search_with_teams", "search_with_users"}
  ):
    raise HTTPException(status_code=400, detail="At least one access-policy field is required")
  await metadata_storage.store_datasource_info(existing)
  logger.info(
    "Updated datasource access metadata datasource=%s owner_team=%s owner_subject=%s search_teams=%s search_users=%s owner_changed=%s search_changed=%s by user=%s",
    datasource_id,
    existing.owner_team_slug,
    existing.owner_subject,
    existing.search_with_teams,
    existing.search_with_users,
    owner_changed,
    search_changed,
    user.email,
  )
  return {
    "datasource_id": datasource_id,
    "owner_team_slug": existing.owner_team_slug,
    "owner_subject": existing.owner_subject,
    "search_with_teams": existing.search_with_teams,
    "search_with_users": existing.search_with_users,
    "changed": owner_changed or search_changed,
  }


@app.patch("/v1/datasource/{datasource_id}", status_code=status.HTTP_200_OK)
async def rename_datasource(
  datasource_id: str,
  body: DatasourceUpdateRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Synchronize mutable source configuration. The datasource id is immutable."""
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")

  try:
    await check_datasource_management_access(user, datasource_id)
  except HTTPException as source_manager_error:
    if source_manager_error.status_code != status.HTTP_403_FORBIDDEN:
      raise
    await check_publication_request_apply_access(
      user,
      request.headers.get("X-Publication-Authorization-Id"),
      "rag_datasource",
      datasource_id,
    )

  existing = await metadata_storage.get_datasource_info(datasource_id)
  if not existing:
    raise HTTPException(status_code=404, detail="Datasource not found")

  changes = body.model_dump(exclude_unset=True)
  if not changes:
    return {"datasource_id": datasource_id, "changed": False}

  connector_fields = {
    "lookback_days",
    "include_bots",
    "jql",
    "include_comments",
    "include_links",
    "custom_fields",
    "get_child_pages",
    "allowed_title_patterns",
    "denied_title_patterns",
    "settings",
  }
  allowed_connector_fields = {
    "slack": {"lookback_days", "include_bots"},
    "webex": {"include_bots"},
    "jira": {"jql", "include_comments", "include_links", "custom_fields"},
    "confluence": {"get_child_pages", "allowed_title_patterns", "denied_title_patterns"},
    "web": {"settings"},
  }.get(existing.source_type, set())
  invalid_connector_fields = (set(changes) & connector_fields) - allowed_connector_fields
  if invalid_connector_fields:
    raise HTTPException(
      status_code=400,
      detail=f"Fields are not valid for {existing.source_type}: {', '.join(sorted(invalid_connector_fields))}",
    )

  if "name" in changes:
    changes["name"] = str(changes["name"]).strip()
    if not changes["name"]:
      raise HTTPException(status_code=400, detail="name must be non-empty after trimming")
  final_chunk_size = int(changes.get("default_chunk_size", existing.default_chunk_size or 0))
  final_chunk_overlap = int(changes.get("default_chunk_overlap", existing.default_chunk_overlap or 0))
  if final_chunk_overlap >= final_chunk_size:
    raise HTTPException(status_code=400, detail="default_chunk_overlap must be smaller than default_chunk_size")

  for field_name in ("name", "description", "default_chunk_size", "default_chunk_overlap", "reload_interval"):
    if field_name in changes:
      setattr(existing, field_name, changes[field_name])

  metadata = dict(existing.metadata or {})
  for field_name in (
    "lookback_days",
    "include_bots",
    "include_comments",
    "include_links",
    "custom_fields",
    "allowed_title_patterns",
    "denied_title_patterns",
  ):
    if field_name not in changes:
      continue
    if changes[field_name] is None:
      metadata.pop(field_name, None)
    else:
      metadata[field_name] = changes[field_name]
  if "jql" in changes:
    if changes["jql"] is None:
      metadata.pop("jql", None)
    else:
      metadata["jql"] = str(changes["jql"]).strip()
  if existing.source_type == "slack" and "name" in changes:
    metadata["channel_name"] = changes["name"]
  elif existing.source_type == "webex" and "name" in changes:
    metadata["space_name"] = changes["name"]
  elif existing.source_type == "jira" and "name" in changes:
    metadata["datasource_name"] = changes["name"]

  nested_key = {
    "web": "url_ingest_request",
    "confluence": "confluence_ingest_request",
  }.get(existing.source_type)
  if nested_key and isinstance(metadata.get(nested_key), dict):
    nested = dict(metadata[nested_key])
    for field_name in ("description", "reload_interval"):
      if field_name in changes:
        nested[field_name] = changes[field_name]
    if existing.source_type == "web":
      settings = dict(nested.get("settings") or {})
      if "settings" in changes:
        settings = dict(changes["settings"] or {})
      if "default_chunk_size" in changes:
        settings["chunk_size"] = changes["default_chunk_size"]
      if "default_chunk_overlap" in changes:
        settings["chunk_overlap"] = changes["default_chunk_overlap"]
      nested["settings"] = settings
    elif existing.source_type == "confluence":
      for field_name in ("default_chunk_size", "default_chunk_overlap"):
        if field_name in changes:
          if changes[field_name] is None:
            nested.pop(field_name, None)
          else:
            nested[field_name] = changes[field_name]
      for field_name in (
        "get_child_pages",
        "allowed_title_patterns",
        "denied_title_patterns",
      ):
        if field_name in changes:
          nested[field_name] = changes[field_name]
      if "get_child_pages" in changes:
        request_url = str(nested.get("url") or "")
        page_match = re.search(r"/pages/(\d+)", request_url)
        if page_match and isinstance(metadata.get("page_configs"), list):
          page_id = page_match.group(1)
          page_configs = [dict(item) for item in metadata["page_configs"]]
          for page_config in page_configs:
            if str(page_config.get("page_id")) == page_id:
              if changes["get_child_pages"] is None:
                page_config.pop("get_child_pages", None)
              else:
                page_config["get_child_pages"] = changes["get_child_pages"]
          metadata["page_configs"] = page_configs
    metadata[nested_key] = nested
  existing.metadata = metadata
  await metadata_storage.store_datasource_info(existing)
  logger.info("Updated datasource %s fields=%s by user=%s", datasource_id, sorted(changes), user.email)
  return {
    "datasource_id": datasource_id,
    "name": existing.name,
    "changed": True,
    "datasource": existing,
  }


@app.delete("/v1/datasource", status_code=status.HTTP_200_OK)
async def delete_datasource(
  datasource_id: str,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Delete datasource from vector storage and metadata."""

  # Check initialization
  if not vector_db or not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")
  if graph_rag_enabled and not data_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized")

  await check_datasource_management_access(user, datasource_id)

  # Fetch datasource info
  datasource_info = await metadata_storage.get_datasource_info(datasource_id)
  if not datasource_info:
    raise HTTPException(status_code=404, detail="Datasource not found")

  # Check if any jobs are running for this datasource
  jobs = await jobmanager.get_jobs_by_datasource(datasource_id)
  if jobs and any(job.status == JobStatus.IN_PROGRESS for job in jobs):
    raise HTTPException(status_code=400, detail="Cannot delete datasource while ingestion job is in progress.")

  # remove all jobs for this datasource
  jobs = await jobmanager.get_jobs_by_datasource(datasource_id)
  if jobs:
    for job in jobs:
      await jobmanager.delete_job(job.job_id)

  await vector_db.adelete(expr=f"datasource_id == {VectorDBQueryService._quote_string(datasource_id)}")
  await metadata_storage.delete_datasource_info(datasource_id)  # remove metadata

  if graph_rag_enabled and data_graph_db:
    await data_graph_db.remove_entity(None, {DATASOURCE_ID_KEY: datasource_id})  # remove from graph db

  return status.HTTP_200_OK


@app.post("/v1/datasource/{datasource_id}/cleanup", response_model=CleanupResponse)
async def cleanup_datasource_stale(
  datasource_id: str,
  user: UserContext = Depends(require_authenticated_user),
):
  """
  Delete stale chunks from a specific datasource.

  Stale chunks are those where fresh_until < current time.
  This is useful for cleaning up orphaned data without removing
  the entire datasource.
  """
  if not vector_db or not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")

  await check_datasource_management_access(user, datasource_id)

  # Verify datasource exists
  datasource_info = await metadata_storage.get_datasource_info(datasource_id)
  if not datasource_info:
    raise HTTPException(status_code=404, detail="Datasource not found")

  now = int(time.time())

  # Delete stale Milvus chunks for this datasource
  expr = f"datasource_id == {VectorDBQueryService._quote_string(datasource_id)} and fresh_until < {now}"
  try:
    await vector_db.adelete(expr=expr)
  except Exception as e:
    logger.error(f"Failed to delete stale chunks for datasource {datasource_id}: {e}")
    raise HTTPException(status_code=500, detail=f"Failed to delete stale chunks: {e}")

  # Delete stale Neo4j entities for this datasource
  if graph_rag_enabled and data_graph_db:
    try:
      await data_graph_db.remove_stale_entities(datasource_id=datasource_id)
    except Exception as e:
      logger.warning(f"Failed to delete stale structured entities for datasource {datasource_id}: {e}")
      # Don't fail the whole operation if graph cleanup fails

  logger.info(f"Cleanup completed for datasource {datasource_id}")

  return CleanupResponse(datasource_id=datasource_id, success=True, message="Cleanup completed successfully")


@app.post("/v1/datasources/cleanup", response_model=CleanupResponse)
async def cleanup_all_stale(
  user: UserContext = Depends(require_role(Role.ADMIN)),
):
  """
  Delete all stale chunks across all datasources safely.

  This operation:
  1. Iterates over each datasource
  2. Skips cleanup if the latest job has failed (to avoid deleting data that may need recovery)
  3. Cleans up stale data for datasources with successful/non-failed jobs
  4. Cleans up orphaned documents where datasource_id doesn't exist in metadata

  Stale chunks are those where fresh_until < current time.
  """
  if not vector_db or not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  try:
    datasources_cleaned, datasources_skipped, orphaned_cleaned = await run_safe_bulk_cleanup()

    # Update last cleanup timestamp
    global last_cleanup_timestamp
    last_cleanup_timestamp = int(time.time())

    message = f"Bulk cleanup completed: {datasources_cleaned} datasources cleaned"
    if datasources_skipped > 0:
      message += f", {datasources_skipped} skipped (failed jobs)"
    if orphaned_cleaned > 0:
      message += f", {orphaned_cleaned} orphaned chunks removed"

    return CleanupResponse(datasource_id=None, success=True, message=message)

  except RuntimeError as e:
    raise HTTPException(status_code=500, detail=str(e))
  except Exception as e:
    logger.error(f"Bulk cleanup failed: {e}")
    raise HTTPException(status_code=500, detail=f"Bulk cleanup failed: {e}")


@app.get("/v1/datasources")
async def list_datasources(
  request: Request,
  ingestor_id: Optional[str] = None,
  user: UserContext = Depends(require_authenticated_user),
):
  """List datasource metadata visible through either independent grant graph.

  Source-management visibility exposes configuration and job lifecycle only;
  the per-row permission flags let callers keep documents/search controls
  hidden unless the separate data-source grant allows them.
  """
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  try:
    datasources = await metadata_storage.fetch_all_datasource_info()
    if ingestor_id:
      datasources = [ds for ds in datasources if ds.ingestor_id == ingestor_id]

    # Derive a display name for records that do not store one. We do not persist
    # this here because `datasource_id` remains the immutable storage/RBAC key;
    # admins can rename via PATCH /v1/datasource/{id}.
    for ds in datasources:
      if not getattr(ds, "name", None):
        meta = ds.metadata or {}
        url = (meta.get("url_ingest_request") or {}).get("url") or meta.get("confluence_url")
        space_key = meta.get("space_key")
        project_key = meta.get("project_key")
        channel_name = meta.get("channel_name") or meta.get("space_name")
        ds.name = utils.derive_friendly_name(
          url=url,
          source_type=ds.source_type,
          space_key=space_key,
          project_key=project_key,
          channel_name=channel_name,
          fallback=ds.datasource_id,
        )

    if is_trusted_ingestor_service(user):
      serialized = [ds.model_dump() for ds in datasources]
      return {"success": True, "datasources": serialized, "count": len(serialized)}

    ds_read, ds_ingest, ds_manage, source_read, source_manage = await asyncio.gather(
      get_accessible_datasource_ids(user, "read"),
      get_accessible_datasource_ids(user, "ingest"),
      get_accessible_datasource_ids(user, "admin"),
      get_accessible_ingestion_source_ids(user, "can_read"),
      get_accessible_ingestion_source_ids(user, "can_manage"),
    )
    unrestricted = any("*" in ids for ids in (ds_read, source_read))
    ds_read_set = set(ds_read)
    ds_ingest_set = set(ds_ingest)
    ds_manage_set = set(ds_manage)
    source_read_set = set(source_read)
    source_manage_set = set(source_manage)

    serialized = []
    for ds in datasources:
      datasource_id = ds.datasource_id
      if not unrestricted and datasource_id not in ds_read_set and datasource_id not in source_read_set:
        continue
      can_read_source_config = "*" in source_read_set or datasource_id in source_read_set
      can_manage_query = "*" in ds_manage_set or datasource_id in ds_manage_set
      datasource_payload = ds.model_dump()
      if not can_read_source_config:
        # A data_source reader may query indexed content, but that grant must
        # not also reveal the independent ingestion-source configuration (URL,
        # channel/space ids, JQL, refresh/chunk settings, creator subject, or
        # worker assignment). Query managers retain only the ownership fields
        # needed by the Search sharing flow.
        datasource_payload = {
          key: datasource_payload[key]
          for key in (
            "datasource_id",
            "name",
            "description",
            "source_type",
            "last_updated",
          )
          if key in datasource_payload
        }
        if can_manage_query:
          datasource_payload.update(
            {
              "creator_subject": ds.creator_subject,
              "owner_subject": ds.owner_subject,
              "owner_team_slug": ds.owner_team_slug,
              "shared_with_teams": ds.shared_with_teams,
              "search_with_teams": ds.search_with_teams,
              "search_with_users": ds.search_with_users,
            }
          )
      serialized.append(
        {
          **datasource_payload,
          "_permissions": {
            "can_read_content": "*" in ds_read_set or datasource_id in ds_read_set,
            "can_ingest": "*" in ds_ingest_set or datasource_id in ds_ingest_set,
            "can_manage_query": can_manage_query,
            "can_read_source_config": can_read_source_config,
            "can_manage_source": "*" in source_manage_set or datasource_id in source_manage_set,
          },
        }
      )

    return {"success": True, "datasources": serialized, "count": len(serialized)}
  except HTTPException:
    raise
  except Exception as e:
    logger.error(f"Failed to list datasources: {e}")
    raise HTTPException(status_code=500, detail=str(e))


@app.get("/v1/datasource/{datasource_id}/documents", response_model=DatasourceDocumentsResponse)
async def list_datasource_documents(
  request: Request,
  datasource_id: str,
  offset: int = Query(default=0, ge=0, description="Number of chunks to skip"),
  limit: int = Query(default=100, ge=1, le=1000, description="Number of chunks to fetch"),
  user: UserContext = Depends(require_role(Role.READONLY)),
):
  """List documents and chunks for a datasource with pagination (without content)."""
  if not vector_db or not vector_db_query_service:
    raise HTTPException(status_code=500, detail="Server not initialized")

  await authorize_search(user)
  await check_datasource_access(user, datasource_id, "read")

  # Validate Milvus constraint: offset + limit must be < 16384
  if offset + limit >= 16384:
    raise HTTPException(
      status_code=400,
      detail="offset + limit must be less than 16,384 (Milvus query limitation)",
    )

  try:
    # Fetch limit + 1 to determine if more chunks exist
    filters = merge_acl_filter({"datasource_id": datasource_id}, user)
    filter_expression = await vector_db_query_service.build_filter_expression(filters)
    results = vector_db.client.query(
      collection_name=default_collection_name_docs,
      filter=filter_expression,
      output_fields=["id", "document_id", "title", "chunk_index", "total_chunks", "fresh_until", "document_type", "document_ingested_at", "is_structured_entity", "source"],
      offset=offset,
      limit=limit + 1,
    )

    # Determine if more chunks exist beyond this batch
    has_more = len(results) > limit
    actual_results = results[:limit]  # Trim to requested limit

    # Group chunks by document_id
    documents_map: dict[str, DocumentInfo] = {}
    for chunk in actual_results:
      doc_id = chunk.get("document_id", "unknown")

      if doc_id not in documents_map:
        documents_map[doc_id] = DocumentInfo(
          document_id=doc_id,
          title=chunk.get("title", ""),
          chunks=[],
        )

      # Build chunk metadata (exclude fields that are already top-level or not needed)
      metadata = {
        "fresh_until": chunk.get("fresh_until"),
        "document_type": chunk.get("document_type"),
        "document_ingested_at": chunk.get("document_ingested_at"),
        "is_structured_entity": chunk.get("is_structured_entity", False),
        "source": chunk.get("source"),
      }

      documents_map[doc_id].chunks.append(
        ChunkInfo(
          id=chunk.get("id", ""),
          chunk_index=chunk.get("chunk_index", 0),
          total_chunks=chunk.get("total_chunks", 1),
          metadata=metadata,
        )
      )

    # Sort chunks within each document by chunk_index
    for doc in documents_map.values():
      doc.chunks.sort(key=lambda c: c.chunk_index)

    # Convert to list and sort by document_id
    documents = sorted(documents_map.values(), key=lambda d: d.document_id)
    total_chunks = sum(len(doc.chunks) for doc in documents)

    return DatasourceDocumentsResponse(
      datasource_id=datasource_id,
      documents=documents,
      total_documents=len(documents),
      total_chunks=total_chunks,
      offset=offset,
      limit=limit,
      has_more=has_more,
    )

  except HTTPException:
    raise
  except Exception as e:
    logger.error(f"Failed to list documents for datasource {datasource_id}: {e}")
    raise HTTPException(status_code=500, detail=str(e))


@app.get("/v1/chunk/{chunk_id:path}/content", response_model=ChunkContentResponse)
async def get_chunk_content(
  request: Request,
  chunk_id: str,
  user: UserContext = Depends(require_role(Role.READONLY)),
):
  """Fetch the text content of a specific chunk."""
  if not vector_db or not vector_db_query_service:
    raise HTTPException(status_code=500, detail="Server not initialized")

  await authorize_search(user)
  try:
    # Query Milvus for the specific chunk by ID
    filters = merge_acl_filter({"id": chunk_id}, user)
    filter_expression = await vector_db_query_service.build_filter_expression(filters)
    results = vector_db.client.query(
      collection_name=default_collection_name_docs,
      filter=filter_expression,
      output_fields=["id", "text", "datasource_id"],
      limit=1,
    )

    if not results:
      raise HTTPException(status_code=404, detail="Chunk not found")

    chunk = results[0]
    await check_datasource_access(user, chunk.get("datasource_id"), "read")

    return ChunkContentResponse(
      id=chunk.get("id", chunk_id),
      text_content=chunk.get("text", ""),
    )

  except HTTPException:
    raise
  except Exception as e:
    logger.error(f"Failed to fetch chunk content for {chunk_id}: {e}")
    raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Job Endpoints
# ============================================================================
@app.get("/v1/job/{job_id}")
async def get_job(request: Request, job_id: str, user: UserContext = Depends(require_authenticated_user)):
  """Get the status of an ingestion job."""
  if not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")
  job_info = await jobmanager.get_job(job_id)
  if not job_info:
    raise HTTPException(status_code=404, detail="Job not found")

  await authorize_job_access(user, job_info.datasource_id, write=False)

  logger.info(f"Returning job {job_info}")
  return job_info


@app.get("/v1/jobs/datasource/{datasource_id}")
async def get_jobs_by_datasource(request: Request, datasource_id: str, status_filter: Optional[JobStatus] = None, user: UserContext = Depends(require_authenticated_user)):
  """Get all jobs for a specific datasource, optionally filtered by status."""
  if not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  await authorize_job_access(user, datasource_id, write=False)

  jobs = await jobmanager.get_jobs_by_datasource(datasource_id, status_filter=status_filter)
  if jobs is None:
    raise HTTPException(status_code=404, detail="No jobs found for the specified datasource")

  logger.info(f"Returning {len(jobs)} jobs for datasource {datasource_id}")
  return jobs


@app.post("/v1/jobs/batch")
async def get_jobs_batch(request: JobsBatchRequest, user: UserContext = Depends(require_authenticated_user)):
  """Get jobs for multiple datasources in a single batch request.

  This endpoint is optimized for polling job statuses across multiple datasources,
  reducing the number of API calls and RBAC authentication overhead. Rather than
  403-ing on any inaccessible datasource, it silently drops them from the result
  (matching the filtering pattern used by /v1/datasources and /v1/query).
  """
  if not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  # Validate request
  if len(request.datasource_ids) > 100:
    raise HTTPException(status_code=400, detail="Cannot fetch jobs for more than 100 datasources at once")

  # Convert status filter strings to JobStatus enum if provided
  status_filter_enums = None
  if request.status_filter:
    try:
      status_filter_enums = [JobStatus(s) for s in request.status_filter]
    except ValueError as e:
      raise HTTPException(status_code=400, detail=f"Invalid status filter: {e}")

  requested_datasource_ids = request.datasource_ids
  if not is_trusted_ingestor_service(user):
    datasource_ids, source_ids = await asyncio.gather(
      get_accessible_datasource_ids(user, "read"),
      get_accessible_ingestion_source_ids(user, "can_read"),
    )
    if "*" not in datasource_ids and "*" not in source_ids:
      accessible = set(datasource_ids) | set(source_ids)
      requested_datasource_ids = [ds_id for ds_id in requested_datasource_ids if ds_id in accessible]

  # Fetch jobs in batch
  jobs_by_datasource = await jobmanager.get_jobs_batch(datasource_ids=requested_datasource_ids, status_filter=status_filter_enums)

  # Count total jobs
  total_jobs = sum(len(jobs) for jobs in jobs_by_datasource.values())

  logger.debug(f"Returning {total_jobs} jobs for {len(requested_datasource_ids)} datasources (batch)")

  return {"jobs": jsonable_encoder(jobs_by_datasource), "total_jobs": total_jobs, "datasource_count": len(requested_datasource_ids)}


@app.post("/v1/job", status_code=status.HTTP_201_CREATED)
async def create_job(request: Request, datasource_id: str, job_status: Optional[JobStatus] = None, message: Optional[str] = None, total: Optional[int] = None, user: UserContext = Depends(require_authenticated_user)):
  """Create a new job for a datasource."""
  if not jobmanager or not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")

  # Check if datasource exists
  datasource_info = await metadata_storage.get_datasource_info(datasource_id)
  if not datasource_info:
    raise HTTPException(status_code=404, detail="Datasource not found")

  await authorize_ingestor_job_transport(request, user, datasource_id)

  # Generate new job ID
  job_id = str(uuid.uuid4())

  # Create job with datasource_id
  success = await jobmanager.upsert_job(job_id, status=job_status or JobStatus.PENDING, message=message or "Job created", total=total, datasource_id=datasource_id)

  if not success:
    raise HTTPException(status_code=400, detail="Failed to create job")

  logger.info(f"Created job {job_id} for datasource {datasource_id}")
  return {"job_id": job_id, "datasource_id": datasource_id}


@app.patch("/v1/job/{job_id}", status_code=status.HTTP_200_OK)
async def update_job(request: Request, job_id: str, job_status: Optional[JobStatus] = None, message: Optional[str] = None, total: Optional[int] = None, user: UserContext = Depends(require_authenticated_user)):
  """Update an existing job."""
  if not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  # Check if job exists
  existing_job = await jobmanager.get_job(job_id)
  if not existing_job:
    raise HTTPException(status_code=404, detail="Job not found")

  await authorize_ingestor_job_transport(request, user, existing_job.datasource_id)

  # Update job
  success = await jobmanager.upsert_job(job_id, status=job_status, message=message, total=total, datasource_id=existing_job.datasource_id)

  if not success:
    raise HTTPException(status_code=400, detail="Failed to update job (job may be terminated)")

  logger.info(f"Updated job {job_id}")
  return {"job_id": job_id, "datasource_id": existing_job.datasource_id}


@app.post("/v1/job/{job_id}/terminate", status_code=status.HTTP_200_OK)
async def terminate_job_endpoint(request: Request, job_id: str, user: UserContext = Depends(require_authenticated_user)):
  """Terminate an ingestion job."""
  if not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  job_info = await jobmanager.get_job(job_id)
  if not job_info:
    raise HTTPException(status_code=404, detail="Job not found")

  await authorize_job_access(user, job_info.datasource_id, write=True)

  success = await jobmanager.terminate_job(job_id)
  if not success:
    raise HTTPException(status_code=500, detail="Failed to terminate job")

  logger.info(f"Job {job_id} has been terminated.")
  return {"message": f"Job {job_id} has been terminated."}


@app.post("/v1/job/{job_id}/increment-progress")
async def increment_job_progress(request: Request, job_id: str, increment: int = 1, user: UserContext = Depends(require_authenticated_user)):
  """Increment the progress counter for a job."""
  if not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  job_info = await jobmanager.get_job(job_id)
  if not job_info:
    raise HTTPException(status_code=404, detail="Job not found")

  await authorize_ingestor_job_transport(request, user, job_info.datasource_id)

  new_value = await jobmanager.increment_progress(job_id, increment)
  if new_value == -1:
    raise HTTPException(status_code=400, detail="Cannot increment progress - job is terminated")

  logger.debug(f"Incremented progress for job {job_id} by {increment}, new value: {new_value}")
  return {"job_id": job_id, "progress_counter": new_value}


@app.post("/v1/job/{job_id}/increment-failure")
async def increment_job_failure(request: Request, job_id: str, increment: int = 1, user: UserContext = Depends(require_authenticated_user)):
  """Increment the failure counter for a job."""
  if not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  job_info = await jobmanager.get_job(job_id)
  if not job_info:
    raise HTTPException(status_code=404, detail="Job not found")

  await authorize_ingestor_job_transport(request, user, job_info.datasource_id)

  new_value = await jobmanager.increment_failure(job_id, increment)
  if new_value == -1:
    raise HTTPException(status_code=400, detail="Cannot increment failure - job is terminated")

  logger.debug(f"Incremented failure for job {job_id} by {increment}, new value: {new_value}")
  return {"job_id": job_id, "failed_counter": new_value}


@app.post("/v1/job/{job_id}/increment-document-count")
async def increment_job_document_count(request: Request, job_id: str, increment: int = 1, user: UserContext = Depends(require_authenticated_user)):
  """Increment the document count for a job."""
  if not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  job_info = await jobmanager.get_job(job_id)
  if not job_info:
    raise HTTPException(status_code=404, detail="Job not found")

  await authorize_ingestor_job_transport(request, user, job_info.datasource_id)

  new_value = await jobmanager.increment_document_count(job_id, increment)
  if new_value == -1:
    raise HTTPException(status_code=400, detail="Cannot increment document count - job is terminated")

  logger.debug(f"Incremented document count for job {job_id} by {increment}, new value: {new_value}")
  return {"job_id": job_id, "document_count": new_value}


@app.post("/v1/job/{job_id}/add-errors")
async def add_job_errors(request: Request, job_id: str, error_messages: List[str], user: UserContext = Depends(require_authenticated_user)):
  """Add error messages to a job."""
  if not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  if not error_messages:
    raise HTTPException(status_code=400, detail="Error messages list cannot be empty")

  job_info = await jobmanager.get_job(job_id)
  if not job_info:
    raise HTTPException(status_code=404, detail="Job not found")

  await authorize_ingestor_job_transport(request, user, job_info.datasource_id)

  results = []
  for error_msg in error_messages:
    new_length = await jobmanager.add_error_msg(job_id, error_msg)
    if new_length == -1:
      raise HTTPException(status_code=400, detail="Cannot add error messages - job is terminated")
    results.append(new_length)

  final_length = results[-1] if results else 0
  logger.debug(f"Added {len(error_messages)} error messages to job {job_id}, total errors: {final_length}")
  return {"job_id": job_id, "errors_added": len(error_messages), "total_errors": final_length}


# ============================================================================
# Query Endpoint
# ============================================================================


@app.post("/v1/query", response_model=List[QueryResult])
async def query_documents(
  query_request: QueryRequest,
  user: UserContext = Depends(require_authenticated_user),
):
  """Query for relevant documents using semantic search in the unified collection."""

  # Explicit org-level search capability (spec 2026-06-03-explicit-search-capability).
  # Defense-in-depth alongside the BFF gate; the per-datasource ACL below
  # (inject_kb_filter) still narrows results to readable sources.
  await authorize_search(user)

  # Enforce max results limit
  if query_request.limit > max_results_per_query:
    raise HTTPException(status_code=400, detail=f"Query limit exceeds maximum allowed of {max_results_per_query} results.")

  # If weighted ranker specified but no weights then use default weights
  if query_request.ranker_type == "weighted":
    if query_request.ranker_params is None:
      query_request.ranker_params = {"weights": [0.7, 0.3]}  # More weight to dense (semantic) score

  # If no ranker specified then set ranker params to None
  if not query_request.ranker_type or query_request.ranker_type == "":
    query_request.ranker_params = None

  if await inject_kb_filter(query_request, user):
    return []

  results = await vector_db_query_service.query(
    query=query_request.query,
    filters=query_request.filters,
    limit=query_request.limit,
    ranker=query_request.ranker_type,
    ranker_params=query_request.ranker_params,
  )
  return results


# ============================================================================
# Ingestion Endpoints
# ============================================================================


LOCAL_FILE_INGESTOR_ID = "local-file-upload"
LOCAL_FILE_ALLOWED_EXTENSIONS = {".md", ".markdown", ".txt", ".text", ".pdf"}
LOCAL_FILE_TEXT_MIME_TYPES = {
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/markdown",
}
LOCAL_FILE_PDF_MIME_TYPES = {"application/pdf"}
LOCAL_FILE_MARKDOWN_EXTENSIONS = {".md", ".markdown"}
LOCAL_FILE_TEXT_EXTENSIONS = {".txt", ".text"}
LOCAL_FILE_PDF_EXTENSIONS = {".pdf"}
# assisted-by Codex Codex-sonnet-4-6
LOCAL_FILE_FORBIDDEN_TEXT_PREFIXES = (
  "<!doctype html",
  "<html",
  "<script",
  "<?xml",
)


def _safe_upload_filename(filename: str | None) -> str:
  candidate = (filename or "uploaded-file").strip().split("/")[-1].split("\\")[-1]
  return candidate or "uploaded-file"


def _local_file_extension(filename: str) -> str:
  lower = filename.lower()
  return f".{lower.rsplit('.', 1)[1]}" if "." in lower else ""


def _local_file_document_type(filename: str, content_type: str | None) -> str:
  extension = _local_file_extension(filename)
  if extension in LOCAL_FILE_PDF_EXTENSIONS or content_type == "application/pdf":
    return "pdf"
  if extension in LOCAL_FILE_MARKDOWN_EXTENSIONS or content_type in {"text/markdown", "text/x-markdown", "application/markdown"}:
    return "markdown"
  return "text"


def _local_file_datasource_id(filename: str, content: bytes) -> str:
  digest = hashlib.sha256(content).hexdigest()[:12]
  stem = filename.rsplit(".", 1)[0] if "." in filename else filename
  clean = "".join(char.lower() if char.isalnum() else "_" for char in stem).strip("_")
  return f"src_file_{clean[:80] or 'upload'}_{digest}"


def _local_files_datasource_id(files: list[tuple[str, bytes]]) -> str:
  digest = hashlib.sha256()
  for filename, content in files:
    digest.update(filename.encode("utf-8"))
    digest.update(b"\0")
    digest.update(hashlib.sha256(content).hexdigest().encode("ascii"))
    digest.update(b"\0")
  first_filename = files[0][0] if files else "upload"
  stem = first_filename.rsplit(".", 1)[0] if "." in first_filename else first_filename
  clean = "".join(char.lower() if char.isalnum() else "_" for char in stem).strip("_")
  if len(files) == 1:
    return f"src_file_{clean[:80] or 'upload'}_{digest.hexdigest()[:12]}"
  return f"src_file_{clean[:64] or 'upload'}_{len(files)}_files_{digest.hexdigest()[:12]}"


def _extract_local_file_text(filename: str, content_type: str | None, content: bytes) -> tuple[str, str]:
  document_type = _local_file_document_type(filename, content_type)
  if document_type in {"markdown", "text"}:
    text = content.decode("utf-8-sig", errors="replace")
    if len(text) > max_local_file_extracted_chars:
      raise HTTPException(status_code=413, detail=f"Extracted text exceeds the {max_local_file_extracted_chars} character limit")
    return text, document_type

  if document_type == "pdf":
    try:
      reader = PdfReader(BytesIO(content))
      if reader.is_encrypted:
        raise HTTPException(status_code=400, detail="Encrypted PDFs are not supported")
      if len(reader.pages) > max_local_file_pdf_pages:
        raise HTTPException(status_code=413, detail=f"PDF exceeds the {max_local_file_pdf_pages} page limit")
      text = "\n\n".join((page.extract_text() or "").strip() for page in reader.pages).strip()
    except HTTPException:
      raise
    except Exception as exc:
      raise HTTPException(status_code=400, detail=f"Could not extract text from PDF: {type(exc).__name__}") from exc
    if not text:
      raise HTTPException(status_code=400, detail="PDF did not contain extractable text")
    if len(text) > max_local_file_extracted_chars:
      raise HTTPException(status_code=413, detail=f"Extracted text exceeds the {max_local_file_extracted_chars} character limit")
    return text, document_type

  raise HTTPException(status_code=415, detail="Unsupported file type")


def _content_looks_like_text_document(content: bytes) -> bool:
  sample = content[:4096]
  if b"\x00" in sample:
    return False
  stripped = sample.lstrip().lower()
  for prefix in LOCAL_FILE_FORBIDDEN_TEXT_PREFIXES:
    if stripped.startswith(prefix.encode()):
      return False
  return True


def _validate_local_file_declared_type(filename: str, content_type: str) -> str:
  extension = _local_file_extension(filename)
  if extension not in LOCAL_FILE_ALLOWED_EXTENSIONS:
    raise HTTPException(status_code=415, detail="Only Markdown, PDF, and plain text uploads are supported")

  if extension in LOCAL_FILE_PDF_EXTENSIONS:
    if content_type and content_type not in LOCAL_FILE_PDF_MIME_TYPES:
      raise HTTPException(status_code=415, detail="PDF uploads must use application/pdf")
    return "pdf"

  if extension in LOCAL_FILE_MARKDOWN_EXTENSIONS:
    if content_type and content_type not in LOCAL_FILE_TEXT_MIME_TYPES:
      raise HTTPException(status_code=415, detail="Markdown uploads must use a text or markdown content type")
    return "markdown"

  if content_type and content_type not in LOCAL_FILE_TEXT_MIME_TYPES:
    raise HTTPException(status_code=415, detail="Text uploads must use a text content type")
  return "text"


def _validate_local_file_upload(file: UploadFile, content: bytes) -> str:
  filename = _safe_upload_filename(file.filename)
  content_type = (file.content_type or "").lower()
  if not content:
    raise HTTPException(status_code=400, detail="Uploaded file is empty")
  if len(content) > max_local_file_upload_bytes:
    raise HTTPException(status_code=413, detail=f"File exceeds the {max_local_file_upload_bytes} byte upload limit")
  document_type = _validate_local_file_declared_type(filename, content_type)
  if document_type == "pdf":
    if not content.startswith(b"%PDF-"):
      raise HTTPException(status_code=415, detail="PDF upload content did not match the expected file signature")
  elif not _content_looks_like_text_document(content):
    raise HTTPException(status_code=415, detail="Text upload content did not match the expected safe text format")
  return filename


def _validate_local_file_batch(files: list[tuple[str, bytes]]) -> None:
  if not files:
    raise HTTPException(status_code=400, detail="At least one file is required")
  if len(files) > max_documents_per_ingest:
    raise HTTPException(status_code=413, detail=f"Upload contains more than the {max_documents_per_ingest} file limit")
  total_size = sum(len(content) for _, content in files)
  if total_size > max_local_file_total_upload_bytes:
    raise HTTPException(status_code=413, detail=f"Upload exceeds the {max_local_file_total_upload_bytes} byte batch limit")


def _bound_local_file_chunk_params(chunk_size: int, chunk_overlap: int) -> tuple[int, int]:
  bounded_chunk_size = max(100, min(chunk_size, 100000))
  bounded_chunk_overlap = max(0, min(chunk_overlap, 10000, bounded_chunk_size - 1))
  return bounded_chunk_size, bounded_chunk_overlap


async def _ingest_local_file_uploads(
  *,
  job_id: str,
  datasource_id: str,
  uploads: list[tuple[UploadFile, str, bytes, str, str]],
  description: str,
  fresh_until: int,
  chunk_size: int,
  chunk_overlap: int,
  user: UserContext,
  success_message: str,
  failure_message: str,
) -> None:
  """Build documents from validated uploads, ingest them, and finalize the job."""
  now = int(time.time())
  documents = []
  for upload_file, filename, content, text, document_type in uploads:
    document_metadata = {
      "document_id": f"{datasource_id}__{hashlib.sha256(filename.encode()).hexdigest()[:8]}",
      "datasource_id": datasource_id,
      "ingestor_id": LOCAL_FILE_INGESTOR_ID,
      "title": filename,
      "description": description or "",
      "is_structured_entity": False,
      "document_type": document_type,
      "document_ingested_at": now,
      "fresh_until": fresh_until,
      "metadata": {
        "source": filename,
        "filename": filename,
        "content_type": upload_file.content_type,
        "byte_size": len(content),
      },
    }
    documents.append(Document(page_content=text, metadata=document_metadata))
    logger.info(
      "local_file_upload accepted filename=%s content_type=%s bytes=%d document_type=%s datasource_id=%s user=%s",
      filename,
      upload_file.content_type,
      len(content),
      document_type,
      datasource_id,
      user.email,
    )

  try:
    await ingestor.ingest_documents(
      ingestor_id=LOCAL_FILE_INGESTOR_ID,
      datasource_id=datasource_id,
      job_id=job_id,
      documents=documents,
      fresh_until=fresh_until,
      chunk_overlap=chunk_overlap,
      chunk_size=chunk_size,
    )
    await jobmanager.increment_document_count(job_id, len(documents))
    await jobmanager.upsert_job(
      job_id,
      status=JobStatus.COMPLETED,
      message=success_message,
      total=len(uploads),
      datasource_id=datasource_id,
    )
  except Exception as exc:
    await jobmanager.increment_failure(job_id, message=str(exc))
    await jobmanager.upsert_job(
      job_id,
      status=JobStatus.FAILED,
      message=failure_message,
      datasource_id=datasource_id,
    )
    raise


@app.post("/v1/ingest/local-file", status_code=status.HTTP_202_ACCEPTED)
async def ingest_local_file(
  request: Request,
  files: List[UploadFile] = File(..., alias="file"),
  description: str = Form(""),
  owner_team_slug: Optional[str] = Form(None),
  search_team_slugs: List[str] = Form(default=[]),
  search_user_subjects: List[str] = Form(default=[]),
  ownership_preprovisioned: bool = Form(False),
  preprovisioned_datasource_id: Optional[str] = Form(None),
  chunk_size: int = Form(10000),
  chunk_overlap: int = Form(2000),
  user: UserContext = Depends(require_authenticated_user),
):
  """Ingest one or more local Markdown, PDF, or text files as a new data source."""
  if not metadata_storage or not jobmanager or not ingestor:
    raise HTTPException(status_code=500, detail="Server not initialized")

  uploads: list[tuple[UploadFile, str, bytes, str, str]] = []
  for upload_file in files:
    content = await upload_file.read()
    try:
      filename = _validate_local_file_upload(upload_file, content)
      text, document_type = _extract_local_file_text(filename, upload_file.content_type, content)
    except HTTPException as exc:
      safe_filename = _safe_upload_filename(upload_file.filename)
      logger.warning(
        "local_file_upload rejected filename=%s content_type=%s bytes=%d status=%d detail=%s user=%s",
        safe_filename,
        upload_file.content_type,
        len(content),
        exc.status_code,
        exc.detail,
        user.email,
      )
      raise
    uploads.append((upload_file, filename, content, text, document_type))

  _validate_local_file_batch([(filename, content) for _, filename, content, _, _ in uploads])
  total_bytes = sum(len(content) for _, _, content, _, _ in uploads)
  datasource_id = _local_files_datasource_id([(filename, content) for _, filename, content, _, _ in uploads])
  if ownership_preprovisioned and preprovisioned_datasource_id != datasource_id:
    raise HTTPException(
      status_code=400,
      detail="Preprovisioned datasource id does not match the uploaded file set",
    )
  existing_datasource = await metadata_storage.get_datasource_info(datasource_id)
  await authorize_source_ingestion(
    request,
    user,
    datasource_id,
    owner_team_slug,
    ownership_preprovisioned,
    existing_datasource,
  )
  if existing_datasource:
    raise HTTPException(status_code=400, detail="File set already ingested, please delete existing datasource before re-ingesting")

  await provision_legacy_datasource_ownership(
    datasource_id,
    owner_team_slug,
    search_team_slugs,
    search_user_subjects,
    user,
    ownership_preprovisioned,
    existing_datasource,
  )

  job_id = str(uuid.uuid4())
  success = await jobmanager.upsert_job(
    job_id,
    status=JobStatus.IN_PROGRESS,
    message="Ingesting uploaded file..." if len(uploads) == 1 else f"Ingesting {len(uploads)} uploaded files...",
    total=len(uploads),
    datasource_id=datasource_id,
  )
  if not success:
    raise HTTPException(status_code=500, detail="Failed to create job")

  bounded_chunk_size, bounded_chunk_overlap = _bound_local_file_chunk_params(chunk_size, chunk_overlap)
  now = int(time.time())
  first_filename = uploads[0][1]
  datasource_name = first_filename if len(uploads) == 1 else f"{first_filename} + {len(uploads) - 1} files"
  file_metadata = [
    {
      "filename": filename,
      "content_type": upload_file.content_type,
      "document_type": document_type,
      "byte_size": len(content),
    }
    for upload_file, filename, content, _, document_type in uploads
  ]
  datasource_info = DataSourceInfo(
    datasource_id=datasource_id,
    name=datasource_name,
    ingestor_id=LOCAL_FILE_INGESTOR_ID,
    description=description or (f"Uploaded file {first_filename}" if len(uploads) == 1 else f"Uploaded {len(uploads)} files"),
    source_type="local_file",
    last_updated=now,
    default_chunk_size=bounded_chunk_size,
    default_chunk_overlap=bounded_chunk_overlap,
    # Config is the source of truth for ownership; OpenFGA is the derived
    # projection (spec 2026-06-03). Persist the same owner/creator the
    # tuples below encode so the sharing panel reflects the owning team.
    owner_team_slug=(owner_team_slug or "").strip() or None,
    creator_subject=user.subject,
    owner_subject=user.subject if not (owner_team_slug or "").strip() else None,
    shared_with_teams=[],
    search_with_teams=search_team_slugs,
    search_with_users=search_user_subjects,
    metadata={
      "filename": first_filename,
      "file_count": len(uploads),
      "total_byte_size": total_bytes,
      "files": file_metadata,
    },
  )

  await metadata_storage.store_datasource_info(datasource_info)

  fresh_until = get_fresh_until(datasource_info.reload_interval)
  await _ingest_local_file_uploads(
    job_id=job_id,
    datasource_id=datasource_id,
    uploads=uploads,
    description=description,
    fresh_until=fresh_until,
    chunk_size=bounded_chunk_size,
    chunk_overlap=bounded_chunk_overlap,
    user=user,
    success_message="Uploaded file ingested successfully" if len(uploads) == 1 else f"Uploaded {len(uploads)} files ingested successfully",
    failure_message="Uploaded file ingestion failed",
  )

  return {
    "datasource_id": datasource_id,
    "job_id": job_id,
    "message": "Local file ingested successfully" if len(uploads) == 1 else "Local files ingested successfully",
  }


@app.post("/v1/ingest/local-file/reupload", status_code=status.HTTP_202_ACCEPTED)
async def reupload_local_file(
  datasource_id: str = Form(...),
  files: List[UploadFile] = File(..., alias="file"),
  chunk_size: Optional[int] = Form(None),
  chunk_overlap: Optional[int] = Form(None),
  user: UserContext = Depends(require_authenticated_user),
):
  """Replace the content of an existing local-file data source with a new upload."""
  if not metadata_storage or not jobmanager or not ingestor or not vector_db:
    raise HTTPException(status_code=500, detail="Server not initialized")
  if graph_rag_enabled and not data_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized")

  existing = await metadata_storage.get_datasource_info(datasource_id)
  if not existing:
    raise HTTPException(status_code=404, detail="Datasource not found")
  if existing.source_type != "local_file":
    raise HTTPException(status_code=400, detail="Only file datasources support re-upload")

  await check_datasource_management_access(user, datasource_id)

  uploads: list[tuple[UploadFile, str, bytes, str, str]] = []
  for upload_file in files:
    content = await upload_file.read()
    try:
      filename = _validate_local_file_upload(upload_file, content)
      text, document_type = _extract_local_file_text(filename, upload_file.content_type, content)
    except HTTPException as exc:
      safe_filename = _safe_upload_filename(upload_file.filename)
      logger.warning(
        "local_file_reupload rejected filename=%s content_type=%s bytes=%d status=%d detail=%s user=%s",
        safe_filename,
        upload_file.content_type,
        len(content),
        exc.status_code,
        exc.detail,
        user.email,
      )
      raise
    uploads.append((upload_file, filename, content, text, document_type))

  _validate_local_file_batch([(filename, content) for _, filename, content, _, _ in uploads])
  total_bytes = sum(len(content) for _, _, content, _, _ in uploads)

  jobs = await jobmanager.get_jobs_by_datasource(datasource_id)
  if jobs and any(job.status == JobStatus.IN_PROGRESS for job in jobs):
    raise HTTPException(status_code=400, detail="Cannot re-upload while an ingestion job is in progress.")

  await vector_db.adelete(expr=f"datasource_id == {VectorDBQueryService._quote_string(datasource_id)}")
  if graph_rag_enabled and data_graph_db:
    await data_graph_db.remove_entity(None, {DATASOURCE_ID_KEY: datasource_id})

  bounded_chunk_size, bounded_chunk_overlap = _bound_local_file_chunk_params(
    chunk_size if chunk_size is not None else (existing.default_chunk_size or 10000),
    chunk_overlap if chunk_overlap is not None else (existing.default_chunk_overlap or 2000),
  )

  job_id = str(uuid.uuid4())
  success = await jobmanager.upsert_job(
    job_id,
    status=JobStatus.IN_PROGRESS,
    message="Re-uploading file..." if len(uploads) == 1 else f"Re-uploading {len(uploads)} files...",
    total=len(uploads),
    datasource_id=datasource_id,
  )
  if not success:
    raise HTTPException(status_code=500, detail="Failed to create job")

  now = int(time.time())
  first_filename = uploads[0][1]
  datasource_name = first_filename if len(uploads) == 1 else f"{first_filename} + {len(uploads) - 1} files"
  file_metadata = [
    {
      "filename": filename,
      "content_type": upload_file.content_type,
      "document_type": document_type,
      "byte_size": len(content),
    }
    for upload_file, filename, content, _, document_type in uploads
  ]
  existing.name = datasource_name
  existing.default_chunk_size = bounded_chunk_size
  existing.default_chunk_overlap = bounded_chunk_overlap
  existing.last_updated = now
  existing.metadata = {
    **(existing.metadata or {}),
    "filename": first_filename,
    "file_count": len(uploads),
    "total_byte_size": total_bytes,
    "files": file_metadata,
  }
  await metadata_storage.store_datasource_info(existing)

  fresh_until = get_fresh_until(existing.reload_interval)
  await _ingest_local_file_uploads(
    job_id=job_id,
    datasource_id=datasource_id,
    uploads=uploads,
    description=existing.description,
    fresh_until=fresh_until,
    chunk_size=bounded_chunk_size,
    chunk_overlap=bounded_chunk_overlap,
    user=user,
    success_message="Re-uploaded file ingested successfully" if len(uploads) == 1 else f"Re-uploaded {len(uploads)} files ingested successfully",
    failure_message="Re-uploaded file ingestion failed",
  )

  return {
    "datasource_id": datasource_id,
    "job_id": job_id,
    "message": "Local file re-uploaded successfully" if len(uploads) == 1 else "Local files re-uploaded successfully",
  }


@app.post("/v1/ingest/webloader/preview")
async def preview_url_ingestion(
  url_request: UrlIngestRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Crawl a bounded sample without creating a datasource, job, or documents."""
  url_request.url = sanitize_url(
    url_request.url,
    url_request.settings.allow_non_public_urls,
  )
  datasource_id = utils.generate_datasource_id_from_url(url_request.url)
  existing_datasource = (
    await metadata_storage.get_datasource_info(datasource_id)
    if metadata_storage
    else None
  )
  await authorize_source_ingestion(
    request,
    user,
    datasource_id,
    url_request.owner_team_slug,
    url_request.ownership_preprovisioned,
    existing_datasource,
  )
  return await request_ingestor_preview(
    ingestor_type=WEBLOADER_INGESTOR_TYPE,
    command=WebIngestorCommand.PREVIEW_URL,
    payload=url_request.model_dump(),
  )


def resolve_confluence_datasource_id(
  confluence_request: ConfluenceIngestRequest,
  space_key: str,
  page_id: str,
) -> str:
  """Resolve page-scoped identity while accepting an existing legacy ID."""
  page_datasource_id = utils.generate_confluence_datasource_id(
    confluence_request.url,
    space_key,
    page_id,
  )
  supplied_id = (confluence_request.preprovisioned_datasource_id or "").strip()
  if not supplied_id:
    return page_datasource_id
  if not confluence_request.ownership_preprovisioned:
    raise HTTPException(
      status_code=400,
      detail="preprovisioned_datasource_id requires preprovisioned ownership",
    )
  legacy_space_id = utils.generate_confluence_datasource_id(
    confluence_request.url,
    space_key,
  )
  if supplied_id not in {page_datasource_id, legacy_space_id}:
    raise HTTPException(
      status_code=400,
      detail="Preprovisioned datasource ID does not match the Confluence page",
    )
  return supplied_id


def confluence_scope_description(
  confluence_request: ConfluenceIngestRequest,
) -> str:
  """Describe the concrete URL scope represented by a Confluence source."""
  if confluence_request.get_child_pages:
    return f"Confluence page and child pages starting at {confluence_request.url}"
  return f"Confluence page {confluence_request.url}"


@app.post("/v1/ingest/confluence/preview")
async def preview_confluence_ingestion(
  confluence_request: ConfluenceIngestRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Resolve the configured Confluence root and filters without ingesting."""
  confluence_match = re.search(r"/spaces/([^/]+)/pages/(\d+)", confluence_request.url)
  if not confluence_match:
    raise HTTPException(
      status_code=400,
      detail="Invalid Confluence URL format. Expected a /spaces/SPACE/pages/PAGE_ID URL",
    )
  if confluence_url:
    submitted = urlparse(confluence_request.url)
    configured = urlparse(confluence_url)
    if submitted.scheme != configured.scheme or submitted.netloc != configured.netloc:
      raise HTTPException(
        status_code=400,
        detail=f"URL must be from configured Confluence instance: {configured.scheme}://{configured.netloc}",
      )
  space_key = unquote(confluence_match.group(1))
  page_id = confluence_match.group(2)
  datasource_id = resolve_confluence_datasource_id(
    confluence_request,
    space_key,
    page_id,
  )
  existing_datasource = (
    await metadata_storage.get_datasource_info(datasource_id)
    if metadata_storage
    else None
  )
  await authorize_source_ingestion(
    request,
    user,
    datasource_id,
    confluence_request.owner_team_slug,
    confluence_request.ownership_preprovisioned,
    existing_datasource,
  )
  return await request_ingestor_preview(
    ingestor_type=CONFLUENCE_INGESTOR_TYPE,
    command=ConfluenceIngestorCommand.PREVIEW_PAGE,
    payload=confluence_request.model_dump(),
  )


@app.post("/v1/ingest/jira/preview")
async def preview_jira_ingestion(
  jira_request: JiraIngestRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Run the submitted JQL as a bounded, read-only preview."""
  datasource_id = f"jira-{jira_request.project_key.lower()}-{jira_request.source_slug}"
  existing_datasource = (
    await metadata_storage.get_datasource_info(datasource_id)
    if metadata_storage
    else None
  )
  await authorize_source_ingestion(
    request,
    user,
    datasource_id,
    jira_request.owner_team_slug,
    jira_request.ownership_preprovisioned,
    existing_datasource,
  )
  return await request_ingestor_preview(
    ingestor_type=JIRA_INGESTOR_TYPE,
    command=JiraIngestorCommand.PREVIEW_PROJECT,
    payload=jira_request.model_dump(),
  )


@app.post("/v1/ingest/webloader/url", status_code=status.HTTP_202_ACCEPTED)
async def ingest_url(
  url_request: UrlIngestRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Queue a URL for ingestion by the webloader ingestor."""
  if not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  logger.info(f"Received URL ingestion request: {url_request.url}")

  # Sanitize URL
  sanitized_url = sanitize_url(url_request.url, url_request.settings.allow_non_public_urls)
  url_request.url = sanitized_url

  # Generate datasource ID and create datasource
  datasource_id = utils.generate_datasource_id_from_url(url_request.url)
  existing_datasource = await metadata_storage.get_datasource_info(datasource_id)
  await authorize_source_ingestion(
    request,
    user,
    datasource_id,
    url_request.owner_team_slug,
    url_request.ownership_preprovisioned,
    existing_datasource,
  )
  if existing_datasource and not url_request.ownership_preprovisioned:
    logger.info(f"Datasource already exists for URL {url_request.url}, datasource ID: {datasource_id}")
    raise HTTPException(status_code=400, detail="URL already ingested, please delete existing datasource before re-ingesting")
  live_ingestor_id = (
    await resolve_datasource_ingestor(existing_datasource, WEBLOADER_INGESTOR_TYPE)
    if existing_datasource
    else await resolve_live_ingestor_id(WEBLOADER_INGESTOR_TYPE)
  )
  await provision_legacy_datasource_ownership(
    datasource_id,
    url_request.owner_team_slug,
    url_request.search_team_slugs,
    url_request.search_user_subjects,
    user,
    url_request.ownership_preprovisioned,
    existing_datasource,
  )

  # Check if there is already a job for this datasource in progress or pending
  await reject_if_ingestion_job_blocking(datasource_id, "URL")

  # Create job with PENDING status first
  job_id = str(uuid.uuid4())
  success = await jobmanager.upsert_job(
    job_id,
    status=JobStatus.PENDING,
    message="Waiting for ingestor to process...",
    total=0,  # Unknown until sitemap is checked
    datasource_id=datasource_id,
  )

  if not success:
    raise HTTPException(status_code=500, detail="Failed to create job")

  logger.info(f"Created job {job_id} for datasource {datasource_id}")

  if not url_request.description:
    url_request.description = f"Web content from {url_request.url}"

  # Metadata schema for source_type="web": {"url_ingest_request": UrlIngestRequest, "reload_interval": int | None}
  if existing_datasource:
    existing_datasource.description = url_request.description
    existing_datasource.default_chunk_size = url_request.settings.chunk_size
    existing_datasource.default_chunk_overlap = url_request.settings.chunk_overlap
    if url_request.reload_interval is not None:
      existing_datasource.reload_interval = url_request.reload_interval
    existing_datasource.last_updated = int(time.time())
    existing_datasource.metadata = {
      **(existing_datasource.metadata or {}),
      "url_ingest_request": url_request.model_dump(),
      "reload_interval": url_request.reload_interval,
    }
    await metadata_storage.store_datasource_info(existing_datasource)
  else:
    datasource_info = DataSourceInfo(
      datasource_id=datasource_id,
      name=utils.derive_friendly_name(url=url_request.url, source_type="web"),
      ingestor_id=live_ingestor_id,
      description=url_request.description,
      source_type="web",
      last_updated=int(time.time()),
      default_chunk_size=url_request.settings.chunk_size,
      default_chunk_overlap=url_request.settings.chunk_overlap,
      reload_interval=url_request.reload_interval,
      owner_team_slug=(url_request.owner_team_slug or "").strip() or None,
      creator_subject=user.subject,
      owner_subject=user.subject if not (url_request.owner_team_slug or "").strip() else None,
      shared_with_teams=[],
      search_with_teams=url_request.search_team_slugs,
      search_with_users=url_request.search_user_subjects,
      metadata={
        "url_ingest_request": url_request.model_dump(),
        "reload_interval": url_request.reload_interval,
        "config_managed": url_request.config_managed,
      },
    )
    await metadata_storage.store_datasource_info(datasource_info)
    logger.info(f"Created datasource: {datasource_id}")

  await enqueue_ingestor_request(
    ingestor_type=WEBLOADER_INGESTOR_TYPE,
    ingestor_id=live_ingestor_id,
    command=WebIngestorCommand.INGEST_URL,
    payload=url_request.model_dump(),
    job_id=job_id,
  )

  return {"datasource_id": datasource_id, "job_id": job_id, "message": "URL ingestion request queued"}


@app.post("/v1/ingest/webloader/reload", status_code=status.HTTP_202_ACCEPTED)
async def reload_url(
  reload_request: UrlReloadRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Reloads a previously ingested URL by re-queuing it for ingestion."""
  job_id = await queue_datasource_reload(
    datasource_id=reload_request.datasource_id,
    resource_label="URL",
    ingestor_type=WEBLOADER_INGESTOR_TYPE,
    command=WebIngestorCommand.RELOAD_DATASOURCE,
    payload=reload_request.model_dump(),
    user=user,
  )
  return {"datasource_id": reload_request.datasource_id, "job_id": job_id, "message": "URL reload ingestion request queued"}


@app.post("/v1/ingest/webloader/reload-all", status_code=status.HTTP_202_ACCEPTED)
async def reload_all_urls(user: UserContext = Depends(require_role(Role.ADMIN))):
  """Reloads all previously ingested URLs by re-queuing them for ingestion."""
  if not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  count = await queue_reload_all(ingestor_type=WEBLOADER_INGESTOR_TYPE, command=WebIngestorCommand.RELOAD_ALL)
  return {"message": "Reload all URLs request queued", "ingestor_count": count}


@app.post("/v1/ingest/confluence/page", status_code=status.HTTP_202_ACCEPTED)
async def ingest_confluence_page(
  confluence_request: ConfluenceIngestRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Queue a Confluence page for ingestion by the confluence ingestor."""
  if not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  logger.info(f"Received Confluence page ingestion request: {confluence_request.url}")
  logger.info(f"  get_child_pages: {confluence_request.get_child_pages}")

  # Parse Confluence URL to extract space_key and page_id
  confluence_match = re.search(r"/spaces/([^/]+)/pages/(\d+)", confluence_request.url)
  if not confluence_match:
    raise HTTPException(status_code=400, detail="Invalid Confluence URL format. Expected: https://domain.atlassian.net/wiki/spaces/SPACE/pages/PAGE_ID/Title")

  space_key = unquote(confluence_match.group(1))
  page_id = confluence_match.group(2)

  # Validate that submitted URL matches configured Confluence instance
  if confluence_url:
    submitted_parsed = urlparse(confluence_request.url)
    configured_parsed = urlparse(confluence_url)

    # Compare scheme and netloc (domain)
    if submitted_parsed.scheme != configured_parsed.scheme or submitted_parsed.netloc != configured_parsed.netloc:
      raise HTTPException(status_code=400, detail=f"URL must be from configured Confluence instance: {configured_parsed.scheme}://{configured_parsed.netloc}")

  # Page-scoped identity allows multiple independent roots in one Confluence
  # space. Existing BFF records may explicitly retain the legacy space ID.
  datasource_id = resolve_confluence_datasource_id(
    confluence_request,
    space_key,
    page_id,
  )

  # Build page config for this ingestion
  page_config = {"page_id": page_id, "source": confluence_request.url, "get_child_pages": confluence_request.get_child_pages}

  # Check if the datasource already exists. Replacing or extending stored
  # connector configuration requires Owner access; a dedicated reload reuses
  # that configuration and therefore also requires Owner access.
  # Creating a new space uses the org author capability + owning-team gate.
  existing_datasource = await metadata_storage.get_datasource_info(datasource_id)
  await authorize_source_ingestion(
    request,
    user,
    datasource_id,
    confluence_request.owner_team_slug,
    confluence_request.ownership_preprovisioned,
    existing_datasource,
  )
  live_ingestor_id = (
    await resolve_datasource_ingestor(existing_datasource, CONFLUENCE_INGESTOR_TYPE)
    if existing_datasource
    else await resolve_live_ingestor_id(CONFLUENCE_INGESTOR_TYPE)
  )
  await provision_legacy_datasource_ownership(
    datasource_id,
    confluence_request.owner_team_slug,
    confluence_request.search_team_slugs,
    confluence_request.search_user_subjects,
    user,
    confluence_request.ownership_preprovisioned,
    existing_datasource,
  )

  # Do not mutate an existing source's config if this request cannot start a
  # job. This is especially important for source managers who intentionally
  # have no indexed-content grant.
  await reject_if_ingestion_job_blocking(datasource_id, "Confluence space")

  if existing_datasource:
    if not existing_datasource.metadata:
      existing_datasource.metadata = {}
    page_configs = existing_datasource.metadata.get("page_configs", [])

    # Check if page already exists in configs
    existing_page_config = next((c for c in page_configs if c.get("page_id") == page_id), None)

    if existing_page_config:
      # Update the get_child_pages flag
      existing_page_config["get_child_pages"] = confluence_request.get_child_pages
      existing_page_config["source"] = confluence_request.url
      logger.info(f"Updated page {page_id} config in {datasource_id}")
    else:
      # Add new page config
      page_configs.append(page_config)
      logger.info(f"Added page {page_id} to {datasource_id}")

    existing_datasource.metadata["page_configs"] = page_configs
    configured_name = (confluence_request.name or "").strip()
    if configured_name:
      existing_datasource.name = configured_name
    configured_description = confluence_request.description.strip()
    if configured_description:
      existing_datasource.description = configured_description
    elif not existing_datasource.description or existing_datasource.description == f"Confluence space {space_key}":
      existing_datasource.description = confluence_scope_description(confluence_request)
    # Update title filter patterns if provided
    if confluence_request.allowed_title_patterns is not None:
      existing_datasource.metadata["allowed_title_patterns"] = confluence_request.allowed_title_patterns
    if confluence_request.denied_title_patterns is not None:
      existing_datasource.metadata["denied_title_patterns"] = confluence_request.denied_title_patterns
    existing_datasource.metadata["confluence_ingest_request"] = confluence_request.model_dump()
    await metadata_storage.store_datasource_info(existing_datasource)
  else:
    # Create new datasource
    if not confluence_request.description:
      confluence_request.description = confluence_scope_description(confluence_request)

    confluence_url_base = confluence_request.url.split("/wiki/")[0] + "/wiki" if "/wiki/" in confluence_request.url else confluence_request.url

    datasource_info = DataSourceInfo(
      datasource_id=datasource_id,
      name=(confluence_request.name or "").strip() or utils.derive_friendly_name(source_type="confluence", space_key=space_key, url=confluence_url_base),
      ingestor_id=live_ingestor_id,
      description=confluence_request.description,
      source_type="confluence",
      last_updated=int(time.time()),
      default_chunk_size=confluence_request.default_chunk_size,
      default_chunk_overlap=confluence_request.default_chunk_overlap,
      reload_interval=confluence_request.reload_interval,
      # Config is the source of truth for ownership; OpenFGA is the derived
      # projection (spec 2026-06-03). Persist the same owner/creator the
      # tuples below encode so the sharing panel reflects the owning team.
      owner_team_slug=(confluence_request.owner_team_slug or "").strip() or None,
      creator_subject=user.subject,
      owner_subject=user.subject if not (confluence_request.owner_team_slug or "").strip() else None,
      shared_with_teams=[],
      search_with_teams=confluence_request.search_team_slugs,
      search_with_users=confluence_request.search_user_subjects,
      metadata={
        "confluence_ingest_request": confluence_request.model_dump(),
        "space_key": space_key,
        "page_configs": [page_config],
        "root_page_id": page_id,
        "root_page_url": confluence_request.url,
        "confluence_url": confluence_url_base,
        "config_managed": confluence_request.config_managed,
        **({"allowed_title_patterns": confluence_request.allowed_title_patterns} if confluence_request.allowed_title_patterns else {}),
        **({"denied_title_patterns": confluence_request.denied_title_patterns} if confluence_request.denied_title_patterns else {}),
      },
    )

    await metadata_storage.store_datasource_info(datasource_info)
    logger.info(f"Created datasource: {datasource_id}")

  # Create job with PENDING status
  job_id = str(uuid.uuid4())
  success = await jobmanager.upsert_job(
    job_id,
    status=JobStatus.PENDING,
    message="Waiting for ingestor to process...",
    total=1,  # Single page ingestion
    datasource_id=datasource_id,
  )

  if not success:
    raise HTTPException(status_code=500, detail="Failed to create job")

  logger.info(f"Created job {job_id} for datasource {datasource_id}")

  await enqueue_ingestor_request(
    ingestor_type=CONFLUENCE_INGESTOR_TYPE,
    ingestor_id=live_ingestor_id,
    command=ConfluenceIngestorCommand.INGEST_PAGE,
    payload=confluence_request.model_dump(),
    job_id=job_id,
  )

  return {"datasource_id": datasource_id, "job_id": job_id, "message": "Confluence page ingestion request queued"}


@app.post("/v1/ingest/confluence/reload", status_code=status.HTTP_202_ACCEPTED)
async def reload_confluence_page(
  reload_request: ConfluenceReloadRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Reloads a previously ingested Confluence page by re-queuing it for ingestion."""
  job_id = await queue_datasource_reload(
    datasource_id=reload_request.datasource_id,
    resource_label="Confluence space",
    ingestor_type=CONFLUENCE_INGESTOR_TYPE,
    command=ConfluenceIngestorCommand.RELOAD_DATASOURCE,
    payload=reload_request.model_dump(),
    user=user,
  )
  return {"datasource_id": reload_request.datasource_id, "job_id": job_id, "message": "Confluence page reload request queued"}


@app.post("/v1/ingest/confluence/reload-all", status_code=status.HTTP_202_ACCEPTED)
async def reload_all_confluence_pages(user: UserContext = Depends(require_role(Role.ADMIN))):
  """Reloads all previously ingested Confluence pages by re-queuing them for ingestion."""
  if not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  count = await queue_reload_all(ingestor_type=CONFLUENCE_INGESTOR_TYPE, command=ConfluenceIngestorCommand.RELOAD_ALL)
  return {"message": "Reload all Confluence pages request queued", "ingestor_count": count}


@app.post("/v1/ingest/slack/channel", status_code=status.HTTP_202_ACCEPTED)
async def ingest_slack_channel(
  slack_request: SlackIngestRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Queue a Slack channel for on-demand ingestion by the slack ingestor."""
  if not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  logger.info(f"Received Slack channel ingestion request: {slack_request.channel_id}")

  datasource_id = f"slack-channel-{slack_request.channel_id}"

  existing_datasource = await metadata_storage.get_datasource_info(datasource_id)
  await authorize_source_ingestion(
    request,
    user,
    datasource_id,
    slack_request.owner_team_slug,
    slack_request.ownership_preprovisioned,
    existing_datasource,
  )
  live_ingestor_id = (
    await resolve_datasource_ingestor(existing_datasource, SLACK_INGESTOR_TYPE)
    if existing_datasource
    else await resolve_live_ingestor_id(SLACK_INGESTOR_TYPE)
  )
  await provision_legacy_datasource_ownership(
    datasource_id,
    slack_request.owner_team_slug,
    slack_request.search_team_slugs,
    slack_request.search_user_subjects,
    user,
    slack_request.ownership_preprovisioned,
    existing_datasource,
  )

  await reject_if_ingestion_job_blocking(datasource_id, "channel")

  job_id = str(uuid.uuid4())
  success = await jobmanager.upsert_job(
    job_id,
    status=JobStatus.PENDING,
    message="Waiting for ingestor to process...",
    total=0,
    datasource_id=datasource_id,
  )
  if not success:
    raise HTTPException(status_code=500, detail="Failed to create job")

  logger.info(f"Created job {job_id} for datasource {datasource_id}")

  if not existing_datasource:
    if not slack_request.description:
      slack_request.description = f"Slack conversations from #{slack_request.channel_name or slack_request.channel_id}"

    datasource_info = DataSourceInfo(
      datasource_id=datasource_id,
      name=utils.derive_friendly_name(source_type="slack", channel_name=slack_request.channel_name or slack_request.channel_id),
      ingestor_id=live_ingestor_id,
      description=slack_request.description,
      source_type="slack",
      last_updated=int(time.time()),
      default_chunk_size=slack_request.default_chunk_size,
      default_chunk_overlap=slack_request.default_chunk_overlap,
      reload_interval=slack_request.reload_interval,
      owner_team_slug=(slack_request.owner_team_slug or "").strip() or None,
      creator_subject=user.subject,
      owner_subject=user.subject if not (slack_request.owner_team_slug or "").strip() else None,
      shared_with_teams=[],
      search_with_teams=slack_request.search_team_slugs,
      search_with_users=slack_request.search_user_subjects,
      metadata={
        "channel_id": slack_request.channel_id,
        "channel_name": slack_request.channel_name or slack_request.channel_id,
        "lookback_days": slack_request.lookback_days,
        "include_bots": slack_request.include_bots,
        "config_managed": slack_request.config_managed,
      },
    )
    await metadata_storage.store_datasource_info(datasource_info)
    logger.info(f"Created datasource: {datasource_id}")

  await enqueue_ingestor_request(
    ingestor_type=SLACK_INGESTOR_TYPE,
    ingestor_id=live_ingestor_id,
    command=SlackIngestorCommand.INGEST_CHANNEL,
    payload=slack_request.model_dump(),
    job_id=job_id,
  )

  return {"datasource_id": datasource_id, "job_id": job_id, "message": "Slack channel ingestion request queued"}


@app.post("/v1/ingest/slack/reload", status_code=status.HTTP_202_ACCEPTED)
async def reload_slack_channel(
  reload_request: SlackReloadRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Reloads a previously ingested Slack channel by re-queuing it for ingestion."""
  job_id = await queue_datasource_reload(
    datasource_id=reload_request.datasource_id,
    resource_label="Slack channel",
    ingestor_type=SLACK_INGESTOR_TYPE,
    command=SlackIngestorCommand.RELOAD_DATASOURCE,
    payload=reload_request.model_dump(),
    user=user,
  )
  return {"datasource_id": reload_request.datasource_id, "job_id": job_id, "message": "Slack channel reload request queued"}


@app.post("/v1/ingest/slack/reload-all", status_code=status.HTTP_202_ACCEPTED)
async def reload_all_slack_channels(user: UserContext = Depends(require_role(Role.ADMIN))):
  """Reloads all previously ingested Slack channels by re-queuing them for ingestion."""
  if not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  count = await queue_reload_all(ingestor_type=SLACK_INGESTOR_TYPE, command=SlackIngestorCommand.RELOAD_ALL)
  return {"message": "Reload all Slack channels request queued", "ingestor_count": count}


@app.post("/v1/ingest/jira/project", status_code=status.HTTP_202_ACCEPTED)
async def ingest_jira_project(
  jira_request: JiraIngestRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Queue a Jira project for on-demand ingestion by the jira ingestor."""
  if not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  logger.info(f"Received Jira project ingestion request: {jira_request.project_key}/{jira_request.source_slug}")

  datasource_id = f"jira-{jira_request.project_key.lower()}-{jira_request.source_slug}"

  existing_datasource = await metadata_storage.get_datasource_info(datasource_id)
  await authorize_source_ingestion(
    request,
    user,
    datasource_id,
    jira_request.owner_team_slug,
    jira_request.ownership_preprovisioned,
    existing_datasource,
  )
  live_ingestor_id = (
    await resolve_datasource_ingestor(existing_datasource, JIRA_INGESTOR_TYPE)
    if existing_datasource
    else await resolve_live_ingestor_id(JIRA_INGESTOR_TYPE)
  )
  await provision_legacy_datasource_ownership(
    datasource_id,
    jira_request.owner_team_slug,
    jira_request.search_team_slugs,
    jira_request.search_user_subjects,
    user,
    jira_request.ownership_preprovisioned,
    existing_datasource,
  )

  await reject_if_ingestion_job_blocking(datasource_id, "project")

  job_id = str(uuid.uuid4())
  success = await jobmanager.upsert_job(
    job_id,
    status=JobStatus.PENDING,
    message="Waiting for ingestor to process...",
    total=0,
    datasource_id=datasource_id,
  )
  if not success:
    raise HTTPException(status_code=500, detail="Failed to create job")

  logger.info(f"Created job {job_id} for datasource {datasource_id}")

  if not existing_datasource:
    if not jira_request.description:
      jira_request.description = f"Jira issues: {jira_request.name} ({jira_request.project_key})"

    datasource_info = DataSourceInfo(
      datasource_id=datasource_id,
      name=f"Jira: {jira_request.name} ({jira_request.project_key})",
      ingestor_id=live_ingestor_id,
      description=jira_request.description,
      source_type="jira",
      last_updated=int(time.time()),
      default_chunk_size=jira_request.default_chunk_size,
      default_chunk_overlap=jira_request.default_chunk_overlap,
      reload_interval=jira_request.reload_interval,
      owner_team_slug=(jira_request.owner_team_slug or "").strip() or None,
      creator_subject=user.subject,
      owner_subject=user.subject if not (jira_request.owner_team_slug or "").strip() else None,
      shared_with_teams=[],
      search_with_teams=jira_request.search_team_slugs,
      search_with_users=jira_request.search_user_subjects,
      metadata={
        "project_key": jira_request.project_key,
        "datasource_name": jira_request.name,
        "jql": jira_request.jql,
        "custom_fields": jira_request.custom_fields,
        "include_comments": jira_request.include_comments,
        "include_links": jira_request.include_links,
        "config_managed": jira_request.config_managed,
      },
    )
    await metadata_storage.store_datasource_info(datasource_info)
    logger.info(f"Created datasource: {datasource_id}")

  await enqueue_ingestor_request(
    ingestor_type=JIRA_INGESTOR_TYPE,
    ingestor_id=live_ingestor_id,
    command=JiraIngestorCommand.INGEST_PROJECT,
    payload=jira_request.model_dump(),
    job_id=job_id,
  )

  return {"datasource_id": datasource_id, "job_id": job_id, "message": "Jira project ingestion request queued"}


@app.post("/v1/ingest/jira/reload", status_code=status.HTTP_202_ACCEPTED)
async def reload_jira_project(
  reload_request: JiraReloadRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Reloads a previously ingested Jira project by re-queuing it for ingestion."""
  job_id = await queue_datasource_reload(
    datasource_id=reload_request.datasource_id,
    resource_label="Jira project",
    ingestor_type=JIRA_INGESTOR_TYPE,
    command=JiraIngestorCommand.RELOAD_DATASOURCE,
    payload=reload_request.model_dump(),
    user=user,
  )
  return {"datasource_id": reload_request.datasource_id, "job_id": job_id, "message": "Jira project reload request queued"}


@app.post("/v1/ingest/jira/reload-all", status_code=status.HTTP_202_ACCEPTED)
async def reload_all_jira_projects(user: UserContext = Depends(require_role(Role.ADMIN))):
  """Reloads all previously ingested Jira projects by re-queuing them for ingestion."""
  if not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  count = await queue_reload_all(ingestor_type=JIRA_INGESTOR_TYPE, command=JiraIngestorCommand.RELOAD_ALL)
  return {"message": "Reload all Jira projects request queued", "ingestor_count": count}


@app.post("/v1/ingest/webex/space", status_code=status.HTTP_202_ACCEPTED)
async def ingest_webex_space(
  webex_request: WebexIngestRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Queue a Webex space for on-demand ingestion by the webex ingestor."""
  if not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  logger.info(f"Received Webex space ingestion request: {webex_request.space_id}")

  datasource_id = f"webex-space-{webex_request.space_id}"

  existing_datasource = await metadata_storage.get_datasource_info(datasource_id)
  await authorize_source_ingestion(
    request,
    user,
    datasource_id,
    webex_request.owner_team_slug,
    webex_request.ownership_preprovisioned,
    existing_datasource,
  )
  live_ingestor_id = (
    await resolve_datasource_ingestor(existing_datasource, WEBEX_INGESTOR_TYPE)
    if existing_datasource
    else await resolve_live_ingestor_id(WEBEX_INGESTOR_TYPE)
  )
  await provision_legacy_datasource_ownership(
    datasource_id,
    webex_request.owner_team_slug,
    webex_request.search_team_slugs,
    webex_request.search_user_subjects,
    user,
    webex_request.ownership_preprovisioned,
    existing_datasource,
  )

  await reject_if_ingestion_job_blocking(datasource_id, "space")

  job_id = str(uuid.uuid4())
  success = await jobmanager.upsert_job(
    job_id,
    status=JobStatus.PENDING,
    message="Waiting for ingestor to process...",
    total=0,
    datasource_id=datasource_id,
  )
  if not success:
    raise HTTPException(status_code=500, detail="Failed to create job")

  logger.info(f"Created job {job_id} for datasource {datasource_id}")

  if not existing_datasource:
    if not webex_request.description:
      webex_request.description = f"Webex messages from space '{webex_request.space_name or webex_request.space_id}'"

    datasource_info = DataSourceInfo(
      datasource_id=datasource_id,
      name=f"Webex: {webex_request.space_name or webex_request.space_id}",
      ingestor_id=live_ingestor_id,
      description=webex_request.description,
      source_type="webex",
      last_updated=int(time.time()),
      default_chunk_size=webex_request.default_chunk_size,
      default_chunk_overlap=webex_request.default_chunk_overlap,
      reload_interval=webex_request.reload_interval,
      owner_team_slug=(webex_request.owner_team_slug or "").strip() or None,
      creator_subject=user.subject,
      owner_subject=user.subject if not (webex_request.owner_team_slug or "").strip() else None,
      shared_with_teams=[],
      search_with_teams=webex_request.search_team_slugs,
      search_with_users=webex_request.search_user_subjects,
      metadata={
        "space_id": webex_request.space_id,
        "space_name": webex_request.space_name or webex_request.space_id,
        "include_bots": webex_request.include_bots,
        "config_managed": webex_request.config_managed,
      },
    )
    await metadata_storage.store_datasource_info(datasource_info)
    logger.info(f"Created datasource: {datasource_id}")

  await enqueue_ingestor_request(
    ingestor_type=WEBEX_INGESTOR_TYPE,
    ingestor_id=live_ingestor_id,
    command=WebexIngestorCommand.INGEST_SPACE,
    payload=webex_request.model_dump(),
    job_id=job_id,
  )

  return {"datasource_id": datasource_id, "job_id": job_id, "message": "Webex space ingestion request queued"}


@app.post("/v1/ingest/webex/reload", status_code=status.HTTP_202_ACCEPTED)
async def reload_webex_space(
  reload_request: WebexReloadRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Reloads a previously ingested Webex space by re-queuing it for ingestion."""
  job_id = await queue_datasource_reload(
    datasource_id=reload_request.datasource_id,
    resource_label="Webex space",
    ingestor_type=WEBEX_INGESTOR_TYPE,
    command=WebexIngestorCommand.RELOAD_DATASOURCE,
    payload=reload_request.model_dump(),
    user=user,
  )
  return {"datasource_id": reload_request.datasource_id, "job_id": job_id, "message": "Webex space reload request queued"}


@app.post("/v1/ingest/webex/reload-all", status_code=status.HTTP_202_ACCEPTED)
async def reload_all_webex_spaces(user: UserContext = Depends(require_role(Role.ADMIN))):
  """Reloads all previously ingested Webex spaces by re-queuing them for ingestion."""
  if not metadata_storage or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  count = await queue_reload_all(ingestor_type=WEBEX_INGESTOR_TYPE, command=WebexIngestorCommand.RELOAD_ALL)
  return {"message": "Reload all Webex spaces request queued", "ingestor_count": count}


@app.post("/v1/ingest")
async def ingest_documents(
  ingest_request: DocumentIngestRequest,
  request: Request,
  user: UserContext = Depends(require_authenticated_user),
):
  """Updates/Ingests text and graph data to the appropriate databases"""

  if not vector_db or not metadata_storage or not ingestor or not jobmanager:
    raise HTTPException(status_code=500, detail="Server not initialized")

  # Check if datasource exists
  datasource_info = await metadata_storage.get_datasource_info(ingest_request.datasource_id)
  if not datasource_info:
    raise HTTPException(status_code=404, detail="Datasource not found")
  await authorize_ingestor_transport(
    user,
    ingest_request.datasource_id,
    ingest_request.ingestor_id,
  )
  logger.info(f"Starting data ingestion for datasource: {ingest_request.datasource_id}")

  if not ingest_request.job_id:
    raise HTTPException(status_code=400, detail="job_id is required")
  # Find the exact server-created job for this datasource.
  job_info = await jobmanager.get_job(ingest_request.job_id)
  if not job_info:
    raise HTTPException(status_code=404, detail="Job not found")
  if job_info.datasource_id != ingest_request.datasource_id:
    raise HTTPException(status_code=403, detail="Job is not assigned to this datasource")

  if job_info.status != JobStatus.IN_PROGRESS:
    raise HTTPException(status_code=400, detail="Ingestion can only be started for jobs in IN_PROGRESS status")

  # Check max documents limit
  if len(ingest_request.documents) > max_documents_per_ingest:
    return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content={"message": f"Number of documents exceeds the maximum limit of {max_documents_per_ingest} per ingestion request."})

  if ingest_request.fresh_until is None or ingest_request.fresh_until == 0:
    # Calculate fresh_until from datasource reload_interval
    ingest_request.fresh_until = get_fresh_until(datasource_info.reload_interval)

  if datasource_info.default_chunk_overlap is None:
    datasource_info.default_chunk_overlap = 0

  if datasource_info.default_chunk_size is None:
    datasource_info.default_chunk_size = 0  # Don't chunk if chunk size is not set

  try:
    await ingestor.ingest_documents(
      ingestor_id=ingest_request.ingestor_id,
      datasource_id=ingest_request.datasource_id,
      job_id=job_info.job_id,
      documents=ingest_request.documents,
      fresh_until=ingest_request.fresh_until,
      chunk_overlap=datasource_info.default_chunk_overlap,
      chunk_size=datasource_info.default_chunk_size,
    )
  except ValueError:
    return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content={"message": "Invalid input data"})
  return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content={"message": "Text data ingestion started successfully"})


# ============================================================================
# Knowledge Graph Endpoints
# ============================================================================


async def _get_accessible_datasource_ids_for_request(user: UserContext, scope: str) -> Optional[List[str]]:
  """Resolve the caller's accessible datasource set once per request.

  Returns ``None`` for the explicit unsafe bypass or an OpenFGA org admin, so
  callers can skip filtering
  entirely instead of comparing against a sentinel list.
  """
  if not user.is_authenticated:
    return None
  accessible = await get_accessible_datasource_ids(user, scope)
  if "*" in accessible:
    return None
  return accessible


async def _require_unrestricted_ontology_access(user: UserContext) -> None:
  """Allow global ontology reads only when the caller can search every source.

  Ontology nodes and relations do not carry datasource provenance, so there is
  no safe way to filter the global ontology for a caller with a bounded source
  grant.  Such callers can still use the provenance-tagged data graph.
  """
  await authorize_search(user)
  accessible = await _get_accessible_datasource_ids_for_request(user, "read")
  if accessible is not None:
    raise HTTPException(
      status_code=403,
      detail="Ontology graph access requires unrestricted datasource access",
    )


def _entity_datasource_id(entity: StructuredEntity) -> Optional[str]:
  return entity.all_properties.get(DATASOURCE_ID_KEY)


def _filter_entities_by_datasource(entities: List[StructuredEntity], accessible: Optional[List[str]]) -> List[StructuredEntity]:
  """Drop entities whose tagged datasource is outside the accessible set.

  Untagged entities have no trustworthy provenance and therefore fail closed
  for restricted callers.
  """
  if accessible is None:
    return entities
  accessible_set = set(accessible)
  return [e for e in entities if _entity_datasource_id(e) in accessible_set]


async def _filter_relations_by_datasource(relations: List[Relation], accessible: Optional[List[str]]) -> List[Relation]:
  """Drop relations whose endpoints resolve to an inaccessible datasource.

  Relation edges themselves are not tagged with ``_datasource_id`` (only the
  ontology-building pipeline creates them, and it does not carry that tag —
  see agent_ontology/relation_manager.py). Resolve each unique endpoint via
  the existing single-entity lookup and require both sides to be accessible
  since this is a graph-DB read, not a PDP call. Untagged or missing endpoints
  fail closed. Only pays this
  cost for callers who are actually team-scope-restricted.
  """
  if accessible is None or not relations or not data_graph_db:
    return relations
  accessible_set = set(accessible)
  endpoint_ids = {(e.entity_type, e.primary_key) for r in relations for e in (r.from_entity, r.to_entity)}
  datasource_by_endpoint: dict[tuple[str, str], Optional[str]] = {}
  for entity_type, primary_key in endpoint_ids:
    entity = await data_graph_db.fetch_entity(entity_type, primary_key)
    datasource_by_endpoint[(entity_type, primary_key)] = _entity_datasource_id(entity) if entity else None

  def _endpoint_accessible(entity_id: StructuredEntityId) -> bool:
    ds_id = datasource_by_endpoint.get((entity_id.entity_type, entity_id.primary_key))
    return ds_id is not None and ds_id in accessible_set

  return [r for r in relations if _endpoint_accessible(r.from_entity) and _endpoint_accessible(r.to_entity)]


@app.get("/v1/graph/explore/entity_type")
async def list_entity_types(user: UserContext = Depends(require_role(Role.READONLY))):
  """
  Lists entity types visible to the caller.

  The ontology is global and has no datasource provenance. Restricted callers
  therefore derive their type list from the provenance-tagged data graph.
  """
  if not ontology_graph_db or not data_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized, or graph RAG is disabled")
  await authorize_search(user)
  logger.debug("Listing entity types")
  accessible = await _get_accessible_datasource_ids_for_request(user, "read")
  if accessible is None:
    e = await ontology_graph_db.get_all_entity_types()
  else:
    e = await data_graph_db.get_all_entity_types(datasource_ids=accessible)
  return JSONResponse(status_code=status.HTTP_200_OK, content=e)


# ====
# Data Graph Endpoints
# ====
@app.get("/v1/graph/explore/data/entities/batch")
async def fetch_data_entities_batch(
  offset: int = Query(0, description="Number of entities to skip (for pagination)", ge=0),
  limit: int = Query(100, description="Maximum number of entities to return", ge=1, le=1000),
  entity_type: Optional[str] = Query(None, description="Optional filter by entity type"),
  user: UserContext = Depends(require_role(Role.READONLY)),
):
  """
  Fetch entities from the data graph in batches for efficient bulk processing.
  Useful for pagination and bulk export of graph data.
  Maximum limit is 1000 entities per request.
  """
  if not data_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized, or graph RAG is disabled")
  await authorize_search(user)

  # Enforce max limit of 1000
  if limit > 1000:
    raise HTTPException(status_code=400, detail="Limit cannot exceed 1000 entities per request")

  logger.debug(f"Fetching data entities batch: offset={offset}, limit={limit}, entity_type={entity_type}")

  accessible = await _get_accessible_datasource_ids_for_request(user, "read")
  entities = await data_graph_db.fetch_entities_batch(
    offset=offset,
    limit=limit,
    entity_type=entity_type,
    datasource_ids=accessible,
  )
  entities = _filter_entities_by_datasource(entities, accessible)

  return JSONResponse(status_code=status.HTTP_200_OK, content={"entities": jsonable_encoder(entities), "count": len(entities), "offset": offset, "limit": limit})


@app.get("/v1/graph/explore/data/relations/batch")
async def fetch_data_relations_batch(
  offset: int = Query(0, description="Number of relations to skip (for pagination)", ge=0),
  limit: int = Query(100, description="Maximum number of relations to return", ge=1, le=1000),
  relation_name: Optional[str] = Query(None, description="Optional filter by relation name"),
  user: UserContext = Depends(require_role(Role.READONLY)),
):
  """
  Fetch relations from the data graph in batches for efficient bulk processing.
  Useful for pagination and bulk export of graph relations.
  Maximum limit is 1000 relations per request.
  """
  if not data_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized, or graph RAG is disabled")
  await authorize_search(user)

  # Enforce max limit of 1000
  if limit > 1000:
    raise HTTPException(status_code=400, detail="Limit cannot exceed 1000 relations per request")

  logger.debug(f"Fetching data relations batch: offset={offset}, limit={limit}, relation_name={relation_name}")

  accessible = await _get_accessible_datasource_ids_for_request(user, "read")
  relations = await data_graph_db.fetch_relations_batch(
    offset=offset,
    limit=limit,
    relation_name=relation_name,
    datasource_ids=accessible,
  )
  relations = await _filter_relations_by_datasource(relations, accessible)

  return JSONResponse(status_code=status.HTTP_200_OK, content={"relations": jsonable_encoder(relations), "count": len(relations), "offset": offset, "limit": limit})


@app.post("/v1/graph/explore/data/entity/neighborhood")
async def explore_data_entity_neighborhood(request: ExploreNeighborhoodRequest, user: UserContext = Depends(require_role(Role.READONLY))):
  """
  Explore an entity and its neighborhood in the data graph up to a specified depth.
  Depth 0 returns just the entity, depth 1 includes direct neighbors, etc.
  """
  if not data_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized, or graph RAG is disabled")
  await authorize_search(user)

  logger.debug(f"Exploring data neighborhood for entity_type={request.entity_type}, entity_pk={request.entity_pk}, depth={request.depth}")

  result = await data_graph_db.explore_neighborhood(entity_type=request.entity_type, entity_pk=request.entity_pk, depth=request.depth, max_results=1000)

  if result["entity"] is None:
    return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"message": "Entity not found"})

  accessible = await _get_accessible_datasource_ids_for_request(user, "read")
  # The starting entity itself is a single-entity fetch: deny outright rather
  # than silently filtering. Untagged entities fail closed for restricted users.
  start_datasource_id = _entity_datasource_id(result["entity"])
  if accessible is not None and start_datasource_id not in set(accessible):
    raise HTTPException(status_code=403, detail="Access denied for this graph entity")

  result["entities"] = _filter_entities_by_datasource(result["entities"], accessible)
  result["relations"] = await _filter_relations_by_datasource(result["relations"], accessible)

  return JSONResponse(status_code=status.HTTP_200_OK, content=jsonable_encoder(result))


@app.get("/v1/graph/explore/data/entity/start")
async def get_random_start_nodes(n: int = Query(10, description="Number of random nodes to fetch", ge=1, le=100), user: UserContext = Depends(require_role(Role.READONLY))):
  """
  Fetch random starting nodes from the data graph.
  Useful for initializing graph visualization or exploration.
  """
  if not data_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized, or graph RAG is disabled")
  await authorize_search(user)

  logger.debug(f"Fetching {n} random nodes from data graph")

  accessible = await _get_accessible_datasource_ids_for_request(user, "read")
  entities = await data_graph_db.fetch_random_entities(count=n, datasource_ids=accessible)
  entities = _filter_entities_by_datasource(entities, accessible)[:n]

  return JSONResponse(status_code=status.HTTP_200_OK, content=jsonable_encoder(entities))


@app.get("/v1/graph/explore/data/stats")
async def get_data_graph_stats(user: UserContext = Depends(require_role(Role.READONLY))):
  """
  Get statistics about the caller's accessible portion of the data graph.
  """
  if not data_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized, or graph RAG is disabled")
  await authorize_search(user)

  logger.debug("Fetching data graph statistics")

  accessible = await _get_accessible_datasource_ids_for_request(user, "read")
  stats = await data_graph_db.get_graph_stats(datasource_ids=accessible)

  return JSONResponse(status_code=status.HTTP_200_OK, content=stats)


# ====
# Ontology Graph Endpoints
# ====
# The ontology graph is deployment-global and has no `_datasource_id` tag on
# nodes or relations (see agent_ontology/relation_manager.py). Until ontology
# provenance exists, bounded callers must fail closed rather than receive
# schema and relationship information learned from sources they cannot read.


@app.get("/v1/graph/explore/ontology/entities/batch")
async def fetch_ontology_entities_batch(
  offset: int = Query(0, description="Number of entities to skip (for pagination)", ge=0),
  limit: int = Query(100, description="Maximum number of entities to return", ge=1, le=1000),
  entity_type: Optional[str] = Query(None, description="Optional filter by entity type"),
  user: UserContext = Depends(require_role(Role.READONLY)),
):
  """
  Fetch entities from the ontology graph in batches for efficient bulk processing.
  Useful for pagination and bulk export of ontology data.
  Maximum limit is 1000 entities per request.
  """
  if not ontology_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized, or graph RAG is disabled")
  await _require_unrestricted_ontology_access(user)

  # Enforce max limit of 1000
  if limit > 1000:
    raise HTTPException(status_code=400, detail="Limit cannot exceed 1000 entities per request")

  logger.debug(f"Fetching ontology entities batch: offset={offset}, limit={limit}, entity_type={entity_type}")

  entities = await ontology_graph_db.fetch_entities_batch(offset=offset, limit=limit, entity_type=entity_type)

  return JSONResponse(status_code=status.HTTP_200_OK, content={"entities": jsonable_encoder(entities), "count": len(entities), "offset": offset, "limit": limit})


@app.get("/v1/graph/explore/ontology/relations/batch")
async def fetch_ontology_relations_batch(
  offset: int = Query(0, description="Number of relations to skip (for pagination)", ge=0),
  limit: int = Query(100, description="Maximum number of relations to return", ge=1, le=1000),
  relation_name: Optional[str] = Query(None, description="Optional filter by relation name"),
  user: UserContext = Depends(require_role(Role.READONLY)),
):
  """
  Fetch relations from the ontology graph in batches for efficient bulk processing.
  Useful for pagination and bulk export of ontology relations.
  Maximum limit is 1000 relations per request.
  """
  if not ontology_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized, or graph RAG is disabled")
  await _require_unrestricted_ontology_access(user)

  # Enforce max limit of 1000
  if limit > 1000:
    raise HTTPException(status_code=400, detail="Limit cannot exceed 1000 relations per request")

  logger.debug(f"Fetching ontology relations batch: offset={offset}, limit={limit}, relation_name={relation_name}")

  relations = await ontology_graph_db.fetch_relations_batch(offset=offset, limit=limit, relation_name=relation_name)

  return JSONResponse(status_code=status.HTTP_200_OK, content={"relations": jsonable_encoder(relations), "count": len(relations), "offset": offset, "limit": limit})


@app.post("/v1/graph/explore/ontology/entity/neighborhood")
async def explore_ontology_entity_neighborhood(request: ExploreNeighborhoodRequest, user: UserContext = Depends(require_role(Role.READONLY))):
  """
  Explore an entity and its neighborhood in the ontology graph up to a specified depth.
  Depth 0 returns just the entity, depth 1 includes direct neighbors, etc.
  """
  if not ontology_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized, or graph RAG is disabled")
  await _require_unrestricted_ontology_access(user)

  logger.debug(f"Exploring ontology neighborhood for entity_type={request.entity_type}, entity_pk={request.entity_pk}, depth={request.depth}")

  result = await ontology_graph_db.explore_neighborhood(entity_type=request.entity_type, entity_pk=request.entity_pk, depth=request.depth, max_results=1000)

  if result["entity"] is None:
    return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"message": "Entity not found"})

  return JSONResponse(status_code=status.HTTP_200_OK, content=jsonable_encoder(result))


@app.get("/v1/graph/explore/ontology/entity/start")
async def get_random_ontology_start_nodes(n: int = Query(10, description="Number of random nodes to fetch", ge=1, le=100), user: UserContext = Depends(require_role(Role.READONLY))):
  """
  Fetch random starting nodes from the ontology graph.
  Useful for initializing graph visualization or exploration.
  """
  if not ontology_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized, or graph RAG is disabled")
  await _require_unrestricted_ontology_access(user)

  logger.debug(f"Fetching {n} random nodes from ontology graph")

  entities = await ontology_graph_db.fetch_random_entities(count=n)

  return JSONResponse(status_code=status.HTTP_200_OK, content=jsonable_encoder(entities))


@app.get("/v1/graph/explore/ontology/stats")
async def get_ontology_graph_stats(user: UserContext = Depends(require_role(Role.READONLY))):
  """
  Get statistics about the ontology graph (node count, relation count).
  """
  if not ontology_graph_db:
    raise HTTPException(status_code=500, detail="Server not initialized, or graph RAG is disabled")
  await _require_unrestricted_ontology_access(user)

  logger.debug("Fetching ontology graph statistics")

  stats = await ontology_graph_db.get_graph_stats()

  return JSONResponse(status_code=status.HTTP_200_OK, content=stats)


# ====
# Ontology Agent Reverse Proxy
# ====
async def _reverse_proxy(request: Request):
  """
  Reverse proxy to ontology agent service, which runs a separate FastAPI instance,
  and is responsible for handling ontology related requests.

  Read-only operations require the RAG search capability.
  Write operations require OpenFGA organization administration.

  This acts as a security gateway - the ontology agent service doesn't need
  its own RBAC implementation since it's only accessible through this proxy.
  """
  # Manually invoke the RBAC check since app.add_route doesn't support Depends()
  # We must manually resolve the auth_manager since Depends() doesn't work here
  auth_manager = get_auth_manager()
  user = await require_authenticated_user(request, auth_manager)

  # The ontology is deployment-global and has no datasource provenance. Even
  # its status message can name the relation currently being evaluated, so
  # every read must use the same unrestricted-source gate as ontology explore.
  # Every mutating operation remains org-admin only.
  is_status_endpoint = request.url.path.endswith("/status")
  is_read_only = request.method == "GET" and is_status_endpoint
  if is_read_only:
    await _require_unrestricted_ontology_access(user)
  else:
    await authorize_org_admin(user)

  logger.info(f"Ontology agent request by {user.email} to {request.url.path}")

  url = httpx.URL(path=request.url.path, query=request.url.query.encode("utf-8"))
  rp_req = ontology_agent_client.build_request(request.method, url, headers=request.headers.raw, content=request.stream(), timeout=30.0)
  rp_resp = await ontology_agent_client.send(rp_req, stream=True)
  return StreamingResponse(
    rp_resp.aiter_raw(),
    status_code=rp_resp.status_code,
    headers=rp_resp.headers,
    background=BackgroundTask(rp_resp.aclose),
  )


if graph_rag_enabled:  # Only add reverse proxy if graph RAG is enabled
  app.add_route("/v1/graph/ontology/agent/{path:path}", _reverse_proxy, ["GET", "POST", "DELETE"])


# ============================================================================
# Health Check and Configuration Endpoint
# ============================================================================


@app.get("/health")
async def liveness():
  """Liveness probe — process health only, no dependency checks."""
  return {"status": "ok"}


@app.get("/healthz")
async def health_check(response: Response):
  """Readiness probe with no deployment or indexed-data diagnostics."""
  health_status = "healthy"
  health_details = {}

  # Check if services are initialized
  if not metadata_storage or not vector_db or not jobmanager or not redis_client or (graph_rag_enabled and (not data_graph_db or not ontology_graph_db)):
    health_status = "unhealthy"
    health_details["error"] = "One or more services are not initialized"
    logger.error("healthz: One or more services are not initialized")

  if health_status == "unhealthy":
    response.status_code = 503
  return {
    "status": health_status,
    "timestamp": int(time.time()),
    "details": health_details,
    # This feature flag is intentionally public: the UI uses it only to
    # select available surfaces, and it contains no resource or topology data.
    "config": {"graph_rag_enabled": graph_rag_enabled},
  }


async def init_tests(logger: logging.Logger, redis_client: redis.Redis, embeddings: EmbeddingsFactory, milvus_uri: str):
  """
  Run initial tests to ensure connections to check if deps are working.
  Note: This does not check the graph db connection as its done in the init of the class.
  """
  logger.info("====== Running initialization tests ======")
  logger.info(f"1. Testing connections to Redis: URI [{redis_url}]...")
  resp = await redis_client.ping()
  logger.info(f"Redis ping response: {resp}")

  # Test embeddings endpoint
  logger.info(f"2. Testing connections to [{embeddings_model}]...")
  resp = embeddings.get_embeddings().embed_documents(["Test document"])
  logger.info(f"Embeddings response: {resp}")

  # Test vector DB connections
  logger.info(f"3. Testing connections to Milvus: [{milvus_uri}]...")
  client = MilvusClient(uri=milvus_uri)
  logger.info("4. Listing Milvus collections")
  collections = client.list_collections()
  logger.info(f"Milvus collections: {collections}")

  test_collection_name = "test_collection"

  # Setup vector db for graph data
  vector_db_test = Milvus(
    embedding_function=embeddings.get_embeddings(), collection_name=test_collection_name, connection_args=milvus_connection_args, index_params=[dense_index_params, sparse_index_params], builtin_function=BM25BuiltInFunction(output_field_names="sparse"), vector_field=["dense", "sparse"]
  )

  doc = Document(page_content="Test document", metadata={"source": "test"})
  logger.info(f"5. Adding test document to Milvus {doc}")
  resp = vector_db_test.add_documents(documents=[doc], ids=["test_doc_1"])
  logger.info(f"Milvus add response: {resp}")

  logger.info("6. Searching test document in Milvus")
  docs_with_score = vector_db_test.similarity_search_with_score("Test", k=1)
  logger.info(f"Milvus similarity search response: {docs_with_score}")

  logger.info(f"7. Listing Milvus collections (again, should see {test_collection_name})")
  collections = client.list_collections()
  logger.info(f"Milvus collections: {collections}")

  logger.info(f"8. Dropping {test_collection_name} collection in Milvus")
  resp = client.drop_collection(collection_name=test_collection_name)
  logger.info(f"Milvus drop collection response: {resp}")

  logger.info(f"9. Listing Milvus collections (final - should not see {test_collection_name})")
  collections = client.list_collections()
  logger.info(f"Milvus collections: {collections}")

  # Enhanced health checks for collections
  logger.info("10. Running enhanced health checks on collections...")

  # Get embedding dimensions for validation
  expected_dim = embeddings.detect_dimensions(embeddings.get_embeddings())
  logger.info(f"Expected embedding dimension: {expected_dim}")

  collections_to_check = [default_collection_name_docs]

  for collection_name in collections_to_check:
    logger.info(f"11. Validating collection {collection_name} in Milvus")

    # Check if collection exists
    if collection_name not in client.list_collections():
      logger.warning(f"Collection {collection_name} does not exist in Milvus, it should be created upon first ingestion.")
      continue

    # Get collection schema
    collection_info = client.describe_collection(collection_name=collection_name)
    logger.info(f"Collection {collection_name} info: {collection_info}")

    # Extract field information
    fields = collection_info.get("fields", [])
    field_names = {field["name"] for field in fields}

    # Check 1: Validate embedding dimensions
    logger.info(f"11a. Validating embedding dimensions for collection {collection_name}...")
    dense_field = next((field for field in fields if field["name"] == "dense"), None)
    if dense_field:
      actual_dim = dense_field["params"].get("dim")
      if actual_dim != expected_dim:
        raise Exception(f"Collection {collection_name}: Dense vector dimension mismatch. Expected: {expected_dim}, Actual: {actual_dim}, Have you changed the embeddings model? Please delete and re-ingest the collection.")
      logger.info(f"✓ Collection {collection_name}: Dense vector dimension correct ({actual_dim})")
    else:
      raise Exception(f"Collection {collection_name}: Dense vector field not found, please delete and re-ingest the collection.")

    # Check 2: Validate vector fields exists
    logger.info(f"11b. Validating vector fields for collection {collection_name}...")
    sparse_field = next((field for field in fields if field["name"] == "sparse"), None)
    if not sparse_field:
      raise Exception(f"Collection {collection_name}: Sparse vector field not found")

    # Validate required vector fields exist
    if "dense" not in field_names or "sparse" not in field_names:
      raise Exception(f"Collection {collection_name}: Missing required vector fields (dense, sparse), please delete and re-ingest the collection.")
    logger.info(f"✓ Collection {collection_name}: Vector fields present")

    if not collection_info.get("enable_dynamic_field"):
      raise Exception(f"Collection {collection_name}: Dynamic fields not enabled, please delete and re-ingest the collection.")

    logger.info(f"✓ Collection {collection_name}: Dynamic fields enabled")
    logger.info(f"✓ Collection {collection_name}: Metadata fields will be stored dynamically")

  logger.info("====== Initialization tests completed successfully ======")
  return


# ============================================================================
# MCP Tool Configuration Endpoints
# ============================================================================


async def _reload_mcp_tools():
  """Reload MCP tools from the current Redis config. No-op if MCP is disabled."""
  if not mcp_enabled or agent_tools is None:
    return
  builtin_config = await metadata_storage.get_mcp_builtin_config() or MCPBuiltinToolsConfig()
  tool_configs = await metadata_storage.fetch_all_mcp_tool_configs()
  await agent_tools.reload_tools(mcp, graph_rag_enabled=graph_rag_enabled, builtin_config=builtin_config, tool_configs=tool_configs)


@app.get("/v1/mcp/custom-tools", tags=["MCP Tools"])
async def list_mcp_tools(user: UserContext = Depends(require_role(Role.READONLY))):
  """List all custom MCP search tool configurations."""
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  tools = await metadata_storage.fetch_all_mcp_tool_configs()
  accessible = await get_accessible_mcp_tool_ids(user, "can_read")
  if "*" not in accessible:
    tools = [tool for tool in tools if tool.tool_id in accessible]
  return JSONResponse(status_code=status.HTTP_200_OK, content=jsonable_encoder(tools))


@app.post("/v1/mcp/custom-tools", tags=["MCP Tools"])
async def create_mcp_tool(config: MCPToolConfig, user: UserContext = Depends(require_authenticated_user)):
  """Create a new custom MCP search tool. The tool_id must be unique and not reserved.

  Authorization is OpenFGA-based (spec 2026-06-03-unified-shareable-resource-rbac):
  the caller must be an org admin or a member of the owner team.
  """
  await authorize_mcp_tool_create(user, getattr(config, "owner_team_slug", None))
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  if config.tool_id in RESERVED_TOOL_IDS:
    raise HTTPException(status_code=409, detail=f"tool_id '{config.tool_id}' conflicts with a built-in tool name and cannot be used.")
  existing = await metadata_storage.get_mcp_tool_config(config.tool_id)
  if existing:
    raise HTTPException(status_code=409, detail=f"A tool with tool_id '{config.tool_id}' already exists. Use PUT to update it.")
  now = int(time.time())
  config.created_at = now
  config.updated_at = now
  await metadata_storage.store_mcp_tool_config(config)
  logger.info(f"Created MCP tool '{config.tool_id}' (by {user.email})")
  await _reload_mcp_tools()
  return JSONResponse(status_code=status.HTTP_201_CREATED, content=jsonable_encoder(config))


@app.put("/v1/mcp/custom-tools/{tool_id}", tags=["MCP Tools"])
async def update_mcp_tool(tool_id: str, config: MCPToolConfig, user: UserContext = Depends(require_authenticated_user)):
  """Update an existing MCP search tool configuration (including the seeded 'search' tool).

  Authorization is OpenFGA-based: the caller must hold `mcp_tool#can_manage`
  (owner, owner-team admin, or org admin).
  """
  await authorize_mcp_tool_manage(user, tool_id)
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  if tool_id in RESERVED_TOOL_IDS:
    raise HTTPException(status_code=409, detail=f"tool_id '{tool_id}' conflicts with a built-in tool name and cannot be managed here.")
  existing = await metadata_storage.get_mcp_tool_config(tool_id)
  if not existing:
    raise HTTPException(status_code=404, detail=f"MCP tool '{tool_id}' not found.")
  if config.tool_id != tool_id:
    raise HTTPException(status_code=400, detail="tool_id in the body must match the path parameter.")
  config.created_at = existing.created_at
  config.updated_at = int(time.time())
  await metadata_storage.store_mcp_tool_config(config)
  logger.info(f"Updated MCP tool '{tool_id}' (by {user.email})")
  await _reload_mcp_tools()
  return JSONResponse(status_code=status.HTTP_200_OK, content=jsonable_encoder(config))


@app.delete("/v1/mcp/custom-tools/{tool_id}", tags=["MCP Tools"])
async def delete_mcp_tool(tool_id: str, user: UserContext = Depends(require_authenticated_user)):
  """Delete a custom MCP search tool. Reserved tool IDs (e.g. 'search') cannot be deleted.

  Authorization is OpenFGA-based: the caller must hold `mcp_tool#can_manage`
  (owner, owner-team admin, or org admin).
  """
  await authorize_mcp_tool_manage(user, tool_id)
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  if tool_id in RESERVED_TOOL_IDS:
    raise HTTPException(status_code=409, detail=f"tool_id '{tool_id}' is a built-in tool and cannot be deleted.")
  existing = await metadata_storage.get_mcp_tool_config(tool_id)
  if not existing:
    raise HTTPException(status_code=404, detail=f"MCP tool '{tool_id}' not found.")
  await metadata_storage.delete_mcp_tool_config(tool_id)
  logger.info(f"Deleted MCP tool '{tool_id}' (by {user.email})")
  await _reload_mcp_tools()
  return JSONResponse(status_code=status.HTTP_200_OK, content={"message": f"MCP tool '{tool_id}' deleted."})


@app.get("/v1/mcp/builtin-tools", tags=["MCP Tools"])
async def get_mcp_builtin_config(user: UserContext = Depends(require_role(Role.READONLY))):
  """Get the built-in MCP tools enable/disable configuration."""
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  config = await metadata_storage.get_mcp_builtin_config() or MCPBuiltinToolsConfig()
  return JSONResponse(status_code=status.HTTP_200_OK, content=jsonable_encoder(config))


@app.put("/v1/mcp/builtin-tools", tags=["MCP Tools"])
async def update_mcp_builtin_config(config: MCPBuiltinToolsConfig, user: UserContext = Depends(require_authenticated_user)):
  """Update the built-in MCP tools enable/disable toggles (fetch_document, fetch_datasources, graph_tools)."""
  if not metadata_storage:
    raise HTTPException(status_code=500, detail="Server not initialized")
  await authorize_org_admin(user)
  await metadata_storage.store_mcp_builtin_config(config)
  logger.info(f"Updated MCPBuiltinToolsConfig (by {user.email}): {config}")
  await _reload_mcp_tools()
  return JSONResponse(status_code=status.HTTP_200_OK, content=jsonable_encoder(config))


@app.get("/v1/mcp/tools/schema", tags=["MCP Tools"])
async def get_mcp_tool_schemas(user: UserContext = Depends(require_role(Role.READONLY))):
  """
  Get all registered MCP tools with their full JSON schemas.

  Returns both built-in tools (search, fetch_document, list_datasources_and_entity_types)
  and custom search tools. Each tool includes its full parameter schema for dynamic
  form generation in the UI.

  This endpoint is useful for:
  - Building dynamic search forms in the UI
  - Discovering available MCP tools and their parameters
  - Debugging/simulating MCP tool invocations via REST
  """
  if not mcp_enabled:
    raise HTTPException(status_code=400, detail="MCP is not enabled")
  if not agent_tools:
    raise HTTPException(status_code=500, detail="MCP tools not initialized")

  # Get all registered tools from FastMCP
  registered_tools = await mcp.list_tools()
  accessible_custom_tools = await get_accessible_mcp_tool_ids(user, "can_read")

  tools_with_schemas = []
  for tool in registered_tools:
    if (
      tool.name not in BUILTIN_MCP_TOOL_IDS
      and "*" not in accessible_custom_tools
      and tool.name not in accessible_custom_tools
    ):
      continue
    tools_with_schemas.append(
      {
        "name": tool.name,
        "description": tool.description or "",
        "parameters": tool.parameters,  # Full JSON schema
      }
    )

  return JSONResponse(
    status_code=status.HTTP_200_OK,
    content={"tools": tools_with_schemas, "count": len(tools_with_schemas)},
  )


@app.post("/v1/mcp/invoke", response_model=MCPToolInvokeResponse, tags=["MCP Tools"])
async def invoke_mcp_tool(request: MCPToolInvokeRequest, user: UserContext = Depends(require_authenticated_user)):
  """
  Invoke an MCP tool via REST API.

  This endpoint allows invoking any registered MCP tool directly via REST,
  useful for debugging, testing, and UI integration without needing a full
  MCP client connection.

  The arguments must match the tool's parameter schema (see /v1/mcp/tools/schema).
  """
  if not mcp_enabled:
    raise HTTPException(status_code=400, detail="MCP is not enabled")
  if not agent_tools:
    raise HTTPException(status_code=500, detail="MCP tools not initialized")

  # Explicit org-level search capability (spec 2026-06-03-explicit-search-capability).
  # Gates BOTH built-in (search/fetch_document) and custom search tools here, so
  # holding `mcp_tool#can_call` on a shared tool does not, by itself, permit
  # search. The per-tool `can_call` gate (BFF) and per-datasource ACL still apply.
  await authorize_search(user)

  # Find the tool
  registered_tools = await mcp.list_tools()
  tool = next((t for t in registered_tools if t.name == request.tool_name), None)

  if not tool:
    raise HTTPException(status_code=404, detail=f"MCP tool '{request.tool_name}' not found")

  if request.tool_name not in BUILTIN_MCP_TOOL_IDS:
    await authorize_mcp_tool_call(user, request.tool_name)

  try:
    # Invoke the tool using tool.run()
    token = mcp_user_context_var.set(user)
    try:
      result = await tool.run(request.arguments)
    finally:
      mcp_user_context_var.reset(token)

    # Extract the raw result from ToolResult.content
    # Each content block has a .text attribute containing JSON-encoded data
    # We parse and return the first content block's data as-is
    raw_result = None
    if result.content:
      first_content = result.content[0]
      if hasattr(first_content, "text"):
        try:
          raw_result = json.loads(first_content.text)
        except (json.JSONDecodeError, TypeError):
          raw_result = first_content.text
      elif isinstance(first_content, dict) and "text" in first_content:
        try:
          raw_result = json.loads(first_content["text"])
        except (json.JSONDecodeError, TypeError):
          raw_result = first_content["text"]
      else:
        raw_result = str(first_content)

    return MCPToolInvokeResponse(
      tool_name=request.tool_name,
      success=True,
      result=raw_result,
      error=None,
    )
  except Exception as e:
    logger.error(f"Error invoking MCP tool '{request.tool_name}': {e}")
    return MCPToolInvokeResponse(
      tool_name=request.tool_name,
      success=False,
      result=None,
      error=str(e),
    )
