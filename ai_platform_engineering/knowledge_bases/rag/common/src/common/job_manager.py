import json
from enum import Enum
from typing import Any, Dict, List, Optional
import redis.asyncio as redis
from common.notifications_client import build_event, schedule_publish
from common.utils import get_logger
import time
from pydantic import BaseModel, Field
from common.constants import (
  REDIS_JOB_PREFIX,
  REDIS_JOB_DATASOURCE_INDEX_PREFIX,
  REDIS_JOB_ERRORS_SUFFIX,
  REDIS_JOB_DATASOURCE_TOUCHED_PREFIX,
  REDIS_DATASOURCE_PREFIX,
)

logger = get_logger(__name__)


class JobStatus(str, Enum):
  PENDING = "pending"
  IN_PROGRESS = "in_progress"
  COMPLETED = "completed"
  COMPLETED_WITH_ERRORS = "completed_with_errors"
  TERMINATED = "terminated"
  FAILED = "failed"


TERMINAL_STATUSES = frozenset({JobStatus.COMPLETED, JobStatus.COMPLETED_WITH_ERRORS, JobStatus.FAILED, JobStatus.TERMINATED})
MAX_NOTIFICATION_RECIPIENTS = 50


def _text(value: Any) -> Optional[str]:
  """Decode a Redis value (bytes or str) to a non-empty string, else None."""
  if isinstance(value, bytes):
    value = value.decode()
  return value if isinstance(value, str) and value else None


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
  triggered_by_subject: Optional[str] = Field(description="Keycloak subject of the user who created the job (None for scheduled/reload/service jobs)", default=None)
  triggered_by_email: Optional[str] = Field(description="Email of the user who created the job (None for scheduled/reload/service jobs)", default=None)


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
    triggered_by_subject: Optional[str] = None,
    triggered_by_email: Optional[str] = None,
  ) -> bool:
    """
    Creates a new job or updates an existing job in Redis.

    Emits a notification event (fire-and-forget, never raises) on the transition
    into IN_PROGRESS or into a terminal state; other upserts emit nothing.

    :param job_id: The ID of the job to create or update.
    :param status: The status of the job (defaults to PENDING for new jobs).
    :param message: The message for the job.
    :param total: The total number of items to process.
    :param datasource_id: The datasource ID associated with this job.
    :param triggered_by_subject: Subject of the human who created/edited the job (recorded as having "touched" the datasource).
    :param triggered_by_email: Email of that human.
    :return: True if the operation was successful, False if job is terminated and cannot be updated.
    """
    job_key = self._get_job_key(job_id)
    previous_status: Optional[str] = None

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
      if triggered_by_subject:
        hash_data["triggered_by_subject"] = triggered_by_subject
      if triggered_by_email:
        hash_data["triggered_by_email"] = triggered_by_email

      # Save as hash (no TTL - jobs are managed via max_jobs_per_datasource limit)
      await self.redis_client.hset(job_key, mapping=hash_data)  # type: ignore

      # Add to datasource index if datasource_id provided
      if datasource_id is not None:
        index_key = self._get_datasource_index_key(datasource_id)
        await self.redis_client.sadd(index_key, job_id)  # type: ignore

        # Cleanup old jobs if limit exceeded
        await self._cleanup_old_jobs_for_datasource(datasource_id)

      logger.debug(f"Successfully created job {job_id}")
      await self._after_write(job_id, datasource_id, None, status or JobStatus.PENDING, triggered_by_subject, triggered_by_email)
      return True
    else:
      # Job exists, check if it's terminated
      job_status = await self.redis_client.hget(job_key, "status")  # type: ignore
      if job_status == JobStatus.TERMINATED.value and status != JobStatus.TERMINATED:
        logger.warning(f"Cannot update job {job_id} - job is terminated")
        return False
      previous_status = _text(job_status)

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

      if triggered_by_subject and not _text(await self.redis_client.hget(job_key, "triggered_by_subject")):  # type: ignore
        updates["triggered_by_subject"] = triggered_by_subject
        if triggered_by_email:
          updates["triggered_by_email"] = triggered_by_email

      if not updates:
        logger.debug(f"upsert_job called for job {job_id} with no fields to update")
        await self._after_write(job_id, datasource_id, previous_status, None, triggered_by_subject, triggered_by_email)
        return True

      # Apply updates to hash
      await self.redis_client.hset(job_key, mapping=updates)  # type: ignore

      logger.debug(f"Successfully updated job {job_id} with: {updates}")
      await self._after_write(job_id, datasource_id, previous_status, status, triggered_by_subject, triggered_by_email)
      return True

  async def _after_write(
    self,
    job_id: str,
    datasource_id: Optional[str],
    previous_status: Optional[str],
    new_status: Optional[JobStatus],
    actor_subject: Optional[str],
    actor_email: Optional[str],
  ) -> None:
    """Record who touched the datasource and emit notifications on status transitions. Never raises."""
    try:
      if datasource_id is None:
        datasource_id = _text(await self.redis_client.hget(self._get_job_key(job_id), "datasource_id"))  # type: ignore
      if datasource_id and (actor_subject or actor_email):
        touch = {k: v for k, v in (("subject", actor_subject), ("email", actor_email)) if v}
        await self.redis_client.sadd(f"{REDIS_JOB_DATASOURCE_TOUCHED_PREFIX}{datasource_id}", json.dumps(touch, sort_keys=True))  # type: ignore
      if new_status is None or new_status.value == previous_status:
        return
      previous_terminal = previous_status in {s.value for s in TERMINAL_STATUSES}
      if new_status in TERMINAL_STATUSES and not previous_terminal:
        await self._emit_job_event(job_id, datasource_id, new_status)
      elif new_status == JobStatus.IN_PROGRESS and previous_status != JobStatus.IN_PROGRESS.value and not previous_terminal:
        await self._emit_job_event(job_id, datasource_id, new_status)
    except Exception as error:  # noqa: BLE001 - notifications must never affect job state
      logger.warning(f"Notification bookkeeping failed for job {job_id} datasource {datasource_id}: {error}")

  async def _notification_recipients(self, job_id: str, datasource_id: Optional[str], datasource_record: Dict[str, Any]) -> List[Dict[str, str]]:
    """Users who "touched" the datasource: its creator/owner, the job's trigger user, and anyone who created or edited a job for it."""
    candidates: List[Dict[str, str]] = []
    for field in ("creator_subject", "owner_subject"):
      subject = datasource_record.get(field)
      if isinstance(subject, str) and subject:
        candidates.append({"subject": subject})
    job_fields = await self.redis_client.hmget(self._get_job_key(job_id), ["triggered_by_subject", "triggered_by_email"])  # type: ignore
    triggered = {k: v for k, v in (("subject", _text(job_fields[0])), ("email", _text(job_fields[1]))) if v}
    if triggered:
      candidates.append(triggered)
    if datasource_id:
      for raw in await self.redis_client.smembers(f"{REDIS_JOB_DATASOURCE_TOUCHED_PREFIX}{datasource_id}"):  # type: ignore
        try:
          entry = json.loads(_text(raw) or "{}")
        except json.JSONDecodeError:
          logger.warning(f"Ignoring malformed touched-user entry for datasource {datasource_id}")
          continue
        if isinstance(entry, dict) and (entry.get("subject") or entry.get("email")):
          candidates.append({k: entry[k] for k in ("subject", "email") if isinstance(entry.get(k), str) and entry[k]})
    # Merge entries that share a subject or email so one person is one recipient.
    merged: List[Dict[str, str]] = []
    for candidate in candidates:
      match = next(
        (m for m in merged if (candidate.get("subject") and candidate.get("subject") == m.get("subject")) or (candidate.get("email") and candidate["email"].lower() == m.get("email", "").lower())),
        None,
      )
      if match is None:
        merged.append(dict(candidate))
      else:
        for key, value in candidate.items():
          match.setdefault(key, value)
    return merged[:MAX_NOTIFICATION_RECIPIENTS]

  async def _emit_job_event(self, job_id: str, datasource_id: Optional[str], new_status: JobStatus) -> None:
    """Build and schedule the ingestion.* event for a status transition."""
    datasource_record: Dict[str, Any] = {}
    if datasource_id:
      raw = _text(await self.redis_client.get(f"{REDIS_DATASOURCE_PREFIX}{datasource_id}"))  # type: ignore
      if raw:
        try:
          parsed = json.loads(raw)
          if isinstance(parsed, dict):
            datasource_record = parsed
        except json.JSONDecodeError:
          logger.warning(f"Datasource record for {datasource_id} is not valid JSON; notifying with id only")
    name = _text(datasource_record.get("name")) or datasource_id or job_id
    counters = await self.redis_client.hmget(self._get_job_key(job_id), ["document_count", "chunk_count", "failed_counter"])  # type: ignore
    documents, chunks, failed = (int(_text(v) or 0) for v in counters)
    if new_status == JobStatus.IN_PROGRESS:
      event_type, title, summary = "ingestion.started", f"Ingestion started: {name}", "Ingestion has started."
    elif new_status == JobStatus.FAILED:
      event_type, title, summary = "ingestion.failed", f"Ingestion failed: {name}", f"Ingestion failed after {documents} documents and {chunks} chunks."
    elif new_status == JobStatus.TERMINATED:
      event_type, title, summary = "ingestion.failed", f"Ingestion stopped: {name}", f"Ingestion was terminated after {documents} documents and {chunks} chunks."
    else:
      suffix = f" with {failed} failed items" if new_status == JobStatus.COMPLETED_WITH_ERRORS else ""
      event_type, title, summary = "ingestion.completed", f"Ingestion completed: {name}", f"Ingested {documents} documents and {chunks} chunks{suffix}."
    # Summary carries counts only: never job messages or error text, which may include document content or secrets.
    recipients = await self._notification_recipients(job_id, datasource_id, datasource_record)
    event = build_event(
      event_type=event_type,
      resource_type="datasource",
      resource_id=datasource_id or job_id,
      attempt_id=job_id,
      correlation_id=datasource_id,
      status=new_status.value,
      title=title,
      summary=summary,
      recipients=recipients,
      href="/knowledge-bases/ingest",
      include_org_admins=True,
    )
    schedule_publish(event)

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
      "triggered_by_subject": _text(hash_data.get(b"triggered_by_subject", hash_data.get("triggered_by_subject"))),
      "triggered_by_email": _text(hash_data.get(b"triggered_by_email", hash_data.get("triggered_by_email"))),
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
