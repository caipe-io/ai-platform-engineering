# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""
Slack Thread Context Utilities

Handles fetching and building conversation context from Slack threads:
- Fetch thread history
- Get user display names
- Build formatted conversation context for AI (full + delta)
- Extract message text from events
"""

import os
from typing import List, Dict, Any, Optional
from loguru import logger

APP_NAME = os.environ.get("SLACK_INTEGRATION_APP_NAME", os.environ.get("APP_NAME", "CAIPE"))

THREAD_HISTORY_LIMIT = int(os.environ.get("SLACK_INTEGRATION_THREAD_HISTORY_LIMIT", "50"))


def fetch_thread_history(
  app,
  channel_id: str,
  thread_ts: str,
  oldest: Optional[str] = None,
  limit: int = THREAD_HISTORY_LIMIT,
) -> List[Dict[str, Any]]:
  """Fetch messages from a Slack thread.

  Args:
      app: Slack Bolt app instance.
      channel_id: Slack channel ID.
      thread_ts: Thread root timestamp.
      oldest: If set, only return messages newer than this timestamp.
      limit: Maximum number of messages to fetch.

  Returns:
      List of message dicts from the Slack API.
  """
  try:
    kwargs: Dict[str, Any] = {
      "channel": channel_id,
      "ts": thread_ts,
      "limit": limit,
    }
    if oldest:
      kwargs["oldest"] = oldest
    result = app.client.conversations_replies(**kwargs)
    return result.get("messages", [])
  except Exception as e:
    logger.warning(f"Error fetching thread history: {e}")
    return []


def get_user_display_name(app, user_id: str) -> str:
  """Get display name for a user."""
  try:
    result = app.client.users_info(user=user_id)
    user = result.get("user", {})
    return user.get("profile", {}).get("display_name") or user.get("real_name") or user.get("name") or f"User {user_id}"
  except Exception as e:
    logger.warning(f"Error fetching user info: {e}")
    return f"User {user_id}"


def _is_our_bot(msg: Dict[str, Any], bot_user_id: str) -> bool:
  """Check whether a Slack message was sent by our bot."""
  if msg.get("bot_id"):
    user_id = msg.get("user")
    return user_id is not None and user_id == bot_user_id
  return False


def _label_speaker(app, msg: Dict[str, Any], bot_user_id: str) -> str:
  """Return a human-readable speaker label for a Slack message."""
  user_id = msg.get("user")
  bot_id = msg.get("bot_id")

  if bot_id or (user_id and user_id == bot_user_id):
    return APP_NAME
  elif user_id:
    return get_user_display_name(app, user_id)
  return "Unknown"


def build_thread_context(app, channel_id: str, thread_ts: str, current_message: str, bot_user_id: str) -> str:
  """Build formatted conversation context from a full thread.

  Used on the **first** bot interaction in a thread (``created=True``) to
  give the agent awareness of all prior messages, including those between
  humans that happened before the bot was invoked.

  Messages are capped to :data:`THREAD_HISTORY_LIMIT`.
  """
  messages = fetch_thread_history(app, channel_id, thread_ts)

  if not messages:
    return current_message

  # Cap to the most recent N messages (keep tail)
  if len(messages) > THREAD_HISTORY_LIMIT:
    messages = messages[-THREAD_HISTORY_LIMIT:]

  conversation_lines = ["Previous conversation:"]
  conversation_lines.append("---")

  for msg in messages:
    full_text = extract_message_text(msg)

    if not full_text.strip():
      continue

    speaker = _label_speaker(app, msg, bot_user_id)
    conversation_lines.append(f"{speaker}: {full_text}")

  conversation_lines.append("---")
  conversation_lines.append(f"Current question: {current_message}")

  return "\n".join(conversation_lines)


def build_delta_context(
  app,
  channel_id: str,
  thread_ts: str,
  current_message: str,
  bot_user_id: str,
  since_ts: str,
  cap: int = THREAD_HISTORY_LIMIT,
) -> str:
  """Build context containing only messages new since the bot's last turn.

  Used on **follow-up** interactions in a thread (``created=False``) to
  avoid re-sending the full history that the agent already has in its
  LangGraph checkpoint chain.

  Only non-bot messages are included — the agent already has its own prior
  messages in checkpoints.  Other bots' messages (e.g. alert bots) are kept.

  Args:
      app: Slack Bolt app instance.
      channel_id: Slack channel ID.
      thread_ts: Thread root timestamp.
      current_message: The user's current message text.
      bot_user_id: Our bot's Slack user ID (to filter out our messages).
      since_ts: Only include messages newer than this timestamp.
      cap: Maximum number of context messages to include.

  Returns:
      The user's message, optionally prefixed with a delta context preamble.
  """
  messages = fetch_thread_history(app, channel_id, thread_ts, oldest=since_ts)

  # Filter out our bot's own messages (agent has those in checkpoints)
  new_messages = [m for m in messages if not _is_our_bot(m, bot_user_id)]

  # Also filter out the current message itself (it will be appended at the end)
  # The current message has the same ts as event["ts"]
  new_messages = [m for m in new_messages if m.get("ts") != since_ts]

  if not new_messages:
    return current_message

  # Cap to the most recent N (keep tail)
  if len(new_messages) > cap:
    new_messages = new_messages[-cap:]

  lines = [
    f"Since your last message, the following conversation took place (last {len(new_messages)} messages):",
    "---",
  ]

  for msg in new_messages:
    full_text = extract_message_text(msg)
    if not full_text.strip():
      continue
    speaker = _label_speaker(app, msg, bot_user_id)
    lines.append(f"{speaker}: {full_text}")

  lines.append("---")
  lines.append(f"Current question: {current_message}")

  return "\n".join(lines)


def _extract_blocks_text(blocks: list, content_parts: list) -> None:
  """Extract text from a list of Slack Block Kit blocks into content_parts."""
  for block in blocks:
    if block.get("type") == "section" and block.get("text"):
      block_text = block["text"].get("text", "")
      if block_text and block_text not in content_parts:
        content_parts.append(block_text)
    elif block.get("type") == "context":
      for element in block.get("elements", []):
        if element.get("type") == "mrkdwn":
          elem_text = element.get("text", "")
          if elem_text and elem_text not in content_parts:
            content_parts.append(elem_text)
    elif block.get("type") == "header" and block.get("text"):
      header_text = block["text"].get("text", "")
      if header_text and header_text not in content_parts:
        content_parts.append(f"**{header_text}**")


def extract_message_text(event: Dict[str, Any]) -> str:
  """Extract comprehensive message text from a Slack event."""
  content_parts = []

  text = event.get("text", "")
  if text.strip():
    content_parts.append(text)

  if event.get("blocks"):
    _extract_blocks_text(event.get("blocks", []), content_parts)

  if event.get("attachments"):
    for attachment in event.get("attachments", []):
      if attachment.get("title"):
        content_parts.append(f"Title: {attachment['title']}")
      if attachment.get("text"):
        content_parts.append(attachment["text"])
      if attachment.get("pretext"):
        content_parts.append(attachment["pretext"])
      if attachment.get("fields"):
        for field in attachment["fields"]:
          field_title = field.get("title", "")
          field_value = field.get("value", "")
          if field_title or field_value:
            content_parts.append(f"{field_title}: {field_value}")
      # Some integrations post with text="" and all content inside
      # attachment.blocks (nested Block Kit).
      if attachment.get("blocks"):
        _extract_blocks_text(attachment.get("blocks", []), content_parts)

  return "\n".join(content_parts).strip()
