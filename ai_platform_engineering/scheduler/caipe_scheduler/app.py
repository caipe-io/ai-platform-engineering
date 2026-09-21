"""FastAPI app for caipe-scheduler.

Endpoints:
  POST   /v1/schedules                  - create
  GET    /v1/schedules                  - list (filter by owner/agent)
  GET    /v1/schedules/{id}             - single
  PATCH  /v1/schedules/{id}             - enable/disable, change cron/tz/msg
  DELETE /v1/schedules/{id}             - remove (Mongo + CronJob)
  POST   /v1/schedules/{id}/one-off-runs - create delayed one-off fire
  GET    /v1/schedules/{id}/one-off-runs - list one-off fires
  GET    /v1/internal/schedules/{id}    - cron-runner schedule lookup
  POST   /v1/schedules/{id}/runs        - cron-runner reports last run
  GET    /v1/settings                   - non-sensitive deployed scheduler limits
  GET    /healthz
"""

from __future__ import annotations

import logging
import secrets
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse
from caipe_scheduler.auth import CallerIdentity, authenticate_caller
from caipe_scheduler.config import Settings, get_settings
from caipe_scheduler.dispatcher import OneOffDispatcher
from caipe_scheduler.k8s import CronJobOps, cronjob_name_for
from caipe_scheduler.models import (
  CronJobReconcileRequest,
  CronJobReconcileResponse,
  LastRunReport,
  Schedule,
  ScheduleCreate,
  ScheduleCreateResponse,
  ScheduleList,
  SchedulePatch,
  ScheduleOneOffCreate,
  ScheduleOneOffList,
  ScheduleOneOffRun,
)
from caipe_scheduler.reconciler import (
  ScheduleNotFoundError,
  reconcile_cronjob_runner_images,
  reconcile_cronjobs_on_startup,
)
from caipe_scheduler.store import ScheduleStore
from caipe_scheduler.validation import validate_cron, validate_message, validate_tz

log = logging.getLogger(__name__)

_store: ScheduleStore | None = None
_k8s: CronJobOps | None = None
_dispatcher: OneOffDispatcher | None = None


def get_store(settings: Annotated[Settings, Depends(get_settings)]) -> ScheduleStore:
  global _store
  if _store is None:
    _store = ScheduleStore(settings)
  return _store


def get_k8s(settings: Annotated[Settings, Depends(get_settings)]) -> CronJobOps:
  global _k8s
  if _k8s is None:
    _k8s = CronJobOps(settings)
  return _k8s


def require_service_token(
  x_scheduler_token: Annotated[str | None, Header()] = None,
  settings: Annotated[Settings, Depends(get_settings)] = None,  # type: ignore[assignment]
) -> None:
  expected = settings.service_token if settings else ""
  if not expected:
    log.error("SCHEDULER_SERVICE_TOKEN is not configured; refusing request.")
    raise HTTPException(503, "Scheduler service authentication is not configured.")
  if not x_scheduler_token or not secrets.compare_digest(x_scheduler_token, expected):
    raise HTTPException(401, "Invalid or missing X-Scheduler-Token.")


def require_caller_identity(
  authorization: Annotated[str | None, Header()] = None,
  settings: Annotated[Settings, Depends(get_settings)] = None,  # type: ignore[assignment]
) -> CallerIdentity:
  return authenticate_caller(authorization, settings or Settings())


def get_owned_schedule(
  schedule_id: str,
  store: ScheduleStore,
  caller: CallerIdentity,
) -> dict:
  schedule = store.get_for_owner(
    schedule_id,
    owner_sub=caller.sub,
    owner_user_id=caller.email,
  )
  if not schedule:
    raise HTTPException(404, "Schedule not found.")
  return schedule


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
  global _dispatcher
  settings = get_settings()
  store = get_store(settings)
  k8s = get_k8s(settings)
  reconcile_cronjobs_on_startup(store=store, k8s=k8s, settings=settings)
  if settings.one_off_dispatch_enabled:
    _dispatcher = OneOffDispatcher(
      store=store,
      k8s=k8s,
      settings=settings,
    )
    _dispatcher.start()
  else:
    log.info("One-off dispatcher disabled")

  try:
    yield
  finally:
    if _dispatcher is not None:
      _dispatcher.stop()
      _dispatcher = None


app = FastAPI(title="CAIPE Scheduler", version="0.1.0", lifespan=lifespan)


# - routes -


@app.get("/healthz")
def healthz() -> dict[str, str]:
  return {"status": "ok"}


@app.get(
  "/v1/settings",
  dependencies=[Depends(require_service_token)],
)
def runtime_settings(
  settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, int]:
  """Return non-sensitive scheduler constraints used by client UIs."""
  return {
    "minimum_schedule_interval_seconds": settings.minimum_schedule_interval_seconds,
  }


@app.post(
  "/v1/admin/reconcile-cronjobs",
  response_model=CronJobReconcileResponse,
  dependencies=[Depends(require_service_token)],
)
def reconcile_cronjobs(
  body: CronJobReconcileRequest,
  store: Annotated[ScheduleStore, Depends(get_store)],
  k8s: Annotated[CronJobOps, Depends(get_k8s)],
  settings: Annotated[Settings, Depends(get_settings)],
) -> CronJobReconcileResponse:
  try:
    return reconcile_cronjob_runner_images(
      store=store,
      k8s=k8s,
      settings=settings,
      dry_run=body.dry_run,
      schedule_id=body.schedule_id,
    )
  except ScheduleNotFoundError as exc:
    raise HTTPException(404, "Schedule not found.") from exc


@app.post(
  "/v1/schedules",
  response_model=ScheduleCreateResponse,
  dependencies=[Depends(require_service_token)],
)
def create_schedule(
  body: ScheduleCreate,
  store: Annotated[ScheduleStore, Depends(get_store)],
  k8s: Annotated[CronJobOps, Depends(get_k8s)],
  settings: Annotated[Settings, Depends(get_settings)],
  caller: Annotated[CallerIdentity, Depends(require_caller_identity)],
) -> ScheduleCreateResponse:
  validate_cron(body.cron, settings.minimum_schedule_interval_seconds)
  validate_tz(body.tz)
  validate_message(body.message_template, settings.max_message_chars)

  if not store.agent_exists(body.agent_id):
    raise HTTPException(404, f"agent_id {body.agent_id!r} not found.")
  if body.edit_agent_id and not store.agent_exists(body.edit_agent_id):
    raise HTTPException(404, f"edit_agent_id {body.edit_agent_id!r} not found.")

  if store.count_for_owner(caller.sub, caller.email) >= settings.max_schedules_per_owner:
    raise HTTPException(
      429,
      f"Owner already has {settings.max_schedules_per_owner} schedules (limit).",
    )

  schedule_id = f"sched_{uuid.uuid4().hex[:16]}"
  cronjob_name = cronjob_name_for(schedule_id)

  doc = {
    "schedule_id": schedule_id,
    "owner_sub": caller.sub,
    "owner_user_id": caller.email,
    "agent_id": body.agent_id,
    "edit_agent_id": body.edit_agent_id,
    "title": body.title,
    "message_template": body.message_template,
    "attributes": body.attributes,
    "cron": body.cron,
    "tz": body.tz,
    "enabled": True,
    "cronjob_name": cronjob_name,
    "version": 1,
    "versions": [],
  }
  store.insert(doc)

  try:
    k8s.create(schedule_id=schedule_id, cron=body.cron, tz=body.tz)
  except Exception as e:
    # Roll back the Mongo doc if we couldn't create the CronJob.
    log.exception("CronJob create failed; rolling back schedule %s", schedule_id)
    store.delete(schedule_id)
    raise HTTPException(500, f"Failed to create CronJob: {e}") from e

  return ScheduleCreateResponse(schedule_id=schedule_id, cronjob_name=cronjob_name)


@app.get(
  "/v1/schedules",
  response_model=ScheduleList,
  dependencies=[Depends(require_service_token)],
)
def list_schedules(
  store: Annotated[ScheduleStore, Depends(get_store)],
  caller: Annotated[CallerIdentity, Depends(require_caller_identity)],
  agent_id: str | None = Query(default=None),
) -> ScheduleList:
  docs = store.list(
    owner_sub=caller.sub,
    owner_user_id=caller.email,
    agent_id=agent_id,
  )
  return ScheduleList(items=[Schedule.model_validate(d) for d in docs])


@app.get(
  "/v1/schedules/{schedule_id}",
  response_model=Schedule,
  dependencies=[Depends(require_service_token)],
)
def get_schedule(
  schedule_id: str,
  store: Annotated[ScheduleStore, Depends(get_store)],
  caller: Annotated[CallerIdentity, Depends(require_caller_identity)],
) -> Schedule:
  doc = get_owned_schedule(schedule_id, store, caller)
  return Schedule.model_validate(doc)


@app.get(
  "/v1/internal/schedules/{schedule_id}",
  response_model=Schedule,
  dependencies=[Depends(require_service_token)],
)
def get_schedule_internal(
  schedule_id: str,
  store: Annotated[ScheduleStore, Depends(get_store)],
) -> Schedule:
  doc = store.get(schedule_id)
  if not doc:
    raise HTTPException(404, "Schedule not found.")
  return Schedule.model_validate(doc)


@app.patch(
  "/v1/schedules/{schedule_id}",
  response_model=Schedule,
  dependencies=[Depends(require_service_token)],
)
def patch_schedule(
  schedule_id: str,
  body: SchedulePatch,
  store: Annotated[ScheduleStore, Depends(get_store)],
  k8s: Annotated[CronJobOps, Depends(get_k8s)],
  settings: Annotated[Settings, Depends(get_settings)],
  caller: Annotated[CallerIdentity, Depends(require_caller_identity)],
) -> Schedule:
  existing = get_owned_schedule(schedule_id, store, caller)

  patch = body.model_dump(exclude_unset=True, exclude_none=False)
  if "cron" in patch and patch["cron"] is not None:
    validate_cron(patch["cron"], settings.minimum_schedule_interval_seconds)
  if "tz" in patch and patch["tz"] is not None:
    validate_tz(patch["tz"])
  if "message_template" in patch and patch["message_template"] is not None:
    validate_message(patch["message_template"], settings.max_message_chars)
  if "title" in patch and patch["title"] is None:
    raise HTTPException(422, "title must be a non-empty string.")
  if "attributes" in patch and patch["attributes"] is None:
    raise HTTPException(422, "attributes must be a JSON object.")
  if "agent_id" in patch and patch["agent_id"] is not None:
    if not store.agent_exists(patch["agent_id"]):
      raise HTTPException(404, f"agent_id {patch['agent_id']!r} not found.")
  if "edit_agent_id" in patch and patch["edit_agent_id"] is not None:
    if not store.agent_exists(patch["edit_agent_id"]):
      raise HTTPException(404, f"edit_agent_id {patch['edit_agent_id']!r} not found.")

  cronjob_name = existing.get("cronjob_name") or cronjob_name_for(schedule_id)
  suspend = not patch["enabled"] if "enabled" in patch and patch["enabled"] is not None else None
  k8s.patch(
    cronjob_name=cronjob_name,
    cron=patch.get("cron"),
    tz=patch.get("tz"),
    suspend=suspend,
  )

  updated = store.patch(schedule_id, patch)
  if updated is None:
    raise HTTPException(404, "Schedule not found.")
  return Schedule.model_validate(updated)


@app.delete(
  "/v1/schedules/{schedule_id}",
  dependencies=[Depends(require_service_token)],
)
def delete_schedule(
  schedule_id: str,
  store: Annotated[ScheduleStore, Depends(get_store)],
  k8s: Annotated[CronJobOps, Depends(get_k8s)],
  caller: Annotated[CallerIdentity, Depends(require_caller_identity)],
) -> JSONResponse:
  existing = get_owned_schedule(schedule_id, store, caller)
  cronjob_name = existing.get("cronjob_name") or cronjob_name_for(schedule_id)
  try:
    k8s.delete(cronjob_name)
  except Exception as exc:
    log.exception("CronJob delete failed for %s; keeping Mongo doc for retry", schedule_id)
    raise HTTPException(502, f"Failed to delete CronJob: {exc}") from exc
  cancelled = store.cancel_one_off_runs_for_schedule(schedule_id)
  store.delete(schedule_id)
  return JSONResponse({"deleted": schedule_id, "cancelled_one_off_runs": cancelled})


@app.post(
  "/v1/schedules/{schedule_id}/one-off-runs",
  response_model=ScheduleOneOffRun,
  dependencies=[Depends(require_service_token)],
)
def create_schedule_one_off_run(
  schedule_id: str,
  body: ScheduleOneOffCreate,
  store: Annotated[ScheduleStore, Depends(get_store)],
  settings: Annotated[Settings, Depends(get_settings)],
  caller: Annotated[CallerIdentity, Depends(require_caller_identity)],
) -> ScheduleOneOffRun:
  existing = get_owned_schedule(schedule_id, store, caller)
  if body.message_template is not None:
    validate_message(body.message_template, settings.max_message_chars)

  now = datetime.now(timezone.utc)
  run_at = _coerce_utc(body.run_at) if body.run_at is not None else now + timedelta(minutes=body.delay_minutes or 0)
  one_off_run_id = f"oneoff_{uuid.uuid4().hex[:16]}"
  doc = {
    "one_off_run_id": one_off_run_id,
    "schedule_id": schedule_id,
    "owner_sub": existing.get("owner_sub") or caller.sub,
    "owner_user_id": existing["owner_user_id"],
    "run_at": run_at,
    "status": "pending",
    "message_template": body.message_template,
    "reason": body.reason,
    "metadata": body.metadata,
    "retry_num": body.retry_num,
    "retry_limit": body.retry_limit,
  }
  created = store.create_one_off_run(doc)
  if _dispatcher is not None:
    _dispatcher.wake()
  return ScheduleOneOffRun.model_validate(created)


@app.get(
  "/v1/schedules/{schedule_id}/one-off-runs",
  response_model=ScheduleOneOffList,
  dependencies=[Depends(require_service_token)],
)
def list_schedule_one_off_runs(
  schedule_id: str,
  store: Annotated[ScheduleStore, Depends(get_store)],
  caller: Annotated[CallerIdentity, Depends(require_caller_identity)],
  status: list[str] | None = Query(default=None),
) -> ScheduleOneOffList:
  get_owned_schedule(schedule_id, store, caller)
  docs = store.list_one_off_runs(schedule_id, statuses=status)
  return ScheduleOneOffList(items=[ScheduleOneOffRun.model_validate(d) for d in docs])


@app.post(
  "/v1/schedules/{schedule_id}/runs",
  dependencies=[Depends(require_service_token)],
)
def report_run(
  schedule_id: str,
  body: LastRunReport,
  store: Annotated[ScheduleStore, Depends(get_store)],
) -> dict[str, str]:
  if not store.get(schedule_id):
    raise HTTPException(404, "Schedule not found.")
  store.record_run(
    schedule_id,
    status=body.status,
    error=body.error,
    http_status=body.http_status,
  )
  if body.one_off_run_id:
    store.record_one_off_run(
      body.one_off_run_id,
      status=body.status,
      error=body.error,
      http_status=body.http_status,
    )
  return {"recorded": schedule_id}


def _coerce_utc(value: datetime) -> datetime:
  if value.tzinfo is None:
    return value.replace(tzinfo=timezone.utc)
  return value.astimezone(timezone.utc)
