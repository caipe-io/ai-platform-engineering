# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""
Scoring utilities for submitting user feedback via the unified /api/feedback endpoint.

All feedback (Langfuse scores + MongoDB writes) is handled by the Next.js
feedback API so that Slack and web feedback flow through a single code path.
"""

import os
import requests
from typing import Optional
from loguru import logger

from .session_manager import SessionManager
from .config_models import Config


def regenerate_requested(view_values: dict) -> bool:
  """Return True if the user opted in to regenerating a response.

  The feedback modal has an optional, off-by-default checkbox
  ("Attempt to regenerate a response based on feedback?"). Feedback is always
  recorded; the bot only regenerates when this box is ticked. Slack reports a
  checkbox as a ``selected_options`` list under its block_id / action_id; a
  non-empty list means it's ticked.

  Args:
      view_values: the modal's ``view["state"]["values"]`` mapping.
  """
  if not isinstance(view_values, dict):
    return False
  selected = (
    view_values.get("regen_input", {})
    .get("regen", {})
    .get("selected_options")
  )
  return bool(selected)


def _build_slack_permalink(
  channel_id: str,
  thread_ts: str,
  message_ts: Optional[str],
  workspace_url: str,
) -> Optional[str]:
  """Build a Slack permalink, linking to the specific bot reply when possible."""
  if not workspace_url:
    return None

  # Validate message_ts looks like a Slack timestamp (digits with a dot)
  valid_message_ts = message_ts and "." in message_ts and message_ts.replace(".", "").isdigit()

  if valid_message_ts and message_ts != thread_ts:
    ts_clean = message_ts.replace(".", "")
    return f"{workspace_url}/archives/{channel_id}/p{ts_clean}?thread_ts={thread_ts}&cid={channel_id}"

  return f"{workspace_url}/archives/{channel_id}/p{thread_ts.replace('.', '')}"


def submit_feedback_score(
  thread_ts: str,
  user_id: str,
  channel_id: str,
  feedback_value: str,
  slack_client,
  session_manager: SessionManager,
  config: Config,
  conversation_id: str,
  comment: Optional[str] = None,
  message_ts: Optional[str] = None,
) -> bool:
  """
  Submit feedback by calling POST /api/feedback on the CAIPE UI.

  The API handles both Langfuse scoring and MongoDB writes.

  Args:
      thread_ts: Slack thread timestamp.
      user_id: Slack user ID.
      channel_id: Slack channel ID.
      feedback_value: Feedback type (e.g. thumbs_up, thumbs_down, retry).
      slack_client: Slack WebClient.
      session_manager: Session manager for user info caching.
      config: Bot configuration.
      conversation_id: Server-side conversation ID (resolved via idempotency_key).
      comment: Optional feedback comment text.
      message_ts: Optional specific message timestamp.
  """
  trace_id = None  # Trace ID tracking removed in AG-UI migration

  # Resolve user email from Slack
  user_email = None
  try:
    cached_user_info = session_manager.get_user_info(user_id)
    if cached_user_info:
      user_email = cached_user_info.get("user", {}).get("profile", {}).get("email")
    else:
      user_info_response = slack_client.users_info(user=user_id)
      if user_info_response:
        user_info = user_info_response.data
        session_manager.set_user_info(user_id, user_info)
        user_email = user_info.get("user", {}).get("profile", {}).get("email")
  except Exception as e:
    logger.warning(f"Could not get user email: {e}")

  # Channel name from config; DMs won't be in config.channels
  is_dm = channel_id.startswith("D") if channel_id else False
  channel_name = None
  if channel_id in config.channels:
    channel_name = config.channels[channel_id].name
  display_channel_name = channel_name or ("DM" if is_dm else None)

  # Permalink
  slack_workspace_url = os.environ.get("SLACK_WORKSPACE_URL", "")
  slack_permalink = _build_slack_permalink(
    channel_id,
    thread_ts,
    message_ts,
    slack_workspace_url,
  )

  # Map feedback_value to feedbackType for the API
  feedback_type = "like" if feedback_value == "thumbs_up" else "dislike"

  payload = {
    "traceId": trace_id,
    "messageId": message_ts if message_ts and "." in message_ts and message_ts.replace(".", "").isdigit() else None,
    "feedbackType": feedback_type,
    "value": feedback_value,
    "conversationId": conversation_id,
    "source": "slack",
    "channelId": channel_id,
    "channelName": display_channel_name,
    "threadTs": thread_ts,
    "slackPermalink": slack_permalink,
    "userId": user_id,
  }
  if comment:
    payload["reason"] = comment
  if user_email:
    payload["userEmail"] = user_email

  # Call the unified feedback API
  feedback_api_url = os.environ.get("CAIPE_API_URL", "http://localhost:3000")
  url = f"{feedback_api_url.rstrip('/')}/api/feedback"

  try:
    response = requests.post(url, json=payload, timeout=10)
    if response.status_code == 200:
      data = response.json()
      logger.info(f"Feedback API response: {data}")
      return data.get("success", False)
    else:
      logger.warning(f"Feedback API returned {response.status_code}: {response.text}")
      return False
  except Exception as e:
    logger.warning(f"Failed to call feedback API at {url}: {e}")
    return False
