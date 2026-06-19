import asyncio
import os
from unittest.mock import AsyncMock, patch

os.environ.setdefault("LITELLM_API_URL", "https://litellm.test")
os.environ.setdefault("LITELLM_API_KEY", "test-token")

from mcp_litellm.tools import token_usage_alerts  # noqa: E402


def test_evaluate_token_usage_alert_suppresses_notification_when_disabled():
  mock_report = {
    "data": [
      {"date": "2026-06-18", "total_tokens": 400},
      {"date": "2026-06-19", "total_tokens": 450},
    ]
  }

  with patch.dict(os.environ, {"LITELLM_TOKEN_ALERTS_ENABLED": "false"}, clear=False):
    with patch.object(token_usage_alerts, "make_api_request", new=AsyncMock(return_value=(True, mock_report))):
      result = asyncio.run(
        token_usage_alerts.evaluate_token_usage_alert(
          param_user_id="user@example.com",
          param_token_limit=1000,
          param_start_date="2026-06-18",
          param_end_date="2026-06-19",
        )
      )

  assert result["used_tokens"] == 850
  assert result["usage_percent"] == 85
  assert result["threshold_reached"] is True
  assert result["alerting_enabled"] is False
  assert result["notification"] == {
    "status": "suppressed",
    "reason": "feature_disabled",
    "would_notify": True,
  }


def test_evaluate_token_usage_alert_does_not_notify_below_threshold():
  mock_report = {"data": [{"date": "2026-06-19", "total_tokens": 500}]}

  with patch.object(token_usage_alerts, "make_api_request", new=AsyncMock(return_value=(True, mock_report))):
    result = asyncio.run(
      token_usage_alerts.evaluate_token_usage_alert(
        param_user_id="user@example.com",
        param_token_limit=1000,
        param_start_date="2026-06-19",
        param_end_date="2026-06-19",
      )
    )

  assert result["usage_percent"] == 50
  assert result["threshold_reached"] is False
  assert result["notification"] == {"status": "not_needed", "would_notify": False}


def test_evaluate_token_usage_alert_requires_token_limit():
  with patch.dict(os.environ, {"LITELLM_TOKEN_ALERT_LIMITS_JSON": ""}, clear=False):
    result = asyncio.run(token_usage_alerts.evaluate_token_usage_alert(param_user_id="user@example.com"))

  assert result["error"] == "token_limit is required"
  assert "LITELLM_TOKEN_ALERT_LIMITS_JSON" in result["hint"]


def test_evaluate_token_usage_alert_uses_env_limit_map():
  mock_report = {"data": [{"date": "2026-06-19", "total_tokens": 800}]}

  with patch.dict(os.environ, {"LITELLM_TOKEN_ALERT_LIMITS_JSON": '{"user@example.com":1000}'}, clear=False):
    with patch.object(token_usage_alerts, "make_api_request", new=AsyncMock(return_value=(True, mock_report))):
      result = asyncio.run(
        token_usage_alerts.evaluate_token_usage_alert(
          param_user_id="user@example.com",
          param_start_date="2026-06-19",
          param_end_date="2026-06-19",
        )
      )

  assert result["token_limit"] == 1000
  assert result["usage_percent"] == 80
  assert result["threshold_reached"] is True


def test_evaluate_token_usage_alert_sends_webex_when_enabled_and_allowed():
  mock_report = {"data": [{"date": "2026-06-19", "total_tokens": 850}]}

  with patch.dict(
    os.environ,
    {
      "LITELLM_TOKEN_ALERTS_ENABLED": "true",
      "LITELLM_TOKEN_ALERT_NOTIFICATION_CHANNEL": "webex",
      "LITELLM_TOKEN_ALERT_ALLOWED_RECIPIENTS": "mouledel@example.com",
    },
    clear=False,
  ):
    with patch.object(token_usage_alerts, "make_api_request", new=AsyncMock(return_value=(True, mock_report))):
      with patch.object(
        token_usage_alerts,
        "_send_webex_notification",
        new=AsyncMock(return_value={"status": "sent", "channel": "webex", "would_notify": True}),
      ) as send_webex:
        result = asyncio.run(
          token_usage_alerts.evaluate_token_usage_alert(
            param_user_id="mouledel",
            param_token_limit=1000,
            param_start_date="2026-06-19",
            param_end_date="2026-06-19",
            param_dry_run=False,
            param_notification_recipient="mouledel@example.com",
          )
        )

  send_webex.assert_awaited_once()
  send_args = send_webex.await_args.args
  assert send_args[0] == "mouledel@example.com"
  assert send_args[1].startswith("⚠️ **LiteLLM Token Usage Warning**")
  assert "**User:** `mouledel`" in send_args[1]
  assert "**Usage:** **85.0%** of the configured token limit" in send_args[1]
  assert "**Tokens used:** `850 / 1,000`" in send_args[1]
  assert "**Alert threshold:** `80.0%`" in send_args[1]
  assert "**Report period:** `2026-06-19 to 2026-06-19`" in send_args[1]
  assert "**Action:** Please review current usage or request a higher token limit from the platform team" in send_args[1]
  assert result["threshold_reached"] is True
  assert result["notification"] == {"status": "sent", "channel": "webex", "would_notify": True}
  assert result["notification_recipient"] == "mouledel@example.com"
  assert result["message"] == send_args[1]


def test_evaluate_token_usage_alert_suppresses_webex_when_recipient_not_allowed():
  mock_report = {"data": [{"date": "2026-06-19", "total_tokens": 850}]}

  with patch.dict(
    os.environ,
    {
      "LITELLM_TOKEN_ALERTS_ENABLED": "true",
      "LITELLM_TOKEN_ALERT_NOTIFICATION_CHANNEL": "webex",
      "LITELLM_TOKEN_ALERT_ALLOWED_RECIPIENTS": "other@example.com",
    },
    clear=False,
  ):
    with patch.object(token_usage_alerts, "make_api_request", new=AsyncMock(return_value=(True, mock_report))):
      with patch.object(token_usage_alerts, "_send_webex_notification", new=AsyncMock()) as send_webex:
        result = asyncio.run(
          token_usage_alerts.evaluate_token_usage_alert(
            param_user_id="mouledel",
            param_token_limit=1000,
            param_start_date="2026-06-19",
            param_end_date="2026-06-19",
            param_dry_run=False,
            param_notification_recipient="mouledel@example.com",
          )
        )

  send_webex.assert_not_awaited()
  assert result["notification"] == {
    "status": "suppressed",
    "reason": "recipient_not_allowed",
    "channel": "webex",
    "would_notify": True,
  }
