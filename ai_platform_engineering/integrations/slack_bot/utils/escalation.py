# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""
Escalation workflows triggered by the 'Get help' button.

Supports three configurable actions (all fire if enabled):
1. VictorOps on-call ping — queries AI for the on-call email, resolves Slack user, @-mentions them
2. Direct user/group ping — @-mentions configured Slack users or groups
3. Emoji reaction — adds a configured emoji to the parent message
"""

import re

from loguru import logger

from sse_client import SSEEventType
from utils.config_models import EscalationConfig


def execute_escalation(
  slack_client,
  sse_client,
  channel_id: str,
  thread_ts: str,
  parent_ts: str,
  user_id: str,
  escalation_config: EscalationConfig,
  agent_id: str = "",
):
  """Run all configured escalation actions.

  Args:
      slack_client: Slack Web API client.
      sse_client: SSEClient for streaming AI queries.
      channel_id: Slack channel ID.
      thread_ts: Thread timestamp (used for replies).
      parent_ts: Parent message timestamp (used for emoji reactions).
      user_id: Slack user ID of the person who triggered escalation.
      escalation_config: Parsed escalation configuration.
      agent_id: Agent ID for VictorOps AI queries (channel default).

  Returns:
      List of result summary strings.
  """
  results = []

  if escalation_config.victorops.enabled and escalation_config.victorops.team:
    result = _ping_victorops_oncall(
      sse_client,
      slack_client,
      channel_id,
      thread_ts,
      escalation_config.victorops.team,
      agent_id=agent_id,
    )
    results.append(result)

  if escalation_config.users:
    result = _ping_users(slack_client, channel_id, thread_ts, escalation_config.users)
    results.append(result)

  if escalation_config.emoji.enabled:
    result = _add_emoji_reaction(
      slack_client,
      channel_id,
      parent_ts,
      escalation_config.emoji.name,
    )
    results.append(result)

  return results


def _ping_victorops_oncall(
  sse_client,
  slack_client,
  channel_id: str,
  thread_ts: str,
  team: str,
  agent_id: str,
) -> str:
  """Query the AI for VictorOps on-call via SSE, resolve to Slack user, and ping them."""
  if not agent_id:
    logger.error(f"[{thread_ts}] VictorOps: missing agent_id")
    slack_client.chat_postMessage(
      channel=channel_id,
      thread_ts=thread_ts,
      text=f"Could not determine on-call for team *{team}*. Please check VictorOps manually.",
    )
    return "victorops: missing agent_id"

  try:
    prompt = f"RESPOND IN 1 WORD THAT IS USER EMAIL. WHO IS ON CALL FOR TEAM {team}?"
    logger.info(f"[{thread_ts}] VictorOps: querying on-call for team {team} (agent={agent_id})")
    accumulated_text: list[str] = []

    # Register a fresh conversation (no idempotency_key) so the on-call lookup
    # does not inherit the channel thread history, which can be very large and
    # cause incorrect results. Retain the originating thread only as metadata
    # so authorized Insights viewers can navigate back to Slack.
    conv_result = sse_client.create_conversation(
      title="VictorOps on-call lookup",
      agent_id=agent_id,
      metadata={
        "channel_id": channel_id,
        "thread_ts": thread_ts,
      },
    )
    conversation_id = conv_result["conversation_id"]

    for event in sse_client.stream_chat(
      message=prompt,
      conversation_id=conversation_id,
      agent_id=agent_id,
    ):
      if event.type == SSEEventType.TEXT_MESSAGE_CONTENT and event.delta:
        accumulated_text.append(event.delta)
      elif event.type == SSEEventType.RUN_FINISHED:
        break

    full_text = "".join(accumulated_text).strip()
    logger.debug(f"[{thread_ts}] VictorOps: raw SSE response: {full_text!r}")

    oncall_email = None
    if full_text:
      # Use the last email match — the agent lists reasoning before its final answer,
      # so the correct on-call address appears last (not first).
      email_matches = re.findall(r"[a-zA-Z0-9.+-]+@[\w-]+\.[\w.]+", full_text)
      if email_matches:
        oncall_email = email_matches[-1].strip(".")

    if not oncall_email:
      logger.warning(f"[{thread_ts}] VictorOps: no email found in AI response for team {team}")
      slack_client.chat_postMessage(
        channel=channel_id,
        thread_ts=thread_ts,
        text=f"Could not determine on-call for team *{team}*. Please check VictorOps manually.",
      )
      return "victorops: could not determine on-call"

    # Resolve email to Slack user ID
    try:
      user_resp = slack_client.users_lookupByEmail(email=oncall_email)
      oncall_slack_id = user_resp["user"]["id"]
      slack_client.chat_postMessage(
        channel=channel_id,
        thread_ts=thread_ts,
        text=f"<@{oncall_slack_id}> — a user requested human help in this thread (on-call for *{team}*)",
      )
      return f"victorops: pinged {oncall_email} (<@{oncall_slack_id}>)"
    except Exception:
      slack_client.chat_postMessage(
        channel=channel_id,
        thread_ts=thread_ts,
        text=f"On-call for *{team}* is *{oncall_email}* but could not find their Slack account.",
      )
      return f"victorops: found {oncall_email} but no Slack account"

  except Exception as e:
    logger.exception(f"[{thread_ts}] VictorOps escalation failed: {e}")
    slack_client.chat_postMessage(
      channel=channel_id,
      thread_ts=thread_ts,
      text=f"Could not determine on-call for team *{team}*. Please check VictorOps manually.",
    )
    return f"victorops: error — {e}"


def _slack_mention(uid: str) -> str:
  return f"<!subteam^{uid}>" if uid.startswith("S") else f"<@{uid}>"


def _ping_users(slack_client, channel_id: str, thread_ts: str, user_ids: list[str]) -> str:
  """Directly @-mention configured users/groups in the thread."""
  try:
    mentions = " ".join(_slack_mention(uid) for uid in user_ids)
    slack_client.chat_postMessage(
      channel=channel_id,
      thread_ts=thread_ts,
      text=f"{mentions} — a user requested human assistance in this thread",
    )
    return f"users: pinged {len(user_ids)} user(s)"
  except Exception as e:
    logger.exception(f"[{thread_ts}] User ping escalation failed: {e}")
    return f"users: error — {e}"


def _add_emoji_reaction(slack_client, channel_id: str, parent_ts: str, emoji_name: str) -> str:
  """Add an emoji reaction to the parent message."""
  try:
    slack_client.reactions_add(
      name=emoji_name,
      channel=channel_id,
      timestamp=parent_ts,
    )
    return f"emoji: added :{emoji_name}:"
  except Exception as e:
    logger.exception(f"[{parent_ts}] Emoji escalation failed: {e}")
    return f"emoji: error — {e}"
