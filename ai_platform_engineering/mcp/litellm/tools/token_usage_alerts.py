"""Token usage alert evaluation tools for LiteLLM reports."""

import json
import logging
import os
from datetime import date, timedelta
from typing import Any

from mcp_litellm.api.client import make_api_request

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mcp_tools")

DEFAULT_THRESHOLD = 0.8
TOTAL_TOKEN_KEYS = {
  "total_tokens",
  "tokens",
  "token_count",
  "total_token_count",
}
ROW_CONTAINER_KEYS = (
  "data",
  "results",
  "items",
  "rows",
  "activity",
  "daily_activity",
  "daily_data",
)


def _env_bool(name: str, default: bool = False) -> bool:
  value = os.getenv(name)
  if value is None:
    return default
  return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_float(name: str, default: float) -> float:
  value = os.getenv(name)
  if value is None or value.strip() == "":
    return default
  try:
    return float(value)
  except ValueError:
    logger.warning("Invalid %s=%r; using default %s", name, value, default)
    return default


def _load_limit_map() -> dict[str, int]:
  raw = os.getenv("LITELLM_TOKEN_ALERT_LIMITS_JSON", "").strip()
  if not raw:
    return {}
  try:
    parsed = json.loads(raw)
  except json.JSONDecodeError:
    logger.warning("Invalid LITELLM_TOKEN_ALERT_LIMITS_JSON; ignoring configured token limits")
    return {}
  if not isinstance(parsed, dict):
    logger.warning("LITELLM_TOKEN_ALERT_LIMITS_JSON must be a JSON object")
    return {}

  limits: dict[str, int] = {}
  for key, value in parsed.items():
    try:
      numeric = int(value)
    except (TypeError, ValueError):
      logger.warning("Ignoring non-integer LiteLLM token alert limit for %s", key)
      continue
    if numeric > 0:
      limits[str(key)] = numeric
  return limits


def _resolve_token_limit(user_id: str | None, api_key: str | None, token_limit: int | None) -> int | None:
  if token_limit is not None and token_limit > 0:
    return token_limit

  limits = _load_limit_map()
  for key in (user_id, api_key, "default"):
    if key and key in limits:
      return limits[key]
  return None


def _extract_numeric_token_value(value: Any) -> int:
  if isinstance(value, bool):
    return 0
  if isinstance(value, int):
    return value
  if isinstance(value, float):
    return int(value)
  if isinstance(value, str):
    try:
      return int(float(value))
    except ValueError:
      return 0
  return 0


def _extract_total_tokens(report: Any) -> int:
  if isinstance(report, list):
    return sum(_extract_total_tokens(item) for item in report)

  if not isinstance(report, dict):
    return 0

  for key in TOTAL_TOKEN_KEYS:
    if key in report:
      return _extract_numeric_token_value(report[key])

  for key in ROW_CONTAINER_KEYS:
    child = report.get(key)
    if isinstance(child, list):
      return sum(_extract_total_tokens(item) for item in child)
    if isinstance(child, dict):
      tokens = _extract_total_tokens(child)
      if tokens:
        return tokens

  return 0


def _default_start_date() -> str:
  return (date.today() - timedelta(days=30)).isoformat()


def _default_end_date() -> str:
  return date.today().isoformat()


def _notification_status(
  *,
  threshold_reached: bool,
  feature_enabled: bool,
  dry_run: bool,
) -> dict[str, Any]:
  if not threshold_reached:
    return {"status": "not_needed", "would_notify": False}
  if not feature_enabled:
    return {"status": "suppressed", "reason": "feature_disabled", "would_notify": True}
  if dry_run:
    return {"status": "dry_run", "reason": "dry_run", "would_notify": True}
  return {"status": "not_sent", "reason": "notifier_not_configured", "would_notify": True}


async def evaluate_token_usage_alert(
  param_user_id: str | None = None,
  param_token_limit: int | None = None,
  param_start_date: str | None = None,
  param_end_date: str | None = None,
  param_api_key: str | None = None,
  param_threshold: float | None = None,
  param_dry_run: bool = True,
  param_timezone: str | None = None,
) -> dict[str, Any]:
  """
  Evaluate whether a LiteLLM user has crossed the configured token usage threshold.

  Notifications are disabled unless LITELLM_TOKEN_ALERTS_ENABLED=true. While disabled,
  this tool still returns would_notify=true when usage reaches the threshold so tests
  can validate alert behavior without messaging users.
  """
  if not param_user_id and not param_api_key:
    return {"error": "param_user_id or param_api_key is required"}

  threshold = param_threshold if param_threshold is not None else _env_float("LITELLM_TOKEN_ALERT_THRESHOLD", DEFAULT_THRESHOLD)
  if threshold <= 0 or threshold > 1:
    return {"error": "threshold must be greater than 0 and less than or equal to 1"}

  token_limit = _resolve_token_limit(param_user_id, param_api_key, param_token_limit)
  if token_limit is None:
    return {
      "error": "token_limit is required",
      "hint": "Pass param_token_limit or set LITELLM_TOKEN_ALERT_LIMITS_JSON with user/API-key limits.",
    }

  params: dict[str, Any] = {
    "start_date": param_start_date or _default_start_date(),
    "end_date": param_end_date or _default_end_date(),
  }
  if param_user_id:
    params["user_id"] = param_user_id
  if param_api_key:
    params["api_key"] = param_api_key
  if param_timezone is not None:
    params["timezone"] = param_timezone

  success, report = await make_api_request("/user/daily/activity/aggregated", method="GET", params=params, data={})
  if not success:
    return report

  used_tokens = _extract_total_tokens(report)
  usage_ratio = used_tokens / token_limit
  usage_percent = round(usage_ratio * 100, 2)
  threshold_percent = round(threshold * 100, 2)
  threshold_reached = usage_ratio >= threshold
  feature_enabled = _env_bool("LITELLM_TOKEN_ALERTS_ENABLED", False)

  recipient = param_user_id or param_api_key or "unknown"
  notification = _notification_status(
    threshold_reached=threshold_reached,
    feature_enabled=feature_enabled,
    dry_run=param_dry_run,
  )

  return {
    "user_id": param_user_id,
    "api_key": param_api_key,
    "start_date": params["start_date"],
    "end_date": params["end_date"],
    "used_tokens": used_tokens,
    "token_limit": token_limit,
    "usage_ratio": round(usage_ratio, 4),
    "usage_percent": usage_percent,
    "threshold": threshold,
    "threshold_percent": threshold_percent,
    "threshold_reached": threshold_reached,
    "alerting_enabled": feature_enabled,
    "dry_run": param_dry_run,
    "notification": notification,
    "recipient": recipient,
    "dedupe_key": f"litellm-token-usage:{recipient}:{threshold_percent}:{params['start_date']}:{params['end_date']}",
    "message": (
      f"LiteLLM token usage for {recipient} is at {usage_percent}% "
      f"({used_tokens}/{token_limit} tokens), threshold {threshold_percent}%."
    ),
  }
