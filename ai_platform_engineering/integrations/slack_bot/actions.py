# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Slack feedback, HITL, retry, escalation, deletion, and passive events."""

from __future__ import annotations

from typing import Any

from loguru import logger

from authorization import _bind_obo_for_handler
from channel_routing import _resolve_escalation
from conversation import _call_ai, _resolve_conversation_id
from handler_dependencies import ActionDependencies
from sse_client import SSEClient
from utils import ai, slack_context, utils
from utils.config_models import Config
from utils.escalation import execute_escalation
from utils.hitl_handler import HITLCallbackHandler
from utils.platform_settings import resolve_victorops_agent_id
from utils.scoring import regenerate_requested, submit_feedback_score
from utils.session_manager import SessionManager


app: Any = None
config: Config
sse_client: SSEClient
session_manager: SessionManager
hitl_handler: HITLCallbackHandler
APP_NAME = "CAIPE"


def configure_actions(dependencies: ActionDependencies) -> None:
  """Install process-scoped collaborators used by action handlers."""
  global app, config, sse_client, session_manager, hitl_handler, APP_NAME

  app = dependencies.bolt_app
  config = dependencies.config
  sse_client = dependencies.sse_client
  session_manager = dependencies.session_manager
  hitl_handler = dependencies.hitl_handler
  APP_NAME = dependencies.app_name


def handle_hitl_action(ack: Any, body: dict[str, Any], client: Any) -> None:
  ack()
  try:
    result = hitl_handler.handle_interaction(body, client)
    if result and result.get("resume_context"):
      ctx = result["resume_context"]
      thread_ts = ctx.get("thread_ts")
      channel_id = ctx.get("channel_id")

      if thread_ts and channel_id and ctx.get("conversation_id") and ctx.get("agent_id"):
        # Get team_id and user_id from the interaction payload
        team_id = body.get("team", {}).get("id")
        user_id = body.get("user", {}).get("id")

        # Process the resume stream
        ai.stream_response(
          sse_client=sse_client,
          slack_client=client,
          channel_id=channel_id,
          thread_ts=thread_ts,
          message_text="",  # Not used for resume
          team_id=team_id,
          user_id=user_id,
          agent_id=ctx["agent_id"],
          conversation_id=ctx["conversation_id"],
          is_resume=True,
          resume_form_data=ctx.get("form_data"),
        )
      else:
        logger.warning(f"HITL resume missing required context: {ctx}")
    elif result:
      logger.info(f"HITL action processed: {result}")
  except Exception as e:
    logger.exception(f"Error handling HITL action: {e}")


# =============================================================================
# Feedback Action Handler
# =============================================================================
def handle_caipe_feedback(
  ack: Any, body: dict[str, Any], client: Any, context: Any = None
) -> None:
  ack()
  _bind_obo_for_handler(context)
  try:
    user_id = body.get("user", {}).get("id")
    channel_id = body.get("channel", {}).get("id")
    message = body.get("message", {})
    message_ts = message.get("ts")
    thread_ts = message.get("thread_ts") or message_ts

    actions = body.get("actions", [])
    if not actions:
      return

    action = actions[0]
    value = action.get("value", "")
    parts = value.split("|")
    feedback_type = parts[0] if parts else value
    agent_id = parts[2] if len(parts) > 2 else ""
    is_positive = feedback_type == "positive"

    feedback_value = "thumbs_up" if is_positive else "thumbs_down"
    conversation_id = _resolve_conversation_id(thread_ts, channel_id, agent_id)
    submit_feedback_score(
      thread_ts=thread_ts,
      user_id=user_id,
      channel_id=channel_id,
      feedback_value=feedback_value,
      slack_client=client,
      session_manager=session_manager,
      config=config,
      conversation_id=conversation_id,
      message_ts=message_ts,
    )

    if is_positive:
      client.chat_postEphemeral(
        channel=channel_id,
        user=user_id,
        thread_ts=thread_ts,
        text="Thanks for the feedback! Glad it was helpful.",
      )
    else:
      action_value = f"{channel_id}|{thread_ts}|{message_ts}|{agent_id}"
      action_elements = [
        {"type": "button", "text": {"type": "plain_text", "text": "More detail"}, "action_id": "caipe_feedback_more_detail", "value": action_value},
        {"type": "button", "text": {"type": "plain_text", "text": "Briefer"}, "action_id": "caipe_feedback_less_verbose", "value": action_value},
        {"type": "button", "text": {"type": "plain_text", "text": "Wrong answer"}, "action_id": "caipe_feedback_wrong_answer", "value": action_value},
        {"type": "button", "text": {"type": "plain_text", "text": "Other"}, "action_id": "caipe_feedback_other", "value": action_value},
      ]

      # Add "Get help" button if escalation is configured
      channel_config = config.channels.get(channel_id)
      esc_config = _resolve_escalation(channel_config, agent_id=agent_id or None, channel_id=channel_id)
      if esc_config:
        action_elements.append({"type": "button", "text": {"type": "plain_text", "text": "\U0001f64b Get help"}, "action_id": "caipe_escalation_get_help", "value": action_value})

      refinement_blocks = [
        {"type": "section", "text": {"type": "mrkdwn", "text": "Sorry that wasn't helpful. What could be improved?"}},
        {"type": "actions", "elements": action_elements},
      ]
      client.chat_postEphemeral(
        channel=channel_id,
        user=user_id,
        thread_ts=thread_ts,
        blocks=refinement_blocks,
        text="What could be improved?",
      )
  except Exception as e:
    logger.exception(f"Error handling feedback: {e}")


def handle_feedback_more_detail(ack: Any, body: dict[str, Any], client: Any) -> None:
  _open_feedback_modal(ack, body, client, feedback_type="needs_detail")


def handle_feedback_less_verbose(ack: Any, body: dict[str, Any], client: Any) -> None:
  _open_feedback_modal(ack, body, client, feedback_type="too_verbose")


def handle_caipe_retry(
  ack: Any, body: dict[str, Any], client: Any, context: Any = None
) -> None:
  ack()
  _bind_obo_for_handler(context)
  try:
    user_id = body.get("user", {}).get("id")
    action = body.get("actions", [{}])[0]
    parts = action.get("value", "").split("|")
    channel_id = parts[0] if len(parts) > 0 else None
    thread_ts = parts[1] if len(parts) > 1 else None
    message_ts = parts[2] if len(parts) > 2 else None
    agent_id = parts[3] if len(parts) > 3 else ""
    if not channel_id or not thread_ts:
      return

    if not utils.is_configured_channel(channel_id):
      return

    channel_config = config.channels[channel_id]
    if not agent_id:
      agent_id = channel_config.agents[0].agent_id if channel_config.agents else ""
    conversation_id = _resolve_conversation_id(thread_ts, channel_id, agent_id)

    submit_feedback_score(
      thread_ts=thread_ts,
      user_id=user_id,
      channel_id=channel_id,
      feedback_value="retry",
      slack_client=client,
      session_manager=session_manager,
      config=config,
      conversation_id=conversation_id,
      message_ts=message_ts,
    )

    user_name, user_email = utils.get_message_author_info(body.get("user", {}), client)
    team_id = body.get("team", {}).get("id")
    bot_info = client.auth_test()
    bot_user_id = bot_info.get("user_id")

    thread_context = slack_context.build_thread_context(app, channel_id, thread_ts, "", bot_user_id)

    retry_message = ai.RETRY_PROMPT_PREFIX + thread_context

    channel_info = utils.get_channel_context(client, channel_id, session_manager)

    client_context = {
      "source": "slack",
      "channel_type": "channel",
      "channel_name": channel_config.name,
      "channel_topic": channel_info.get("topic", ""),
      "channel_purpose": channel_info.get("purpose", ""),
    }
    if user_email:
      client_context["user_email"] = user_email

    _call_ai(
      client=client,
      channel_id=channel_id,
      thread_ts=thread_ts,
      message_text=retry_message,
      user_id=user_id,
      team_id=team_id,
      agent_id=agent_id,
      conversation_id=conversation_id,
      additional_footer=f"Retried by <@{user_id}>",
      client_context=client_context,
    )
  except Exception as e:
    logger.exception(f"Error handling retry: {e}")


# =============================================================================
# Escalation Action Handlers
# =============================================================================
def handle_escalation_get_help(
  ack: Any, body: dict[str, Any], client: Any, context: Any = None
) -> None:
  ack()
  _bind_obo_for_handler(context)
  try:

    user_id = body.get("user", {}).get("id")
    action = body.get("actions", [{}])[0]
    parts = action.get("value", "").split("|")
    channel_id = parts[0] if len(parts) > 0 else None
    thread_ts = parts[1] if len(parts) > 1 else None
    agent_id = parts[3] if len(parts) > 3 else ""
    if not channel_id or not thread_ts:
      return

    # Check if escalation was already triggered for this thread
    if session_manager.is_escalated(thread_ts):
      client.chat_postEphemeral(
        channel=channel_id,
        user=user_id,
        thread_ts=thread_ts,
        text="Help has already been requested for this thread.",
      )
      return

    # Get escalation config for this channel. channel_config may be None for a
    # channel configured entirely through the admin UI — _resolve_escalation
    # falls back to the DB route resolver in that case.
    channel_config = config.channels.get(channel_id)
    esc_config = _resolve_escalation(channel_config, agent_id=agent_id or None, channel_id=channel_id)
    if not esc_config:
      return

    # Validate victorops agent is configured before proceeding. The agent set
    # in Admin → Integrations → Slack → Advanced (DB) wins over the
    # SLACK_INTEGRATION_VICTOROPS_AGENT_ID env/YAML fallback.
    vo_agent_id = resolve_victorops_agent_id(config.defaults.victorops_agent_id)
    if esc_config.victorops.enabled and not vo_agent_id:
      client.chat_postEphemeral(
        channel=channel_id,
        user=user_id,
        thread_ts=thread_ts,
        text="VictorOps escalation is enabled but no agent is configured. Set the VictorOps escalation agent in Admin → Integrations → Slack → Advanced (or the `SLACK_INTEGRATION_VICTOROPS_AGENT_ID` env var) to enable on-call lookups.",
      )
      return

    # Mark as escalated
    session_manager.set_escalated(thread_ts)

    # Track escalation in feedback
    conversation_id = _resolve_conversation_id(thread_ts, channel_id, agent_id)
    submit_feedback_score(
      thread_ts=thread_ts,
      user_id=user_id,
      channel_id=channel_id,
      feedback_value="escalation_requested",
      slack_client=client,
      session_manager=session_manager,
      config=config,
      conversation_id=conversation_id,
    )

    client.chat_postEphemeral(
      channel=channel_id,
      user=user_id,
      thread_ts=thread_ts,
      text="Got it! Connecting you with a human...",
    )

    # Determine the parent message ts (root of thread)
    message = body.get("message", {})
    parent_ts = message.get("thread_ts") or thread_ts

    execute_escalation(
      slack_client=client,
      sse_client=sse_client,
      channel_id=channel_id,
      thread_ts=thread_ts,
      parent_ts=parent_ts,
      user_id=user_id,
      escalation_config=esc_config,
      agent_id=vo_agent_id or "",
    )

    # Mark conversation as escalated for admin dashboard resolution stats
    try:
      sse_client.update_conversation_metadata(conversation_id, {"escalated": True})
    except Exception:
      logger.warning(f"[{thread_ts}] Failed to mark conversation as escalated in metadata")

  except Exception as e:
    logger.exception(f"Error handling escalation: {e}")


def handle_delete_message(
  ack: Any, body: dict[str, Any], client: Any, context: Any = None
) -> None:
  ack()
  _bind_obo_for_handler(context)
  try:
    user_id = body.get("user", {}).get("id")
    channel_id = body.get("channel", {}).get("id")
    message = body.get("message", {})
    message_ts = message.get("ts")
    thread_ts = message.get("thread_ts") or message_ts

    action = body.get("actions", [{}])[0]
    parts = action.get("value", "").split("|")
    agent_id = parts[3] if len(parts) > 3 else ""

    if not channel_id or not message_ts:
      return

    channel_config = config.channels.get(channel_id)
    delete_admins = []
    if channel_config:
      for agent in channel_config.agents:
        if agent.escalation and agent.escalation.delete_admins:
          delete_admins = agent.escalation.delete_admins
          break

    if delete_admins and user_id not in delete_admins:
      client.chat_postEphemeral(
        channel=channel_id,
        user=user_id,
        thread_ts=thread_ts,
        text="You don't have permission to delete this message.",
      )
      logger.warning(f"[{thread_ts}] Unauthorized delete attempt by <@{user_id}>")
      return

    conversation_id = _resolve_conversation_id(thread_ts, channel_id, agent_id)
    submit_feedback_score(
      thread_ts=thread_ts,
      user_id=user_id,
      channel_id=channel_id,
      feedback_value="message_deleted",
      slack_client=client,
      session_manager=session_manager,
      config=config,
      conversation_id=conversation_id,
    )

    client.chat_delete(channel=channel_id, ts=message_ts)
    logger.info(f"[{thread_ts}] Message {message_ts} deleted by <@{user_id}>")
  except Exception as e:
    logger.exception(f"Error handling message delete: {e}")

_FEEDBACK_MODAL_COPY = {
  "needs_detail": {
    "title": "More detail",
    "comment_label": "What detail is missing?",
    "comment_placeholder": "e.g., 'Explain how the retry backoff is configured'",
  },
  "too_verbose": {
    "title": "Briefer response",
    "comment_label": "Anything to focus on?",
    "comment_placeholder": "e.g., 'Just give me the command'",
  },
  "wrong_answer": {
    "title": "What was wrong?",
    "comment_label": "What should be corrected?",
    "comment_placeholder": "e.g., 'The API endpoint mentioned doesn't exist'",
  },
  "other": {
    "title": "Feedback",
    "comment_label": "Tell us more",
    "comment_placeholder": "Describe the issue",
  },
}

_REGEN_INSTRUCTIONS = {
  "needs_detail": (
    "The user wants more detail on your previous answer. Search for at least 5 "
    "additional sources beyond what you already cited. Keep your response to 2-3 "
    "short paragraphs. Focus on details you left out the first time. End with "
    "sources and links."
  ),
  "too_verbose": (
    "Please provide a more concise response. Summarize the key points briefly. "
    "Be direct and to the point."
  ),
}


def _open_feedback_modal(
  ack: Any, body: dict[str, Any], client: Any, feedback_type: str
) -> None:
  ack()
  try:
    trigger_id = body.get("trigger_id")
    action = body.get("actions", [{}])[0]
    value = action.get("value", "")

    copy = _FEEDBACK_MODAL_COPY.get(feedback_type, _FEEDBACK_MODAL_COPY["other"])

    client.views_open(
      trigger_id=trigger_id,
      view={
        "type": "modal",
        "callback_id": "caipe_feedback_modal",
        "private_metadata": f"{value}|{feedback_type}",
        "title": {"type": "plain_text", "text": copy["title"]},
        "submit": {"type": "plain_text", "text": "Submit"},
        "close": {"type": "plain_text", "text": "Cancel"},
        "blocks": [
          {"type": "section", "text": {"type": "mrkdwn", "text": f"Your feedback is recorded either way. {APP_NAME} will only generate a new response if you tick the box below."}},
          {
            "type": "input",
            "block_id": "correction_input",
            "optional": True,
            "element": {
              "type": "plain_text_input",
              "action_id": "correction_text",
              "multiline": True,
              "placeholder": {"type": "plain_text", "text": copy["comment_placeholder"]},
            },
            "label": {"type": "plain_text", "text": copy["comment_label"]},
          },
          {
            "type": "input",
            "block_id": "regen_input",
            "optional": True,
            "element": {
              "type": "checkboxes",
              "action_id": "regen",
              "options": [
                {
                  "text": {"type": "plain_text", "text": "Attempt to regenerate a response based on feedback?"},
                  "value": "regenerate",
                },
              ],
            },
            "label": {"type": "plain_text", "text": "Generate new response"},
          },
        ],
      },
    )
  except Exception as e:
    logger.exception(f"Error opening feedback modal: {e}")


def handle_feedback_wrong_answer(ack: Any, body: dict[str, Any], client: Any) -> None:
  _open_feedback_modal(ack, body, client, feedback_type="wrong_answer")


def handle_feedback_other(ack: Any, body: dict[str, Any], client: Any) -> None:
  _open_feedback_modal(ack, body, client, feedback_type="other")


def _regen_message_text(feedback_type: str, comment: str) -> str:
  """Build the agent instruction for an opted-in regeneration.

  For wrong_answer/other the user's comment is the substance of the request;
  for needs_detail/too_verbose a fixed instruction drives the rewrite and the
  comment (if any) is appended as extra context.
  """
  if feedback_type in ("wrong_answer", "other"):
    if comment:
      return (
        f'The user indicated your previous response needed work and provided the '
        f'following IMPORTANT context: "{comment}"\n\nPlease carefully review this '
        f'feedback and provide a corrected response.'
      )
    return "The user indicated your previous response needed work. Please review it and provide a corrected response."

  instruction = _REGEN_INSTRUCTIONS.get(feedback_type, "")
  if comment:
    return f'{instruction}\n\nAdditional context from the user: "{comment}"'
  return instruction


def handle_feedback_modal_submission(
  ack: Any,
  body: dict[str, Any],
  client: Any,
  view: dict[str, Any],
  context: Any = None,
) -> None:
  ack()
  _bind_obo_for_handler(context)
  try:
    user_id = body.get("user", {}).get("id")
    team_id = body.get("team", {}).get("id")

    private_metadata = view.get("private_metadata", "")
    parts = private_metadata.split("|")
    channel_id = parts[0] if len(parts) > 0 else None
    thread_ts = parts[1] if len(parts) > 1 else None
    message_ts = parts[2] if len(parts) > 2 else None
    agent_id = parts[3] if len(parts) > 3 else ""
    feedback_type = parts[4] if len(parts) > 4 else "other"

    if not channel_id or not thread_ts:
      return

    values = view.get("state", {}).get("values", {})
    comment = values.get("correction_input", {}).get("correction_text", {}).get("value", "") or ""

    # Opt-in: feedback is always recorded; the bot only regenerates if the user
    # ticked the (off-by-default) "Attempt to regenerate" checkbox.
    regenerate = regenerate_requested(values)

    conversation_id = _resolve_conversation_id(thread_ts, channel_id, agent_id)

    submit_feedback_score(
      thread_ts=thread_ts,
      user_id=user_id,
      channel_id=channel_id,
      feedback_value=feedback_type,
      slack_client=client,
      session_manager=session_manager,
      config=config,
      conversation_id=conversation_id,
      comment=comment or None,
      message_ts=message_ts,
    )

    if not regenerate:
      client.chat_postEphemeral(
        channel=channel_id,
        user=user_id,
        thread_ts=thread_ts,
        text="Got it! Your feedback was recorded.",
      )
      return

    # No acknowledgment ephemeral here: the user explicitly ticked the box, and
    # the regenerated response arriving in-thread is self-evident.
    channel_config = config.channels.get(channel_id)
    esc_config = _resolve_escalation(channel_config, agent_id=agent_id or None, channel_id=channel_id)

    _call_ai(
      client=client,
      channel_id=channel_id,
      thread_ts=thread_ts,
      message_text=_regen_message_text(feedback_type, comment),
      user_id=user_id,
      team_id=team_id,
      agent_id=agent_id,
      conversation_id=conversation_id,
      additional_footer=f"New response requested by <@{user_id}>",
      escalation_config=esc_config,
    )
  except Exception as e:
    logger.exception(f"Error handling feedback modal submission: {e}")


def handle_reaction_added(event: dict[str, Any], logger: Any) -> None:
  pass


def handle_reaction_removed(event: dict[str, Any], logger: Any) -> None:
  pass


def handle_assistant_thread_context_changed(event: dict[str, Any], logger: Any) -> None:
  pass


def handle_assistant_thread_started(event: dict[str, Any], logger: Any) -> None:
  pass


def handle_app_home_opened(event: dict[str, Any], logger: Any) -> None:
  pass


def custom_error_handler(error: Exception, body: dict[str, Any], logger: Any) -> None:
  logger.exception(f"Error: {error}, Request body: {body}")
