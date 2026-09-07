import os
import asyncio
import time
from typing import List, Optional, Dict, Any, Callable
import aiohttp
from common.models.rag import DataSourceInfo, DocumentMetadata, StructuredEntity
from common.models.server import DocumentIngestRequest, IngestorPingRequest, ExploreDataEntityRequest
from common.job_manager import JobStatus, JobInfo
from common.constants import (
  DATASOURCE_SCHEDULE_CHECK_INTERVAL,
  MIN_RELOAD_INTERVAL,
)
from langchain_core.documents import Document
import common.utils as utils
import dotenv

# Load environment variables from .env file
dotenv.load_dotenv()

logger = utils.get_logger(__name__)


class Client:
  """
  Client bindings for RAG server REST API - handles ingestor lifecycle and data ingestion

  Uses OAuth2 Client Credentials via INGESTOR_OIDC_* env vars.
  """

  def __init__(self, ingestor_name: str, ingestor_type: str, ingestor_description: str = "", ingestor_metadata: Optional[Dict[str, Any]] = {}):
    self.server_addr = os.getenv("RAG_SERVER_URL", "http://localhost:9446")
    self.ingestor_type = ingestor_type
    self.ingestor_name = ingestor_name
    self.ingestor_description = ingestor_description
    self.ingestor_metadata = ingestor_metadata
    self.ingestor_id: Optional[str] = None

    # This is what the ingestor will batch ingestion by
    # ingestor will choose whichever is smaller: self.ingestor_max_docs_per_ingest or self.server_max_docs_per_ingest
    self.ingestor_max_docs_per_ingest: int = int(os.getenv("MAX_DOCUMENTS_PER_INGEST", "1000"))
    self.server_max_docs_per_ingest: int = 1000  # This is the server's max documents per ingestion request - will be updated from server during ping

    self._ping_task: Optional[asyncio.Task] = None
    self._ping_interval = int(os.getenv("INGESTOR_PING_INTERVAL_SECONDS", "120"))  # Default 2 minutes

    # OAuth2 client credentials configuration
    self.oidc_issuer = os.getenv("INGESTOR_OIDC_ISSUER")
    self.oidc_client_id = os.getenv("INGESTOR_OIDC_CLIENT_ID")
    self.oidc_client_secret = os.getenv("INGESTOR_OIDC_CLIENT_SECRET")
    # Discovery URL (optional - if set, use this instead of constructing from issuer)
    self.oidc_discovery_url = os.getenv("INGESTOR_OIDC_DISCOVERY_URL")
    # Scope is optional - if not set, don't send any scope (many providers don't need it for client credentials)
    self.oidc_scope = os.getenv("INGESTOR_OIDC_SCOPE", "")

    # Token cache
    self._access_token: Optional[str] = None
    self._token_expiry: Optional[float] = None
    self._token_endpoint: Optional[str] = None  # Discovered from OIDC metadata

    # Determine authentication mode and log configuration details
    has_issuer = bool(self.oidc_issuer)
    has_discovery_url = bool(self.oidc_discovery_url)
    has_client_id = bool(self.oidc_client_id)
    has_client_secret = bool(self.oidc_client_secret)

    # Need (issuer or discovery URL) AND client credentials
    if (has_issuer or has_discovery_url) and has_client_id and has_client_secret:
      logger.info(f"Ingestor '{self.ingestor_name}': OAuth2 client credentials DETECTED")
      if has_discovery_url and has_issuer:
        logger.info(f"  - INGESTOR_OIDC_DISCOVERY_URL: {self.oidc_discovery_url} (primary)")
        logger.info(f"  - INGESTOR_OIDC_ISSUER: {self.oidc_issuer} (fallback)")
      elif has_discovery_url:
        logger.info(f"  - INGESTOR_OIDC_DISCOVERY_URL: {self.oidc_discovery_url} (will extract issuer)")
      else:
        logger.info(f"  - INGESTOR_OIDC_ISSUER: {self.oidc_issuer} (will construct discovery URL)")
      logger.info(f"  - INGESTOR_OIDC_CLIENT_ID: {self.oidc_client_id}")
      logger.info(f"  - INGESTOR_OIDC_CLIENT_SECRET: {'***' if self.oidc_client_secret else 'NOT SET'}")
      logger.info(f"  - INGESTOR_OIDC_SCOPE: {self.oidc_scope if self.oidc_scope else '(none - will omit scope parameter)'}")
      logger.info("  - Authentication mode: OAUTH2 (will send authenticated requests)")
    else:
      logger.info(f"Ingestor '{self.ingestor_name}': OAuth2 client credentials NOT fully configured")
      logger.info("  - Need: (ISSUER or DISCOVERY_URL) + CLIENT_ID + CLIENT_SECRET")
      logger.info(f"  - INGESTOR_OIDC_ISSUER: {'SET' if has_issuer else 'NOT SET'}")
      logger.info(f"  - INGESTOR_OIDC_DISCOVERY_URL: {'SET' if has_discovery_url else 'NOT SET'}")
      logger.info(f"  - INGESTOR_OIDC_CLIENT_ID: {'SET' if has_client_id else 'NOT SET'}")
      logger.info(f"  - INGESTOR_OIDC_CLIENT_SECRET: {'SET' if has_client_secret else 'NOT SET'}")
      logger.info("  - Authentication mode: NOT CONFIGURED (requests will fail before send)")

    # Note: Health check will be done during initialize() with aiohttp

  async def initialize(self) -> None:
    """
    Initialize the ingestor by performing initial ping and starting periodic ping task
    """
    logger.info(f"Initializing ingestor {self.ingestor_name} of type {self.ingestor_type}")

    # Perform initial ping to get ingestor_id with retry
    await utils.retry_function_async(self._perform_ping, retries=10, delay=5)

    if self.ingestor_id is None:
      raise ValueError("Failed to get ingestor_id from server during initialization")

    # Start periodic ping task
    self._ping_task = asyncio.create_task(self._periodic_ping())
    logger.info(f"Ingestor initialized with ID: {self.ingestor_id}")

  def max_docs_per_ingest(self) -> int:
    """
    Return the maximum number of documents the ingestor will ingest per ingestion request
    """
    logger.info(f"ingestor_max_docs_per_ingest: {self.ingestor_max_docs_per_ingest}, server_max_docs_per_ingest: {self.server_max_docs_per_ingest}")
    return min(self.ingestor_max_docs_per_ingest, self.server_max_docs_per_ingest)

  async def shutdown(self) -> None:
    """
    Shutdown the ingestor and stop periodic ping task
    """
    if self._ping_task:
      self._ping_task.cancel()
      try:
        await self._ping_task
      except asyncio.CancelledError:
        pass
      self._ping_task = None
    logger.info(f"Ingestor {self.ingestor_name} shutdown complete")

  async def _discover_token_endpoint(self) -> str:
    """
    Discover the token endpoint from OIDC provider's well-known configuration.

    This uses the standard OIDC Discovery mechanism to find the correct token endpoint
    for any OIDC-compliant provider (Keycloak, Auth0, Okta, Duo, Azure AD, etc.)

    Strategy:
    1. Try explicit INGESTOR_OIDC_DISCOVERY_URL if provided
    2. Fallback to constructing from INGESTOR_OIDC_ISSUER if discovery URL fails or not set

    Returns:
        Token endpoint URL

    Raises:
        Exception if all discovery attempts fail
    """
    if self._token_endpoint:
      return self._token_endpoint

    discovery_attempts = []

    # Attempt 1: Try explicit discovery URL if provided
    if self.oidc_discovery_url:
      try:
        logger.info(f"Ingestor '{self.ingestor_name}': Attempting discovery with explicit URL: {self.oidc_discovery_url}")
        return await self._fetch_discovery(self.oidc_discovery_url)
      except Exception as e:
        logger.warning(f"Ingestor '{self.ingestor_name}': Explicit discovery URL failed: {e}")
        discovery_attempts.append(f"Discovery URL ({self.oidc_discovery_url}): {e}")

    # Attempt 2: Construct from issuer if available
    if self.oidc_issuer:
      try:
        issuer = self.oidc_issuer.rstrip("/")
        constructed_url = f"{issuer}/.well-known/openid-configuration"
        logger.info(f"Ingestor '{self.ingestor_name}': Attempting discovery from issuer: {constructed_url}")
        return await self._fetch_discovery(constructed_url)
      except Exception as e:
        logger.warning(f"Ingestor '{self.ingestor_name}': Discovery from issuer failed: {e}")
        discovery_attempts.append(f"Constructed from issuer ({constructed_url}): {e}")

    # All attempts failed. Build this outside the issuer branch because a
    # discovery-URL-only deployment is valid (and is the default Helm wiring).
    error_msg = "All OIDC discovery attempts failed:\n" + "\n".join(
      f"  - {attempt}" for attempt in discovery_attempts
    )
    logger.error(f"Ingestor '{self.ingestor_name}': {error_msg}")

    # Try Keycloak-style fallback if we have an issuer
    if self.oidc_issuer:
      logger.warning(f"Ingestor '{self.ingestor_name}': Using Keycloak-style fallback endpoint")
      issuer = self.oidc_issuer.rstrip("/")
      # Do not cache a guessed endpoint. A transient startup/DNS failure must
      # allow the next initialize retry to run discovery again; otherwise the
      # client can remain pinned to an unreachable browser-facing issuer such
      # as localhost even after the in-network provider becomes available.
      return f"{issuer}/protocol/openid-connect/token"

    raise RuntimeError(f"OIDC discovery failed and no issuer available for fallback. {error_msg}")

  async def _fetch_discovery(self, discovery_url: str) -> str:
    """
    Fetch OIDC discovery document and extract token endpoint.

    Args:
        discovery_url: URL to fetch discovery document from

    Returns:
        Token endpoint URL

    Raises:
        Exception if fetch fails or token_endpoint not found
    """
    async with aiohttp.ClientSession() as session:
      async with session.get(discovery_url, allow_redirects=True) as resp:
        if resp.status == 404:
          raise aiohttp.ClientError(f"Discovery endpoint not found (404): {discovery_url}")

        resp.raise_for_status()
        oidc_config = await resp.json()

        # Extract issuer from discovery document if not already set
        if not self.oidc_issuer and oidc_config.get("issuer"):
          self.oidc_issuer = oidc_config.get("issuer")
          logger.info(f"Ingestor '{self.ingestor_name}': Extracted issuer from discovery: {self.oidc_issuer}")

        self._token_endpoint = oidc_config.get("token_endpoint")
        if not self._token_endpoint:
          available_keys = list(oidc_config.keys())
          raise ValueError(f"token_endpoint not found in discovery document. Available keys: {available_keys}")

        logger.info(f"Ingestor '{self.ingestor_name}': ✓ Discovered token endpoint: {self._token_endpoint}")
        return self._token_endpoint

  async def _get_access_token(self) -> str:
    """
    Get valid OAuth2 access token using client credentials flow.

    Token is cached and automatically refreshed before expiry.

    Returns:
        Access token string
    """
    # Check if OAuth2 is configured (need either issuer or discovery URL, plus client credentials)
    if not (self.oidc_issuer or self.oidc_discovery_url) or not self.oidc_client_id or not self.oidc_client_secret:
      raise RuntimeError(
        "Ingestor OAuth2 client credentials are required: configure "
        "INGESTOR_OIDC_ISSUER or INGESTOR_OIDC_DISCOVERY_URL, "
        "INGESTOR_OIDC_CLIENT_ID, and INGESTOR_OIDC_CLIENT_SECRET"
      )

    # Check if cached token is still valid (with 60s buffer)
    if self._access_token and self._token_expiry:
      if time.time() < self._token_expiry - 60:
        logger.debug(f"Ingestor '{self.ingestor_name}': Using cached OAuth2 access token (expires in {int(self._token_expiry - time.time())}s)")
        return self._access_token

    # Discover token endpoint (cached after first discovery)
    token_endpoint = await self._discover_token_endpoint()
    logger.info(f"Ingestor '{self.ingestor_name}': Fetching new OAuth2 access token from {token_endpoint}")

    try:
      async with aiohttp.ClientSession() as session:
        # Build token request data
        token_data = {
          "grant_type": "client_credentials",
          "client_id": self.oidc_client_id,
          "client_secret": self.oidc_client_secret,
        }

        # Only include scope if configured (many providers don't need it for client credentials)
        if self.oidc_scope:
          token_data["scope"] = self.oidc_scope
          logger.debug(f"Ingestor '{self.ingestor_name}': Requesting token with scope: {self.oidc_scope}")
        else:
          logger.debug(f"Ingestor '{self.ingestor_name}': Requesting token without scope parameter")

        async with session.post(token_endpoint, data=token_data, headers={"Content-Type": "application/x-www-form-urlencoded"}) as resp:
          resp.raise_for_status()
          token_data = await resp.json()

          self._access_token = token_data["access_token"]
          expires_in = token_data.get("expires_in", 3600)
          self._token_expiry = time.time() + expires_in

          logger.info(f"Ingestor '{self.ingestor_name}': ✓ OAuth2 access token acquired successfully (expires in {expires_in}s)")
          return self._access_token

    except aiohttp.ClientError as e:
      logger.error(f"Ingestor '{self.ingestor_name}': ✗ Failed to fetch OAuth2 access token: {e}")
      raise
    except Exception as e:
      logger.error(f"Ingestor '{self.ingestor_name}': ✗ Unexpected error fetching OAuth2 access token: {e}")
      raise

  async def _get_auth_headers(self) -> Dict[str, str]:
    """
    Get authentication headers for RAG server requests.

    Returns headers with an Authorization Bearer token.

    Also includes X-Ingestor-Type and X-Ingestor-Name headers for identification.

    Returns:
        Dictionary of HTTP headers
    """
    headers = {"Content-Type": "application/json"}

    # Add ingestor identification headers
    headers["X-Ingestor-Type"] = self.ingestor_type
    headers["X-Ingestor-Name"] = self.ingestor_name

    token = await self._get_access_token()
    headers["Authorization"] = f"Bearer {token}"
    logger.debug(f"Ingestor '{self.ingestor_name}': Sending AUTHENTICATED request (OAuth2 Bearer token)")

    return headers

  async def _perform_ping(self) -> Dict[str, Any]:
    """
    Internal method to perform ping and update ingestor_id
    """
    ping_request = IngestorPingRequest(ingestor_name=self.ingestor_name, ingestor_type=self.ingestor_type, description=self.ingestor_description, metadata=self.ingestor_metadata)

    headers = await self._get_auth_headers()

    async with aiohttp.ClientSession() as session:
      async with session.post(url=f"{self.server_addr}/v1/ingestor/heartbeat", headers=headers, json=ping_request.model_dump()) as resp:
        resp.raise_for_status()

        # Extract response data
        ping_response = await resp.json()

        # Extract ingestor_id and server_max_docs_per_ingest from response
        self.ingestor_id = ping_response.get("ingestor_id", f"{self.ingestor_type}:{self.ingestor_name}")
        self.server_max_docs_per_ingest = ping_response.get("max_documents_per_ingest", 1000)  # default to 1000

        logger.info(f"Updated max_documents_per_ingest to {self.server_max_docs_per_ingest} for ingestor {self.ingestor_name}")

        return ping_response

  async def _periodic_ping(self) -> None:
    """
    Periodic ping task that runs in the background
    """
    while True:
      try:
        await asyncio.sleep(self._ping_interval)
        await self._perform_ping()
        logger.debug(f"Periodic ping successful for ingestor {self.ingestor_name}")
      except asyncio.CancelledError:
        logger.info(f"Periodic ping cancelled for ingestor {self.ingestor_name}")
        break
      except Exception as e:
        logger.error(f"Periodic ping failed for ingestor {self.ingestor_name}: {e}")
        # Continue trying even if ping fails

  async def ingest_entities(self, job_id: str, datasource_id: str, entities: List[StructuredEntity], fresh_until: int):
    """
    Ingest entities into the RAG system as documents with automatic batching
    :param job_id: ID of the ingestion job
    :param datasource_id: ID of the datasource
    :param entities: List of entities to ingest
    :param fresh_until: Timestamp until which data is considered fresh (epoch seconds)
    :return: Response from server (last batch response if batching used)
    """
    if self.ingestor_id is None:
      raise ValueError("Ingestor not initialized. Call initialize() first to get ingestor_id.")

    # Convert entities to documents
    documents = []
    for entity in entities:
      # Extract a meaningful title based on entity properties
      title = self._extract_structured_entity_title(entity, entity.get_external_properties())

      document_metadata = DocumentMetadata(
        document_id="",  # Will get populated by server based on entity primary key
        document_type="",  # Will get populated by server based on entity type
        datasource_id=datasource_id,
        ingestor_id=self.ingestor_id,
        title=title,
        description=f"Structured entity of type {entity.entity_type}",
        is_structured_entity=True,
        document_ingested_at=None,  # Will get populated by server
        fresh_until=fresh_until,
        metadata={},  # Will be populated by server with structured_entity_type and structured_entity_pk
      ).model_dump()

      # Use Pydantic's own JSON serialization to preserve all fields including additional_key_properties
      entity_json_text = entity.model_dump_json()

      document = Document(page_content=entity_json_text, metadata=document_metadata)
      documents.append(document)

    # Use batching logic by calling ingest_documents
    return await self.ingest_documents(job_id, datasource_id, documents, fresh_until)

  async def ingest_documents(self, job_id: str, datasource_id: str, documents: List[Document], fresh_until: int):
    """
    Ingest documents into the RAG system with automatic batching
    :param job_id: ID of the ingestion job
    :param datasource_id: ID of the datasource
    :param documents: List of documents to ingest
    :param fresh_until: Timestamp until which data is considered fresh (epoch seconds)
    :return: Response from server (last batch response if batching used)
    """
    if self.ingestor_id is None:
      raise ValueError("Ingestor not initialized. Call initialize() first to get ingestor_id.")

    logger.info(f"Ingesting {len(documents)} documents with max_docs_per_ingest: {self.max_docs_per_ingest()}")
    # Check if we need to batch the documents
    total_documents = len(documents)
    if total_documents <= self.max_docs_per_ingest():
      # Single batch - process all documents at once
      logger.info(f"Ingesting {total_documents} documents in a single batch")
      result = await self._ingest_documents_batch(job_id, datasource_id, documents, fresh_until)
      await self.increment_document_count(job_id, total_documents)
      return result

    # Multiple batches - split documents into chunks
    logger.info(f"Ingesting {total_documents} documents in batches of {self.max_docs_per_ingest()}")
    last_response: Dict[str, Any] = {}

    for i in range(0, total_documents, self.max_docs_per_ingest()):
      batch_end = min(i + self.max_docs_per_ingest(), total_documents)
      batch_documents = documents[i:batch_end]
      batch_num = (i // self.max_docs_per_ingest()) + 1
      total_batches = (total_documents + self.max_docs_per_ingest() - 1) // self.max_docs_per_ingest()

      logger.info(f"Processing batch {batch_num}/{total_batches} with {len(batch_documents)} documents")
      last_response = await self._ingest_documents_batch(job_id, datasource_id, batch_documents, fresh_until)
      await self.increment_document_count(job_id, len(batch_documents))

    return last_response

  def _extract_structured_entity_title(self, entity: StructuredEntity, entity_properties: Dict[str, Any]) -> str:
    """
    Extract a meaningful title from entity properties by checking common fields
    :param entity: The entity object
    :param entity_properties: Dictionary of entity properties
    :return: A meaningful title string
    """
    # Common property names that could serve as titles (ordered by preference)
    title_candidates = ["name", "title", "display_name", "displayName", "label", "full_name", "fullName", "description", "summary", "subject", "topic", "heading", "caption"]

    # First, try to find a title in the entity properties
    for candidate in title_candidates:
      # Check both exact match and case-insensitive match
      for key, value in entity_properties.items():
        if key.lower() == candidate.lower() and value and isinstance(value, str) and len(value.strip()) > 0:
          # Clean up the title - limit length and remove extra whitespace
          title = str(value).strip()
          if len(title) > 100:  # Reasonable title length limit
            title = title[:97] + "..."
          return f"{entity.entity_type}: {title}"

    # Fallback: Just the entity type
    return f"Structured Entity {entity.entity_type}"

  async def _ingest_documents_batch(self, job_id: str, datasource_id: str, documents: List[Document], fresh_until: int) -> Dict[str, Any]:
    """
    Internal method to ingest a single batch of documents
    :param datasource_id: ID of the datasource
    :param documents: List of documents to ingest (single batch)
    :param fresh_until: Fresh until timestamp
    :return: Response from server
    """
    if self.ingestor_id is None:
      raise ValueError("Ingestor not initialized. Call initialize() first to get ingestor_id.")

    # Create DocumentIngestRequest using Pydantic model
    ingest_request = DocumentIngestRequest(datasource_id=datasource_id, job_id=job_id, ingestor_id=self.ingestor_id, documents=documents, fresh_until=fresh_until)

    headers = await self._get_auth_headers()

    async with aiohttp.ClientSession() as session:
      async with session.post(url=f"{self.server_addr}/v1/ingest", headers=headers, json=ingest_request.model_dump()) as resp:
        resp.raise_for_status()
        return await resp.json()

  async def list_datasources(self, ingestor_id: Optional[str] = None) -> List[DataSourceInfo]:
    """
    List datasources from the RAG server
    :param ingestor_id: Optional ingestor ID to filter datasources
    :return: List of DataSourceInfo
    """
    params = {}
    if ingestor_id:
      params["ingestor_id"] = ingestor_id

    headers = await self._get_auth_headers()

    async with aiohttp.ClientSession() as session:
      async with session.get(url=f"{self.server_addr}/v1/datasources", headers=headers, params=params) as resp:
        resp.raise_for_status()
        resp_json = await resp.json()
        datasources_data = resp_json.get("datasources", [])
        return [DataSourceInfo.model_validate(ds) for ds in datasources_data]

  async def upsert_datasource(self, datasource_info: DataSourceInfo):
    """
    Create or update a datasource
    :param datasource_info: Datasource information
    """
    headers = await self._get_auth_headers()

    async with aiohttp.ClientSession() as session:
      async with session.post(url=f"{self.server_addr}/v1/datasource", headers=headers, json=datasource_info.model_dump()) as resp:
        resp.raise_for_status()

  async def create_job(self, datasource_id: str, job_status: Optional[JobStatus] = None, message: Optional[str] = None, total: Optional[int] = None) -> Dict[str, Any]:
    """
    Create a new job for a datasource
    :param datasource_id: ID of the datasource
    :param job_status: Status of the job
    :param message: Job message
    :param total: Total number of items to process
    :return: Job creation response with job_id and datasource_id
    """
    params = {"datasource_id": datasource_id}
    if job_status is not None:
      params["job_status"] = job_status.value
    if message is not None:
      params["message"] = message
    if total is not None:
      params["total"] = str(total)  # Convert to string for query params

    headers = await self._get_auth_headers()

    async with aiohttp.ClientSession() as session:
      async with session.post(url=f"{self.server_addr}/v1/job", headers=headers, params=params) as resp:
        resp.raise_for_status()
        return await resp.json()

  async def update_job(self, job_id: str, job_status: Optional[JobStatus] = None, message: Optional[str] = None, total: Optional[int] = None) -> Dict[str, Any]:
    """
    Update an existing job
    :param job_id: ID of the job to update
    :param job_status: Status of the job
    :param message: Job message
    :param total: Total number of items to process
    :return: Job update response with job_id and datasource_id
    """
    params = {}
    if job_status is not None:
      params["job_status"] = job_status.value
    if message is not None:
      params["message"] = message
    if total is not None:
      params["total"] = str(total)  # Convert to string for query params

    headers = await self._get_auth_headers()

    async with aiohttp.ClientSession() as session:
      async with session.patch(url=f"{self.server_addr}/v1/job/{job_id}", headers=headers, params=params) as resp:
        resp.raise_for_status()
        return await resp.json()

  async def get_job(self, job_id: str) -> JobInfo:
    """
    Get job details by job ID
    :param job_id: Job ID
    :return: Job details
    """
    headers = await self._get_auth_headers()

    async with aiohttp.ClientSession() as session:
      async with session.get(url=f"{self.server_addr}/v1/job/{job_id}", headers=headers) as resp:
        resp.raise_for_status()
        job_data = await resp.json()
        return JobInfo.model_validate(job_data)

  async def increment_job_progress(self, job_id: str, increment: int = 1) -> Dict[str, Any]:
    """
    Increment job progress counter
    :param job_id: Job ID
    :param increment: Amount to increment by
    :return: Updated progress information
    """
    headers = await self._get_auth_headers()

    async with aiohttp.ClientSession() as session:
      async with session.post(url=f"{self.server_addr}/v1/job/{job_id}/increment-progress", headers=headers, params={"increment": increment}) as resp:
        resp.raise_for_status()
        return await resp.json()

  async def increment_job_failure(self, job_id: str, increment: int = 1) -> Dict[str, Any]:
    """
    Increment job failure counter
    :param job_id: Job ID
    :param increment: Amount to increment by
    :return: Updated failure information
    """
    headers = await self._get_auth_headers()

    async with aiohttp.ClientSession() as session:
      async with session.post(url=f"{self.server_addr}/v1/job/{job_id}/increment-failure", headers=headers, params={"increment": increment}) as resp:
        resp.raise_for_status()
        return await resp.json()

  async def increment_document_count(self, job_id: str, increment: int = 1) -> Dict[str, Any]:
    """
    Increment job document count
    :param job_id: Job ID
    :param increment: Amount to increment by
    :return: Updated document count information
    """
    headers = await self._get_auth_headers()

    async with aiohttp.ClientSession() as session:
      async with session.post(url=f"{self.server_addr}/v1/job/{job_id}/increment-document-count", headers=headers, params={"increment": increment}) as resp:
        resp.raise_for_status()
        return await resp.json()

  async def add_job_error(self, job_id: str, error_messages: List[str]) -> Dict[str, Any]:
    """
    Add error messages to a job
    :param job_id: Job ID
    :param error_messages: List of error messages to add
    :return: Error addition response
    """
    headers = await self._get_auth_headers()

    async with aiohttp.ClientSession() as session:
      async with session.post(url=f"{self.server_addr}/v1/job/{job_id}/add-errors", headers=headers, json=error_messages) as resp:
        resp.raise_for_status()
        return await resp.json()

  async def is_job_terminated(self, job_id: str) -> bool:
    """
    Check if a job is in a terminated state (COMPLETED or FAILED)
    :param job_id: Job ID
    :return: True if job is terminated, False otherwise
    """
    job_info = await self.get_job(job_id)
    return job_info.status == JobStatus.TERMINATED

  async def graph_find_entity(self, entity_type: str, entity_pk: str) -> Dict[str, Any]:
    """
    Find a structured entity by type and primary key using the graph database
    :param entity_type: Type of the entity
    :param entity_pk: Primary key of the entity
    :return: StructuredEntity and relations information
    """
    explore_request = ExploreDataEntityRequest(entity_type=entity_type, entity_pk=entity_pk)

    headers = await self._get_auth_headers()

    async with aiohttp.ClientSession() as session:
      async with session.post(url=f"{self.server_addr}/v1/graph/explore/data/entity", headers=headers, json=explore_request.model_dump()) as resp:
        resp.raise_for_status()
        return await resp.json()


class IngestorBuilder:
  """
    Builder pattern for creating and running ingestors with minimal boilerplate
    
    Example usage:
        def my_sync_function(client):
            # Create datasource
            datasource = DataSourceInfo(
                datasource_id="my-datasource",
                ingestor_id=client.ingestor_id or "",
                description="Sample data",
                source_type="documents",
                last_updated=int(time.time())
            )
            client.upsert_datasource(datasource)
            
            # Ingest entities
            entities = [StructuredEntity(entity_id="1", entity_type="Document", properties={"title": "Test"})]
            client.ingest_entities("my-datasource", entities)
        
        # Run ingestor
        ingestor_builder()\\
            .name("my-ingestor")\\
            .type("test")\\
            .sync_with(my_sync_function)\\
            .every(60)\\
            .run()
    """

  def __init__(self):
    self._name: Optional[str] = None
    self._type: Optional[str] = None
    self._description: Optional[str] = None
    self._metadata: Dict[str, Any] = {}
    self._sync_function: Optional[Callable] = None
    self._startup_function: Optional[Callable] = None
    self._sync_interval = 0  # User-specified sync interval (how often data should be refreshed)
    self._datasource_scheduled = False
    self._schedule_check_only = False
    self._init_delay = 0  # Optional init delay
    self._last_sync_time: Optional[int] = None  # Track last sync completion time

  def name(self, name: str) -> "IngestorBuilder":
    """Set the ingestor name"""
    self._name = name
    return self

  def type(self, ingestor_type: str) -> "IngestorBuilder":
    """Set the ingestor type"""
    self._type = ingestor_type
    return self

  def description(self, description: str) -> "IngestorBuilder":
    """Set the ingestor description"""
    self._description = description
    return self

  def metadata(self, metadata: Dict[str, Any]) -> "IngestorBuilder":
    """Set the ingestor metadata"""
    self._metadata = metadata
    return self

  def sync_with_fn(self, sync_function) -> "IngestorBuilder":
    """Set the sync function to run periodically. Can be sync or async."""
    self._sync_function = sync_function
    return self

  def every(self, seconds: int) -> "IngestorBuilder":
    """
    Set the sync interval in seconds (how often data should be refreshed).

    The builder will automatically check datasources and determine when the next
    sync should occur based on their last_updated timestamps.
    """
    self._sync_interval = seconds
    return self

  def schedule_from_datasources(self) -> "IngestorBuilder":
    """Schedule reloads from each datasource's persisted reload interval.

    The worker periodically re-reads datasource records so sources created or
    edited through the application are discovered without a deployment-level
    refresh interval.
    """
    self._datasource_scheduled = True
    return self

  def _schedule_fallback_interval(self) -> int:
    """Return the retry interval when datasource scheduling is unavailable."""
    if self._datasource_scheduled:
      return DATASOURCE_SCHEDULE_CHECK_INTERVAL
    return self._sync_interval

  def with_init_delay(self, seconds: int) -> "IngestorBuilder":
    """Set an optional initialization delay in seconds before starting sync"""
    self._init_delay = seconds
    return self

  def with_startup(self, startup_function: Callable) -> "IngestorBuilder":
    """Set an optional startup function to run concurrently (e.g., to start a server). Can be sync or async."""
    self._startup_function = startup_function
    return self

  def run(self, loop: asyncio.AbstractEventLoop | None = None):
    """Build and run the ingestor

    Args:
        loop: Optional event loop to use. If not provided, asyncio.run() will create one.
              Use this when you need to install a custom reactor (e.g., Twisted asyncio reactor)
              before running the ingestor.
    """
    # Validate required parameters
    assert self._name, "Ingestor name is required. Use .name('my-ingestor')"
    assert self._type, "Ingestor type is required. Use .type('my-type')"
    assert self._sync_function, "Sync function is required. Use .sync_with(my_function)"

    if self._description is None:
      self._description = f"Ingestor {self._name} of type {self._type}"

    if self._metadata is None:
      self._metadata = {}

    # Run the ingestor
    if loop is not None:
      # Use provided event loop (useful for Twisted reactor integration)
      loop.run_until_complete(self._run_ingestor())
    else:
      asyncio.run(self._run_ingestor())

  async def _calculate_next_sync_time(self, client: Client) -> tuple[int, bool]:
    """
    Calculate how long to sleep before next sync by checking datasource timestamps
    and last sync time.

    Returns:
        tuple[int, bool]: (seconds to sleep, has_datasources)
    """
    self._schedule_check_only = False
    try:
      current_time = int(time.time())

      # Fetch all datasources for this ingestor
      datasources = await client.list_datasources(ingestor_id=client.ingestor_id)

      if self._datasource_scheduled and self._last_sync_time is None:
        # Run once at worker startup. This materializes newly-added legacy
        # environment config while every persisted source still performs its
        # own due check before contacting the upstream connector.
        return (0, bool(datasources))

      if not datasources:
        # No datasources yet - base scheduling on last sync time
        if self._last_sync_time is None:
          # Never synced before, sync immediately
          logger.debug("No datasources found and never synced before, needs immediate sync")
          return (0, False)

        if self._datasource_scheduled:
          # Startup already reconciled legacy configuration. UI-created
          # sources arrive through the command listener and create their
          # datasource record, so an empty worker only needs to re-read
          # schedule metadata from here onward.
          self._schedule_check_only = True
          logger.info(
            "No datasources found, checking schedule metadata again in "
            f"{DATASOURCE_SCHEDULE_CHECK_INTERVAL}s"
          )
          return (DATASOURCE_SCHEDULE_CHECK_INTERVAL, False)

        # Calculate time until next sync based on last sync time
        time_since_last_sync = current_time - self._last_sync_time
        fallback_interval = self._schedule_fallback_interval()
        time_until_next_sync = fallback_interval - time_since_last_sync

        if time_until_next_sync <= 0:
          # Overdue for next sync
          logger.debug(f"No datasources found, last sync was {time_since_last_sync}s ago, needs immediate sync")
          return (0, False)

        # Schedule next sync based on interval
        logger.info(f"No datasources found, checking again in {time_until_next_sync}s")
        return (int(time_until_next_sync), False)

      # Find the earliest datasource that will need reloading
      min_time_until_reload: int | None = None

      for ds in datasources:
        if ds.last_updated is None:
          # Datasource never updated, needs immediate reload
          logger.debug(f"Datasource {ds.datasource_id} has no last_updated, needs immediate sync")
          return (0, True)

        # Get per-datasource reload interval, clamp to minimum to prevent tight loops
        ds_reload_interval = ds.reload_interval
        if ds_reload_interval < MIN_RELOAD_INTERVAL:
          logger.warning(f"Datasource {ds.datasource_id} has reload_interval {ds_reload_interval}s below minimum {MIN_RELOAD_INTERVAL}s, clamping to minimum")
          ds_reload_interval = MIN_RELOAD_INTERVAL

        time_since_update = current_time - ds.last_updated
        time_until_reload = ds_reload_interval - time_since_update

        if time_until_reload <= 0:
          # This datasource is overdue, sync immediately
          logger.debug(f"Datasource {ds.datasource_id} is overdue (last updated {time_since_update}s ago), needs immediate sync")
          return (0, True)

        # Track the earliest reload time
        if min_time_until_reload is None or time_until_reload < min_time_until_reload:
          min_time_until_reload = time_until_reload
          logger.debug(f"Datasource {ds.datasource_id} will need reload in {time_until_reload}s (interval: {ds_reload_interval}s)")

      assert min_time_until_reload is not None
      if (
        self._datasource_scheduled
        and min_time_until_reload > DATASOURCE_SCHEDULE_CHECK_INTERVAL
      ):
        # Only re-read metadata at this wake-up. Connector work remains asleep
        # until a datasource is actually due.
        self._schedule_check_only = True
        sleep_time = DATASOURCE_SCHEDULE_CHECK_INTERVAL
        logger.info(
          f"Next datasource schedule check in {sleep_time}s; earliest refresh "
          f"is due in {int(min_time_until_reload)}s"
        )
      else:
        minimum_sleep = 1 if self._datasource_scheduled else MIN_RELOAD_INTERVAL
        sleep_time = max(minimum_sleep, int(min_time_until_reload))
        logger.info(
          f"Next datasource refresh in {sleep_time}s "
          f"({sleep_time / 3600:.1f}h)"
        )
      return (sleep_time, True)

    except Exception as e:
      fallback_interval = self._schedule_fallback_interval()
      self._schedule_check_only = self._datasource_scheduled
      logger.warning(
        f"Error calculating next sync time: {e}, retrying in {fallback_interval}s"
      )
      return (fallback_interval, False)

  async def _run_ingestor(self):
    """Internal method to run the ingestor with proper async handling"""
    # Type checking - these should never be None due to assertions in run()
    assert self._name is not None
    assert self._type is not None
    assert self._sync_function is not None
    assert self._description is not None
    assert self._metadata is not None

    # Check if we should exit after first sync (for debugging and job mode)
    exit_after_first_sync = os.getenv("EXIT_AFTER_FIRST_SYNC", "false").lower() in ("true", "1", "yes")

    schedule_mode = "datasource" if self._datasource_scheduled else "fixed"
    logger.info(f"Starting ingestor: {self._name} (type: {self._type}, schedule: {schedule_mode}, sync_interval: {self._sync_interval}s, init_delay: {self._init_delay}s, exit_after_first_sync: {exit_after_first_sync})")

    # Create and initialize RAG client
    client = Client(self._name, self._type, self._description, self._metadata)
    startup_task: asyncio.Task | None = None

    async def ensure_startup_running() -> None:
      if not startup_task or not startup_task.done():
        return
      try:
        await startup_task
      except asyncio.CancelledError:
        raise RuntimeError("Ingestor startup task was cancelled unexpectedly") from None
      raise RuntimeError("Ingestor startup task exited unexpectedly")

    async def sleep_while_monitoring_startup(seconds: int) -> None:
      if not startup_task:
        await asyncio.sleep(seconds)
        return
      sleeper = asyncio.create_task(asyncio.sleep(seconds))
      done, _ = await asyncio.wait(
        {startup_task, sleeper},
        return_when=asyncio.FIRST_COMPLETED,
      )
      if startup_task in done:
        sleeper.cancel()
        await asyncio.gather(sleeper, return_exceptions=True)
        await ensure_startup_running()

    try:
      # Initialize client
      await client.initialize()
      logger.info(f"RAG client initialized: {self._name} ({self._type})")

      # Start optional startup function concurrently (e.g., server)
      if self._startup_function:
        logger.info("Starting user-provided startup function...")
        if asyncio.iscoroutinefunction(self._startup_function):
          startup_task = asyncio.create_task(self._startup_function(client))
        else:
          # Run sync function in executor to avoid blocking
          assert self._startup_function is not None  # Type hint for mypy
          startup_fn = self._startup_function

          async def _run_sync_startup():
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, startup_fn, client)

          startup_task = asyncio.create_task(_run_sync_startup())
        logger.info("Startup function running concurrently")

      # Delay only the periodic/env-driven synchronization. Long-lived
      # startup services (including the shared on-demand command listener)
      # start immediately so a UI-created source is ingested without waiting
      # through SLACK/JIRA/WEBEX init delays.
      if self._init_delay > 0:
        logger.info(f"Waiting {self._init_delay} seconds before starting sync...")
        await sleep_while_monitoring_startup(self._init_delay)

      if self._sync_interval <= 0 and not self._datasource_scheduled:
        # Single run mode
        logger.info("Running single sync cycle...")

        # Call user's sync function with client (original signature)
        if asyncio.iscoroutinefunction(self._sync_function):
          await self._sync_function(client)
        else:
          self._sync_function(client)

        # Track sync completion time
        self._last_sync_time = int(time.time())
        logger.info(f"Single sync cycle completed at {self._last_sync_time}")
        return
      else:
        # Periodic mode with smart scheduling based on datasource timestamps
        while True:
          await ensure_startup_running()
          # Calculate when next sync should happen based on datasource timestamps
          sleep_time, has_datasources = await self._calculate_next_sync_time(client)

          # EXIT_AFTER_FIRST_SYNC logic:
          # - If there are datasources but none need updating (sleep_time > 0) → exit without syncing
          # - If there are no datasources → run sync first, then exit
          if exit_after_first_sync and has_datasources and sleep_time > 0:
            logger.info("EXIT_AFTER_FIRST_SYNC is set and no datasources need updating. Exiting without sync.")
            return

          # Enforce minimum sleep to prevent tight loops from misconfiguration
          MIN_LOOP_SLEEP = 600  # 10 minute floor
          if sleep_time > 0:
            if self._schedule_check_only:
              logger.info(
                f"Sleeping for {sleep_time}s before rechecking datasource schedules"
              )
            else:
              logger.info(f"Sleeping for {sleep_time}s before next sync")
            await sleep_while_monitoring_startup(sleep_time)
            if self._schedule_check_only:
              continue
          elif self._last_sync_time is not None:
            time_since_last_sync = int(time.time()) - self._last_sync_time
            minimum_loop_sleep = (
              MIN_RELOAD_INTERVAL if self._datasource_scheduled else MIN_LOOP_SLEEP
            )
            if time_since_last_sync < minimum_loop_sleep:
              backoff = minimum_loop_sleep - time_since_last_sync
              logger.warning(f"Sync returned sleep_time=0 but last sync was only {time_since_last_sync}s ago, backing off {backoff}s to prevent tight loop")
              await sleep_while_monitoring_startup(backoff)

          # Now run the sync (either immediately if overdue, or after sleeping)
          logger.info("Running sync cycle...")

          # Call user's sync function (original signature - no changes needed!)
          if asyncio.iscoroutinefunction(self._sync_function):
            await self._sync_function(client)
          else:
            self._sync_function(client)

          # Track sync completion time
          self._last_sync_time = int(time.time())
          logger.info(f"Sync cycle completed at {self._last_sync_time}")

          # Exit after first sync if environment variable is set
          if exit_after_first_sync:
            logger.info("EXIT_AFTER_FIRST_SYNC is set. Exiting after first sync.")
            return

    except KeyboardInterrupt:
      logger.info("Received interrupt signal, shutting down...")
    except Exception as e:
      logger.error(f"Ingestor error: {e}", exc_info=True)
      raise
    finally:
      # Cancel startup task if it's still running
      if startup_task and not startup_task.done():
        logger.info("Cancelling startup task...")
        startup_task.cancel()
        try:
          await startup_task
        except asyncio.CancelledError:
          pass

      # Cleanup
      await client.shutdown()
      logger.info("Ingestor shutdown complete")
