from enum import Enum
from typing import Dict, List, Optional
import redis.asyncio as redis
from common.utils import get_logger
import time
from pydantic import BaseModel, Field
from common.constants import (
  REDIS_JOB_PREFIX,
  REDIS_JOB_DATASOURCE_INDEX_PREFIX,
  REDIS_JOB_ERRORS_SUFFIX,
)

logger = get_logger(__name__)


class JobStatus(str, Enum):
  PENDING = "pending"
  IN_PROGRESS = "in_progress"
  COMPLETED = "completed"
  COMPLETED_WITH_ERRORS = "completed_with_errors"
  TERMINATED = "terminated"
  FAILED = "failed"


class JobInfo(BaseModel):
  job_id: str = Field(description="Job ID")
  status: JobStatus = Field(description="Job status")
  message: Optional[str] = Field(description="Current message", default=None)
  created_at: int = Field(description="Created at")
  completed_at: Optional[int] = Field(description="Completed at", default=None)
  total: Optional[int] = Field(description="Total items to process", default=None)
  progress_counter: Optional[int] = Field(description="Number of items processed", default=0)
  failed_counter: Optional[int] = Field(description="Number of items failed", default=0)
  error_msgs: Optional[List[str]] = Field(description="Error messages if any", default_factory=list)
  datasource_id: Optional[str] = Field(description="Associated datasource ID", default=None)
  document_count: Optional[int] = Field(description="Number of documents ingested", default=0)
  chunk_count: Optional[int] = Field(description="Number of chunks created", default=0)


# Ingestors dequeue their Redis list within ~1s (blpop timeout=1), so a job
# still PENDING well past that means the ingestor pod that should have
# dequeued it crashed, was scaled down, or never started - not that ingestion
# is genuinely still queued.
DEFAULT_STALE_PENDING_JOB_SECONDS = 15 * 60


def is_stale_pending_job(job: JobInfo, max_age_seconds: int = DEFAULT_STALE_PENDING_JOB_SECONDS) -> bool:
  """Returns True if a PENDING job has been abandoned by its ingestor rather than genuinely still queued."""
  if job.status != JobStatus.PENDING:
    return False
  return int(time.time()) - job.created_at > max_age_seconds


class JobManager:
  """Manages job status updates in Redis using atomic operations."""

  def __init__(self, redis_client: redis.Redis, max_jobs_per_datasource: int = 10):
    """
    Initializes the JobManager with a Redis client.

    :param redis_client: An asynchronous Redis client instance.
    :param max_jobs_per_datasource: Maximum number of jobs to keep per datasource (default: 10).
    """
    self.redis_client = redis_client
    self.max_jobs_per_datasource = max_jobs_per_datasource

  def _get_job_key(self, job_id: str) -> str:
    """Constructs the Redis key for storing job information (hash)."""
    return f"{REDIS_JOB_PREFIX}{job_id}"

  def _get_error_msgs_key(self, job_id: str) -> str:
    """Constructs the Redis key for error messages list."""
    return f"{REDIS_JOB_PREFIX}{job_id}{REDIS_JOB_ERRORS_SUFFIX}"

  def _get_datasource_index_key(self, datasource_id: str) -> str:
    """Constructs the Redis key for datasource->job_id index."""
    return f"{REDIS_JOB_DATASOURCE_INDEX_PREFIX}{datasource_id}"

  async def _cleanup_old_jobs_for_datasource(self, datasource_id: str) -> int:
    """
    Removes oldest jobs for a datasource if the count exceeds max_jobs_per_datasource.

    :param datasource_id: The datasource ID to cleanup jobs for.
    :return: Number of jobs deleted.
    """
    index_key = self._get_datasource_index_key(datasource_id)
    job_ids = await self.redis_client.smembers(index_key)  # type: ignore

    if not job_ids or len(job_ids) <= self.max_jobs_per_datasource:
      return 0

    # Fetch creation times for all jobs
    jobs_with_times = []
    for job_id in job_ids:
      if isinstance(job_id, bytes):
        job_id = job_id.decode()

      job_key = self._get_job_key(job_id)
      created_at = await self.redis_client.hget(job_key, "created_at")  # type: ignore

      if created_at:
        if isinstance(created_at, bytes):
          created_at = created_at.decode()
        jobs_with_times.append((job_id, int(created_at)))

    # Sort by creation time (oldest first)
    jobs_with_times.sort(key=lambda x: x[1])

    # Calculate how many to delete
    num_to_delete = len(jobs_with_times) - self.max_jobs_per_datasource

    if num_to_delete <= 0:
      return 0

    # Delete oldest jobs
    deleted_count = 0
    for job_id, _ in jobs_with_times[:num_to_delete]:
      if await self.delete_job(job_id):
        deleted_count += 1
        logger.info(f"Deleted old job {job_id} from datasource {datasource_id} (cleanup)")

    return deleted_count

  async def upsert_job(
    self,
    job_id: str,
    *,
    status: Optional[JobStatus] = None,
    message: Optional[str] = None,
    total: Optional[int] = None,
    datasource_id: Optional[str] = None,
  ) -> bool:
    """
    Creates a new job or updates an existing job in Redis.

    :param job_id: The ID of the job to create or update.
    :param status: The status of the job (defaults to PENDING for new jobs).
    :param message: The message for the job.
    :param total: The total number of items to process.
    :param datasource_id: The datasource ID associated with this job.
    :return: True if the operation was successful, False if job is terminated and cannot be updated.
    """
    job_key = self._get_job_key(job_id)

    # Check if job exists
    exists = await self.redis_client.exists(job_key)

    if not exists:
      # Job doesn't exist, create a new one
      hash_data = {
        "job_id": job_id,
        "status": status.value if status is not None else JobStatus.PENDING.value,
        "created_at": str(int(time.time())),
        "progress_counter": "0",
        "failed_counter": "0",
        "document_count": "0",
        "chunk_count": "0",
      }

      if message is not None:
        hash_data["message"] = message
      if total is not None:
        hash_data["total"] = str(total)
      if datasource_id is not None:
        hash_data["datasource_id"] = datasource_id

      # Save as hash (no TTL - jobs are managed via max_jobs_per_datasource limit)
      await self.redis_client.hset(job_key, mapping=hash_data)  # type: ignore

      # Add to datasource index if datasource_id provided
      if datasource_id is not None:
        index_key = self._get_datasource_index_key(datasource_id)
        await self.redis_client.sadd(index_key, job_id)  # type: ignore

        # Cleanup old jobs if limit exceeded
        await self._cleanup_old_jobs_for_datasource(datasource_id)

      logger.debug(f"Successfully created job {job_id}")
      return True
    else:
      # Job exists, check if it's terminated
      job_status = await self.redis_client.hget(job_key, "status")  # type: ignore
      if job_status == JobStatus.TERMINATED.value and status != JobStatus.TERMINATED:
        logger.warning(f"Cannot update job {job_id} - job is terminated")
        return False

      # Prepare updates
      updates = {}
      if status is not None:
        updates["status"] = status.value
      if message is not None:
        updates["message"] = message
      if total is not None:
        updates["total"] = str(total)
      if datasource_id is not None:
        updates["datasource_id"] = datasource_id
        # Update datasource index
        old_datasource_id = await self.redis_client.hget(job_key, "datasource_id")  # type: ignore
        if old_datasource_id and old_datasource_id != datasource_id:
          # Remove from old index
          await self.redis_client.srem(self._get_datasource_index_key(old_datasource_id), job_id)  # type: ignore
        # Add to new index
        index_key = self._get_datasource_index_key(datasource_id)
        await self.redis_client.sadd(index_key, job_id)  # type: ignore

      # Set completed_at if job is completing
      if status is not None and status in [JobStatus.COMPLETED, JobStatus.COMPLETED_WITH_ERRORS, JobStatus.FAILED, JobStatus.TERMINATED]:
        updates["completed_at"] = str(int(time.time()))

      if not updates:
        logger.debug(f"upsert_job called for job {job_id} with no fields to update")
        return True

      # Apply updates to hash
      await self.redis_client.hset(job_key, mapping=updates)  # type: ignore

      logger.debug(f"Successfully updated job {job_id} with: {updates}")
      return True

  async def increment_progress(self, job_id: str, increment: int = 1) -> int:
    """
    Atomically increments the progress counter for a job.

    :param job_id: The ID of the job.
    :param increment: The amount to increment by (default: 1).
    :return: The new progress counter value, or -1 if job is terminated.
    """
    job_key = self._get_job_key(job_id)

    # Check if job is terminated
    job_status = await self.redis_client.hget(job_key, "status")  # type: ignore
    if job_status == JobStatus.TERMINATED.value:
      logger.warning(f"Cannot increment progress for job {job_id} - job is terminated")
      return -1

    # Use HINCRBY for atomic increment on hash field
    new_value = await self.redis_client.hincrby(job_key, "progress_counter", increment)  # type: ignore
    logger.debug(f"Incremented progress for job {job_id} by {increment}, new value: {new_value}")
    return new_value

  async def increment_failure(self, job_id: str, increment: int = 1, message: str = "") -> int:
    """
    Atomically increments the failure counter for a job.

    :param job_id: The ID of the job.
    :param increment: The amount to increment by (default: 1).
    :param message: An optional error message to add.
    :return: The new failure counter value, or -1 if job is terminated.
    """
    job_key = self._get_job_key(job_id)

    # Check if job is terminated
    job_status = await self.redis_client.hget(job_key, "status")  # type: ignore
    if job_status == JobStatus.TERMINATED.value:
      logger.warning(f"Cannot increment failure for job {job_id} - job is terminated")
      return -1

    if message:
      await self.add_error_msg(job_id, message)

    # Use HINCRBY for atomic increment on hash field
    new_value = await self.redis_client.hincrby(job_key, "failed_counter", increment)  # type: ignore
    logger.debug(f"Incremented failure counter for job {job_id} by {increment}, new value: {new_value}")
    return new_value

  async def increment_document_count(self, job_id: str, increment: int = 1) -> int:
    """
    Atomically increments the document count for a job.

    :param job_id: The ID of the job.
    :param increment: The amount to increment by (default: 1).
    :return: The new document count value, or -1 if job is terminated.
    """
    job_key = self._get_job_key(job_id)

    # Check if job is terminated
    job_status = await self.redis_client.hget(job_key, "status")  # type: ignore
    if job_status == JobStatus.TERMINATED.value:
      logger.warning(f"Cannot increment document count for job {job_id} - job is terminated")
      return -1

    # Use HINCRBY for atomic increment on hash field
    new_value = await self.redis_client.hincrby(job_key, "document_count", increment)  # type: ignore
    logger.debug(f"Incremented document count for job {job_id} by {increment}, new value: {new_value}")
    return new_value

  async def increment_chunk_count(self, job_id: str, increment: int = 1) -> int:
    """
    Atomically increments the chunk count for a job.

    :param job_id: The ID of the job.
    :param increment: The amount to increment by (default: 1).
    :return: The new chunk count value, or -1 if job is terminated.
    """
    job_key = self._get_job_key(job_id)

    # Check if job is terminated
    job_status = await self.redis_client.hget(job_key, "status")  # type: ignore
    if job_status == JobStatus.TERMINATED.value:
      logger.warning(f"Cannot increment chunk count for job {job_id} - job is terminated")
      return -1

    # Use HINCRBY for atomic increment on hash field
    new_value = await self.redis_client.hincrby(job_key, "chunk_count", increment)  # type: ignore
    logger.debug(f"Incremented chunk count for job {job_id} by {increment}, new value: {new_value}")
    return new_value

  async def add_error_msg(self, job_id: str, error_msg: str) -> int:
    """
    Adds an error message to the job's error list.

    :param job_id: The ID of the job.
    :param error_msg: The error message to add.
    :return: The new length of the error messages list, or -1 if job is terminated.
    """
    job_key = self._get_job_key(job_id)

    # Check if job is terminated
    job_status = await self.redis_client.hget(job_key, "status")  # type: ignore
    if job_status == JobStatus.TERMINATED.value:
      logger.warning(f"Cannot add error message to job {job_id} - job is terminated")
      return -1

    error_msgs_key = self._get_error_msgs_key(job_id)
    new_length = await self.redis_client.rpush(error_msgs_key, error_msg)  # type: ignore

    logger.debug(f"Added error message to job {job_id}, new list length: {new_length}")
    return new_length  # type: ignore

  async def fail_stale_pending_job(self, job_id: str) -> bool:
    """
    Marks an abandoned PENDING job as FAILED so it stops blocking retries for its datasource.

    :param job_id: The ID of the job to fail.
    :return: True if the job was updated.
    """
    # Compare-and-set in Redis: the worker may move PENDING -> IN_PROGRESS
    # between the guard's read and this write. Never overwrite that progress.
    script = """
      if redis.call('HGET', KEYS[1], 'status') == ARGV[1] then
        redis.call('HSET', KEYS[1],
          'status', ARGV[2],
          'message', ARGV[3],
          'completed_at', ARGV[4])
        return 1
      end
      return 0
    """
    changed = await self.redis_client.eval(
      script,
      1,
      self._get_job_key(job_id),
      JobStatus.PENDING.value,
      JobStatus.FAILED.value,
      "No ingestor picked up this job before it went stale; marked as failed.",
      str(int(time.time())),
    )
    success = bool(changed)
    if success:
      logger.warning(f"Marked stale pending job {job_id} as FAILED")
    return success

  async def terminate_job(self, job_id: str) -> bool:
    """
    Marks a job as terminated.

    :param job_id: The ID of the job to terminate.
    :return: True if the termination flag was set successfully.
    """
    # Update the job status to terminated
    await self.upsert_job(job_id, status=JobStatus.TERMINATED)

    logger.debug(f"Terminated job {job_id}")
    return True

  async def is_job_terminated(self, job_id: str) -> bool:
    """
    Checks if a job is terminated.

    :param job_id: The ID of the job to check.
    :return: True if the job is terminated, False otherwise.
    """
    job_key = self._get_job_key(job_id)
    job_status = await self.redis_client.hget(job_key, "status")  # type: ignore
    return job_status == JobStatus.TERMINATED.value if job_status else False

  async def get_job(self, job_id: str) -> Optional[JobInfo]:
    """
    Retrieves a job's information from Redis, including counters and error messages.

    :param job_id: The ID of the job to retrieve.
    :return: JobInfo object if job exists, None otherwise.
    """
    job_key = self._get_job_key(job_id)

    # Get all hash fields and error messages in parallel
    pipeline = self.redis_client.pipeline()
    pipeline.hgetall(job_key)
    pipeline.lrange(self._get_error_msgs_key(job_id), 0, -1)
    results = await pipeline.execute()

    hash_data = results[0]
    error_msgs = results[1]

    if not hash_data:
      return None

    # Convert hash data to JobInfo
    job_dict = {
      "job_id": hash_data.get(b"job_id", b"").decode() if isinstance(hash_data.get(b"job_id"), bytes) else hash_data.get("job_id", ""),
      "status": hash_data.get(b"status", b"").decode() if isinstance(hash_data.get(b"status"), bytes) else hash_data.get("status", ""),
      "message": hash_data.get(b"message", b"").decode() if isinstance(hash_data.get(b"message"), bytes) else hash_data.get("message") if hash_data.get("message") or hash_data.get(b"message") else None,
      "created_at": int(hash_data.get(b"created_at", b"0").decode() if isinstance(hash_data.get(b"created_at"), bytes) else hash_data.get("created_at", "0")),
      "completed_at": int(hash_data.get(b"completed_at", b"0").decode() if isinstance(hash_data.get(b"completed_at"), bytes) else hash_data.get("completed_at", "0")) if hash_data.get("completed_at") or hash_data.get(b"completed_at") else None,
      "total": int(hash_data.get(b"total", b"0").decode() if isinstance(hash_data.get(b"total"), bytes) else hash_data.get("total", "0")) if hash_data.get("total") or hash_data.get(b"total") else None,
      "progress_counter": int(hash_data.get(b"progress_counter", b"0").decode() if isinstance(hash_data.get(b"progress_counter"), bytes) else hash_data.get("progress_counter", "0")),
      "failed_counter": int(hash_data.get(b"failed_counter", b"0").decode() if isinstance(hash_data.get(b"failed_counter"), bytes) else hash_data.get("failed_counter", "0")),
      "datasource_id": hash_data.get(b"datasource_id", b"").decode() if isinstance(hash_data.get(b"datasource_id"), bytes) else hash_data.get("datasource_id") if hash_data.get("datasource_id") or hash_data.get(b"datasource_id") else None,
      "document_count": int(hash_data.get(b"document_count", b"0").decode() if isinstance(hash_data.get(b"document_count"), bytes) else hash_data.get("document_count", "0")),
      "chunk_count": int(hash_data.get(b"chunk_count", b"0").decode() if isinstance(hash_data.get(b"chunk_count"), bytes) else hash_data.get("chunk_count", "0")),
      "error_msgs": error_msgs if error_msgs else [],
    }

    job_info = JobInfo(**job_dict)
    return job_info

  async def get_jobs_by_datasource(self, datasource_id: str, status_filter: Optional[JobStatus] = None) -> Optional[List[JobInfo]]:
    """
    Retrieves jobs associated with a specific datasource. Sorted by creation time descending (latest first).

    :param datasource_id: The datasource ID to search for.
    :param status_filter: Optional status to filter by (e.g., JobStatus.IN_PROGRESS).
    :return: List of JobInfo objects if found, None otherwise.
    """
    # Use datasource index for O(1) lookup
    index_key = self._get_datasource_index_key(datasource_id)
    job_ids = await self.redis_client.smembers(index_key)  # type: ignore

    if not job_ids:
      return None

    # Fetch all jobs in parallel using pipeline
    matching_jobs = []

    for job_id in job_ids:
      # Decode job_id if it's bytes
      if isinstance(job_id, bytes):
        job_id = job_id.decode()

      job_info = await self.get_job(job_id)
      if job_info:
        # Apply status filter if provided
        if status_filter is None or job_info.status == status_filter:
          matching_jobs.append(job_info)

    # Sort by created_at descending (most recent first)
    if matching_jobs:
      matching_jobs.sort(key=lambda j: j.created_at, reverse=True)
      return matching_jobs

    return None

  async def get_jobs_batch(
    self,
    datasource_ids: List[str],
    status_filter: Optional[List[JobStatus]] = None,
  ) -> Dict[str, List[JobInfo]]:
    """
    Retrieves jobs for multiple datasources in a single batch operation.
    Uses Redis pipelines for efficient fetching.

    :param datasource_ids: List of datasource IDs to fetch jobs for.
    :param status_filter: Optional list of statuses to filter by (e.g., [JobStatus.IN_PROGRESS, JobStatus.PENDING]).
    :return: Dict mapping datasource_id to list of JobInfo objects.
    """
    if not datasource_ids:
      return {}

    result: Dict[str, List[JobInfo]] = {}

    # Step 1: Fetch all job IDs for all datasources using pipeline
    pipeline = self.redis_client.pipeline()
    for datasource_id in datasource_ids:
      index_key = self._get_datasource_index_key(datasource_id)
      pipeline.smembers(index_key)

    index_results = await pipeline.execute()

    # Build a mapping of datasource_id -> job_ids and collect all unique job_ids
    datasource_job_ids: Dict[str, List[str]] = {}
    all_job_ids: List[str] = []

    for i, datasource_id in enumerate(datasource_ids):
      job_ids = index_results[i]
      if job_ids:
        decoded_ids = [jid.decode() if isinstance(jid, bytes) else jid for jid in job_ids]
        datasource_job_ids[datasource_id] = decoded_ids
        all_job_ids.extend(decoded_ids)
      else:
        datasource_job_ids[datasource_id] = []

    if not all_job_ids:
      # No jobs found for any datasource
      return {ds_id: [] for ds_id in datasource_ids}

    # Step 2: Fetch all job data and error messages using pipeline
    # Remove duplicates while preserving ability to map back
    unique_job_ids = list(set(all_job_ids))

    pipeline = self.redis_client.pipeline()
    for job_id in unique_job_ids:
      job_key = self._get_job_key(job_id)
      pipeline.hgetall(job_key)
      pipeline.lrange(self._get_error_msgs_key(job_id), 0, -1)

    job_results = await pipeline.execute()

    # Parse job data into JobInfo objects, keyed by job_id
    job_info_map: Dict[str, JobInfo] = {}
    for i, job_id in enumerate(unique_job_ids):
      hash_data = job_results[i * 2]
      error_msgs = job_results[i * 2 + 1]

      if not hash_data:
        continue

      # Convert hash data to JobInfo (same logic as get_job)
      job_dict = {
        "job_id": hash_data.get(b"job_id", b"").decode() if isinstance(hash_data.get(b"job_id"), bytes) else hash_data.get("job_id", ""),
        "status": hash_data.get(b"status", b"").decode() if isinstance(hash_data.get(b"status"), bytes) else hash_data.get("status", ""),
        "message": hash_data.get(b"message", b"").decode() if isinstance(hash_data.get(b"message"), bytes) else hash_data.get("message") if hash_data.get("message") or hash_data.get(b"message") else None,
        "created_at": int(hash_data.get(b"created_at", b"0").decode() if isinstance(hash_data.get(b"created_at"), bytes) else hash_data.get("created_at", "0")),
        "completed_at": int(hash_data.get(b"completed_at", b"0").decode() if isinstance(hash_data.get(b"completed_at"), bytes) else hash_data.get("completed_at", "0")) if hash_data.get("completed_at") or hash_data.get(b"completed_at") else None,
        "total": int(hash_data.get(b"total", b"0").decode() if isinstance(hash_data.get(b"total"), bytes) else hash_data.get("total", "0")) if hash_data.get("total") or hash_data.get(b"total") else None,
        "progress_counter": int(hash_data.get(b"progress_counter", b"0").decode() if isinstance(hash_data.get(b"progress_counter"), bytes) else hash_data.get("progress_counter", "0")),
        "failed_counter": int(hash_data.get(b"failed_counter", b"0").decode() if isinstance(hash_data.get(b"failed_counter"), bytes) else hash_data.get("failed_counter", "0")),
        "datasource_id": hash_data.get(b"datasource_id", b"").decode() if isinstance(hash_data.get(b"datasource_id"), bytes) else hash_data.get("datasource_id") if hash_data.get("datasource_id") or hash_data.get(b"datasource_id") else None,
        "document_count": int(hash_data.get(b"document_count", b"0").decode() if isinstance(hash_data.get(b"document_count"), bytes) else hash_data.get("document_count", "0")),
        "chunk_count": int(hash_data.get(b"chunk_count", b"0").decode() if isinstance(hash_data.get(b"chunk_count"), bytes) else hash_data.get("chunk_count", "0")),
        "error_msgs": [msg.decode() if isinstance(msg, bytes) else msg for msg in error_msgs] if error_msgs else [],
      }

      try:
        job_info = JobInfo(**job_dict)

        # Apply status filter if provided
        if status_filter is None or job_info.status in status_filter:
          job_info_map[job_id] = job_info
      except Exception as e:
        logger.warning(f"Failed to parse job {job_id}: {e}")
        continue

    # Step 3: Group jobs by datasource_id and sort
    for datasource_id in datasource_ids:
      job_ids_for_ds = datasource_job_ids.get(datasource_id, [])
      jobs_for_ds = [job_info_map[jid] for jid in job_ids_for_ds if jid in job_info_map]
      # Sort by created_at descending (most recent first)
      jobs_for_ds.sort(key=lambda j: j.created_at, reverse=True)
      result[datasource_id] = jobs_for_ds

    return result

  async def delete_job(self, job_id: str) -> bool:
    """
    Deletes a job and all its associated data from Redis.

    :param job_id: The ID of the job to delete.
    :return: True if the job was deleted successfully.
    """
    job_key = self._get_job_key(job_id)

    # Get datasource_id to remove from index
    datasource_id = await self.redis_client.hget(job_key, "datasource_id")  # type: ignore

    keys_to_delete = [
      job_key,
      self._get_error_msgs_key(job_id),
    ]

    # Remove from datasource index
    if datasource_id:
      if isinstance(datasource_id, bytes):
        datasource_id = datasource_id.decode()
      await self.redis_client.srem(self._get_datasource_index_key(datasource_id), job_id)  # type: ignore

    deleted_count = await self.redis_client.delete(*keys_to_delete)
    logger.debug(f"Deleted job {job_id}, removed {deleted_count} keys")
    return deleted_count > 0
