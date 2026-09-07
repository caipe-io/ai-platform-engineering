"""
Scrapy Worker Pool for managing crawler subprocess workers.

This module provides a pool of worker processes that run Scrapy crawlers.
Each worker runs Twisted's reactor.run() in its own process, avoiding
event loop conflicts with the main asyncio-based ingestor.
"""

import asyncio
import multiprocessing
import os
from typing import Dict, Optional, Callable, Awaitable
from dataclasses import dataclass

# Use 'spawn' context to create fresh processes without inheriting parent's event loop
# This is critical for Twisted reactor to work properly in subprocess
mp_context = multiprocessing.get_context("spawn")
Process = mp_context.Process
Queue = mp_context.Queue

from common.utils import get_logger

from .worker_types import (
  WorkerMessage,
  MessageType,
  CrawlRequest,
  CrawlProgress,
  CrawlDocuments,
  CrawlResult,
  CrawlStatus,
)

logger = get_logger(__name__)

# Default pool size
DEFAULT_POOL_SIZE = int(os.getenv("SCRAPY_WORKER_POOL_SIZE", "3"))


@dataclass
class PendingJob:
  """A job waiting for a result."""

  request: CrawlRequest
  future: asyncio.Future
  worker_id: int  # Track which worker is handling this job
  on_progress: Optional[Callable[[CrawlProgress], Awaitable[None]]] = None
  on_documents: Optional[Callable[[CrawlDocuments], Awaitable[bool]]] = None  # Returns False to cancel


class ScrapyWorkerPool:
  """
  Pool of Scrapy worker processes.

  This class manages a fixed number of worker processes that run Scrapy crawlers.
  Crawl requests are dispatched to available workers, and results are returned
  asynchronously.

  Usage:
      pool = ScrapyWorkerPool(max_workers=3)
      await pool.start()

      result = await pool.crawl(request, on_progress=callback)

      await pool.shutdown()
  """

  def __init__(self, max_workers: int = DEFAULT_POOL_SIZE):
    """
    Initialize the worker pool.

    Args:
        max_workers: Maximum number of concurrent worker processes
    """
    self.max_workers = max_workers
    self.workers: Dict[int, Process] = {}
    self.request_queues: Dict[int, Queue] = {}
    self.result_queue: Optional[Queue] = None
    self.pending_jobs: Dict[str, PendingJob] = {}  # job_id -> PendingJob
    self.available_workers: asyncio.Queue = asyncio.Queue()
    self._running = False
    self._result_processor_task: Optional[asyncio.Task] = None

  async def start(self):
    """
    Start the worker pool.

    This spawns worker processes and waits for them to become ready.
    """
    if self._running:
      logger.warning("Worker pool already running")
      return

    logger.info(f"Starting Scrapy worker pool with {self.max_workers} workers")

    # Create shared result queue
    self.result_queue = Queue()

    # Spawn workers
    for worker_id in range(self.max_workers):
      request_queue = Queue()
      self.request_queues[worker_id] = request_queue

      # Import here to avoid circular imports
      from .scrapy_worker import worker_main

      process = Process(
        target=worker_main,
        args=(worker_id, request_queue, self.result_queue),
        daemon=True,
      )
      process.start()
      self.workers[worker_id] = process

      logger.info(f"Started worker {worker_id} (PID: {process.pid})")

    # Wait for all workers to signal ready
    ready_count = 0
    timeout = 30  # seconds
    start_time = asyncio.get_event_loop().time()

    while ready_count < self.max_workers:
      if asyncio.get_event_loop().time() - start_time > timeout:
        raise TimeoutError(f"Workers failed to start within {timeout}s")

      try:
        # Check result queue in executor to avoid blocking
        msg_dict = await asyncio.get_event_loop().run_in_executor(None, self._get_message_timeout, 1.0)

        if msg_dict:
          msg = WorkerMessage.from_dict(msg_dict)
          if msg.type == MessageType.WORKER_READY:
            worker_id = msg.payload.get("worker_id")
            await self.available_workers.put(worker_id)
            ready_count += 1
            logger.info(f"Worker {worker_id} ready ({ready_count}/{self.max_workers})")

      except Exception as e:
        logger.warning(f"Error waiting for workers: {e}")
        await asyncio.sleep(0.5)

    self._running = True

    # Start result processor
    self._result_processor_task = asyncio.create_task(self._process_results())

    logger.info("Worker pool started successfully")

  def _get_message_timeout(self, timeout: float) -> Optional[dict]:
    """Get a message from result queue with timeout (runs in executor)."""
    try:
      return self.result_queue.get(timeout=timeout)
    except Exception:
      return None

  async def _process_results(self):
    """
    Background task to process results from workers.

    This runs continuously and dispatches results to waiting futures.
    """
    logger.info("Starting result processor")

    while self._running:
      try:
        # Check for results in executor
        msg_dict = await asyncio.get_event_loop().run_in_executor(None, self._get_message_timeout, 0.5)

        if msg_dict is None:
          continue

        msg = WorkerMessage.from_dict(msg_dict)

        if msg.type == MessageType.CRAWL_STARTED:
          job_id = msg.payload.get("job_id")
          logger.debug(f"Crawl started: {job_id}")

        elif msg.type == MessageType.CRAWL_PROGRESS:
          job_id = msg.payload.get("job_id")
          pending = self.pending_jobs.get(job_id)

          if pending and pending.on_progress:
            progress = CrawlProgress(
              job_id=job_id,
              pages_crawled=msg.payload.get("pages_crawled", 0),
              pages_failed=msg.payload.get("pages_failed", 0),
              current_url=msg.payload.get("current_url"),
              message=msg.payload.get("message", ""),
              total_pages=msg.payload.get("total_pages"),
              queue_size=msg.payload.get("queue_size", 0),
            )
            try:
              await pending.on_progress(progress)
            except Exception:
              logger.warning("Progress callback error")

        elif msg.type == MessageType.CRAWL_DOCUMENTS:
          # Streaming document batch from worker
          job_id = msg.payload.get("job_id")
          pending = self.pending_jobs.get(job_id)

          if pending and pending.on_documents:
            docs = CrawlDocuments(
              job_id=job_id,
              documents=msg.payload.get("documents", []),
              batch_number=msg.payload.get("batch_number", 0),
              is_final_batch=msg.payload.get("is_final_batch", False),
            )
            try:
              # Callback returns False if we should cancel the crawl
              should_continue = await pending.on_documents(docs)
              if not should_continue:
                logger.info(f"Documents callback requested cancellation for job {job_id}")
                await self.cancel_crawl(job_id)
            except Exception as e:
              logger.warning(f"Documents callback error: {e}")

        elif msg.type == MessageType.CRAWL_RESULT:
          job_id = msg.payload.get("job_id")
          pending = self.pending_jobs.pop(job_id, None)

          if pending:
            result = CrawlResult(
              job_id=job_id,
              status=CrawlStatus(msg.payload.get("status", "failed")),
              pages_crawled=msg.payload.get("pages_crawled", 0),
              pages_failed=msg.payload.get("pages_failed", 0),
              documents=msg.payload.get("documents", []),
              fatal_error=msg.payload.get("fatal_error"),
              errors=msg.payload.get("errors", []),
              elapsed_seconds=msg.payload.get("elapsed_seconds", 0),
              urls_found_in_sitemap=msg.payload.get("urls_found_in_sitemap", 0),
              urls_matched_in_sitemap=msg.payload.get("urls_matched_in_sitemap", 0),
              urls_filtered_external=msg.payload.get("urls_filtered_external", 0),
              urls_filtered_pattern=msg.payload.get("urls_filtered_pattern", 0),
              urls_filtered_max_pages=msg.payload.get("urls_filtered_max_pages", 0),
              sitemap_url_used=msg.payload.get("sitemap_url_used"),
            )

            if not pending.future.done():
              pending.future.set_result(result)

            logger.info(f"Crawl completed: {job_id} - {result.pages_crawled} pages in {result.elapsed_seconds:.1f}s")

        elif msg.type == MessageType.WORKER_READY:
          worker_id = msg.payload.get("worker_id")
          await self.available_workers.put(worker_id)
          logger.debug(f"Worker {worker_id} available")

        elif msg.type == MessageType.WORKER_ERROR:
          error = msg.payload.get("error")
          job_id = msg.payload.get("job_id")
          logger.error(f"Worker error: {error}")

          if job_id:
            pending = self.pending_jobs.pop(job_id, None)
            if pending and not pending.future.done():
              pending.future.set_exception(Exception(error))

      except asyncio.CancelledError:
        break
      except Exception as e:
        logger.error(f"Error processing results: {e}")
        await asyncio.sleep(0.5)

    logger.info("Result processor stopped")

  async def crawl(
    self,
    request: CrawlRequest,
    on_progress: Optional[Callable[[CrawlProgress], Awaitable[None]]] = None,
    on_documents: Optional[Callable[[CrawlDocuments], Awaitable[bool]]] = None,
    timeout: float = 3600,  # 1 hour default
  ) -> CrawlResult:
    """
    Submit a crawl request and wait for the result.

    Args:
        request: Crawl request configuration
        on_progress: Optional callback for progress updates
        on_documents: Optional callback for streaming document batches.
            Called with each batch of documents as they're crawled.
            Return True to continue crawling, False to cancel.
        timeout: Maximum time to wait for crawl completion

    Returns:
        CrawlResult with crawled documents

    Raises:
        TimeoutError: If crawl exceeds timeout
        Exception: If worker encounters an error
    """
    if not self._running:
      raise RuntimeError("Worker pool not running. Call start() first.")

    # Get an available worker
    try:
      worker_id = await asyncio.wait_for(self.available_workers.get(), timeout=60)
    except asyncio.TimeoutError:
      raise RuntimeError("No workers available within 60s")

    logger.info(f"Dispatching crawl {request.job_id} to worker {worker_id}")

    # Create future for result
    loop = asyncio.get_event_loop()
    future = loop.create_future()

    # Track pending job with worker_id for cancellation support
    self.pending_jobs[request.job_id] = PendingJob(
      request=request,
      future=future,
      worker_id=worker_id,
      on_progress=on_progress,
      on_documents=on_documents,
    )

    # Send request to worker
    msg = WorkerMessage.crawl_request(request)
    self.request_queues[worker_id].put(msg.to_dict())

    try:
      # Wait for result
      result = await asyncio.wait_for(future, timeout=timeout)

      # Mark worker as available again
      await self.available_workers.put(worker_id)

      return result

    except asyncio.TimeoutError:
      # Remove from pending
      self.pending_jobs.pop(request.job_id, None)

      # Worker might be stuck - don't return it to pool
      logger.error(f"Crawl {request.job_id} timed out after {timeout}s")

      return CrawlResult(
        job_id=request.job_id,
        status=CrawlStatus.FAILED,
        pages_crawled=0,
        pages_failed=0,
        fatal_error=f"Crawl timed out after {timeout}s",
      )

    except Exception:
      # Remove from pending
      self.pending_jobs.pop(request.job_id, None)

      # Return worker to pool (it might still be healthy)
      await self.available_workers.put(worker_id)

      raise

  async def cancel_crawl(self, job_id: str) -> bool:
    """
    Cancel an active crawl.

    Sends a cancellation message to the worker handling the job.
    The worker will stop crawling and send a final result.

    Args:
        job_id: The job ID to cancel

    Returns:
        True if cancellation was sent, False if job not found
    """
    pending = self.pending_jobs.get(job_id)
    if not pending:
      logger.warning(f"Cannot cancel job {job_id}: not found in pending jobs")
      return False

    worker_id = pending.worker_id
    logger.info(f"Sending cancel request for job {job_id} to worker {worker_id}")

    try:
      msg = WorkerMessage.cancel_crawl(job_id)
      self.request_queues[worker_id].put(msg.to_dict())
      return True
    except Exception as e:
      logger.error(f"Error sending cancel request for job {job_id}: {e}")
      return False

  async def shutdown(self, timeout: float = 10):
    """
    Shutdown the worker pool.

    Args:
        timeout: Maximum time to wait for workers to exit gracefully
    """
    if not self._running:
      return

    logger.info("Shutting down worker pool")
    self._running = False

    # Cancel result processor
    if self._result_processor_task:
      self._result_processor_task.cancel()
      try:
        await self._result_processor_task
      except asyncio.CancelledError:
        pass

    # Send shutdown signal to all workers
    for worker_id, request_queue in self.request_queues.items():
      try:
        request_queue.put(WorkerMessage.shutdown().to_dict())
      except Exception as e:
        logger.warning(f"Error sending shutdown to worker {worker_id}: {e}")

    # Wait for workers to exit
    for worker_id, process in self.workers.items():
      process.join(timeout=timeout)
      if process.is_alive():
        logger.warning(f"Worker {worker_id} did not exit gracefully, terminating")
        process.terminate()
        process.join(timeout=2)

    # Cleanup
    self.workers.clear()
    self.request_queues.clear()
    self.pending_jobs.clear()

    logger.info("Worker pool shutdown complete")

  @property
  def active_crawls(self) -> int:
    """Number of crawls currently in progress."""
    return len(self.pending_jobs)

  @property
  def available_worker_count(self) -> int:
    """Number of workers available for new crawls."""
    return self.available_workers.qsize()


# Global pool instance (lazy initialized)
_pool: Optional[ScrapyWorkerPool] = None
_pool_lock: asyncio.Lock | None = None


def _get_pool_lock() -> asyncio.Lock:
  """Get or create the pool lock (must be called from async context)."""
  global _pool_lock
  if _pool_lock is None:
    _pool_lock = asyncio.Lock()
  return _pool_lock


async def get_worker_pool() -> ScrapyWorkerPool:
  """
  Get the global worker pool instance.

  Creates and starts the pool if it doesn't exist.
  Thread-safe via asyncio lock to prevent race conditions during startup.
  """
  global _pool

  async with _get_pool_lock():
    if _pool is None:
      _pool = ScrapyWorkerPool()
      await _pool.start()

  return _pool


async def shutdown_worker_pool():
  """Shutdown the global worker pool."""
  global _pool

  async with _get_pool_lock():
    if _pool is not None:
      await _pool.shutdown()
      _pool = None
