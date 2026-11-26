from enum import Enum
from typing import Dict, List, Optional
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from common.mongo_storage import CURRENT_CLAIM, MongoStorage, utcnow, live_filter
from common.utils import get_logger
import time
from pydantic import BaseModel, Field

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


DEFAULT_STALE_PENDING_JOB_SECONDS = 15 * 60


def is_stale_pending_job(job: JobInfo, max_age_seconds: int = DEFAULT_STALE_PENDING_JOB_SECONDS) -> bool:
  """Identify pending jobs whose command was never picked up."""
  return job.status == JobStatus.PENDING and int(time.time()) - job.created_at > max_age_seconds


class JobManager:
  """Atomically maintain job state and counters in MongoDB."""

  def __init__(self, redis_client: MongoStorage | None = None, max_jobs_per_datasource: int = 10, *, storage: MongoStorage | None = None) -> None:
    self.storage = storage or redis_client or MongoStorage()
    self.jobs = self.storage.db.rag_jobs
    self.errors = self.storage.db.rag_job_errors
    self.max_jobs_per_datasource = max_jobs_per_datasource

  def _write_filter(self, job_id: str) -> dict:
    query: dict = {"_id": job_id, "status": {"$ne": JobStatus.TERMINATED.value}, **live_filter()}
    claim = CURRENT_CLAIM.get()
    if claim:
      query.update(claim_token=claim["token"], claim_until={"$gt": utcnow()}, datasource_id=claim["_id"])
    else:
      query["claim_token"] = {"$exists": False}
    return query

  async def _cleanup_old_jobs_for_datasource(self, datasource_id: str) -> int:
    old = [record["_id"] async for record in self.jobs.find({"datasource_id": datasource_id}).sort([("created_at", -1), ("_id", -1)]).skip(self.max_jobs_per_datasource)]
    # Active jobs survive history cleanup so an overlapping enqueue cannot
    # erase the current worker's counters or completion state.
    inactive = [record["_id"] async for record in self.jobs.find({"_id": {"$in": old}, "status": {"$nin": ["pending", "in_progress"]}})]
    if inactive:
      await self.errors.delete_many({"job_id": {"$in": inactive}})
      return (await self.jobs.delete_many({"_id": {"$in": inactive}})).deleted_count
    return 0

  async def upsert_job(self, job_id: str, *, status: Optional[JobStatus] = None, message: Optional[str] = None, total: Optional[int] = None, datasource_id: Optional[str] = None) -> bool:
    updates = {key: value for key, value in {"status": status.value if status else None, "message": message, "total": total, "datasource_id": datasource_id}.items() if value is not None}
    if status in {JobStatus.COMPLETED, JobStatus.COMPLETED_WITH_ERRORS, JobStatus.FAILED, JobStatus.TERMINATED}:
      updates["completed_at"] = int(time.time())
    record = await self.jobs.find_one({"_id": job_id, **live_filter()})
    if record:
      query = self._write_filter(job_id)
      if status == JobStatus.TERMINATED:
        query = {"_id": job_id}
      if not updates:
        return bool(await self.jobs.find_one(query))
      changed = await self.jobs.update_one(query, {"$set": updates})
      return changed.matched_count == 1
    new = {"_id": job_id, "job_id": job_id, "status": "pending", "created_at": int(time.time()), "progress_counter": 0, "failed_counter": 0, "document_count": 0, "chunk_count": 0, "error_sequence": 0, **updates}
    claim = CURRENT_CLAIM.get()
    if claim:
      if datasource_id != claim["_id"]:
        raise RuntimeError("Job is not assigned to the claimed datasource")
      await self.storage.assert_claim(claim["_id"], claim["token"])
      current = await self.storage.db.rag_datasource_claims.find_one({"_id": claim["_id"], "token": claim["token"]})
      new.update(claim_token=claim["token"], claim_until=current["lease_until"])
    try:
      await self.jobs.insert_one(new)
    except DuplicateKeyError:
      # Expired documents can remain until the TTL monitor runs. A duplicate
      # insert must neither resurrect them nor retry recursively.
      if not updates:
        return bool(await self.jobs.find_one(self._write_filter(job_id)))
      changed = await self.jobs.update_one(self._write_filter(job_id), {"$set": updates})
      return changed.matched_count == 1
    if datasource_id:
      await self._cleanup_old_jobs_for_datasource(datasource_id)
    return True

  async def _increment(self, job_id: str, field: str, increment: int) -> int:
    record = await self.jobs.find_one_and_update(self._write_filter(job_id), {"$inc": {field: increment}}, return_document=ReturnDocument.AFTER)
    return record[field] if record else -1

  async def increment_progress(self, job_id: str, increment: int = 1) -> int:
    return await self._increment(job_id, "progress_counter", increment)

  async def increment_failure(self, job_id: str, increment: int = 1, message: str = "") -> int:
    count = await self._increment(job_id, "failed_counter", increment)
    if message and count != -1:
      await self.add_error_msg(job_id, message)
    return count

  async def increment_document_count(self, job_id: str, increment: int = 1) -> int:
    return await self._increment(job_id, "document_count", increment)

  async def increment_chunk_count(self, job_id: str, increment: int = 1) -> int:
    return await self._increment(job_id, "chunk_count", increment)

  async def add_error_msg(self, job_id: str, error_msg: str) -> int:
    record = await self.jobs.find_one_and_update(self._write_filter(job_id), {"$inc": {"error_sequence": 1}}, return_document=ReturnDocument.AFTER)
    if not record:
      return -1
    error = {"job_id": job_id, "sequence": record["error_sequence"], "message": error_msg}
    previous = await self.errors.find_one({"job_id": job_id, **live_filter()}, sort=[("sequence", 1)])
    expiry = previous.get("expires_at") if previous else record.get("expires_at")
    if expiry:
      error["expires_at"] = expiry
    await self.errors.insert_one(error)
    return record["error_sequence"]

  async def fail_stale_pending_job(self, job_id: str) -> bool:
    # A durable queued command remains valid during an ingestor outage.
    queued = await self.storage.db.rag_commands.find_one({"job_id": job_id, "state": "queued", **live_filter()})
    if queued:
      return False
    changed = await self.jobs.update_one(
      {"_id": job_id, "status": "pending", "created_at": {"$lt": int(time.time()) - DEFAULT_STALE_PENDING_JOB_SECONDS}},
      {"$set": {"status": "failed", "message": "No ingestor picked up this job before it went stale; marked as failed.", "completed_at": int(time.time())}},
    )
    return changed.modified_count == 1

  async def terminate_job(self, job_id: str) -> bool:
    return await self.upsert_job(job_id, status=JobStatus.TERMINATED)

  async def is_job_terminated(self, job_id: str) -> bool:
    return bool(await self.jobs.find_one({"_id": job_id, "status": "terminated"}))

  async def get_job(self, job_id: str) -> Optional[JobInfo]:
    record = await self.jobs.find_one({"_id": job_id, **live_filter()})
    if record is None:
      return None
    record["error_msgs"] = [error["message"] async for error in self.errors.find({"job_id": job_id, **live_filter()}).sort("sequence", 1)]
    return JobInfo(**record)

  async def get_jobs_by_datasource(self, datasource_id: str, status_filter: Optional[JobStatus] = None) -> Optional[List[JobInfo]]:
    result = await self.get_jobs_batch([datasource_id], [status_filter] if status_filter else None)
    return result[datasource_id] or None

  async def get_jobs_batch(self, datasource_ids: List[str], status_filter: Optional[List[JobStatus]] = None) -> Dict[str, List[JobInfo]]:
    result: Dict[str, List[JobInfo]] = {source: [] for source in datasource_ids}
    query: dict = {"datasource_id": {"$in": datasource_ids}, **live_filter()}
    if status_filter:
      query["status"] = {"$in": [status.value for status in status_filter]}
    records = [record async for record in self.jobs.find(query).sort([("created_at", -1), ("_id", -1)])]
    errors: dict[str, list[str]] = {}
    async for error in self.errors.find({"job_id": {"$in": [record["_id"] for record in records]}, **live_filter()}).sort("sequence", 1):
      errors.setdefault(error["job_id"], []).append(error["message"])
    for record in records:
      record["error_msgs"] = errors.get(record["_id"], [])
      result[record["datasource_id"]].append(JobInfo(**record))
    return result

  async def delete_job(self, job_id: str) -> bool:
    await self.errors.delete_many({"job_id": job_id})
    return (await self.jobs.delete_one({"_id": job_id})).deleted_count > 0
