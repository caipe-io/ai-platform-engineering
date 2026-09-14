# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Slack channel, mention, and ambient-message routing."""

from __future__ import annotations

import time
from typing import Any

from loguru import logger

from authorization import (
  _agent_access_denied_text,
  _bind_obo_for_handler,
  _log_stage,
  _post_ephemeral_for_event,
  _slack_agent_channel_grant_check,
)
from conversation import (
  _apply_attachment_notices,
  _call_ai,
  _msg_link,
  _record_message_turns,
  _track_interaction,
)
from handler_dependencies import ChannelRoutingDependencies
from personal_routing import handle_dm_message
from sse_client import AgentAccessDeniedError, SSEClient
from utils import ai, slack_context, slack_formatter, utils
from utils.chat_envelope import augment_slack_client_context
from utils.config_models import ChannelConfig, Config, get_escalation_config
from utils.dispatch_identity import apply_execution_identity
from utils.file_ingest import download_slack_files
from utils.obo_exchange import impersonate_service_account
from utils.platform_settings import resolve_default_agent_id
from utils.session_manager import SessionManager
from utils.slack_agent_routes import (
  get_slack_agent_route_resolver,
  slack_agent_route_mode,
  slack_workspace_ref,
)
from utils.slack_runtime_policy import should_post_route_miss_notice


config: Config
sse_client: SSEClient
session_manager: SessionManager
app: Any = None
APP_NAME = "CAIPE"
SLACK_WORKSPACE_URL = ""
RBAC_ENABLED = False
_ROUTABLE_AMBIENT_MESSAGE_SUBTYPES = frozenset(
  {None, "", "bot_message", "file_share"}
)


def configure_channel_routing(dependencies: ChannelRoutingDependencies) -> None:
  """Install process-scoped channel-routing collaborators."""
  global app, config, sse_client, session_manager, APP_NAME
  global SLACK_WORKSPACE_URL, RBAC_ENABLED

  app = dependencies.bolt_app
  config = dependencies.config
  sse_client = dependencies.sse_client
  session_manager = dependencies.session_manager
  APP_NAME = dependencies.app_name
  SLACK_WORKSPACE_URL = dependencies.workspace_url
  RBAC_ENABLED = dependencies.rbac_enabled


def _get_agent_id(
  channel_config: Any = None, mapped_agent_id: str | None = None
) -> str:
  """Resolve the DB route, static channel binding, or platform default."""
  if mapped_agent_id:
    return mapped_agent_id
  if channel_config and hasattr(channel_config, "agent_id") and channel_config.agent_id:
    return channel_config.agent_id
  # Platform default from Admin → Settings → Default Agent (DB) wins over the
  # SLACK_INTEGRATION_DEFAULT_AGENT_ID env/YAML fallback.
  default_agent_id = resolve_default_agent_id(config.defaults.default_agent_id)
  if default_agent_id:
    return default_agent_id
  logger.warning("No agent_id configured — using empty string")
  return ""


def _agent_listens_to(agent_listen: str, requested: str) -> bool:
  """Check if an agent's listen mode satisfies the requested mode."""
  return agent_listen == "all" or agent_listen == requested


def _match_agents(
  channel_config: ChannelConfig,
  is_bot: bool,
  bot_username: str | None = None,
  bot_user_id: str | None = None,
  user_id: str | None = None,
  listen: str | None = None,
) -> list[Any]:
  """Return all agents configured for this sender type and listen mode."""
  matched = []
  for agent in channel_config.agents:
    if is_bot and agent.bots:
      if not agent.bots.enabled:
        continue
      if listen and not _agent_listens_to(agent.bots.listen, listen):
        continue
      if agent.bots.bot_list is not None:
        # Allow matching by name (e.g. "GitLab") OR by U-prefixed user ID.
        if bot_username not in agent.bots.bot_list and bot_user_id not in agent.bots.bot_list:
          continue
      matched.append(agent)
    elif not is_bot and agent.users:
      if not agent.users.enabled:
        continue
      if listen and not _agent_listens_to(agent.users.listen, listen):
        continue
      if agent.users.user_list is not None and user_id not in agent.users.user_list:
        continue
      matched.append(agent)
  return matched


def _configured_or_route_backed_channel(
  channel_id: str | None,
) -> ChannelConfig | None:
  """Return channel config, allowing DB-backed routes in opt-in modes."""
  if channel_id and utils.is_configured_channel(channel_id):
    return config.channels[channel_id]
  if slack_agent_route_mode() != "config" and channel_id:
    return ChannelConfig(name=channel_id, agents=[])
  return None


def _event_workspace_id(event: dict[str, Any]) -> str:
  team_id = event.get("team")
  return slack_workspace_ref(str(team_id) if team_id else None)


def _match_channel_agents(
  channel_id: str,
  channel_config: ChannelConfig,
  is_bot: bool,
  bot_username: str | None = None,
  bot_user_id: str | None = None,
  user_id: str | None = None,
  listen: str | None = None,
  workspace_id: str | None = None,
) -> list[Any]:
  """Return agent matches from the selected route source.

  Static config is the default. DB routes are used only when
  ``SLACK_AGENT_ROUTES_MODE`` opts in.
  """
  config_matches = _match_agents(
    channel_config,
    is_bot=is_bot,
    bot_username=bot_username,
    bot_user_id=bot_user_id,
    user_id=user_id,
    listen=listen,
  )
  mode = slack_agent_route_mode()
  if mode == "config":
    return config_matches

  route_matches = get_slack_agent_route_resolver().match_routes(
    workspace_id=workspace_id or slack_workspace_ref(),
    channel_id=channel_id,
    is_bot=is_bot,
    bot_username=bot_username,
    user_id=user_id,
    listen=listen,
  )
  if route_matches:
    logger.info(
      "Using DB-backed Slack agent routes channel={} mode={} matches={}",
      channel_id,
      mode,
      [match.agent_id for match in route_matches],
    )
    return route_matches
  if mode == "db_only":
    return []
  return config_matches


def _post_route_miss_notice(
  client: Any,
  channel_id: str,
  user_id: str | None,
  text: str,
  *,
  explicit_invocation: bool = False,
) -> None:
  """Tell the sender why Slack routing did not dispatch an agent."""
  if not channel_id or not text:
    return
  if not should_post_route_miss_notice(explicit_invocation=explicit_invocation):
    logger.debug("Suppressing Slack route miss notice for ambient channel message")
    return
  try:
    if user_id:
      client.chat_postEphemeral(channel=channel_id, user=user_id, text=text)
    else:
      client.chat_postMessage(channel=channel_id, text=text)
  except Exception as exc:
    logger.warning("Slack route miss notice failed for channel={} user={}: {}", channel_id, user_id, exc)


def _resolve_escalation(
  channel_config: ChannelConfig | None,
  agent_id: str | None = None,
  channel_id: str | None = None,
) -> Any:
  """Return the escalation config for a specific agent binding, or None.

  Static YAML config is checked first. When the channel has no static binding
  for ``agent_id`` (e.g. a channel configured entirely through the admin UI),
  we fall back to the DB-backed route resolver so escalation ("Get help",
  VictorOps paging) works for UI-managed channels too.
  """
  if not agent_id:
    return None
  if channel_config:
    for agent in channel_config.agents:
      if agent.agent_id == agent_id:
        return get_escalation_config(agent)
  if channel_id and slack_agent_route_mode() != "config":
    return get_slack_agent_route_resolver().escalation_for(
      workspace_id=slack_workspace_ref(),
      channel_id=channel_id,
      agent_id=agent_id,
    )
  return None


def handle_mention(
  event: dict[str, Any], say: Any, client: Any, context: Any = None
) -> None:
  """Handle @mentions of the bot to query CAIPE."""
  _log_stage(event, "handle_mention_entry")
  try:
    # Wall-clock start for `_track_interaction(response_time_ms=...)` below.
    t0 = time.monotonic()
    # SEC-3: do NOT bind OBO here — _bind_obo_for_handler is called below
    # AFTER apply_execution_identity so the correct token (user or SA) is
    # bound once. Mirroring _route_to_agent which also binds only once, after
    # the identity decision.
    if event.get("edited") or event.get("subtype") == "message_changed":
      logger.debug("Skipping edited @mention message")
      return

    channel_id = event.get("channel")

    channel_config = _configured_or_route_backed_channel(channel_id)
    if channel_config is None:
      logger.info(f"Channel {channel_id} has no config, ignoring @mention")
      return

    thread_ts = event.get("thread_ts") or event.get("ts")

    # A Workflow Builder step that @mentions the bot delivers an app_mention
    # with `bot_id` set and no `user` — resolve the same way _route_to_agent /
    # handle_message_events do for bot-authored messages, so routing/filtering
    # and RBAC still see a real identity instead of `user_id=None`.
    mention_bot_id = event.get("bot_id")
    is_bot = mention_bot_id is not None
    if is_bot:
      bot_username, sender_bot_user_id = utils.get_bot_info_by_id(mention_bot_id)
      user_id = sender_bot_user_id or mention_bot_id
    else:
      bot_username = None
      sender_bot_user_id = None
      user_id = event.get("user")

    if not utils.verify_thread_exists(client, channel_id, thread_ts):
      logger.warning(f"[{thread_ts}] Ignoring @mention — parent message was deleted")
      return

    message_text = slack_context.extract_message_text(event)

    user_name, user_email = utils.get_message_author_info(event, client)

    logger.info(f"[{thread_ts}] CAIPE was invoked by User: {user_name} ({user_id or event.get('bot_id')}), Email: {user_email}, Channel: {channel_id}, Thread: {thread_ts}{_msg_link(channel_id, thread_ts)}")

    if not message_text:
      if is_bot:
        logger.info(f"[{thread_ts}] Ignoring bot/workflow @mention with no message text — silently dropping")
        return
      say(text="Please include a question or message!", thread_ts=thread_ts)
      return

    bot_info = client.auth_test()
    bot_user_id = bot_info.get("user_id")

    # Run normal match first to seed agent_id for conversation creation.
    # Ownership may override this below once we have conv_metadata.
    matches = _match_channel_agents(
      channel_id,
      channel_config,
      is_bot=is_bot,
      bot_username=bot_username,
      bot_user_id=sender_bot_user_id,
      user_id=user_id,
      listen="mention",
      workspace_id=_event_workspace_id(event),
    )
    agent_match = matches[0] if matches else None
    agent_id = agent_match.agent_id if agent_match else (resolve_default_agent_id(config.defaults.default_agent_id) or "")

    # Channel grant check uses the initial agent_id. Thread-ownership may
    # override it below, but ownership only applies to replies on threads
    # already established — the grant on the initial agent is sufficient.
    denial = _slack_agent_channel_grant_check(context, channel_id, agent_id)
    if denial:
      if is_bot:
        logger.warning(
          "Slack channel grant denied for bot/workflow @mention channel={} agent={} — silently dropping",
          channel_id,
          agent_id,
        )
      else:
        _post_ephemeral_for_event(client, event, channel_id, user_id, denial)
      return

    # Apply the route's execution identity BEFORE create_conversation — the
    # conversation's `can_use agent` check runs against whatever token is bound
    # here. For service_account routes this mints the SA token and overwrites
    # context["obo_token"]; obo_user routes keep the user/anon token already set
    # by the middleware. Mirrors the same block in _route_to_agent (FR: routing
    # identity must apply to @mentions, not just ambient messages).
    if RBAC_ENABLED and context is not None and agent_match is not None:
      try:
        exec_id = agent_match.execution_identity
        should_proceed = apply_execution_identity(
          run_as_mode=exec_id.mode,
          sa_sub=exec_id.service_account_sub,
          sa_name=exec_id.service_account_name,
          agent_id=agent_id,
          context=context,
          event=event,
          client=client,
          say=say,
          is_bot=is_bot,
          impersonate_fn=impersonate_service_account,
        )
        if not should_proceed:
          return
      except AttributeError as exc:
        # Route records without execution identity use the request-bound identity.
        logger.debug(
          "Slack mention route has no execution_identity for agent_id={}: {}",
          agent_id,
          exc,
        )
    # SEC-3: bind OBO ONCE here (after the identity decision), unconditionally.
    # When RBAC is disabled or no agent_match, context["obo_token"] is absent
    # and _bind_obo_for_handler is a no-op; when RBAC enabled the SA token (if
    # any) was just written into context["obo_token"] above.
    _bind_obo_for_handler(context)

    try:
      conv_result = sse_client.create_conversation(
        title=message_text[:50].strip() or "Slack Thread",
        agent_id=agent_id,
        owner_id=user_email or user_id,
        idempotency_key=thread_ts,
        metadata={
          "thread_ts": thread_ts,
          "channel_id": channel_id,
          "channel_name": channel_config.name,
          # Flag threads owned by a Slack bot/app (e.g. GitLab, alert bots).
          # Their Slack user IDs are "U…"-prefixed like humans, so stats can't
          # tell them apart by ID — this lets the leaderboard exclude them when
          # "Show bot users" is off.
          **({"owner_is_bot": True} if is_bot else {}),
          # Bot/app owners aren't rows in our users collection, so stats can't
          # resolve their "U…" owner_id to a name. Persist the app's display
          # name here so the leaderboard shows "GitLab" instead of the raw id
          # when "Show bot users" is on.
          **({"owner_display_name": bot_username} if is_bot and bot_username else {}),
          **({"workspace_url": SLACK_WORKSPACE_URL} if SLACK_WORKSPACE_URL else {}),
        },
      )
    except AgentAccessDeniedError as e:
      if is_bot:
        logger.warning(
          "Agent access denied for bot/workflow @mention channel={} agent={} — silently dropping",
          channel_id,
          e.agent_id,
        )
      else:
        _post_ephemeral_for_event(
          client, event, channel_id, user_id,
          _agent_access_denied_text(e.agent_id, context, agent_match),
        )
      return

    conversation_id = conv_result["conversation_id"]
    conv_created = conv_result["created"]
    conv_metadata = conv_result.get("metadata", {})

    # Thread ownership: resolve from in-memory cache (hot path) or server
    # metadata (survives restarts). Only applies to thread replies — root
    # messages establish ownership after they respond.
    is_thread_reply = bool(event.get("thread_ts"))
    if is_thread_reply:
      owner_id = session_manager.get_thread_owner(thread_ts) or conv_metadata.get("thread_owner_agent_id")
      if owner_id:
        session_manager.set_thread_owner(thread_ts, owner_id)  # warm cache on restart
        logger.info(f"[{thread_ts}] Thread owned by agent={owner_id}, bypassing match{_msg_link(channel_id, thread_ts)}")
        agent_match = next((a for a in channel_config.agents if a.agent_id == owner_id), None)
        agent_id = owner_id

    overthink = agent_match.users.overthink if agent_match and agent_match.users else None

    # Build thread context: full on first interaction, delta on follow-ups
    context_message = message_text
    if event.get("thread_ts"):
      if conv_created:
        context_message = slack_context.build_thread_context(app, channel_id, thread_ts, message_text, bot_user_id)
      else:
        since_ts = conv_metadata.get("last_processed_ts", thread_ts)
        context_message = slack_context.build_delta_context(app, channel_id, thread_ts, message_text, bot_user_id, since_ts=since_ts)

    is_humble_followup = session_manager.is_skipped(thread_ts)
    if is_humble_followup:
      logger.info(f"[{thread_ts}] Detected humble followup - thread was previously skipped")
      session_manager.clear_skipped(thread_ts)
      if overthink and overthink.followup_prompt:
        context_message = f"{overthink.followup_prompt}\n\n{context_message}"

    channel_info = utils.get_channel_context(client, channel_id, session_manager)
    team_id = event.get("team")

    client_context = {
      "source": "slack",
      "channel_type": "channel",
      "channel_name": channel_config.name,
      "channel_topic": channel_info.get("topic", ""),
      "channel_purpose": channel_info.get("purpose", ""),
      "humble_followup": is_humble_followup,
      "overthink": False,
      "overthink_boilerplate": "",
    }
    if user_email:
      client_context["user_email"] = user_email
    # Origin context lets downstream authorization derive team from channel.
    client_context = augment_slack_client_context(
      client_context,
      channel_id=channel_id,
      workspace_id=team_id,
      thread_ts=thread_ts,
      surface_kind="channel",
    )

    esc_config = get_escalation_config(agent_match) if agent_match else None

    # Download any Slack attachments into base64 multimodal blocks so the model
    # can read them (client.token authenticates the private file URLs). Files
    # that couldn't be accessed (e.g. missing files:read scope) surface as
    # notices folded into the message so the agent can tell the user.
    ingest = download_slack_files(event.get("files"), bot_token=client.token)
    input_files = ingest.files
    context_message = _apply_attachment_notices(context_message, ingest)

    result = _call_ai(
      client=client,
      channel_id=channel_id,
      thread_ts=thread_ts,
      message_text=context_message,
      user_id=user_id,
      team_id=team_id,
      agent_id=agent_id,
      conversation_id=conversation_id,
      escalation_config=esc_config,
      client_context=client_context,
      files=input_files,
    )

    if isinstance(result, dict) and result.get("skipped"):
      reason = result.get("reason", "unknown")
      logger.info(f"[{thread_ts}] Overthink: skipped mention response ({reason}) for {user_name}{_msg_link(channel_id, thread_ts)}")
      session_manager.set_skipped(thread_ts, True)
      return

    if isinstance(result, dict) and result.get("retry_needed"):
      original_error = result.get("error", "Unknown error")
      logger.warning(f"[{thread_ts}] Request failed, showing retry button: {original_error[:100]}")

      client.chat_postMessage(
        channel=channel_id,
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
                "value": f"{channel_id}|{thread_ts}||{agent_id}",
              },
            ],
          },
        ],
        text="Something went wrong. Click Retry to try again.",
      )

    session_manager.set_thread_owner(thread_ts, agent_id)
    logger.info(f"[{thread_ts}] Completed CAIPE request for {user_name}")

    # Interaction telemetry owns the last-processed timestamp used by delta context.
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    _track_interaction(
      conversation_id=conversation_id,
      thread_ts=thread_ts,
      channel_id=channel_id,
      interaction_type="mention",
      user_id=user_id,
      user_email=user_email,
      user_name=user_name,
      response_time_ms=elapsed_ms,
      last_processed_ts=event.get("ts"),
      thread_owner_agent_id=agent_id,
    )

    # Persist per-turn message rows for stats/linking — only on a genuine
    # successful response (skip retry/error turns, which fall through above).
    if not (isinstance(result, dict) and result.get("retry_needed")):
      _record_message_turns(
        conversation_id=conversation_id,
        thread_ts=thread_ts,
        channel_id=channel_id,
        trigger_ts=event.get("ts") or thread_ts,
        agent_id=agent_id,
        response_time_ms=elapsed_ms,
        channel_name=channel_config.name if channel_config else None,
      )

  except Exception as e:
    logger.exception(f"Error handling CAIPE mention: {e}")
    try:
      say(
        blocks=slack_formatter.format_error_message(str(e)),
        text=f"Error: {e}",
        thread_ts=event.get("thread_ts") or event.get("ts"),
      )
    except Exception as say_error:
      logger.exception(f"Failed to send error message: {say_error}")


def _route_to_agent(
  event: dict[str, Any],
  say: Any,
  client: Any,
  channel_config: ChannelConfig,
  agent_match: Any,
  is_bot: bool,
  bot_username: str | None = None,
  context: Any = None,
) -> None:
  """Route user and bot messages through the shared agent dispatcher.

  `context` is the Slack Bolt request context — needed by the channel ReBAC
  authorization check and by `_bind_obo_for_handler()` so OBO tokens flow into
  MCP calls. Both default to no-ops when RBAC is disabled.
  """
  _log_stage(event, "route_to_agent_entry", agent_id=agent_match.agent_id if agent_match else None)
  try:
    t0 = time.monotonic()

    # Decision 3 (anonymous-and-obo-routing): honor per-route execution identity
    # BEFORE binding the OBO token onto the SSE ContextVar.
    #
    # Decision table:
    #   route mode        | user linked? | token used
    #   ------------------|--------------|----------------------------------
    #   obo_user          | yes          | user OBO (set by _rbac_enrich_context — unchanged)
    #   obo_user          | no           | anon SA (set by unlinked fallback in middleware)
    #   service_account   | yes or no    | named SA (minted here, overrides context["obo_token"])
    #
    # Service-account routes replace the request token with the route identity.
    if RBAC_ENABLED and context is not None:
        try:
            exec_id = agent_match.execution_identity
            should_proceed = apply_execution_identity(
                run_as_mode=exec_id.mode,
                sa_sub=exec_id.service_account_sub,
                sa_name=exec_id.service_account_name,
                agent_id=agent_match.agent_id,
                context=context,
                event=event,
                client=client,
                say=say,
                is_bot=is_bot,
                impersonate_fn=impersonate_service_account,
            )
            if not should_proceed:
                return
        except AttributeError:
            # agent_match has no execution_identity (shouldn't happen with the default
            # factory, but defensive guard).
            pass

    _bind_obo_for_handler(context)
    channel_id = event.get("channel")
    thread_ts = event.get("ts")

    subtype = event.get("subtype")
    if subtype not in _ROUTABLE_AMBIENT_MESSAGE_SUBTYPES:
      logger.debug(
        "[{}] Ignoring ambient Slack message subtype={}",
        thread_ts,
        subtype,
      )
      return

    if not utils.verify_thread_exists(client, channel_id, thread_ts):
      logger.warning(f"[{thread_ts}] Ignoring message — parent message was deleted")
      return

    if is_bot:
      _, bot_user_id = utils.get_bot_info_by_id(event.get("bot_id"))
      user_id = bot_user_id or event.get("bot_id")
    else:
      user_id = event.get("user")
    team_id = event.get("team")
    message_text = slack_context.extract_message_text(event)
    raw_files = event.get("files") or []

    if raw_files:
      logger.info(
        "[{}] Processing Slack message attachments files={} has_text={} subtype={}",
        thread_ts,
        len(raw_files),
        bool(message_text.strip()),
        subtype or "none",
      )

    user_name, user_email = utils.get_message_author_info(event, client)
    sender_label = "bot" if is_bot else "user"

    logger.info(f"[{thread_ts}] Routing {sender_label} message to agent={agent_match.agent_id} - User: {user_name} ({user_id}), Channel: {channel_id}{_msg_link(channel_id, thread_ts)}")

    if not message_text.strip() and not raw_files:
      logger.debug(
        "[{}] Ignoring ambient Slack message with no text or files",
        thread_ts,
      )
      return

    agent_id = agent_match.agent_id

    denial = _slack_agent_channel_grant_check(context, channel_id, agent_id)
    if denial:
      logger.warning(
        "Slack channel grant denied for ambient message channel={} agent={} — silently dropping",
        channel_id,
        agent_id,
      )
      return

    # Download attachments only after the route is authorized. If Slack file
    # access is unavailable (for example, no files:read scope), the ingest
    # notice is appended to the original text and CAIPE still handles the turn.
    ingest = download_slack_files(raw_files, bot_token=client.token)
    input_files = ingest.files
    message_text = _apply_attachment_notices(message_text, ingest)

    if not message_text.strip() and not input_files:
      logger.info(
        "[{}] Ignoring Slack file message with no usable text or attachments",
        thread_ts,
      )
      return

    conv_result = sse_client.create_conversation(
      title=message_text[:50].strip() or "Slack Thread",
      agent_id=agent_id,
      owner_id=user_email or user_id,
      idempotency_key=thread_ts,
      metadata={
        "thread_ts": thread_ts,
        "channel_id": channel_id,
        "channel_name": channel_config.name,
        # Flag bot/app-owned threads so stats can exclude them (see handle_mention).
        **({"owner_is_bot": True} if is_bot else {}),
        # Persist the bot/app display name so stats can label the "U…" owner_id
        # (see handle_mention).
        **({"owner_display_name": bot_username} if is_bot and bot_username else {}),
        **({"workspace_url": SLACK_WORKSPACE_URL} if SLACK_WORKSPACE_URL else {}),
      },
    )
    conversation_id = conv_result["conversation_id"]
    conv_metadata = conv_result.get("metadata", {})

    # Thread ownership: bot messages start new threads so are never replies;
    # for user messages, honour whoever responded first in this thread.
    # Check in-memory cache first (hot path), fall back to server metadata
    # (survives restarts). thread_root_ts is the ownership key shared with
    # handle_mention.
    thread_root_ts = event.get("thread_ts")
    if not is_bot and thread_root_ts:
      owner_id = session_manager.get_thread_owner(thread_root_ts) or conv_metadata.get("thread_owner_agent_id")
      if owner_id:
        session_manager.set_thread_owner(thread_root_ts, owner_id)  # warm cache on restart
        if owner_id != agent_match.agent_id:
          logger.info(f"[{thread_root_ts}] Thread owned by agent={owner_id}, skipping agent={agent_match.agent_id}{_msg_link(channel_id, thread_root_ts)}")
          return
        logger.info(f"[{thread_root_ts}] Thread owned by agent={owner_id}, confirmed match{_msg_link(channel_id, thread_root_ts)}")

    channel_info = utils.get_channel_context(client, channel_id, session_manager)

    overthink = None
    if is_bot and agent_match.bots:
      overthink = agent_match.bots.overthink
    elif not is_bot and agent_match.users:
      overthink = agent_match.users.overthink

    is_overthink = bool(overthink and overthink.enabled)
    client_context = {
      "source": "slack",
      "channel_type": "channel",
      "channel_name": channel_config.name,
      "channel_topic": channel_info.get("topic", ""),
      "channel_purpose": channel_info.get("purpose", ""),
      "overthink": is_overthink,
      "overthink_boilerplate": ai.OVERTHINK_BOILERPLATE if is_overthink else "",
      "timestamp": thread_ts,
    }
    if user_email:
      client_context["user_email"] = user_email
    if bot_username:
      client_context["bot_username"] = bot_username
    if is_bot:
      if event.get("blocks"):
        client_context["blocks"] = event["blocks"]
      if event.get("attachments"):
        client_context["attachments"] = event["attachments"]
    # Origin context lets downstream authorization derive team from channel.
    client_context = augment_slack_client_context(
      client_context,
      channel_id=channel_id,
      workspace_id=team_id,
      thread_ts=thread_ts,
      surface_kind="channel",
    )

    esc_config = get_escalation_config(agent_match)

    result = _call_ai(
      client=client,
      channel_id=channel_id,
      thread_ts=thread_ts,
      message_text=message_text,
      user_id=user_id,
      team_id=team_id,
      agent_id=agent_id,
      conversation_id=conversation_id,
      overthink_config=overthink,
      escalation_config=esc_config,
      client_context=client_context,
      files=input_files,
    )

    if isinstance(result, dict) and result.get("skipped"):
      reason = result.get("reason", "unknown")
      logger.info(f"[{thread_ts}] Overthink: skipped response ({reason}) for {user_name}")
      session_manager.set_skipped(thread_ts, True)
      return

    session_manager.set_thread_owner(thread_root_ts or thread_ts, agent_id)
    logger.info(f"[{thread_ts}] Completed {sender_label} request for {user_name}")

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    _track_interaction(
      conversation_id=conversation_id,
      thread_ts=thread_ts,
      channel_id=channel_id,
      interaction_type=sender_label,
      user_id=user_id,
      user_email=user_email,
      user_name=user_name,
      response_time_ms=elapsed_ms,
      thread_owner_agent_id=agent_id,
    )

    # Persist per-turn message rows for stats/linking (successful turn only —
    # skipped turns return above; this handler has no retry fallthrough).
    _record_message_turns(
      conversation_id=conversation_id,
      thread_ts=thread_ts,
      channel_id=channel_id,
      trigger_ts=event.get("ts") or thread_ts,
      agent_id=agent_id,
      response_time_ms=elapsed_ms,
      channel_name=channel_config.name if channel_config else None,
    )

  except AgentAccessDeniedError as e:
    logger.warning(
      "Agent access denied for ambient message channel=%s agent=%s user=%s — silently dropping",
      channel_id, e.agent_id, user_id,
    )
  except Exception as e:
    logger.exception(f"Error handling {sender_label} message: {e}")
    try:
      say(
        blocks=slack_formatter.format_error_message(str(e)),
        text=f"Error: {e}",
        thread_ts=event.get("ts"),
      )
    except Exception as say_error:
      logger.exception(f"Failed to send error message: {say_error}")


def handle_message_events(
  body: dict[str, Any], say: Any, client: Any, context: Any = None
) -> None:
  event = body.get("event")
  if not event:
    return
  _log_stage(event, "handle_message_events_entry")

  subtype = event.get("subtype")
  if subtype in ("message_deleted", "message_changed", "channel_join", "channel_leave"):
    return

  # Route DMs to dedicated handler
  channel_type = event.get("channel_type")
  if channel_type == "im" and not event.get("bot_id"):
    handle_dm_message(event, say, client, context)
    return

  channel_id = event.get("channel")
  bot_id = event.get("bot_id")
  is_bot = bot_id is not None

  channel_config = _configured_or_route_backed_channel(channel_id)
  if channel_config is None:
    return

  # Skip true thread replies (ts != thread_ts). Root messages can have
  # thread_ts populated by Slack when a follow-up arrives before the socket
  # event is delivered, so checking thread_ts is not None is too broad.
  is_thread_reply = event.get("thread_ts") is not None and event.get("thread_ts") != event.get("ts")
  if is_thread_reply:
    return

  # Skip @mentions — handled by handle_mention
  bot_info = client.auth_test()
  bot_user_id = bot_info.get("user_id")
  if f"<@{bot_user_id}>" in event.get("text", ""):
    return

  bot_username = None
  sender_bot_user_id = None
  if is_bot:
    bot_username, sender_bot_user_id = utils.get_bot_info_by_id(bot_id)
    if not bot_username:
      logger.warning(f"bots.info lookup failed for bot_id={bot_id}, falling back to event username")
      bot_username = event.get("username")
      if not bot_username:
        logger.warning(f"event.get('username') also returned nothing for bot_id={bot_id}; bot_list filtering may not work correctly")

  sender_user_id = event.get("user") if not is_bot else None
  _match_t0 = time.monotonic()
  matches = _match_channel_agents(
    channel_id,
    channel_config,
    is_bot=is_bot,
    bot_username=bot_username,
    bot_user_id=sender_bot_user_id,
    user_id=sender_user_id,
    listen="message",
    workspace_id=_event_workspace_id(event),
  )
  logger.debug(
    "[{}] stage=match_channel_agents_done duration_ms={} matched={}",
    event.get("ts"), int((time.monotonic() - _match_t0) * 1000), bool(matches),
  )
  if not matches:
    mode = slack_agent_route_mode()
    if mode != "config":
      workspace_id = _event_workspace_id(event)
      resolver = get_slack_agent_route_resolver()
      notice = resolver.explain_no_route_match(
        workspace_id=workspace_id,
        channel_id=channel_id,
        is_bot=is_bot,
        bot_username=bot_username,
        user_id=sender_user_id,
        listen="message",
        app_name=APP_NAME,
        route_required=mode == "db_only" or not utils.is_configured_channel(channel_id),
      )
      if notice:
        _post_route_miss_notice(
          client,
          channel_id,
          sender_user_id,
          notice,
          explicit_invocation=False,
        )
    return

  # First-match wins: config order is the priority order. Only one agent responds
  # per event so that thread memory stays coherent on follow-ups.
  # `context` is plumbed through so _route_to_agent can authorize the selected
  # agent against channel ReBAC and bind the OBO bearer for downstream MCP calls.
  _route_to_agent(event, say, client, channel_config, matches[0], is_bot=is_bot, bot_username=bot_username, context=context)
