# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Slack direct-message and slash-command routing."""

from __future__ import annotations

from typing import Any
import time

from loguru import logger

from authorization import (
  _agent_access_denied_text,
  _bind_obo_for_handler,
  _obo_token_from_context,
  _post_ephemeral_for_event,
)
from conversation import (
  _apply_attachment_notices,
  _call_ai,
  _msg_link,
  _record_message_turns,
  _track_interaction,
)
from handler_dependencies import PersonalRoutingDependencies
from sse_client import AgentAccessDeniedError, SSEClient
from utils import slack_context, slack_formatter, utils
from utils.accessible_agents_client import AccessibleAgentsClient
from utils.chat_envelope import augment_slack_client_context
from utils.command_rate_limiter import CommandRateLimiter
from utils.config_models import Config
from utils.dm_agent_resolver import DmAgentResolution, resolve_dm_agent
from utils.dm_authz_client import DmAuthzClient
from utils.dm_thread_overrides import OverrideKey, get_default_override_store
from utils.file_ingest import download_slack_files
from utils.platform_settings import resolve_default_agent_id
from utils.slash_commands import (
  SlashCommandResult,
  _cmd_prefix,
  handle_help_command,
  handle_list_command,
  handle_use_command,
)
from utils.user_preferences_client import UserPreferencesClient


app: Any = None
config: Config
sse_client: SSEClient
APP_NAME = "CAIPE"
SLACK_WORKSPACE_URL = ""
RBAC_ENABLED = False
_COMMAND_RATE_LIMIT = 5
_COMMAND_RATE_WINDOW = 30.0


def configure_personal_routing(dependencies: PersonalRoutingDependencies) -> None:
  """Install process-scoped personal-routing collaborators."""
  global app, config, sse_client, APP_NAME
  global SLACK_WORKSPACE_URL, RBAC_ENABLED
  global _COMMAND_RATE_LIMIT, _COMMAND_RATE_WINDOW

  app = dependencies.bolt_app
  config = dependencies.config
  sse_client = dependencies.sse_client
  APP_NAME = dependencies.app_name
  SLACK_WORKSPACE_URL = dependencies.workspace_url
  RBAC_ENABLED = dependencies.rbac_enabled
  _COMMAND_RATE_LIMIT = dependencies.command_rate_limit
  _COMMAND_RATE_WINDOW = dependencies.command_rate_window


def _get_agent_id_for_dm() -> str:
  """Resolve the static DM fallback from deployment and platform defaults."""
  if config.defaults.dm_agent_id:
    return config.defaults.dm_agent_id
  # Platform default from Admin → Settings → Default Agent (DB) wins over the
  # SLACK_INTEGRATION_DEFAULT_AGENT_ID env/YAML fallback for DMs too.
  default_agent_id = resolve_default_agent_id(config.defaults.default_agent_id)
  if default_agent_id:
    return default_agent_id
  logger.warning("No agent_id configured for DMs — using empty string")
  return ""


# Clients shared by slash commands and DM resolution stay lazy so importing
# routing policy never constructs network-backed collaborators.

_dm_authz_client_singleton: DmAuthzClient | None = None
_accessible_agents_client_singleton: AccessibleAgentsClient | None = None
_user_preferences_client_singleton: UserPreferencesClient | None = None
_command_rate_limiter_singleton: CommandRateLimiter | None = None


def _dm_authz_client() -> DmAuthzClient:
  global _dm_authz_client_singleton
  if _dm_authz_client_singleton is None:
    _dm_authz_client_singleton = DmAuthzClient()
  return _dm_authz_client_singleton


def _accessible_agents_client() -> AccessibleAgentsClient:
  global _accessible_agents_client_singleton
  if _accessible_agents_client_singleton is None:
    _accessible_agents_client_singleton = AccessibleAgentsClient()
  return _accessible_agents_client_singleton


def _user_preferences_client() -> UserPreferencesClient:
  global _user_preferences_client_singleton
  if _user_preferences_client_singleton is None:
    _user_preferences_client_singleton = UserPreferencesClient()
  return _user_preferences_client_singleton


def _command_rate_limiter() -> CommandRateLimiter:
  global _command_rate_limiter_singleton
  if _command_rate_limiter_singleton is None:
    _command_rate_limiter_singleton = CommandRateLimiter(
        max_per_window=_COMMAND_RATE_LIMIT,
        window_seconds=_COMMAND_RATE_WINDOW,
    )
  return _command_rate_limiter_singleton


def _override_key_for_dm(
    *,
    workspace_id: str | None,
    channel_id: str | None,
    user_id: str | None,
    thread_ts: str | None,
) -> OverrideKey | None:
  """Build a Slack DM override key, or None if any component is missing.

  Only DM channels (Slack channel id starts with ``D``) are eligible —
  callers gate on that BEFORE calling.
  """
  if not workspace_id or not channel_id or not user_id or not thread_ts:
    return None
  try:
    return OverrideKey(
        workspace_id=str(workspace_id),
        channel_id=str(channel_id),
        user_id=str(user_id),
        thread_ts=str(thread_ts),
    )
  except ValueError as exc:
    logger.warning("Invalid OverrideKey components: {}", exc)
    return None


def _resolve_dm_agent_for_message(
    *,
    bearer_token: str,
    override_key: OverrideKey,
) -> DmAgentResolution:
  """Run the FR-023 dispatch chain for a DM message.

  Returns the full :class:`DmAgentResolution`; callers handle
  ``source=='pdp_unavailable'`` (temporary deny), ``'denied'`` (helpful
  hint), and the regular allow paths.
  """
  return resolve_dm_agent(
      override_key=override_key,
      overrides=get_default_override_store(),
      prefs_client=_user_preferences_client(),
      authz_client=_dm_authz_client(),
      dm_agent_id=config.defaults.dm_agent_id or None,
      # Platform default from Admin → Settings → Default Agent (DB) wins over
      # the SLACK_INTEGRATION_DEFAULT_AGENT_ID env/YAML fallback.
      default_agent_id=resolve_default_agent_id(config.defaults.default_agent_id),
      bearer_token=bearer_token,
  )


def _ack_ephemeral(ack: Any, result: SlashCommandResult) -> None:
  """Post a slash-command result as an ephemeral reply (FR-034)."""
  try:
    ack(response_type="ephemeral", text=result.text)
  except Exception as exc:
    logger.warning("Failed to ack slash command (code={}): {}", result.code, exc)


def _register_slash_commands(bolt_app: Any) -> None:
  """Register /{cmd}-help, /{cmd}-list, /{cmd}-use with the Bolt app.

  The command prefix is derived from APP_NAME at startup time so that
  ``APP_NAME=Forge`` registers ``/forge-help`` etc.
  """
  cmd = _cmd_prefix()

  @bolt_app.command(f"/{cmd}-help")
  def slash_help(
    ack: Any, body: dict[str, Any], context: Any = None
  ) -> None:
    channel_id = body.get("channel_id") or ""
    is_dm = bool(channel_id) and channel_id.startswith("D")
    user_id = body.get("user_id") or ""
    result = handle_help_command(
        user_key=user_id,
        is_dm=is_dm,
        rate_limiter=_command_rate_limiter(),
    )
    _ack_ephemeral(ack, result)

  @bolt_app.command(f"/{cmd}-list")
  def slash_list(
    ack: Any, body: dict[str, Any], context: Any = None
  ) -> None:
    channel_id = body.get("channel_id") or ""
    is_dm = bool(channel_id) and channel_id.startswith("D")
    user_id = body.get("user_id") or ""
    bearer_token = _obo_token_from_context(context) or ""
    if not bearer_token:
      _ack_ephemeral(
          ack,
          SlashCommandResult(
              text=(
                  "I couldn't verify your identity for this command. "
                  "Please re-link your account and try again."
              ),
              code="no_bearer",
          ),
      )
      return
    result = handle_list_command(
        user_key=user_id,
        bearer_token=bearer_token,
        accessible_agents_client=_accessible_agents_client(),
        is_dm=is_dm,
        rate_limiter=_command_rate_limiter(),
    )
    _ack_ephemeral(ack, result)


  @bolt_app.command(f"/{cmd}-use")
  def slash_use(
    ack: Any, body: dict[str, Any], context: Any = None
  ) -> None:
    user_id = body.get("user_id") or ""
    bearer_token = _obo_token_from_context(context) or ""
    if not bearer_token:
      _ack_ephemeral(
          ack,
          SlashCommandResult(
              text=(
                  "I couldn't verify your identity for this command. "
                  "Please re-link your account and try again."
              ),
              code="no_bearer",
          ),
      )
      return

    raw_text = body.get("text") or ""
    channel_id = body.get("channel_id") or ""
    workspace_id = (context or {}).get("slack_workspace_id") or body.get("team_id") or ""
    # Slack slash commands fire against a single channel; for DM threads
    # the "thread" identity is the channel itself (Slack DMs don't carry
    # a thread_ts in the command body). This matches the override key the
    # DM message handler builds below for root messages.
    thread_ts = channel_id  # one thread-key per DM channel for command-level overrides

    # Slack DM channel ids start with "D" — this is a stable Slack
    # convention, so it works regardless of whether RBAC enrichment ran.
    is_dm = bool(channel_id) and channel_id.startswith("D")
    override_key = (
        _override_key_for_dm(
            workspace_id=workspace_id,
            channel_id=channel_id,
            user_id=user_id,
            thread_ts=thread_ts,
        )
        if is_dm
        else None
    )

    result = handle_use_command(
        user_key=user_id,
        raw_text=raw_text,
        bearer_token=bearer_token,
        is_dm=is_dm,
        override_key=override_key,
        override_store=get_default_override_store(),
        dm_authz_client=_dm_authz_client(),
        user_preferences_client=_user_preferences_client(),
        accessible_agents_client=_accessible_agents_client(),
        rate_limiter=_command_rate_limiter(),
    )
    _ack_ephemeral(ack, result)

def handle_dm_message(
  event: dict[str, Any], say: Any, client: Any, context: Any = None
) -> None:
  """Handle direct messages to the bot."""
  try:
    # Wall-clock start for `_track_interaction(response_time_ms=...)` below.
    t0 = time.monotonic()
    _bind_obo_for_handler(context)
    if event.get("bot_id"):
      return

    channel_id = event.get("channel")
    thread_ts = event.get("thread_ts") or event.get("ts")

    if not utils.verify_thread_exists(client, channel_id, thread_ts):
      logger.warning(f"[{thread_ts}] Ignoring DM — parent message was deleted")
      return

    user_id = event.get("user")
    message_text = slack_context.extract_message_text(event)

    user_name, user_email = utils.get_message_author_info(event, client)

    logger.info(f"[{thread_ts}] DM from User: {user_name} ({user_id}), Email: {user_email}, Message: {message_text}{_msg_link(channel_id, thread_ts)}")

    if not message_text or not message_text.strip():
      say(text="Please include a question or message!", thread_ts=thread_ts)
      return

    bot_info = client.auth_test()
    bot_user_id = bot_info.get("user_id")

    # DM selection follows override → saved preference → deployment defaults.
    # Requests without RBAC or an OBO token use the static configured default.
    bearer_token = _obo_token_from_context(context) if context else None
    agent_id: str = ""
    resolver_notices: list[str] = []
    resolver_source: str = "legacy"
    workspace_id_for_override = (context or {}).get("slack_workspace_id") or event.get("team") or ""
    override_key = _override_key_for_dm(
        workspace_id=workspace_id_for_override,
        channel_id=channel_id,
        user_id=user_id,
        thread_ts=thread_ts,
    )
    if bearer_token and override_key is not None:
      resolution = _resolve_dm_agent_for_message(
          bearer_token=bearer_token,
          override_key=override_key,
      )
      resolver_source = resolution.source
      resolver_notices = list(resolution.notices)
      if resolution.source == "pdp_unavailable":
        say(
            text=(
                "I can't verify your agent access right now. Please try "
                "again in a moment."
            ),
            thread_ts=thread_ts,
        )
        return
      if resolution.source in {"denied", "no_candidates"}:
        say(
            text=(
                "You don't have access to any agents that can answer this "
                f"DM. Use `/{APP_NAME.lower()}-list` to see what's available, or ask "
                "your admin for a grant."
            ),
            thread_ts=thread_ts,
        )
        return
      agent_id = resolution.agent_id or ""
      logger.info(
          f"[{thread_ts}] DM resolver source={resolver_source} agent_id={agent_id}",
      )
    else:
      agent_id = _get_agent_id_for_dm()

    if not agent_id:
      logger.error(
          f"[{thread_ts}] No agent_id configured for DMs — set "
          "SLACK_INTEGRATION_DM_AGENT_ID or SLACK_INTEGRATION_DEFAULT_AGENT_ID"
      )
      say(
          text=(
              "Sorry, DMs aren't configured yet — no agent ID is set. "
              "Please contact an admin."
          ),
          thread_ts=thread_ts,
      )
      return

    # Surface any resolver notices BEFORE we kick off the agent call so
    # the user understands why their preference/override changed.
    for notice in resolver_notices:
      try:
        say(text=notice, thread_ts=thread_ts)
      except Exception as notice_err:
        logger.warning(
            f"[{thread_ts}] Could not post resolver notice: {notice_err}"
        )

    # Create or retrieve conversation via shared API (server owns ID generation).
    # Must happen BEFORE context building so we can use `created` to decide
    # full vs delta thread context.
    try:
      conv_result = sse_client.create_conversation(
        title=message_text[:50].strip() or "Slack DM",
        agent_id=agent_id,
        owner_id=user_email or user_id,
        idempotency_key=thread_ts,
        metadata={
          "thread_ts": thread_ts,
          "channel_id": channel_id,
          "channel_type": "dm",
          **({"workspace_url": SLACK_WORKSPACE_URL} if SLACK_WORKSPACE_URL else {}),
        },
      )
    except AgentAccessDeniedError as e:
      # DMs always act as the user (no per-route service-account identity).
      _post_ephemeral_for_event(
        client, event, channel_id, user_id,
        _agent_access_denied_text(e.agent_id, context, None),
      )
      return
    conversation_id = conv_result["conversation_id"]
    conv_created = conv_result["created"]
    conv_metadata = conv_result.get("metadata", {})

    # Build thread context: full on first interaction, delta on follow-ups
    context_message = message_text
    if event.get("thread_ts"):
      if conv_created:
        context_message = slack_context.build_thread_context(app, channel_id, thread_ts, message_text, bot_user_id)
      else:
        since_ts = conv_metadata.get("last_processed_ts", thread_ts)
        context_message = slack_context.build_delta_context(app, channel_id, thread_ts, message_text, bot_user_id, since_ts=since_ts)

    client_context = {
      "source": "slack",
      "channel_type": "dm",
    }
    if user_email:
      client_context["user_email"] = user_email

    team_id = event.get("team")
    dm_channel_id = event.get("channel")
    # Missing channel-team mapping marks DMs for user-team-union evaluation.
    client_context = augment_slack_client_context(
      client_context,
      channel_id=dm_channel_id,
      workspace_id=team_id,
      thread_ts=thread_ts,
      surface_kind="dm",
    )

    # Download any Slack attachments into base64 multimodal blocks so the model
    # can read them (client.token authenticates the private file URLs). Files
    # that couldn't be accessed (e.g. missing files:read scope) surface as
    # notices folded into the message so the agent can tell the user.
    ingest = download_slack_files(event.get("files"), bot_token=client.token)
    input_files = ingest.files
    context_message = _apply_attachment_notices(context_message, ingest)

    result = _call_ai(
      client=client,
      channel_id=dm_channel_id,
      thread_ts=thread_ts,
      message_text=context_message,
      user_id=user_id,
      team_id=team_id,
      agent_id=agent_id,
      conversation_id=conversation_id,
      client_context=client_context,
      files=input_files,
    )

    if isinstance(result, dict) and result.get("retry_needed"):
      original_error = result.get("error", "Unknown error")
      logger.warning(f"[{thread_ts}] DM request failed, showing retry button: {original_error[:100]}")

      client.chat_postMessage(
        channel=event.get("channel"),
        thread_ts=thread_ts,
        blocks=[
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": "Something went wrong - some tools or subagents may have timed out. Would you like to try again?",
            },
          },
          {
            "type": "actions",
            "elements": [
              {
                "type": "button",
                "text": {"type": "plain_text", "text": "Retry"},
                "style": "primary",
                "action_id": "caipe_retry",
                "value": f"{event.get('channel')}|{thread_ts}||{agent_id}",
              },
            ],
          },
        ],
        text="Something went wrong. Click Retry to try again.",
      )

    logger.info(f"[{thread_ts}] Completed DM request for {user_name}")

    # Interaction telemetry owns the last-processed timestamp used by delta context.
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    _track_interaction(
      conversation_id=conversation_id,
      thread_ts=thread_ts,
      channel_id=channel_id,
      interaction_type="dm",
      user_id=user_id,
      user_email=user_email,
      user_name=user_name,
      response_time_ms=elapsed_ms,
      last_processed_ts=event.get("ts"),
    )

    # Persist per-turn message rows for stats/linking — only on a genuine
    # successful response (skip retry/error turns, which fall through above).
    # DMs have no channel config, so no channel_name.
    if not (isinstance(result, dict) and result.get("retry_needed")):
      _record_message_turns(
        conversation_id=conversation_id,
        thread_ts=thread_ts,
        channel_id=channel_id,
        trigger_ts=event.get("ts") or thread_ts,
        agent_id=agent_id,
        response_time_ms=elapsed_ms,
      )

  except Exception as e:
    logger.exception(f"Error handling DM message: {e}")
    try:
      say(
        blocks=slack_formatter.format_error_message(str(e)),
        text=f"Error: {e}",
        thread_ts=event.get("thread_ts") or event.get("ts"),
      )
    except Exception as say_error:
      logger.exception(f"Failed to send error message: {say_error}")
