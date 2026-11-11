"""Periodic LiteLLM token usage alert scanner."""

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from tools import token_usage_alerts

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mcp_litellm.token_alert_scanner")

DEFAULT_SCAN_INTERVAL_SECONDS = 3600
DEFAULT_DEDUPE_FILE = "/tmp/litellm-token-alerts/state.json"
DEFAULT_DEDUPE_TTL_SECONDS = 86400


@dataclass(frozen=True)
class AlertTarget:
  user_id: str | None = None
  api_key: str | None = None
  token_limit: int | None = None
  recipient: str | None = None
  threshold: float | None = None
  timezone: str | None = None


def _env_bool(name: str, default: bool = False) -> bool:
  value = os.getenv(name)
  if value is None:
    return default
  return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int) -> int:
  value = os.getenv(name)
  if value is None or value.strip() == "":
    return default
  try:
    return int(value)
  except ValueError:
    logger.warning("Invalid %s=%r; using default %s", name, value, default)
    return default


def _env_float(name: str, default: float) -> float:
  value = os.getenv(name)
  if value is None or value.strip() == "":
    return default
  try:
    return float(value)
  except ValueError:
    logger.warning("Invalid %s=%r; using default %s", name, value, default)
    return default


def _optional_str(value: Any) -> str | None:
  if value is None:
    return None
  text = str(value).strip()
  return text or None


def _optional_int(value: Any) -> int | None:
  if value is None or value == "":
    return None
  try:
    numeric = int(value)
  except (TypeError, ValueError):
    return None
  return numeric if numeric > 0 else None


def _optional_float(value: Any) -> float | None:
  if value is None or value == "":
    return None
  try:
    numeric = float(value)
  except (TypeError, ValueError):
    return None
  return numeric if numeric > 0 else None


def _target_from_dict(raw_target: dict[str, Any]) -> AlertTarget | None:
  user_id = _optional_str(raw_target.get("user_id"))
  api_key = _optional_str(raw_target.get("api_key"))
  if not user_id and not api_key:
    logger.warning("Ignoring LiteLLM token alert target without user_id or api_key")
    return None

  recipient = _optional_str(raw_target.get("recipient") or raw_target.get("notification_recipient"))
  if not recipient and user_id and "@" in user_id:
    recipient = user_id

  return AlertTarget(
    user_id=user_id,
    api_key=api_key,
    token_limit=_optional_int(raw_target.get("token_limit")),
    recipient=recipient,
    threshold=_optional_float(raw_target.get("threshold")),
    timezone=_optional_str(raw_target.get("timezone")),
  )


def _load_targets_from_json() -> list[AlertTarget]:
  raw = os.getenv("LITELLM_TOKEN_ALERT_TARGETS_JSON", "").strip()
  if not raw:
    return []
  try:
    parsed = json.loads(raw)
  except json.JSONDecodeError:
    logger.warning("Invalid LITELLM_TOKEN_ALERT_TARGETS_JSON; no explicit targets loaded")
    return []
  if not isinstance(parsed, list):
    logger.warning("LITELLM_TOKEN_ALERT_TARGETS_JSON must be a JSON array")
    return []

  targets: list[AlertTarget] = []
  for raw_target in parsed:
    if not isinstance(raw_target, dict):
      logger.warning("Ignoring non-object LiteLLM token alert target")
      continue
    target = _target_from_dict(raw_target)
    if target:
      targets.append(target)
  return targets


def _load_targets_from_limit_map() -> list[AlertTarget]:
  targets: list[AlertTarget] = []
  for target_id, token_limit in token_usage_alerts._load_limit_map().items():
    if target_id == "default":
      continue
    targets.append(
      AlertTarget(
        user_id=target_id,
        token_limit=token_limit,
        recipient=target_id if "@" in target_id else None,
      )
    )
  return targets


def load_alert_targets() -> list[AlertTarget]:
  """Load scanner targets from LITELLM_TOKEN_ALERT_TARGETS_JSON or limit map keys."""
  explicit_targets = _load_targets_from_json()
  if explicit_targets:
    return explicit_targets
  return _load_targets_from_limit_map()


def _dedupe_file() -> Path:
  return Path(os.getenv("LITELLM_TOKEN_ALERT_DEDUPE_FILE", DEFAULT_DEDUPE_FILE))


def _dedupe_ttl_seconds() -> int:
  return _env_int("LITELLM_TOKEN_ALERT_DEDUPE_TTL_SECONDS", DEFAULT_DEDUPE_TTL_SECONDS)


def _load_dedupe_state(path: Path) -> dict[str, float]:
  try:
    raw = json.loads(path.read_text(encoding="utf-8"))
  except (FileNotFoundError, json.JSONDecodeError, OSError):
    return {}

  sent = raw.get("sent") if isinstance(raw, dict) else None
  if not isinstance(sent, dict):
    return {}

  state: dict[str, float] = {}
  for key, value in sent.items():
    try:
      state[str(key)] = float(value)
    except (TypeError, ValueError):
      continue
  return state


def _save_dedupe_state(path: Path, state: dict[str, float]) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(json.dumps({"sent": state}, sort_keys=True), encoding="utf-8")


def _prune_dedupe_state(state: dict[str, float], *, now: float, ttl_seconds: int) -> dict[str, float]:
  if ttl_seconds <= 0:
    return state
  return {key: value for key, value in state.items() if now - value < ttl_seconds}


def _target_label(target: AlertTarget) -> str:
  return target.user_id or target.api_key or "unknown"


async def _evaluate_target(
  target: AlertTarget,
  *,
  start_date: str | None,
  end_date: str | None,
  dry_run: bool,
) -> dict[str, Any]:
  return await token_usage_alerts.evaluate_token_usage_alert(
    param_user_id=target.user_id,
    param_api_key=target.api_key,
    param_token_limit=target.token_limit,
    param_start_date=start_date,
    param_end_date=end_date,
    param_threshold=target.threshold,
    param_dry_run=dry_run,
    param_timezone=target.timezone,
    param_notification_recipient=target.recipient,
  )


async def scan_token_usage_alerts(
  param_dry_run: bool | None = None,
  param_start_date: str | None = None,
  param_end_date: str | None = None,
) -> dict[str, Any]:
  """
  Scan all configured LiteLLM token alert targets and send Webex notifications.

  Targets come from LITELLM_TOKEN_ALERT_TARGETS_JSON. If that is not set, each
  non-default key in LITELLM_TOKEN_ALERT_LIMITS_JSON is scanned as a user_id.
  """
  targets = load_alert_targets()
  if not targets:
    return {
      "status": "no_targets",
      "targets_checked": 0,
      "notifications_sent": 0,
      "results": [],
    }

  dry_run = param_dry_run if param_dry_run is not None else _env_bool("LITELLM_TOKEN_ALERT_SCANNER_DRY_RUN", False)
  start_date = param_start_date or os.getenv("LITELLM_TOKEN_ALERT_SCAN_START_DATE")
  end_date = param_end_date or os.getenv("LITELLM_TOKEN_ALERT_SCAN_END_DATE")
  state_path = _dedupe_file()
  now = time.time()
  state = _prune_dedupe_state(_load_dedupe_state(state_path), now=now, ttl_seconds=_dedupe_ttl_seconds())
  state_changed = False

  results: list[dict[str, Any]] = []
  notifications_sent = 0
  deduped = 0

  for target in targets:
    preview = await _evaluate_target(target, start_date=start_date, end_date=end_date, dry_run=True)
    if "error" in preview:
      results.append({"target": _target_label(target), "result": preview})
      continue

    notification = preview.get("notification", {})
    if (
      not preview.get("threshold_reached")
      or not preview.get("alerting_enabled")
      or notification.get("would_notify") is not True
      or notification.get("status") not in {"dry_run", "pending"}
    ):
      results.append({"target": _target_label(target), "result": preview})
      continue

    dedupe_key = preview.get("dedupe_key")
    if dedupe_key and dedupe_key in state:
      deduped += 1
      preview["notification"] = {
        "status": "deduped",
        "reason": "already_notified",
        "channel": preview.get("notification_channel"),
        "would_notify": True,
      }
      results.append({"target": _target_label(target), "result": preview})
      continue

    if dry_run:
      results.append({"target": _target_label(target), "result": preview})
      continue

    sent_result = await _evaluate_target(target, start_date=start_date, end_date=end_date, dry_run=False)
    sent_notification = sent_result.get("notification", {})
    if sent_notification.get("status") == "sent":
      notifications_sent += 1
      if sent_result.get("dedupe_key"):
        state[str(sent_result["dedupe_key"])] = now
        state_changed = True
    results.append({"target": _target_label(target), "result": sent_result})

  if state_changed:
    _save_dedupe_state(state_path, state)
  elif state:
    _save_dedupe_state(state_path, state)

  return {
    "status": "ok",
    "targets_checked": len(targets),
    "notifications_sent": notifications_sent,
    "notifications_deduped": deduped,
    "dry_run": dry_run,
    "results": results,
  }


async def run_periodic_scanner() -> None:
  if not _env_bool("LITELLM_TOKEN_ALERT_SCANNER_ENABLED", False):
    logger.info("LiteLLM token alert scanner is disabled")
    return

  interval_seconds = _env_int("LITELLM_TOKEN_ALERT_SCAN_INTERVAL_SECONDS", DEFAULT_SCAN_INTERVAL_SECONDS)
  if interval_seconds <= 0:
    interval_seconds = DEFAULT_SCAN_INTERVAL_SECONDS

  logger.info("Starting LiteLLM token alert scanner with interval=%s seconds", interval_seconds)
  while True:
    await scan_token_usage_alerts()
    # The result includes target identifiers and alert details; keep it out of logs.
    logger.info("LiteLLM token alert scan completed")
    await asyncio.sleep(interval_seconds)


def main() -> None:
  load_dotenv()
  load_dotenv(".env.mcp")
  asyncio.run(run_periodic_scanner())


if __name__ == "__main__":
  main()
