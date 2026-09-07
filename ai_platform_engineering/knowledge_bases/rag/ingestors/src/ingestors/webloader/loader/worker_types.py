"""
IPC message types for Scrapy worker subprocess communication.

These dataclasses define the messages passed between the main ingestor process
and the Scrapy worker subprocess via multiprocessing queues.
"""

from dataclasses import dataclass, field
from enum import Enum


class MessageType(str, Enum):
  """Types of messages sent between main process and worker."""

  # Main -> Worker
  CRAWL_REQUEST = "crawl_request"
  CANCEL_CRAWL = "cancel_crawl"  # Request to stop crawling a specific job
  SHUTDOWN = "shutdown"

  # Worker -> Main
  CRAWL_STARTED = "crawl_started"
  CRAWL_PROGRESS = "crawl_progress"
  CRAWL_DOCUMENTS = "crawl_documents"  # Batch of documents ready for ingestion
  CRAWL_RESULT = "crawl_result"
  WORKER_READY = "worker_ready"
  WORKER_ERROR = "worker_error"


class CrawlStatus(str, Enum):
  """Status of a crawl operation."""

  SUCCESS = "success"
  FAILED = "failed"
  PARTIAL = "partial"  # Some pages failed


@dataclass
class CrawlRequest:
  """
  Request to crawl a URL.

  Sent from main process to worker.
  """

  job_id: str
  url: str
  datasource_id: str

  # Scrapy settings (serialized as dict for IPC)
  crawl_mode: str  # "single", "sitemap", "recursive"
  max_depth: int = 2
  max_pages: int = 100
  render_javascript: bool = False
  wait_for_selector: str | None = None
  page_load_timeout: int = 30
  follow_external_links: bool = False
  allowed_url_patterns: list[str] | None = None
  denied_url_patterns: list[str] | None = None
  download_delay: float = 0.5
  concurrent_requests: int = 8
  respect_robots_txt: bool = True
  user_agent: str | None = None
  allow_non_public_urls: bool = False

  # Metadata for document creation
  ingestor_id: str = ""
  datasource_name: str = ""
  reload_interval: int = 86400  # Used to calculate fresh_until for documents


@dataclass
class CrawlProgress:
  """
  Progress update during a crawl.

  Sent from worker to main process periodically.
  """

  job_id: str
  pages_crawled: int
  pages_failed: int
  current_url: str | None = None
  message: str = ""
  # For progress bar calculation
  total_pages: int | None = None  # Known total (e.g., from sitemap)
  queue_size: int = 0  # Pending URLs in queue (for recursive mode)


@dataclass
class CrawlDocuments:
  """
  Batch of documents ready for ingestion.

  Sent from worker to main process as documents are crawled.
  This enables streaming ingestion instead of waiting for crawl completion.
  """

  job_id: str
  documents: list[dict] = field(default_factory=list)  # Serialized Document objects
  batch_number: int = 0  # For tracking/logging
  is_final_batch: bool = False  # True if this is the last batch


@dataclass
class CrawlResult:
  """
  Final result of a crawl operation.

  Sent from worker to main process when crawl completes.
  """

  job_id: str
  status: CrawlStatus
  pages_crawled: int
  pages_failed: int
  documents: list[dict] = field(default_factory=list)  # Serialized Document objects
  fatal_error: str | None = None  # Fatal error message when entire crawl fails
  errors: list[str] = field(default_factory=list)  # Individual page errors (for partial failures)
  elapsed_seconds: float = 0.0

  # Filtering stats for debugging failed crawls
  urls_found_in_sitemap: int = 0
  urls_matched_in_sitemap: int = 0
  urls_filtered_external: int = 0
  urls_filtered_pattern: int = 0
  urls_filtered_max_pages: int = 0

  # Sitemap discovery info
  sitemap_url_used: str | None = None  # The sitemap URL that was successfully loaded


@dataclass
class WorkerMessage:
  """
  Wrapper for all worker messages with type discrimination.

  This is the actual message format sent through queues.
  """

  type: MessageType
  payload: dict = field(default_factory=dict)

  def to_dict(self) -> dict:
    """Serialize to dict for queue transport."""
    return {"type": self.type.value, "payload": self.payload}

  @classmethod
  def from_dict(cls, data: dict) -> "WorkerMessage":
    """Deserialize from dict."""
    return cls(type=MessageType(data["type"]), payload=data.get("payload", {}))

  @classmethod
  def crawl_request(cls, request: CrawlRequest) -> "WorkerMessage":
    """Create a crawl request message."""
    return cls(type=MessageType.CRAWL_REQUEST, payload=request.__dict__)

  @classmethod
  def cancel_crawl(cls, job_id: str) -> "WorkerMessage":
    """Create a cancel crawl message."""
    return cls(type=MessageType.CANCEL_CRAWL, payload={"job_id": job_id})

  @classmethod
  def shutdown(cls) -> "WorkerMessage":
    """Create a shutdown message."""
    return cls(type=MessageType.SHUTDOWN)

  @classmethod
  def crawl_started(cls, job_id: str) -> "WorkerMessage":
    """Create a crawl started message."""
    return cls(type=MessageType.CRAWL_STARTED, payload={"job_id": job_id})

  @classmethod
  def crawl_progress(cls, progress: CrawlProgress) -> "WorkerMessage":
    """Create a progress update message."""
    return cls(type=MessageType.CRAWL_PROGRESS, payload=progress.__dict__)

  @classmethod
  def crawl_documents(cls, docs: CrawlDocuments) -> "WorkerMessage":
    """Create a crawl documents message for streaming ingestion."""
    return cls(
      type=MessageType.CRAWL_DOCUMENTS,
      payload={
        "job_id": docs.job_id,
        "documents": docs.documents,
        "batch_number": docs.batch_number,
        "is_final_batch": docs.is_final_batch,
      },
    )

  @classmethod
  def crawl_result(cls, result: CrawlResult) -> "WorkerMessage":
    """Create a crawl result message."""
    payload = {
      "job_id": result.job_id,
      "status": result.status.value,
      "pages_crawled": result.pages_crawled,
      "pages_failed": result.pages_failed,
      "documents": result.documents,
      "fatal_error": result.fatal_error,
      "errors": result.errors,
      "elapsed_seconds": result.elapsed_seconds,
      # Filtering stats for debugging
      "urls_found_in_sitemap": result.urls_found_in_sitemap,
      "urls_matched_in_sitemap": result.urls_matched_in_sitemap,
      "urls_filtered_external": result.urls_filtered_external,
      "urls_filtered_pattern": result.urls_filtered_pattern,
      "urls_filtered_max_pages": result.urls_filtered_max_pages,
      "sitemap_url_used": result.sitemap_url_used,
    }
    return cls(type=MessageType.CRAWL_RESULT, payload=payload)

  @classmethod
  def worker_ready(cls, worker_id: int) -> "WorkerMessage":
    """Create a worker ready message."""
    return cls(type=MessageType.WORKER_READY, payload={"worker_id": worker_id})

  @classmethod
  def worker_error(cls, error: str, job_id: str | None = None) -> "WorkerMessage":
    """Create a worker error message."""
    return cls(type=MessageType.WORKER_ERROR, payload={"error": error, "job_id": job_id})
