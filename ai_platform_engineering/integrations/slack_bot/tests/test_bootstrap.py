# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for Slack process dependency construction and health retry."""

from __future__ import annotations

import pathlib
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import requests

_APP_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(_APP_DIR) not in sys.path:
  sys.path.insert(0, str(_APP_DIR))

import bootstrap  # noqa: E402


def test_build_runtime_constructs_dependencies_without_health_call(monkeypatch) -> None:
  bolt_app = MagicMock()
  sse_client = MagicMock()
  session_manager = MagicMock()
  session_manager.get_store_type.return_value = "memory"
  health_call = MagicMock(side_effect=AssertionError("health called during construction"))

  monkeypatch.setattr(bootstrap, "App", MagicMock(return_value=bolt_app))
  monkeypatch.setattr(bootstrap, "SSEClient", MagicMock(return_value=sse_client))
  monkeypatch.setattr(bootstrap, "SessionManager", MagicMock(return_value=session_manager))
  monkeypatch.setattr(bootstrap, "HITLCallbackHandler", MagicMock())
  monkeypatch.setattr(bootstrap.requests, "get", health_call)

  runtime = bootstrap.build_runtime(
    {
      "CAIPE_API_URL": "https://api.example.com",
      "SLACK_INTEGRATION_BOT_TOKEN": "xoxb-example-token",
      "SLACK_INTEGRATION_APP_NAME": "Example",
      "SLACK_WORKSPACE_URL": "https://example.com",
      "SLACK_WORKSPACE_ID": "example-workspace",
      "SLACK_RBAC_ENABLED": "true",
      "SLACK_COMMAND_RATE_LIMIT": "7",
      "SLACK_COMMAND_RATE_WINDOW": "45",
      "SLACK_LINKING_PROMPT_COOLDOWN": "120",
    }
  )

  assert runtime.bolt_app is bolt_app
  assert runtime.sse_client is sse_client
  assert runtime.app_name == "Example"
  assert runtime.rbac_enabled is True
  assert runtime.command_rate_limit == 7
  assert runtime.command_rate_window == 45.0
  assert runtime.linking_prompt_cooldown == 120.0
  health_call.assert_not_called()


def test_build_runtime_logs_oauth_failure_before_api_url_validation(monkeypatch) -> None:
  auth_error = RuntimeError("credentials unavailable")
  from_env = MagicMock(side_effect=auth_error)
  log_error = MagicMock()
  monkeypatch.setattr(bootstrap.OAuth2ClientCredentials, "from_env", from_env)
  monkeypatch.setattr(bootstrap.logger, "error", log_error)

  with pytest.raises(RuntimeError, match="credentials unavailable"):
    bootstrap.build_runtime({"SLACK_INTEGRATION_ENABLE_AUTH": "true"})

  from_env.assert_called_once_with()
  log_error.assert_called_once_with("Failed to initialize OAuth2 auth: {}", auth_error)


def test_wait_for_api_preserves_retry_behavior(monkeypatch) -> None:
  response = SimpleNamespace(ok=True, status_code=200, text="ok")
  health_call = MagicMock(
    side_effect=[requests.ConnectionError("not ready"), response]
  )
  sleep = MagicMock()
  monkeypatch.setattr(bootstrap.requests, "get", health_call)
  monkeypatch.setattr(bootstrap.time, "sleep", sleep)

  bootstrap.wait_for_api(
    SimpleNamespace(app_name="Example", api_url="https://api.example.com"),
    {"CAIPE_CONNECT_RETRIES": "2", "CAIPE_CONNECT_RETRY_DELAY": "3"},
  )

  assert health_call.call_count == 2
  sleep.assert_called_once_with(3)


def test_wait_for_api_retries_unexpected_exceptions(monkeypatch) -> None:
  response = SimpleNamespace(ok=True, status_code=200, text="ok")
  health_call = MagicMock(side_effect=[ValueError("unexpected"), response])
  sleep = MagicMock()
  monkeypatch.setattr(bootstrap.requests, "get", health_call)
  monkeypatch.setattr(bootstrap.time, "sleep", sleep)

  bootstrap.wait_for_api(
    SimpleNamespace(app_name="Example", api_url="https://api.example.com"),
    {"CAIPE_CONNECT_RETRIES": "2", "CAIPE_CONNECT_RETRY_DELAY": "3"},
  )

  assert health_call.call_count == 2
  sleep.assert_called_once_with(3)
