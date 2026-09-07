from enum import Enum
from pydantic import BaseModel, Field, model_validator
from typing import Optional, Dict, Any, List
from langchain_core.documents import Document


# ============================================================================
# Web Scraping Configuration Models
# ============================================================================


class CrawlMode(str, Enum):
  """How to discover pages to crawl."""

  SINGLE_URL = "single"  # Only the specified URL
  SITEMAP = "sitemap"  # Discover and crawl sitemap
  RECURSIVE = "recursive"  # Follow links from starting URL


class ScrapySettings(BaseModel):
  """Scraping configuration exposed to users."""

  # Crawl behavior
  crawl_mode: CrawlMode = Field(CrawlMode.SINGLE_URL, description="How to discover pages: 'single' (just this URL), 'sitemap' (discover sitemap), 'recursive' (follow links)")
  max_depth: int = Field(2, description="Maximum link depth for recursive crawling", ge=1, le=10)
  max_pages: int = Field(2000, description="Maximum pages to crawl", ge=1)

  # JavaScript rendering
  render_javascript: bool = Field(False, description="Enable JavaScript rendering via Playwright (slower but handles SPAs)")
  wait_for_selector: Optional[str] = Field(None, description="CSS selector to wait for before extracting content (JS rendering only)")
  page_load_timeout: int = Field(15, description="Page load timeout in seconds", ge=5, le=120)

  # URL filtering
  follow_external_links: bool = Field(False, description="Follow links to external domains (recursive mode only)")
  allowed_url_patterns: Optional[List[str]] = Field(None, description="Regex patterns for URLs to include (whitelist)")
  denied_url_patterns: Optional[List[str]] = Field(None, description="Regex patterns for URLs to exclude (blacklist)")

  # Rate limiting
  download_delay: float = Field(0.05, description="Delay between requests to same domain (seconds)", ge=0)
  concurrent_requests: int = Field(30, description="Maximum concurrent requests", ge=1, le=50)
  respect_robots_txt: bool = Field(True, description="Obey robots.txt rules")

  # Chunking
  chunk_size: int = Field(10000, description="Maximum size of each text chunk in characters", ge=100, le=100000)
  chunk_overlap: int = Field(2000, description="Overlap between chunks in characters", ge=0, le=10000)

  # Misc
  user_agent: Optional[str] = Field(None, description="Custom user agent string (defaults to Chrome-like UA)")
  allow_non_public_urls: bool = Field(False, description="Allow crawling URLs that resolve to private/internal IP addresses. Disabled by default (SSRF protection). Only enable for datasources on internal networks.")

  @model_validator(mode="after")
  def validate_chunk_overlap(self) -> "ScrapySettings":
    if self.chunk_overlap >= self.chunk_size:
      raise ValueError("chunk_overlap must be smaller than chunk_size")
    return self


# ============================================================================
# Models for Ingestor ping and registration
# ============================================================================
class IngestorPingRequest(BaseModel):
  ingestor_type: str = Field(..., description="Type of the ingestor")
  ingestor_name: str = Field(..., description="Name of the ingestor")
  description: Optional[str] = Field("", description="Description of the ingestor")
  metadata: Optional[Dict[str, Any]] = Field({}, description="Additional metadata for the ingestor")


class IngestorPingResponse(BaseModel):
  ingestor_id: str = Field(..., description="Unique identifier for the ingestor")
  max_documents_per_ingest: int = Field(..., description="Maximum number of documents the server can handle per request")
  message: str = Field(..., description="Response message from the server")


# ============================================================================
# General Ingestor Models
# ============================================================================


class IngestionTuning(BaseModel):
  """Chunking and refresh settings shared by non-web ingestion requests."""

  default_chunk_size: int = Field(10000, ge=100, le=100000)
  default_chunk_overlap: int = Field(2000, ge=0, le=10000)
  reload_interval: int = Field(..., ge=60)
  search_team_slugs: List[str] = Field(
    default_factory=list,
    description=(
      "Teams explicitly granted Search access to a newly-created "
      "datasource. This is independent from source management ownership."
    ),
  )
  search_user_subjects: List[str] = Field(
    default_factory=list,
    description="Individual user subjects granted Search access to the new datasource.",
  )
  ownership_preprovisioned: bool = Field(
    False,
    description="The caller already reconciled independent knowledge_base/data_source OpenFGA policy.",
  )
  config_managed: bool = Field(
    False,
    description="The datasource configuration is managed in the application database rather than legacy connector env config.",
  )

  @model_validator(mode="after")
  def validate_chunk_overlap(self) -> "IngestionTuning":
    if self.default_chunk_overlap >= self.default_chunk_size:
      raise ValueError("default_chunk_overlap must be smaller than default_chunk_size")
    return self


class IngestorRequest(BaseModel):
  ingestor_id: str = Field(..., description="ID of the ingestor performing the ingestion")
  command: str = Field(..., description="Command to execute")
  payload: Optional[Any] = Field(..., description="Data associated with the command")
  job_id: Optional[str] = Field(None, description="Exact server-created job associated with this command")
  response_key: Optional[str] = Field(
    None,
    description="Redis list key used for a bounded request/response command such as preview",
  )


class DocumentIngestRequest(BaseModel):
  documents: List[Document] = Field(..., description="List of langchain Documents to ingest")
  ingestor_id: str = Field(..., description="ID of the ingestor ingesting these documents")
  datasource_id: str = Field(..., description="ID of the datasource associated with these documents")
  job_id: Optional[str] = Field(None, description="Job ID associated with this ingestion")
  fresh_until: Optional[int] = Field(0, description="Timestamp until which this data is considered fresh (epoch seconds)")


# ============================================================================
# Models specific for Web Ingestor
# ============================================================================


class UrlIngestRequest(BaseModel):
  """Request to ingest a URL with configurable scraping settings."""

  url: str = Field(..., description="URL to ingest")
  description: str = Field("", description="Description for this data source")
  settings: ScrapySettings = Field(default_factory=lambda: ScrapySettings(), description="Scraping configuration (crawl mode, JS rendering, rate limiting, etc.)")
  reload_interval: int = Field(..., ge=60, description="Auto-reload interval in seconds.")
  # Optional management owner. None creates a personal source owned by the
  # caller; Search Access remains the independent list below.
  owner_team_slug: Optional[str] = Field(None, description="Slug of the team that will manage this new data source. None creates a personal source.")
  search_team_slugs: List[str] = Field(
    default_factory=list,
    description=(
      "Teams explicitly granted Search access to a newly-created "
      "datasource. This is independent from source management ownership."
    ),
  )
  search_user_subjects: List[str] = Field(
    default_factory=list,
    description="Individual user subjects granted Search access to the new datasource.",
  )
  ownership_preprovisioned: bool = Field(
    False,
    description="The caller already reconciled independent knowledge_base/data_source OpenFGA policy.",
  )
  config_managed: bool = Field(
    False,
    description="The datasource configuration is managed in the application database rather than legacy connector env config.",
  )

  # DEPRECATED fields - will be removed in a future version.
  # Use 'settings' object instead.
  check_for_sitemaps: Optional[bool] = Field(None, description="DEPRECATED: Use settings.crawl_mode instead")
  sitemap_max_urls: Optional[int] = Field(None, description="DEPRECATED: Use settings.max_pages instead")
  ingest_type: Optional[str] = Field(None, description="DEPRECATED: No longer used")


class UrlReloadRequest(BaseModel):
  datasource_id: str = Field(..., description="ID of the URL datasource to reload")


class WebIngestorCommand(str, Enum):
  INGEST_URL = "ingest-url"
  PREVIEW_URL = "preview-url"
  RELOAD_ALL = "reload-all"
  RELOAD_DATASOURCE = "reload-datasource"


# ============================================================================
# Models specific for Confluence Ingestor
# ============================================================================


class ConfluenceIngestRequest(IngestionTuning):
  url: str = Field(..., description="Confluence page URL (e.g., 'https://domain.atlassian.net/wiki/spaces/SPACE/pages/PAGE_ID/Title')")
  name: Optional[str] = Field(None, max_length=120, description="Human-readable name for this data source")
  description: str = Field("", description="Description for this data source")
  get_child_pages: bool = Field(False, description="Whether to ingest direct child pages of this page")
  allowed_title_patterns: Optional[List[str]] = Field(None, description="Regex patterns for page titles to include (whitelist). If set, only pages whose title matches at least one pattern are ingested.")
  denied_title_patterns: Optional[List[str]] = Field(None, description="Regex patterns for page titles to exclude (blacklist). Pages whose title matches any pattern are skipped. Checked after allowed_title_patterns.")
  # Optional management owner for a new Confluence datasource. None creates a
  # personal source; ignored when appending pages to an existing datasource.
  owner_team_slug: Optional[str] = Field(None, description="Slug of the team that will manage this new data source. None creates a personal source.")
  preprovisioned_datasource_id: Optional[str] = Field(
    None,
    description=(
      "Datasource ID already provisioned by the application. Supports existing "
      "legacy space-level sources while new page sources use a page-specific ID."
    ),
  )


class ConfluenceReloadRequest(BaseModel):
  datasource_id: str = Field(..., description="ID of the Confluence datasource to reload")


class ConfluenceIngestorCommand(str, Enum):
  INGEST_PAGE = "ingest-page"
  PREVIEW_PAGE = "preview-page"
  RELOAD_ALL = "reload-all"
  RELOAD_DATASOURCE = "reload-datasource"


# ============================================================================
# Models specific for Slack Ingestor
# ============================================================================


class SlackIngestRequest(IngestionTuning):
  channel_id: str = Field(..., description="Slack channel ID to ingest (e.g., 'C0123456789')")
  channel_name: Optional[str] = Field(None, description="Human-readable channel name, used for display and message links")
  description: str = Field("", description="Description for this data source")
  lookback_days: int = Field(30, description="Number of days of message history to fetch on first sync", ge=0)
  include_bots: bool = Field(False, description="Whether to include bot messages")
  owner_team_slug: Optional[str] = Field(None, description="Slug of the team that will manage this new data source. None creates a personal source.")


class SlackReloadRequest(BaseModel):
  datasource_id: str = Field(..., description="ID of the Slack channel datasource to reload")


class SlackIngestorCommand(str, Enum):
  INGEST_CHANNEL = "ingest-channel"
  RELOAD_ALL = "reload-all"
  RELOAD_DATASOURCE = "reload-datasource"


# ============================================================================
# Models specific for Jira Ingestor
# ============================================================================


class JiraIngestRequest(IngestionTuning):
  project_key: str = Field(..., description="Jira project key (e.g., 'PROJ')")
  # The caller-supplied, immutable slug used to derive datasource_id — NOT
  # derived from the mutable `name` field, so renaming a source never
  # orphans its ingested data (see ui/src/lib/ingestion-source-id.ts).
  source_slug: str = Field(..., description="Immutable slug identifying this datasource within the project")
  name: str = Field(..., description="Human-readable name for this datasource")
  jql: str = Field(..., description="JQL query string used to fetch issues")
  description: str = Field("", description="Description for this data source")
  include_comments: bool = Field(True, description="Whether to include issue comments")
  include_links: bool = Field(True, description="Whether to include linked issues")
  custom_fields: Optional[Dict[str, str]] = Field(None, description="Mapping of friendly field name to Jira custom field id")
  owner_team_slug: Optional[str] = Field(None, description="Slug of the team that will manage this new data source. None creates a personal source.")


class JiraReloadRequest(BaseModel):
  datasource_id: str = Field(..., description="ID of the Jira project datasource to reload")


class JiraIngestorCommand(str, Enum):
  INGEST_PROJECT = "ingest-project"
  PREVIEW_PROJECT = "preview-project"
  RELOAD_ALL = "reload-all"
  RELOAD_DATASOURCE = "reload-datasource"


# ============================================================================
# Models specific for Webex Ingestor
# ============================================================================


class WebexIngestRequest(IngestionTuning):
  space_id: str = Field(..., description="Webex space (room) ID to ingest")
  space_name: Optional[str] = Field(None, description="Human-readable space name, used for display")
  description: str = Field("", description="Description for this data source")
  include_bots: bool = Field(False, description="Whether to include bot messages")
  owner_team_slug: Optional[str] = Field(None, description="Slug of the team that will manage this new data source. None creates a personal source.")


class WebexReloadRequest(BaseModel):
  datasource_id: str = Field(..., description="ID of the Webex space datasource to reload")


class WebexIngestorCommand(str, Enum):
  INGEST_SPACE = "ingest-space"
  RELOAD_ALL = "reload-all"
  RELOAD_DATASOURCE = "reload-datasource"


# ============================================================================
# Models for Graph Exploration and Querying
# ============================================================================
class ExploreNeighborhoodRequest(BaseModel):
  entity_type: str = Field(..., description="Type of the entity to explore")
  entity_pk: str = Field(..., description="Primary key of the entity to explore")
  depth: int = Field(1, description="Depth of neighborhood to explore (0 = just entity, 1 = direct neighbors, etc.)", ge=0, le=10)


class ExploreDataEntityRequest(BaseModel):
  entity_type: str = Field(..., description="Type of the entity to fetch")
  entity_pk: str = Field(..., description="Primary key of the entity to fetch")


class ExploreEntityRequest(BaseModel):
  entity_type: Optional[str] = Field(None, description="Type of entity to explore")
  filter_by_properties: Optional[Dict[str, str]] = Field(None, description="Properties to filter by")


class ExploreRelationsRequest(BaseModel):
  from_type: Optional[str] = Field(None, description="Type of the source entity")
  to_type: Optional[str] = Field(None, description="Type of the target entity")
  relation_name: Optional[str] = Field(None, description="Name of the relation")
  filter_by_properties: Optional[Dict[str, str]] = Field(None, description="Properties to filter relations by")


# ============================================================================
# Models for Querying
# ============================================================================
class QueryRequest(BaseModel):
  query: str = Field(..., description="Query string to search for")
  limit: int = Field(3, description="Maximum number of results to return", ge=1, le=100)
  similarity_threshold: float = Field(0.3, description="Minimum similarity score", ge=0.0, le=1.0)
  filters: Optional[Dict[str, str | bool | List[str]]] = Field(
    None, description="Additional filters as key-value pairs (values may be lists for OR / IN semantics)"
  )
  ranker_type: str = Field("weighted", description="Type of ranker to use")
  ranker_params: Optional[Dict[str, Any]] = Field({"weights": [0.7, 0.3]}, description="Parameters for the ranker")


class QueryResult(BaseModel):
  document: Document
  score: float


# ============================================================================
# Models for Batch Job Status
# ============================================================================
class JobsBatchRequest(BaseModel):
  datasource_ids: List[str] = Field(..., description="List of datasource IDs to fetch jobs for", max_length=100)
  status_filter: Optional[List[str]] = Field(None, description="Optional list of job statuses to filter by (e.g., ['in_progress', 'pending'])")


# ============================================================================
# Models for MCP Tool Invocation
# ============================================================================
class MCPToolInvokeRequest(BaseModel):
  """Request to invoke an MCP tool via REST API."""

  tool_name: str = Field(..., description="Name of the MCP tool to invoke (e.g., 'search', 'fetch_document')")
  arguments: Dict[str, Any] = Field(default_factory=dict, description="Arguments to pass to the tool (must match tool's parameter schema)")


class MCPToolInvokeResponse(BaseModel):
  """Response from MCP tool invocation."""

  tool_name: str = Field(..., description="Name of the tool that was invoked")
  success: bool = Field(..., description="Whether the tool invocation succeeded")
  result: Optional[Any] = Field(None, description="Result returned by the tool (if successful)")
  error: Optional[str] = Field(None, description="Error message (if failed)")


# ============================================================================
# Models for Document/Chunk Listing
# ============================================================================
class ChunkInfo(BaseModel):
  """Information about a single chunk (without content)."""

  id: str = Field(..., description="Unique chunk ID")
  chunk_index: int = Field(..., description="Index of the chunk within the document")
  total_chunks: int = Field(..., description="Total number of chunks in the document")
  metadata: Dict[str, Any] = Field(default_factory=dict, description="Chunk metadata (fresh_until, document_type, etc.)")


class DocumentInfo(BaseModel):
  """Information about a document with its chunks."""

  document_id: str = Field(..., description="Unique document ID")
  title: str = Field(default="", description="Document title")
  chunks: List[ChunkInfo] = Field(default_factory=list, description="List of chunks in this document")


class DatasourceDocumentsResponse(BaseModel):
  """Response for listing documents in a datasource."""

  datasource_id: str = Field(..., description="The datasource ID")
  documents: List[DocumentInfo] = Field(default_factory=list, description="List of documents with their chunks")
  total_documents: int = Field(..., description="Number of unique documents in this response")
  total_chunks: int = Field(..., description="Number of chunks in this response")
  offset: int = Field(..., description="Current offset (number of chunks skipped)")
  limit: int = Field(..., description="Requested limit")
  has_more: bool = Field(..., description="Whether more chunks exist beyond this batch")


class ChunkContentResponse(BaseModel):
  """Response for fetching chunk content."""

  id: str = Field(..., description="Chunk ID")
  text_content: str = Field(..., description="The text content of the chunk")


class CleanupResponse(BaseModel):
  """Response for cleanup operations."""

  datasource_id: Optional[str] = Field(None, description="Datasource ID (for per-datasource cleanup)")
  success: bool = Field(..., description="Whether cleanup completed successfully")
  message: str = Field(..., description="Status message")
