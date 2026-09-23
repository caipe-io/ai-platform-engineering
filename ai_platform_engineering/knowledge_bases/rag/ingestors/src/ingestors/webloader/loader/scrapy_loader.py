"""
Scrapy-based web loader for scraping and ingesting web content.

This module provides the main entry point for Scrapy-based web scraping,
using a subprocess worker pool to avoid Twisted/asyncio event loop conflicts.
"""

import gc

from langchain_core.documents import Document

from common.models.server import ScrapySettings
from common.models.rag import DataSourceInfo
from common.job_manager import JobManager, JobStatus
from common.ingestor import Client
from common.utils import get_logger, get_fresh_until
from common.constants import MIN_RELOAD_INTERVAL

from .worker_pool import get_worker_pool
from .worker_types import CrawlRequest, CrawlProgress, CrawlDocuments, CrawlResult, CrawlStatus

logger = get_logger(__name__)


class ScrapyLoader:
  """
  Main entry point for Scrapy-based web scraping.

  This class manages crawl requests using a worker pool and handles
  document ingestion to the RAG server.
  """

  def __init__(
    self,
    rag_client: Client,
    job_manager: JobManager,
    datasource_info: DataSourceInfo,
  ):
    """
    Initialize the Scrapy loader.

    Args:
        rag_client: Client for communicating with RAG server
        job_manager: Manager for job status updates
        datasource_info: Metadata about the datasource
    """
    self.client = rag_client
    self.job_manager = job_manager
    self.datasource_info = datasource_info
    self.logger = get_logger(f"scrapy-loader:{datasource_info.datasource_id[:12]}")

  async def load(
    self,
    url: str,
    settings: ScrapySettings,
    job_id: str,
  ) -> None:
    """
    Load content from a URL using Scrapy worker pool.

    Uses streaming ingestion: documents are sent to the server as they are crawled,
    rather than waiting for the entire crawl to complete. If the server rejects
    documents (e.g., job terminated), the crawl is cancelled.

    Args:
        url: URL to scrape
        settings: Scraping configuration
        job_id: ID of the ingestion job
    """
    self.logger.info(f"Starting Scrapy crawl for {url} with mode {settings.crawl_mode}")

    # Track streaming ingestion state
    documents_ingested = 0
    crawl_cancelled = False

    try:
      # Update job status with mode info
      if settings.render_javascript:
        await self.job_manager.upsert_job(
          job_id=job_id,
          status=JobStatus.IN_PROGRESS,
          message=f"Starting {settings.crawl_mode.value} crawl with JavaScript rendering (Chromium)",
        )
        self.logger.info("JavaScript rendering enabled - using Playwright/Chromium")
      else:
        await self.job_manager.upsert_job(
          job_id=job_id,
          status=JobStatus.IN_PROGRESS,
          message=f"Starting {settings.crawl_mode.value} crawl of {url}",
        )

      # Get worker pool
      pool = await get_worker_pool()

      # Get reload_interval from datasource, clamp to minimum to prevent tight loops
      reload_interval = self.datasource_info.reload_interval
      if reload_interval < MIN_RELOAD_INTERVAL:
        self.logger.warning(f"Datasource {self.datasource_info.datasource_id} has reload_interval {reload_interval}s below minimum {MIN_RELOAD_INTERVAL}s, clamping to minimum")
        reload_interval = MIN_RELOAD_INTERVAL

      # Calculate fresh_until for document ingestion
      fresh_until = get_fresh_until(reload_interval)

      auth_headers, auth_credential_labels = await self.client.resolve_auth_headers(settings.auth_headers)

      # Build crawl request
      request = CrawlRequest(
        job_id=job_id,
        url=url,
        datasource_id=self.datasource_info.datasource_id,
        crawl_mode=settings.crawl_mode.value,
        max_depth=settings.max_depth,
        max_pages=settings.max_pages,
        render_javascript=settings.render_javascript,
        wait_for_selector=settings.wait_for_selector,
        page_load_timeout=settings.page_load_timeout,
        follow_external_links=settings.follow_external_links,
        allowed_url_patterns=settings.allowed_url_patterns,
        denied_url_patterns=settings.denied_url_patterns,
        download_delay=settings.download_delay,
        concurrent_requests=settings.concurrent_requests,
        respect_robots_txt=settings.respect_robots_txt,
        user_agent=settings.user_agent,
        allow_non_public_urls=settings.allow_non_public_urls,
        resolved_auth_headers=auth_headers or None,
        auth_credential_labels=auth_credential_labels,
        ingestor_id=self.client.ingestor_id or "",
        datasource_name=getattr(self.datasource_info, "name", "") or "",
        reload_interval=reload_interval,
      )

      # Progress tracking state
      last_pages_crawled = 0
      total_set = False

      # Progress callback
      async def on_progress(progress: CrawlProgress):
        nonlocal last_pages_crawled, total_set

        # Set total if we now know it (from sitemap) and haven't set it yet
        if progress.total_pages and not total_set:
          await self.job_manager.upsert_job(
            job_id=job_id,
            status=JobStatus.IN_PROGRESS,
            message=progress.message,
            total=progress.total_pages,
          )
          total_set = True
        else:
          await self.job_manager.upsert_job(
            job_id=job_id,
            status=JobStatus.IN_PROGRESS,
            message=progress.message,
          )

        # Increment progress counter by the delta
        delta = progress.pages_crawled - last_pages_crawled
        if delta > 0:
          await self.job_manager.increment_progress(job_id, delta)
          last_pages_crawled = progress.pages_crawled

      # Streaming documents callback
      async def on_documents(docs: CrawlDocuments) -> bool:
        """
        Handle streaming document batches from the crawler.

        Returns True to continue crawling, False to cancel.
        """
        nonlocal documents_ingested, crawl_cancelled

        if not docs.documents:
          return True  # Empty batch, continue

        # Convert document dicts to LangChain Documents
        documents = []
        for doc_dict in docs.documents:
          doc = Document(
            id=doc_dict.get("id"),
            page_content=doc_dict.get("page_content", ""),
            metadata=doc_dict.get("metadata", {}),
          )
          documents.append(doc)

        self.logger.info(f"Received batch {docs.batch_number} with {len(documents)} documents (streaming)")

        # Send to RAG server
        try:
          await self.client.ingest_documents(
            job_id=job_id,
            datasource_id=self.datasource_info.datasource_id,
            documents=documents,
            fresh_until=fresh_until,
          )
          # Note: document_count is auto-incremented by Client.ingest_documents()

          documents_ingested += len(documents)
          self.logger.info(f"Ingested batch {docs.batch_number} ({len(documents)} documents, {documents_ingested} total)")
          return True  # Continue crawling

        except Exception as e:
          error_msg = str(e)
          self.logger.warning(f"Failed to ingest batch {docs.batch_number}: {error_msg}")

          # Check if this is a job rejection (job no longer IN_PROGRESS)
          # HTTP 400 with "IN_PROGRESS" or "terminated" typically means job was cancelled
          if "400" in error_msg and ("IN_PROGRESS" in error_msg or "terminated" in error_msg.lower()):
            self.logger.info(f"Job {job_id} appears to be terminated, cancelling crawl")
            crawl_cancelled = True
            return False  # Cancel crawling

          # Other errors - log but continue crawling
          await self.job_manager.add_error_msg(job_id, f"Batch ingest failed: {error_msg}")
          return True

      # Run crawl with streaming ingestion
      self.logger.info(f"Submitting crawl to worker pool: {url}")
      result = await pool.crawl(
        request=request,
        on_progress=on_progress,
        on_documents=on_documents,
        timeout=settings.max_pages * 30,  # ~30 seconds per page max
      )

      self.logger.info(f"Crawl completed: {result.pages_crawled} pages, status: {result.status}, documents_ingested: {documents_ingested}")

      # Process final result (handles any remaining documents and status)
      await self._process_result(result, job_id, url, fresh_until, documents_ingested, crawl_cancelled)

    except Exception as e:
      self.logger.error(f"Crawl failed: {e}")

      await self.job_manager.upsert_job(
        job_id=job_id,
        status=JobStatus.FAILED,
        message=f"Crawl failed: {str(e)}",
      )

      raise

    finally:
      gc.collect()

  async def _process_result(
    self,
    result: CrawlResult,
    job_id: str,
    url: str,
    fresh_until: int,
    documents_already_ingested: int = 0,
    crawl_cancelled: bool = False,
  ):
    """
    Process crawl result and update job status.

    With streaming ingestion, documents are ingested as they're crawled via on_documents callback.
    This method handles the final status update and any documents that weren't streamed
    (fallback for non-streaming mode).

    Args:
        result: Crawl result from worker
        job_id: Job ID
        url: Original URL
        fresh_until: Timestamp until which data is considered fresh (epoch seconds)
        documents_already_ingested: Count of documents already sent to server via streaming
        crawl_cancelled: True if crawl was cancelled (e.g., job terminated)
    """
    # If crawl was cancelled, set appropriate status
    if crawl_cancelled:
      # Add any error messages from the crawl
      for error in result.errors:
        await self.job_manager.add_error_msg(job_id, error)

      if documents_already_ingested > 0:
        await self.job_manager.upsert_job(
          job_id=job_id,
          status=JobStatus.COMPLETED_WITH_ERRORS,
          message=f"Crawl cancelled after ingesting {documents_already_ingested} documents",
        )
      else:
        await self.job_manager.upsert_job(
          job_id=job_id,
          status=JobStatus.FAILED,
          message="Crawl cancelled (job terminated)",
        )
      return

    if result.status == CrawlStatus.FAILED:
      fatal_error = result.fatal_error or f"Failed to crawl {url}"
      self.logger.error(f"Crawl failed: {fatal_error}")

      # Log filtering stats for debugging
      if result.urls_found_in_sitemap > 0:
        self.logger.info(f"Filtering stats: {result.urls_found_in_sitemap} URLs in sitemap, {result.urls_filtered_external} filtered as external, {result.urls_filtered_pattern} filtered by pattern, {result.urls_filtered_max_pages} filtered by max pages")

      # Add individual error messages to the job
      for error in result.errors:
        await self.job_manager.add_error_msg(job_id, error)

      await self.job_manager.upsert_job(
        job_id=job_id,
        status=JobStatus.FAILED,
        message=fatal_error,
      )
      return

    # Check if we have any documents (either streamed or in result)
    total_documents = documents_already_ingested + len(result.documents)

    if total_documents == 0:
      # Build a more helpful message if we have filtering stats
      fatal_error = result.fatal_error
      if not fatal_error:
        if result.urls_found_in_sitemap > 0:
          fatal_error = f"No content extracted from {url}. Found {result.urls_found_in_sitemap} URLs in sitemap but none were successfully scraped."
        else:
          fatal_error = f"No content extracted from {url}"

      self.logger.error(f"No documents extracted: {fatal_error}")

      # Add individual error messages to the job
      for error in result.errors:
        await self.job_manager.add_error_msg(job_id, error)

      await self.job_manager.upsert_job(
        job_id=job_id,
        status=JobStatus.FAILED,
        message=fatal_error,
      )
      return

    # Ingest any documents that weren't streamed (fallback for non-streaming or final batch)
    if result.documents:
      self.logger.info(f"Ingesting {len(result.documents)} remaining documents from final result")

      # Convert document dicts to LangChain Documents
      documents = []
      for doc_dict in result.documents:
        doc = Document(
          id=doc_dict.get("id"),
          page_content=doc_dict.get("page_content", ""),
          metadata=doc_dict.get("metadata", {}),
        )
        documents.append(doc)

      # Send to RAG server in batches
      batch_size = 100
      total_batches = (len(documents) + batch_size - 1) // batch_size

      for i in range(0, len(documents), batch_size):
        batch = documents[i : i + batch_size]
        batch_num = i // batch_size + 1

        try:
          await self.client.ingest_documents(
            job_id=job_id,
            datasource_id=self.datasource_info.datasource_id,
            documents=batch,
            fresh_until=fresh_until,
          )
          # Note: document_count is auto-incremented by Client.ingest_documents()
          self.logger.info(f"Ingested final batch {batch_num}/{total_batches} ({len(batch)} documents)")

        except Exception as e:
          error_msg = f"Failed to ingest final batch {batch_num}/{total_batches}: {e}"
          self.logger.error(error_msg)
          await self.job_manager.add_error_msg(job_id, error_msg)
          # Continue with next batch

    # Update final status
    if result.status == CrawlStatus.PARTIAL:
      # Add individual error messages to the job
      for error in result.errors:
        await self.job_manager.add_error_msg(job_id, error)

      await self.job_manager.upsert_job(
        job_id=job_id,
        status=JobStatus.COMPLETED_WITH_ERRORS,
        message=f"Crawled {result.pages_crawled} pages with {result.pages_failed} errors",
      )
    else:
      # Build success message, include sitemap URL if one was used
      if result.sitemap_url_used:
        message = f"Crawled {result.pages_crawled} pages from {result.sitemap_url_used} in {result.elapsed_seconds:.1f}s"
      else:
        message = f"Successfully crawled {result.pages_crawled} pages in {result.elapsed_seconds:.1f}s"

      await self.job_manager.upsert_job(
        job_id=job_id,
        status=JobStatus.COMPLETED,
        message=message,
      )


async def run_scrapy_loader(
  url: str,
  settings: ScrapySettings,
  job_id: str,
  client: Client,
  job_manager: JobManager,
  datasource_info: DataSourceInfo,
) -> None:
  """
  Convenience function to run the Scrapy loader.

  Args:
      url: URL to scrape
      settings: Scraping configuration
      job_id: ID of the ingestion job
      client: RAG server client
      job_manager: Job status manager
      datasource_info: Datasource metadata
  """
  loader = ScrapyLoader(
    rag_client=client,
    job_manager=job_manager,
    datasource_info=datasource_info,
  )

  await loader.load(url=url, settings=settings, job_id=job_id)
