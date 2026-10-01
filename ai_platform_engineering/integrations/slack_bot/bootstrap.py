# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Slack bot process configuration, dependency construction, and startup."""

from __future__ import annotations

from dataclasses import dataclass
import os
import time
from typing import Mapping

from loguru import logger
import requests
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
from slack_bolt.response import BoltResponse

from sse_client import SSEClient
from utils.config import config
from utils.config_models import Config
from utils.hitl_handler import HITLCallbackHandler
from utils.oauth2_client import OAuth2ClientCredentials
from utils.session_manager import SessionManager
from utils.slack_admin_api import start_slack_admin_api_server


@dataclass(frozen=True)
class SlackRuntime:
  """Process-scoped dependencies owned by the composition root."""

  bolt_app: App
  config: Config
  sse_client: SSEClient
  session_manager: SessionManager
  hitl_handler: HITLCallbackHandler
  handled_response: BoltResponse
  app_name: str
  workspace_url: str
  workspace_id: str
  api_url: str
  rbac_enabled: bool
  command_rate_limit: int
  command_rate_window: float
  linking_prompt_cooldown: float


def build_runtime(environ: Mapping[str, str] | None = None) -> SlackRuntime:
  """Parse process settings and construct Slack handler dependencies."""
  env = environ or os.environ
  app_name = env.get("SLACK_INTEGRATION_APP_NAME", env.get("APP_NAME", "CAIPE"))
  workspace_url = env.get("SLACK_WORKSPACE_URL", "")

  auth_client = None
  auth_enabled = env.get("SLACK_INTEGRATION_ENABLE_AUTH", "false").lower() == "true"
  if auth_enabled:
    try:
      auth_client = OAuth2ClientCredentials.from_env()
      logger.info("OAuth2 client credentials auth enabled for dynamic agents requests")
    except RuntimeError as exc:
      logger.error("Failed to initialize OAuth2 auth: {}", exc)
      raise
  else:
    logger.info("Auth disabled (set SLACK_INTEGRATION_ENABLE_AUTH=true to enable)")

  api_url = env.get("CAIPE_API_URL")
  if not api_url:
    raise ValueError("CAIPE_API_URL environment variable is required")

  bolt_app = App(
    token=env.get("SLACK_INTEGRATION_BOT_TOKEN", env.get("SLACK_BOT_TOKEN", ""))
  )
  sse_client = SSEClient(api_url, timeout=300, auth_client=auth_client)
  session_manager = SessionManager()

  logger.info("SLACK_WORKSPACE_URL={}", workspace_url or "(not set)")
  logger.info("SSE client initialized at {}", api_url)
  logger.info("Session store type: {}", session_manager.get_store_type())

  rbac_enabled = env.get("SLACK_RBAC_ENABLED", "false").lower() == "true"
  logger.info(
    "Enterprise RBAC enforcement {} for Slack bot",
    "enabled" if rbac_enabled else "disabled",
  )

  return SlackRuntime(
    bolt_app=bolt_app,
    config=config,
    sse_client=sse_client,
    session_manager=session_manager,
    hitl_handler=HITLCallbackHandler(sse_client),
    handled_response=BoltResponse(status=200, body=""),
    app_name=app_name,
    workspace_url=workspace_url,
    workspace_id=env.get("SLACK_WORKSPACE_ID", ""),
    api_url=api_url,
    rbac_enabled=rbac_enabled,
    command_rate_limit=int(env.get("SLACK_COMMAND_RATE_LIMIT", "5")),
    command_rate_window=float(env.get("SLACK_COMMAND_RATE_WINDOW", "30")),
    linking_prompt_cooldown=float(env.get("SLACK_LINKING_PROMPT_COOLDOWN", "3600")),
  )


def wait_for_api(runtime: SlackRuntime, environ: Mapping[str, str] | None = None) -> None:
  """Block process startup until the CAIPE API health endpoint is ready."""
  env = environ or os.environ
  max_retries = int(env.get("CAIPE_CONNECT_RETRIES", "10"))
  retry_delay = int(env.get("CAIPE_CONNECT_RETRY_DELAY", "6"))

  for attempt in range(1, max_retries + 1):
    try:
      logger.info(
        "Connecting to {} at {} (attempt {}/{})",
        runtime.app_name,
        runtime.api_url,
        attempt,
        max_retries,
      )
      response = requests.get(f"{runtime.api_url.rstrip('/')}/api/health", timeout=10)
      if not response.ok:
        raise RuntimeError(
          f"Health check returned {response.status_code}: {response.text}"
        )
      logger.info("Connected to {} API (status {})", runtime.app_name, response.status_code)
      return
    except Exception as exc:
      if attempt < max_retries:
        logger.warning(
          "{} API not ready, retrying in {}s...", runtime.app_name, retry_delay
        )
        time.sleep(retry_delay)
        continue
      logger.error(
        "Failed to connect to {} after {} attempts: {}.",
        runtime.app_name,
        max_retries,
        exc,
      )
      raise SystemExit(1) from exc


def run_runtime(runtime: SlackRuntime, environ: Mapping[str, str] | None = None) -> None:
  """Verify dependencies, start the admin API, and serve Slack requests."""
  env = environ or os.environ
  wait_for_api(runtime, env)
  start_slack_admin_api_server(runtime.config)

  bot_mode = env.get(
    "SLACK_INTEGRATION_BOT_MODE", env.get("SLACK_BOT_MODE", "socket")
  ).lower()
  if bot_mode == "http":
    port = int(env.get("PORT", "3000"))
    logger.info("Starting {} Slack Bot in HTTP mode on port {}", runtime.app_name, port)
    runtime.bolt_app.start(port=port)
    return

  logger.info("Starting {} Slack Bot in Socket Mode", runtime.app_name)
  app_token = env.get("SLACK_INTEGRATION_APP_TOKEN", env.get("SLACK_APP_TOKEN", ""))
  SocketModeHandler(runtime.bolt_app, app_token).start()
