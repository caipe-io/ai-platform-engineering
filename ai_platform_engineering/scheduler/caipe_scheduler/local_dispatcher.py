"""In-process schedule dispatcher for Docker Compose installations."""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any

import httpx
import pytz
from croniter import croniter

from caipe_scheduler.config import Settings
from caipe_scheduler.store import ScheduleStore

log = logging.getLogger(__name__)


class LocalScheduleDispatcher:
  """Fire schedules without requiring a Kubernetes API or CronJob pods.

  This backend is intentionally for the single-instance Docker Compose path.
  Kubernetes installations continue to use CronJobOps and the low-privilege
  cron-runner pods.
  """

  def __init__(self, *, store: ScheduleStore, settings: Settings):
    self._store = store
    self._settings = settings
    self._stop = threading.Event()
    self._wake = threading.Event()
    self._thread: threading.Thread | None = None
    self._next_runs: dict[str, tuple[tuple[str, str], datetime]] = {}

  def start(self) -> None:
    if self._thread and self._thread.is_alive():
      return
    self._thread = threading.Thread(target=self._run, name="local-schedule-dispatcher", daemon=True)
    self._thread.start()
    log.info("Local schedule dispatcher started")

  def stop(self) -> None:
    self._stop.set()
    self._wake.set()
    if self._thread and self._thread.is_alive():
      self._thread.join(timeout=5)
    log.info("Local schedule dispatcher stopped")

  def wake(self) -> None:
    self._wake.set()

  def _run(self) -> None:
    while not self._stop.is_set():
      try:
        self.dispatch_once()
      except Exception:
        log.exception("Local schedule dispatcher loop failed")
      self._wake.wait(timeout=10)
      self._wake.clear()

  def dispatch_once(self) -> None:
    now = datetime.now(timezone.utc)
    for schedule in self._store.list():
      schedule_id = str(schedule.get("schedule_id") or "")
      if not schedule_id or not schedule.get("enabled", True):
        self._next_runs.pop(schedule_id, None)
        continue
      try:
        signature = (str(schedule.get("cron") or ""), str(schedule.get("tz") or "UTC"))
        current = self._next_runs.get(schedule_id)
        if current is None or current[0] != signature:
          self._next_runs[schedule_id] = (signature, self._next_run(schedule, now))
          current = self._next_runs[schedule_id]
        if current[1] > now:
          continue
        self._next_runs[schedule_id] = (signature, self._next_run(schedule, now))
        self._fire(schedule)
      except Exception:
        log.exception("Local schedule fire failed: %s", schedule_id)

    for run in self._store.claim_due_one_off_runs(limit=20, claim_timeout_seconds=300):
      self._fire_one_off(run)

  @staticmethod
  def _next_run(schedule: dict[str, Any], now: datetime) -> datetime:
    tz = pytz.timezone(str(schedule.get("tz") or "UTC"))
    local_now = now.astimezone(tz)
    return croniter(str(schedule["cron"]), local_now).get_next(datetime).astimezone(timezone.utc)

  def _fire(self, schedule: dict[str, Any]) -> None:
    self._invoke(schedule)

  def _fire_one_off(self, run: dict[str, Any]) -> None:
    schedule = self._store.get(str(run["schedule_id"]))
    if not schedule:
      self._store.mark_one_off_failed(run["one_off_run_id"], error="Parent schedule not found.")
      return
    status, error, http_status = self._invoke(
      schedule,
      one_off_run_id=run["one_off_run_id"],
      retry_num=run.get("retry_num"),
      retry_limit=run.get("retry_limit"),
      retry_reason=run.get("reason"),
      one_off_metadata=run.get("metadata") or {},
      message_override=run.get("message_template"),
    )
    self._store.record_one_off_run(
      run["one_off_run_id"],
      status=status,
      error=error,
      http_status=http_status,
    )

  def _invoke(
    self,
    schedule: dict[str, Any],
    *,
    one_off_run_id: str | None = None,
    retry_num: int | None = None,
    retry_limit: int | None = None,
    retry_reason: str | None = None,
    one_off_metadata: dict[str, Any] | None = None,
    message_override: str | None = None,
  ) -> tuple[str, str | None, int | None]:
    schedule_id = str(schedule["schedule_id"])
    run_ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_key = f"{schedule_id}:{one_off_run_id or ''}:{run_ts}"
    run_id = f"scheduled-{schedule_id}-{hashlib.sha1(run_key.encode()).hexdigest()[:12]}"
    metadata = one_off_metadata or {}
    message = message_override if message_override is not None else str(schedule["message_template"])
    metadata_lines = ["", "SCHEDULED_RUN_METADATA", f"schedule_id={schedule_id}", f"run_type={'one_off' if one_off_run_id else 'recurring'}"]
    if one_off_run_id:
      metadata_lines.extend([f"one_off_run_id={one_off_run_id}", f"one_off_metadata_json={json.dumps(metadata, sort_keys=True, separators=(',', ':'))}"])
      if retry_num is not None:
        metadata_lines.append(f"retry_num={retry_num}")
      if retry_limit is not None:
        metadata_lines.append(f"retry_limit={retry_limit}")
      if retry_reason:
        metadata_lines.append(f"retry_reason={retry_reason}")

    payload = {
      "agent_id": schedule["agent_id"],
      "message": "\n".join([message, *metadata_lines]),
      "conversation_id": run_id,
      "trace_id": run_id,
      "client_context": {
        "source": "scheduler",
        "schedule_id": schedule_id,
        "schedule_title": schedule.get("title"),
        "run_id": run_id,
        "attributes": schedule.get("attributes") or {},
        "run_type": "one_off" if one_off_run_id else "recurring",
        "one_off_run_id": one_off_run_id,
        "retry_num": retry_num,
        "retry_limit": retry_limit,
        "retry_reason": retry_reason,
        "one_off_metadata": metadata,
      },
    }
    status = "ok"
    error: str | None = None
    http_status: int | None = None
    try:
      with httpx.Client(timeout=300.0) as client:
        response = client.post(
          f"{self._settings.caipe_api_url.rstrip('/')}{self._settings.caipe_chat_path}",
          headers={
            "Content-Type": "application/json",
            "X-Scheduler-Token": self._settings.service_token,
            "X-Client-Source": "caipe-scheduler-local",
          },
          json=payload,
        )
        http_status = response.status_code
        if response.is_error:
          status = "error"
          error = (response.text or "")[:1000]
        else:
          body = response.json()
          if isinstance(body, dict) and body.get("success") is False:
            status = "error"
            error = str(body.get("error") or response.text)[:1000]
    except Exception as exc:
      status = "error"
      error = str(exc)[:1000]
      log.exception("Local scheduled chat invoke failed: %s", schedule_id)

    self._store.record_run(schedule_id, status=status, error=error, http_status=http_status)
    return status, error, http_status
