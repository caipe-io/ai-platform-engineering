"""Shared MongoDB command listener for all RAG ingestors.

The RAG server addresses commands to a per-ingestor queue and includes the
exact job id it created. Type-specific modules only provide their request
models and ingestion/reload callbacks.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import traceback
from collections.abc import Awaitable, Callable, AsyncIterator
from typing import Any, Optional, Type

from pydantic import BaseModel
from contextlib import asynccontextmanager
from common.mongo_storage import MongoStorage, CURRENT_CLAIM, LEASE_SECONDS, IngestionLeaseLostError

from common.constants import MIN_RELOAD_INTERVAL, ingestor_request_queue
from common.ingestor import Client
from common.job_manager import JobManager, JobStatus, is_stale_pending_job
from common.models.rag import DataSourceInfo
from common.models.server import IngestorRequest
from common.utils import get_logger

logger = get_logger(__name__)

IngestHandler = Callable[[Client, JobManager, BaseModel, str], Awaitable[None]]
ReloadHandler = Callable[[Client, JobManager, DataSourceInfo, Optional[str]], Awaitable[None]]
ReloadAllHandler = Callable[[Client], Awaitable[None]]
LifecycleHandler = Callable[[], Awaitable[None]]
LabelHandler = Callable[[BaseModel], str]
PreviewHandler = Callable[[Client, BaseModel], Awaitable[dict[str, Any]]]


@asynccontextmanager
async def ingestion_claim(storage: MongoStorage, datasource_id: str | None, job_id: str | None = None, command: dict | None = None) -> AsyncIterator[bool]:
  """Fence every ingestion path and cancel workers whose lease cannot renew."""
  claim = await storage.acquire_datasource(datasource_id, job_id) if datasource_id else None
  if datasource_id and claim is None:
    yield False
    return
  context = CURRENT_CLAIM.set(claim)
  owner = asyncio.current_task()
  assert owner is not None
  lease_lost = False

  async def heartbeat() -> None:
    nonlocal lease_lost
    try:
      while True:
        await asyncio.sleep(LEASE_SECONDS / 3)
        if not await storage.renew(claim, command):
          lease_lost = True
          owner.cancel()
          return
    except asyncio.CancelledError:
      raise
    except Exception:
      logger.exception("Ingestion lease renewal failed")
      lease_lost = True
      owner.cancel()

  heartbeat_task = asyncio.create_task(heartbeat())
  try:
    yield True
  except asyncio.CancelledError as error:
    if lease_lost and owner.uncancel() == 0:
      raise IngestionLeaseLostError("Ingestion lease expired; retry explicitly") from error
    raise
  finally:
    heartbeat_task.cancel()
    await asyncio.gather(heartbeat_task, return_exceptions=True)
    CURRENT_CLAIM.reset(context)
    if claim:
      await storage.release_datasource(claim)


async def run_claimed_ingestion(
  storage: MongoStorage, datasource_id: str, operation: Callable[[], Awaitable[None]],
) -> bool:
  """Confine lease cancellation to one operation, preserving its scheduler."""
  async def run() -> bool:
    async with ingestion_claim(storage, datasource_id) as acquired:
      if acquired:
        await operation()
      return acquired
  return await asyncio.create_task(run())


async def run_standalone_ingestion(datasource_id: str, operation: Callable[[], Awaitable[None]]) -> bool:
  """Apply the shared datasource lease to a deployment-managed sync operation."""
  if os.getenv("RAG_WRITES_PAUSED", "false").lower() == "true":
    return False
  storage = MongoStorage()
  try:
    await storage.setup()
    try:
      return await run_claimed_ingestion(storage, datasource_id, operation)
    except IngestionLeaseLostError:
      logger.exception("Datasource ingestion lost its lease: %s", datasource_id)
      return False
  finally:
    await storage.aclose()


async def reload_persisted_datasources(
  client: Client,
  reload_handler: ReloadHandler,
  *,
  due_only: bool = True,
  job_manager: Optional[JobManager] = None,
) -> tuple[int, int]:
  """Reload datasource records assigned to this ingestor.

  Every periodic connector path enumerates the persisted RAG datasource store.
  This shared implementation honors per-source refresh intervals and avoids
  racing an on-demand job already using the datasource.

  Returns ``(reloaded, skipped)``. A failure for one datasource is isolated so
  the remaining sources still receive a refresh attempt.
  """
  if os.getenv("RAG_WRITES_PAUSED", "false").lower() == "true":
    return 0, 0
  owned_storage = None
  if job_manager is None:
    owned_storage = MongoStorage()
    await owned_storage.setup()
    job_manager = JobManager(storage=owned_storage)

  reloaded = 0
  skipped = 0
  now = int(time.time())

  try:
    try:
      datasources = await client.list_datasources(ingestor_id=client.ingestor_id)
    except Exception as error:
      logger.error(f"Failed to list persisted datasources: {error}")
      logger.error(traceback.format_exc())
      return 0, 0

    for datasource in datasources:
      try:
        if datasource.reload_interval < MIN_RELOAD_INTERVAL:
          logger.warning(
            f"Datasource {datasource.datasource_id} has reload_interval "
            f"{datasource.reload_interval}s below minimum "
            f"{MIN_RELOAD_INTERVAL}s; using the minimum"
          )
        reload_interval = max(datasource.reload_interval, MIN_RELOAD_INTERVAL)
        if due_only and datasource.last_updated is not None:
          age = now - datasource.last_updated
          if age < reload_interval:
            logger.debug(
              f"Skipping datasource {datasource.datasource_id}: last updated "
              f"{age}s ago, interval is {reload_interval}s"
            )
            skipped += 1
            continue

        jobs = await job_manager.get_jobs_by_datasource(datasource.datasource_id)
        has_active_job = False
        for job in jobs or []:
          if job.status == JobStatus.IN_PROGRESS:
            has_active_job = True
          elif job.status == JobStatus.PENDING:
            if not is_stale_pending_job(job) or not await job_manager.fail_stale_pending_job(job.job_id):
              has_active_job = True
        if has_active_job:
          logger.info(
            f"Skipping datasource {datasource.datasource_id}: an ingestion job is already active"
          )
          skipped += 1
          continue

        logger.info(
          f"Reloading persisted datasource {datasource.datasource_id} "
          f"(interval: {reload_interval}s)"
        )
        acquired = await run_claimed_ingestion(
          job_manager.storage, datasource.datasource_id,
          lambda: reload_handler(client, job_manager, datasource, None),
        )
        if acquired:
          reloaded += 1
        else:
          skipped += 1
      except Exception as error:
        logger.error(f"Failed to reload datasource {datasource.datasource_id}: {error}")
        logger.error(traceback.format_exc())

    logger.info(
      f"Persisted datasource reload completed: {reloaded} reloaded, {skipped} skipped"
    )
    return reloaded, skipped
  finally:
    if owned_storage is not None:
      await owned_storage.aclose()


async def _mark_job_failed(job_manager: JobManager, job_id: Optional[str], error: Exception) -> None:
  if not job_id:
    return
  job = await job_manager.get_job(job_id)
  if not job or job.status in {
    JobStatus.COMPLETED,
    JobStatus.COMPLETED_WITH_ERRORS,
    JobStatus.FAILED,
    JobStatus.TERMINATED,
  }:
    return
  message = str(error) or error.__class__.__name__
  await job_manager.add_error_msg(job_id, message)
  await job_manager.upsert_job(job_id, status=JobStatus.FAILED, message=message)


async def run_ingestor_listener(
  client: Client,
  *,
  ingest_command: str,
  ingest_model: Type[BaseModel],
  ingest_handler: IngestHandler,
  reload_all_command: str,
  reload_all_handler: ReloadAllHandler,
  reload_datasource_command: str,
  reload_model: Type[BaseModel],
  reload_handler: ReloadHandler,
  max_tasks: int = 5,
  describe_ingest: Optional[LabelHandler] = None,
  on_startup: Optional[LifecycleHandler] = None,
  on_shutdown: Optional[LifecycleHandler] = None,
  preview_command: Optional[str] = None,
  preview_model: Optional[Type[BaseModel]] = None,
  preview_handler: Optional[PreviewHandler] = None,
) -> None:
  """Consume commands for ``client.ingestor_id`` and run bounded tasks.

  Initial-ingest and single-reload commands must carry a job id. Exceptions
  are reflected on that exact job, so a worker crash cannot leave it stuck in
  ``in_progress`` or accidentally update another job for the datasource.
  """
  if not client.ingestor_id:
    raise RuntimeError("Ingestor client must be initialized before starting its listener")
  if max_tasks < 1:
    raise ValueError("max_tasks must be at least 1")

  redis_client = MongoStorage()
  await redis_client.setup()
  job_manager = JobManager(storage=redis_client)
  queue = ingestor_request_queue(client.ingestor_type, client.ingestor_id)
  active_tasks: set[asyncio.Task[None]] = set()
  idle_delay = 0.25
  last_recovery = 0.0

  async def publish_preview_response(
    response_key: str,
    response: dict[str, Any],
  ) -> None:
    """Answer a preview request without letting response I/O stop the worker."""
    try:
      await redis_client.publish_preview(response_key, json.dumps(response))
    except Exception as error:
      logger.error(f"Failed to publish preview response on {response_key}: {error}")

  async def run_preview(
    payload: BaseModel,
    response_key: str,
  ) -> None:
    """Run a non-persisting preview and always answer the waiting server."""
    try:
      if preview_handler is None:
        raise RuntimeError("Preview handler is not configured")
      data = await preview_handler(client, payload)
      response = {"ok": True, "data": data}
    except Exception as error:
      logger.error(f"Preview command failed: {error}")
      logger.error(traceback.format_exc())
      response = {
        "ok": False,
        "error": str(error) or error.__class__.__name__,
      }
    await publish_preview_response(response_key, response)

  async def run_task(coro: Awaitable[None], label: str, job_id: Optional[str], command: dict) -> None:
    try:
      job = await job_manager.get_job(job_id) if job_id else None
      datasource_id = job.datasource_id if job else None
      async with ingestion_claim(redis_client, datasource_id, job_id, command) as acquired:
        if not acquired:
          if hasattr(coro, "close"):
            coro.close()
          await _mark_job_failed(job_manager, job_id, RuntimeError("Datasource is already being ingested; retry explicitly"))
          await redis_client.finish_command(command, failed=True)
          return
        try:
          await coro
        except asyncio.CancelledError:
          try:
            await asyncio.shield(_mark_job_failed(job_manager, job_id, RuntimeError("Ingestor stopped before the job completed")))
            await asyncio.shield(redis_client.finish_command(command, failed=True))
          except Exception as status_error:
            logger.error(f"Failed to record interrupted command {command['_id']}: {status_error}")
          raise
        except Exception as error:
          await _mark_job_failed(job_manager, job_id, error)
          await redis_client.finish_command(command, failed=True)
          raise
        await redis_client.finish_command(command)
    except asyncio.CancelledError:
      # Listener shutdown cancels every active task. Record that interruption
      # on the server-created job instead of leaving it permanently active.
      # ``shield`` gives the MongoDB write a chance to finish while this task is
      # already in a cancelled state.
      try:
        await asyncio.shield(
          _mark_job_failed(
            job_manager,
            job_id,
            RuntimeError("Ingestor stopped before the job completed"),
          )
        )
      except Exception as status_error:
        logger.error(f"Failed to mark cancelled job {job_id} failed: {status_error}")
      raise
    except Exception as error:
      logger.error(f"{label} failed: {error}")
      logger.error(traceback.format_exc())
      try:
        await _mark_job_failed(job_manager, job_id, error)
      except Exception as status_error:
        logger.error(f"Failed to mark job {job_id} failed: {status_error}")

  def schedule(coro: Awaitable[None], label: str, job_id: Optional[str]) -> None:
    task = asyncio.create_task(run_task(coro, label, job_id, result))
    active_tasks.add(task)
    task.add_done_callback(active_tasks.discard)

  try:
    if on_startup:
      await on_startup()
    logger.info(
      f"Listening for {client.ingestor_type} commands on {queue} "
      f"(max_tasks={max_tasks})"
    )

    while True:
      if os.getenv("RAG_WRITES_PAUSED", "false").lower() == "true":
        await asyncio.sleep(1)
        continue
      if len(active_tasks) >= max_tasks:
        await asyncio.wait(active_tasks, return_when=asyncio.FIRST_COMPLETED)
        continue

      try:
        if asyncio.get_running_loop().time() - last_recovery >= 15:
          await redis_client.recover_interrupted()
          last_recovery = asyncio.get_running_loop().time()
        result = await redis_client.claim_command(queue)
      except asyncio.CancelledError:
        raise
      except Exception as error:
        # Database restarts and brief network interruptions are expected in both
        # Compose and Kubernetes. Keep the long-lived listener alive and let
        # the driver reconnect instead of taking down the whole ingestor.
        logger.error(f"Failed to read ingestor queue {queue}: {error}")
        await asyncio.sleep(1)
        continue
      if result is None:
        await asyncio.sleep(idle_delay)
        idle_delay = min(5, idle_delay * 2)
        continue
      idle_delay = 0.25
      message = result["payload"]

      request: Optional[IngestorRequest] = None
      try:
        request = IngestorRequest.model_validate_json(message)
        if request.ingestor_id != client.ingestor_id:
          # This should be impossible with per-id queues. Re-route instead of
          # dropping data if an older producer addressed the wrong list.
          target_queue = ingestor_request_queue(client.ingestor_type, request.ingestor_id)
          await redis_client.enqueue(target_queue, message)
          await redis_client.finish_command(result)
          logger.warning(f"Re-routed command for {request.ingestor_id} to {target_queue}")
          continue

        if request.command == ingest_command:
          if not request.job_id:
            raise ValueError(f"{ingest_command} command is missing job_id")
          payload = ingest_model.model_validate(request.payload)
          label = describe_ingest(payload) if describe_ingest else ingest_command
          schedule(
            ingest_handler(client, job_manager, payload, request.job_id),
            label,
            request.job_id,
          )
        elif request.command == reload_all_command:
          schedule(reload_all_handler(client), reload_all_command, request.job_id)
        elif request.command == reload_datasource_command:
          if not request.job_id:
            raise ValueError(f"{reload_datasource_command} command is missing job_id")
          payload = reload_model.model_validate(request.payload)
          datasource_id = getattr(payload, "datasource_id", None)
          if not isinstance(datasource_id, str) or not datasource_id:
            raise ValueError(f"{reload_datasource_command} payload is missing datasource_id")
          datasources = await client.list_datasources(ingestor_id=client.ingestor_id)
          datasource = next(
            (item for item in datasources if item.datasource_id == datasource_id),
            None,
          )
          if not datasource:
            raise ValueError(f"Datasource not found: {datasource_id}")
          schedule(
            reload_handler(client, job_manager, datasource, request.job_id),
            f"Reload datasource: {datasource_id}",
            request.job_id,
          )
        elif preview_command and request.command == preview_command:
          if preview_model is None or preview_handler is None:
            raise ValueError(f"{preview_command} is not configured")
          if not request.response_key:
            raise ValueError(f"{preview_command} command is missing response_key")
          payload = preview_model.model_validate(request.payload)
          schedule(
            run_preview(payload, request.response_key),
            preview_command,
            None,
          )
        else:
          raise ValueError(f"Unknown ingestor command: {request.command}")
      except Exception as error:
        logger.error(f"Invalid command on {queue}: {error}")
        logger.error(traceback.format_exc())
        # Preview is a synchronous request/response operation from the RAG
        # server's perspective. Validation and dispatch errors happen before
        # ``run_preview`` is scheduled, so answer them here instead of making
        # the caller wait for the full preview timeout.
        if (
          request
          and preview_command
          and request.command == preview_command
          and request.response_key
        ):
          await publish_preview_response(
            request.response_key,
            {
              "ok": False,
              "error": str(error) or error.__class__.__name__,
            },
          )
        try:
          await redis_client.finish_command(result, failed=True)
        except Exception as finish_error:
          logger.error(f"Failed to finish invalid command on {queue}: {finish_error}")
        request_job_id = request.job_id if request else None
        try:
          await _mark_job_failed(job_manager, request_job_id, error)
        except Exception as status_error:
          # A database error while recording the failure must not terminate the
          # command consumer; the server's stale-pending recovery can repair
          # the job once MongoDB is available again.
          logger.error(f"Failed to mark job {request_job_id} failed: {status_error}")
  except asyncio.CancelledError:
    logger.info(f"Listener cancelled for {client.ingestor_id}")
    raise
  finally:
    for task in active_tasks:
      task.cancel()
    if active_tasks:
      await asyncio.gather(*active_tasks, return_exceptions=True)
    if on_shutdown:
      await on_shutdown()
    await redis_client.aclose()
