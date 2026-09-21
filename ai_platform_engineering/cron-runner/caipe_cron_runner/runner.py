"""
caipe-cron-runner is used to run a single scheduled job fire, invoked by a k8s CronJob. It:

  1. Reads SCHEDULE_ID from env.
  2. GET <SCHEDULER_INTERNAL_URL>/v1/internal/schedules/<id> (auth: SCHEDULER_SERVICE_TOKEN).
  3. POST <CAIPE_API_URL><CAIPE_CHAT_PATH> (auth: SCHEDULER_SERVICE_TOKEN).
  4. POST <SCHEDULER_INTERNAL_URL>/v1/schedules/<id>/runs with status.

It has no Mongo or k8s API access by design - the only secret it sees is its own service token,
which is mounted from a k8s Secret at fire time.

The runner is a thin, low-privilege caller. It does NOT authenticate as the schedule owner and
never sends a user identity the chat API is asked to trust. Instead it presents the shared
X-Scheduler-Token to prove it is the scheduler subsystem, and the BFF (the platform auth boundary)
loads the immutable owner from the schedule DB record and mints a real owner bearer via Keycloak
token exchange before forwarding to Dynamic Agents. See docs/scheduled-job-auth-approaches.md.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

import httpx

log = logging.getLogger("caipe-cron-runner")
DEFAULT_HTTP_TIMEOUT_SECONDS = 300.0


def _required_env(key: str) -> str:
  val = os.environ.get(key, "").strip()
  if not val:
    log.error("Missing required env: %s", key)
    sys.exit(2)
  return val


def main() -> int:
  logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
  )

  schedule_id = _required_env("SCHEDULE_ID")
  scheduler_url = _required_env("SCHEDULER_INTERNAL_URL").rstrip("/")
  scheduler_token = _required_env("SCHEDULER_SERVICE_TOKEN")
  caipe_url = _required_env("CAIPE_API_URL").rstrip("/")
  chat_path = os.environ.get("CAIPE_CHAT_PATH", "/api/v1/chat/invoke")
  timeout = float(os.environ.get("HTTP_TIMEOUT", str(DEFAULT_HTTP_TIMEOUT_SECONDS)))
  one_off_run_id = os.environ.get("ONE_OFF_RUN_ID", "").strip() or None
  retry_num = os.environ.get("RETRY_NUM", "").strip() or None
  retry_limit = os.environ.get("RETRY_LIMIT", "").strip() or None
  retry_reason = os.environ.get("RETRY_REASON", "").strip() or None
  one_off_metadata = _load_one_off_metadata(os.environ.get("ONE_OFF_METADATA_JSON", "").strip())
  message_override = os.environ.get("MESSAGE_TEMPLATE_OVERRIDE")

  sched_headers = {"X-Scheduler-Token": scheduler_token}

  # 1. Fetch schedule.
  with httpx.Client(timeout=timeout) as client:
    try:
      r = client.get(
        f"{scheduler_url}/v1/internal/schedules/{schedule_id}",
        headers=sched_headers,
      )
      r.raise_for_status()
      schedule = r.json()
    except Exception as e:
      log.exception("Failed to fetch schedule %s: %s", schedule_id, e)
      return 3

    if not schedule.get("enabled", True) and not one_off_run_id:
      log.info("Schedule %s is disabled, skipping fire.", schedule_id)
      return 0
    if not schedule.get("enabled", True) and one_off_run_id:
      log.info(
        "Schedule %s is disabled, but one-off run %s is independent; continuing fire.",
        schedule_id,
        one_off_run_id,
      )

    # 2. POST to chat as the schedule's owner user.
    run_ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    conversation_hash = hashlib.sha1(f"{schedule_id}:{one_off_run_id or ''}:{run_ts}".encode()).hexdigest()[:12]
    run_id = f"scheduled-{schedule_id}-{conversation_hash}"
    message = message_override if message_override is not None else schedule["message_template"]
    metadata_lines = [
      "",
      "SCHEDULED_RUN_METADATA",
      f"schedule_id={schedule_id}",
      f"run_type={'one_off' if one_off_run_id else 'recurring'}",
    ]
    if one_off_run_id:
      metadata_lines.append(f"one_off_run_id={one_off_run_id}")
      if retry_num is not None:
        metadata_lines.append(f"retry_num={retry_num}")
      if retry_limit is not None:
        metadata_lines.append(f"retry_limit={retry_limit}")
      if retry_reason:
        metadata_lines.append(f"retry_reason={retry_reason}")
      if one_off_metadata:
        metadata_lines.append(
          "one_off_metadata_json="
          + json.dumps(
            one_off_metadata,
            sort_keys=True,
            separators=(",", ":"),
          )
        )
    message = "\n".join([message, *metadata_lines])

    chat_payload = {
      "agent_id": schedule["agent_id"],
      "message": message,
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
        "one_off_metadata": one_off_metadata,
      },
    }

    # No Authorization bearer and no trusted owner header: the runner does
    # not assert the owner's identity. The BFF authenticates this call by
    # the shared X-Scheduler-Token, resolves the immutable owner from the
    # schedule DB record, and mints a real owner bearer via Keycloak token
    # exchange before forwarding to Dynamic Agents. The runner sends no owner
    # identity; the BFF resolves it from the schedule DB record.
    chat_headers = {
      "Content-Type": "application/json",
      "X-Scheduler-Token": scheduler_token,
      "X-Client-Source": "caipe-cron-runner",
    }

    status: str = "ok"
    error: str | None = None
    http_status: int | None = None
    try:
      chat_resp = client.post(
        f"{caipe_url}{chat_path}",
        headers=chat_headers,
        json=chat_payload,
      )
      http_status = chat_resp.status_code
      if chat_resp.is_error:
        status = "error"
        error = (chat_resp.text or "")[:1000]
        log.error(
          "Chat POST failed: schedule=%s http=%s body=%s",
          schedule_id,
          http_status,
          error,
        )
      else:
        try:
          chat_body = chat_resp.json()
        except ValueError:
          chat_body = None

        if isinstance(chat_body, dict) and chat_body.get("success") is False:
          status = "error"
          error = str(chat_body.get("error") or chat_resp.text or "Chat API returned success=false")[:1000]
          log.error(
            "Chat POST returned unsuccessful response: schedule=%s http=%s body=%s",
            schedule_id,
            http_status,
            error,
          )
        else:
          log.info("Chat POST ok: schedule=%s http=%s", schedule_id, http_status)
    except Exception as e:
      status = "error"
      error = str(e)[:1000]
      log.exception("Chat POST raised: schedule=%s", schedule_id)

    # 3. Report back.
    try:
      report_resp = client.post(
        f"{scheduler_url}/v1/schedules/{schedule_id}/runs",
        headers=sched_headers,
        json={
          "status": status,
          "error": error,
          "http_status": http_status,
          "one_off_run_id": one_off_run_id,
        },
      )
      report_resp.raise_for_status()
    except Exception:
      log.exception("Failed to report run back to scheduler for %s", schedule_id)

  return 0 if status == "ok" else 1


def _load_one_off_metadata(raw: str) -> dict[str, Any]:
  if not raw:
    return {}
  try:
    parsed = json.loads(raw)
  except ValueError:
    log.warning("Ignoring invalid ONE_OFF_METADATA_JSON.")
    return {}
  if not isinstance(parsed, dict):
    log.warning("Ignoring non-object ONE_OFF_METADATA_JSON.")
    return {}
  return parsed


if __name__ == "__main__":
  sys.exit(main())
