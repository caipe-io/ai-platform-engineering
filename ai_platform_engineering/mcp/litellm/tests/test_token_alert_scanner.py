import asyncio
import json
import os
from unittest.mock import AsyncMock, patch

os.environ.setdefault("LITELLM_API_URL", "https://litellm.test")
os.environ.setdefault("LITELLM_API_KEY", "test-token")

import token_alert_scanner  # noqa: E402


def test_load_alert_targets_prefers_explicit_targets():
  targets_json = json.dumps(
    [
      {
        "user_id": "mouledel@example.com",
        "token_limit": 1000,
        "recipient": "mouledel@example.com",
        "threshold": 0.8,
      }
    ]
  )

  with patch.dict(
    os.environ,
    {
      "LITELLM_TOKEN_ALERT_TARGETS_JSON": targets_json,
      "LITELLM_TOKEN_ALERT_LIMITS_JSON": '{"other@example.com": 2000}',
    },
    clear=False,
  ):
    targets = token_alert_scanner.load_alert_targets()

  assert len(targets) == 1
  assert targets[0].user_id == "mouledel@example.com"
  assert targets[0].token_limit == 1000
  assert targets[0].recipient == "mouledel@example.com"
  assert targets[0].threshold == 0.8


def test_load_alert_targets_falls_back_to_limit_map():
  with patch.dict(
    os.environ,
    {
      "LITELLM_TOKEN_ALERT_TARGETS_JSON": "",
      "LITELLM_TOKEN_ALERT_LIMITS_JSON": '{"mouledel@example.com": 1000, "default": 500}',
    },
    clear=False,
  ):
    targets = token_alert_scanner.load_alert_targets()

  assert len(targets) == 1
  assert targets[0].user_id == "mouledel@example.com"
  assert targets[0].token_limit == 1000
  assert targets[0].recipient == "mouledel@example.com"


def test_scan_token_usage_alerts_sends_once_then_dedupes(tmp_path):
  state_file = tmp_path / "state.json"
  targets_json = json.dumps([{"user_id": "mouledel@example.com", "token_limit": 1000}])
  preview_result = {
    "threshold_reached": True,
    "alerting_enabled": True,
    "notification": {"status": "dry_run", "would_notify": True, "channel": "webex"},
    "notification_channel": "webex",
    "dedupe_key": "litellm-token-usage:mouledel@example.com:80.0:2026-06-19:2026-06-19",
  }
  sent_result = {
    **preview_result,
    "notification": {"status": "sent", "would_notify": True, "channel": "webex"},
  }

  with patch.dict(
    os.environ,
    {
      "LITELLM_TOKEN_ALERT_TARGETS_JSON": targets_json,
      "LITELLM_TOKEN_ALERT_DEDUPE_FILE": str(state_file),
      "LITELLM_TOKEN_ALERT_DEDUPE_TTL_SECONDS": "86400",
    },
    clear=False,
  ):
    with patch.object(
      token_alert_scanner.token_usage_alerts,
      "evaluate_token_usage_alert",
      new=AsyncMock(side_effect=[preview_result, sent_result, preview_result]),
    ) as evaluate:
      first_scan = asyncio.run(token_alert_scanner.scan_token_usage_alerts(param_dry_run=False))
      second_scan = asyncio.run(token_alert_scanner.scan_token_usage_alerts(param_dry_run=False))

  assert first_scan["notifications_sent"] == 1
  assert first_scan["notifications_deduped"] == 0
  assert second_scan["notifications_sent"] == 0
  assert second_scan["notifications_deduped"] == 1
  assert second_scan["results"][0]["result"]["notification"]["status"] == "deduped"
  assert evaluate.await_count == 3
