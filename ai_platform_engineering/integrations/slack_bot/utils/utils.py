# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
import os
import requests
import json
from functools import lru_cache
from .config import config
from loguru import logger


# One-shot warn flag for the "missing_scope" branch in get_channel_context.
# Logged once per process, then suppressed to avoid log spam when the bot
# lacks channels:read / groups:read / im:read / mpim:read.
_MISSING_CHANNEL_SCOPE_LOGGED: bool = False


def verify_thread_exists(client, channel_id: str, thread_ts: str) -> bool:
  """Verify that thread_ts references a message that still exists.

  When a user posts a message and deletes it before the event reaches the bot,
  thread_ts points to a non-existent message.  Slack's chat_postMessage silently
  falls back to posting in the main channel instead of erroring, so we must
  check proactively.

  Returns True if the parent message exists, False otherwise.
  """
  try:
    result = client.conversations_replies(channel=channel_id, ts=thread_ts, limit=1, inclusive=True)
    messages = result.get("messages", [])
    if not messages:
      logger.warning(f"[{thread_ts}] No message found for thread_ts (channel={channel_id}) — deleted message or ephemeral/slash-command response")
    return len(messages) > 0
  except Exception as e:
    error_str = str(e)
    if "thread_not_found" in error_str or "message_not_found" in error_str:
      logger.warning(f"[{thread_ts}] Thread parent message was deleted (channel={channel_id})")
      return False
    logger.warning(f"[{thread_ts}] Could not verify thread existence: {e}")
    # On unexpected errors, allow processing to continue rather than silently dropping
    return True


def is_configured_channel(channel_id):
  return channel_id in config.channels


def get_current_channel_id(event):
  """Extract channel ID from a Slack event."""
  return event["channel"]


@lru_cache(maxsize=32)
def get_bot_info_by_id(bot_id):
  """
  Get bot name and user_id from bot ID using Slack API.
  Results are cached to avoid repeated API calls.

  Returns:
      Tuple of (bot_name, bot_user_id). Either may be empty string on failure.
  """
  url = "https://slack.com/api/bots.info"
  headers = {
    "Authorization": "Bearer " + os.environ.get("SLACK_INTEGRATION_BOT_TOKEN", os.environ.get("SLACK_BOT_TOKEN", "")),
    "Content-Type": "application/x-www-form-urlencoded",
  }
  payload = "bot={}".format(bot_id)

  try:
    response = requests.request("POST", url, headers=headers, data=payload)
  except requests.exceptions.RequestException as e:
    logger.warning(e)
    return ("", "")

  response_dict = json.loads(response.text)
  if response_dict["ok"]:
    bot = response_dict["bot"]
    return (bot.get("name", ""), bot.get("user_id", ""))
  else:
    logger.info(response_dict)
    return ("", "")


def get_username_by_bot_id(bot_id):
  """Get bot username from bot ID. Convenience wrapper around get_bot_info_by_id."""
  return get_bot_info_by_id(bot_id)[0]


def get_message_author_info(event, client):
  """
  Get author name and email from a Slack event.
  Handles both regular user messages and bot messages.

  Returns:
      Tuple of (user_name, user_email)
  """
  user_id = event.get("user")
  bot_id = event.get("bot_id")

  if bot_id:
    user_name = get_username_by_bot_id(bot_id)
    user_email = None
  else:
    try:
      user_info = client.users_info(user=user_id)
      user_data = user_info.get("user", {})
      user_name = user_data.get("real_name") or user_data.get("name") or user_id
      user_email = user_data.get("profile", {}).get("email")
    except Exception as e:
      logger.error(f"Error getting user info: {e}")
      user_name = user_id
      user_email = None

  return user_name, user_email


# Module-level guard so we only log the "missing scope" warning once per
# process instead of on every channel lookup. The operator only needs to see
# the remediation hint a single time; after that the bot continues to work
# (channel topic/purpose just stay empty).
_MISSING_CHANNEL_SCOPE_LOGGED = False


def get_channel_context(client, channel_id: str, session_mgr) -> dict:
  """Fetch channel topic and purpose, with TTL cache via session manager.

  Returns a dict with 'topic' and 'purpose' (empty strings if unavailable).

  When the bot's Slack token is missing the ``channels:read`` /
  ``groups:read`` / ``im:read`` / ``mpim:read`` scopes (depends on channel
  type), `conversations.info` returns a ``missing_scope`` SlackApiError. We
  treat that as a soft failure: log once with operator guidance, then cache
  the empty result so we don't keep hitting the Slack API and tripping rate
  limits for something we know will fail.
  """
  cached = session_mgr.get_channel_info(channel_id)
  if cached is not None:
    return cached

  info = {"topic": "", "purpose": ""}
  try:
    result = client.conversations_info(channel=channel_id)
    channel = result.get("channel", {})
    info["topic"] = (channel.get("topic") or {}).get("value", "")
    info["purpose"] = (channel.get("purpose") or {}).get("value", "")
  except Exception as e:
    # Slack SDK exposes the response payload on the exception; sniffing the
    # `error` key avoids importing the SDK type just for isinstance().
    err_code = ""
    response = getattr(e, "response", None)
    if response is not None:
      try:
        err_code = (response.data or {}).get("error", "")
      except Exception:  # pragma: no cover — defensive
        err_code = ""

    if err_code == "missing_scope":
      global _MISSING_CHANNEL_SCOPE_LOGGED
      if not _MISSING_CHANNEL_SCOPE_LOGGED:
        logger.warning(
          "Slack bot token is missing channel-read scopes "
          "(channels:read / groups:read / im:read / mpim:read). "
          "Channel topic/purpose context will be empty for all channels. "
          "Add the missing scopes to the Slack app manifest, reinstall the "
          "app, and update SLACK_BOT_TOKEN. This warning will not repeat."
        )
        _MISSING_CHANNEL_SCOPE_LOGGED = True
      # else: silent — operator has been told once.
    else:
      logger.warning(f"Could not fetch channel info for {channel_id}: {e}")

  session_mgr.set_channel_info(channel_id, info)
  return info
