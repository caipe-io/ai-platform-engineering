"""Shared Redis command listener for all RAG ingestors.

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
from collections.abc import Awaitable, Callable
from typing import Any, Optional, Type

from pydantic import BaseModel
from redis.asyncio import Redis

from common.constants import (
  DEFAULT_RELOAD_INTERVAL,
  MIN_RELOAD_INTERVAL,
  ingestor_request_queue,
)
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


def configured_reload_interval(
  config: dict[str, Any],
  existing: Optional[DataSourceInfo] = None,
) -> int:
  """Resolve a legacy config source's persisted refresh interval.

  Existing datasource cadence wins when an older config has no per-source
  value. New legacy sources retain the historical 24-hour default.
  """
  raw_value = config.get("reload_interval")
  if raw_value is None:
    return existing.reload_interval if existing else DEFAULT_RELOAD_INTERVAL
  if isinstance(raw_value, bool):
    raise ValueError("reload_interval must be an integer number of seconds")
  try:
    interval = int(raw_value)
  except (TypeError, ValueError) as error:
    raise ValueError("reload_interval must be an integer number of seconds") from error
  if interval < MIN_RELOAD_INTERVAL:
    raise ValueError(
      f"reload_interval must be at least {MIN_RELOAD_INTERVAL} seconds"
    )
  return interval


async def reload_persisted_datasources(
  client: Client,
  reload_handler: ReloadHandler,
  *,
  due_only: bool = True,
  config_managed_only: bool = False,
  job_manager: Optional[JobManager] = None,
) -> tuple[int, int]:
  """Reload datasource records assigned to this ingestor.

  Database-managed sources are absent from the legacy connector env vars, so
  every periodic connector path must enumerate the persisted RAG datasource
  store. This shared implementation honors per-source refresh intervals and
  avoids racing an on-demand job already using the datasource.

  Returns ``(reloaded, skipped)``. A failure for one datasource is isolated so
  the remaining sources still receive a refresh attempt.
  """
  owned_redis: Optional[Redis] = None
  if job_manager is None:
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
    owned_redis = Redis.from_url(redis_url, decode_responses=True)
    job_manager = JobManager(owned_redis)

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
        if config_managed_only and not (datasource.metadata or {}).get("config_managed"):
          skipped += 1
          continue

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
        has_active_job = any(
          job.status == JobStatus.IN_PROGRESS
          or (job.status == JobStatus.PENDING and not is_stale_pending_job(job))
          for job in jobs or []
        )
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
        await reload_handler(client, job_manager, datasource, None)
        reloaded += 1
      except Exception as error:
        logger.error(f"Failed to reload datasource {datasource.datasource_id}: {error}")
        logger.error(traceback.format_exc())

    logger.info(
      f"Persisted datasource reload completed: {reloaded} reloaded, {skipped} skipped"
    )
    return reloaded, skipped
  finally:
    if owned_redis is not None:
      await owned_redis.aclose()


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

  redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
  redis_client = Redis.from_url(redis_url, decode_responses=True)
  job_manager = JobManager(redis_client)
  queue = ingestor_request_queue(client.ingestor_type, client.ingestor_id)
  active_tasks: set[asyncio.Task[None]] = set()

  async def publish_preview_response(
    response_key: str,
    response: dict[str, Any],
  ) -> None:
    """Answer a preview request without letting response I/O stop the worker."""
    try:
      await redis_client.rpush(response_key, json.dumps(response))
      await redis_client.expire(response_key, 300)
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

  async def run_task(coro: Awaitable[None], label: str, job_id: Optional[str]) -> None:
    try:
      await coro
    except asyncio.CancelledError:
      # Listener shutdown cancels every active task. Record that interruption
      # on the server-created job instead of leaving it permanently active.
      # ``shield`` gives the Redis write a chance to finish while this task is
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
    task = asyncio.create_task(run_task(coro, label, job_id))
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
      if len(active_tasks) >= max_tasks:
        await asyncio.wait(active_tasks, return_when=asyncio.FIRST_COMPLETED)
        continue

      try:
        result = await redis_client.blpop([queue], timeout=1)
      except asyncio.CancelledError:
        raise
      except Exception as error:
        # Redis restarts and brief network interruptions are expected in both
        # Compose and Kubernetes. Keep the long-lived listener alive and let
        # redis-py reconnect instead of taking down the whole ingestor.
        logger.error(f"Failed to read ingestor queue {queue}: {error}")
        await asyncio.sleep(1)
        continue
      if result is None:
        continue
      _, message = result

      request: Optional[IngestorRequest] = None
      try:
        request = IngestorRequest.model_validate_json(message)
        if request.ingestor_id != client.ingestor_id:
          # This should be impossible with per-id queues. Re-route instead of
          # dropping data if an older producer addressed the wrong list.
          target_queue = ingestor_request_queue(client.ingestor_type, request.ingestor_id)
          await redis_client.rpush(target_queue, message)
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
        request_job_id = request.job_id if request else None
        try:
          await _mark_job_failed(job_manager, request_job_id, error)
        except Exception as status_error:
          # A Redis error while recording the failure must not terminate the
          # command consumer; the server's stale-pending recovery can repair
          # the job once Redis is available again.
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
