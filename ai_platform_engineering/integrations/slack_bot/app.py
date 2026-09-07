# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: E402
"""
CAIPE Slack Bot - Entry Point

A Slack bot that communicates with dynamic agents via AG-UI protocol.
Supports @mention queries, Q&A mode, AI alert processing, HITL forms, and feedback.
"""

import asyncio
import os
import re
import sys
import time
import requests as _requests

# 098: install the log redaction filter BEFORE importing slack_bolt / slack_sdk
# so their module-level loggers pick it up. Slack Bolt has been observed to log
# entire request payloads (containing the per-request `token`, OAuth bearers,
# JWTs, etc.) when a middleware short-circuits without calling next() — see
# `utils.log_redaction` for the full list of patterns scrubbed.
from utils.log_redaction import install as _install_log_redaction  # noqa: E402
_install_log_redaction()

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
from slack_bolt.response import BoltResponse

from loguru import logger
from utils.config import config
from utils import utils
from utils import ai
from utils import slack_context
from utils import slack_formatter
from utils.hitl_handler import HITLCallbackHandler
from utils.chat_envelope import augment_slack_client_context  # noqa: E402
from utils.file_ingest import download_slack_files, IngestResult  # noqa: E402

from sse_client import AgentAccessDeniedError, SSEClient, set_obo_token
from utils.session_manager import SessionManager

from utils.scoring import submit_feedback_score, regenerate_requested

from utils.config_models import ChannelConfig, get_escalation_config  # noqa: E402
from utils.platform_settings import (  # noqa: E402
    resolve_default_agent_id,
    resolve_victorops_agent_id,
)
from utils.slack_agent_routes import (  # noqa: E402
    get_slack_agent_route_resolver,
    slack_agent_route_mode,
    slack_workspace_ref,
)
from utils.slack_runtime_policy import should_post_route_miss_notice  # noqa: E402
from utils.dispatch_identity import apply_execution_identity  # noqa: E402
from utils.unlinked_fallback import apply_unlinked_fallback  # noqa: E402
from utils.slack_admin_api import start_slack_admin_api_server  # noqa: E402

app = App(token=os.environ.get("SLACK_INTEGRATION_BOT_TOKEN", os.environ.get("SLACK_BOT_TOKEN", "")))
APP_NAME = os.environ.get("SLACK_INTEGRATION_APP_NAME", os.environ.get("APP_NAME", "CAIPE"))
_WORKSPACE_URL = os.environ.get("SLACK_WORKSPACE_URL", "").rstrip("/")
_ROUTABLE_AMBIENT_MESSAGE_SUBTYPES = frozenset(
  {None, "", "bot_message", "file_share"}
)


def _msg_link(channel_id: str, ts: str) -> str:
  if not _WORKSPACE_URL or not ts:
    return ""
  return f" {_WORKSPACE_URL}/archives/{channel_id}/p{ts.replace('.', '')}"


def _apply_attachment_notices(message_text: str, ingest: IngestResult) -> str:
  """Append any 'file attached but inaccessible' notices to the agent message.

  Files that couldn't be downloaded (e.g. missing files:read scope) produce
  notices; we fold them into the message so the agent can tell the user a file
  was attached but unreadable instead of silently ignoring it. No notices ⇒
  message unchanged.
  """
  if not ingest.notices:
    return message_text
  note = "\n\n".join(ingest.notices)
  return f"{message_text}\n\n[Attachment note: {note}]" if message_text else f"[Attachment note: {note}]"


def _ingestion_lag_ms(event: dict) -> int | None:
  """Milliseconds between Slack's event timestamp and now.

  ``event["ts"]`` is the wall-clock time Slack assigned when the message was
  sent, so this measures true end-to-end lag (Slack delivery + our own
  queueing/processing), not just time spent inside this process. Used to
  profile where multi-minute response delays accumulate — Slack delivery,
  our RBAC/routing pipeline, or agent dispatch — without hand-correlating
  raw event timestamps against logs after the fact.
  """
  send_ts = event.get("ts")
  try:
    send_ts = float(send_ts)
  except (TypeError, ValueError):
    return None
  return int((time.time() - send_ts) * 1000)


def _log_stage(event: dict, stage: str, **extra) -> None:
  """Emit a single structured timing line for pipeline-stage profiling."""
  fields = " ".join(f"{k}={v}" for k, v in extra.items())
  logger.debug(
    "[{}] stage={} ingestion_lag_ms={} {}",
    event.get("ts"), stage, _ingestion_lag_ms(event), fields,
  )


def _channel_id_from_view_metadata(body: dict) -> str | None:
  """Recover channel_id for view_submission payloads (modal submits).

  Unlike block_actions/event bodies, a view_submission body carries no
  top-level channel field at all — the channel only lives in
  view.private_metadata, which our feedback modal encodes as
  "channel_id|thread_ts|message_ts|agent_id|feedback_type".
  """
  private_metadata = body.get("view", {}).get("private_metadata", "")
  return private_metadata.split("|")[0] or None if private_metadata else None

# 098 Enterprise RBAC enforcement
RBAC_ENABLED = os.environ.get("SLACK_RBAC_ENABLED", "false").lower() == "true"

if RBAC_ENABLED:
    from utils.identity_linker import (
        resolve_slack_user,
        auto_bootstrap_slack_user,
    )
    from utils.channel_team_resolver import (
        resolve_channel_team,
        is_dm_channel,
    )
    from utils.slack_channel_auto_assign import get_slack_channel_auto_assigner
    from utils.obo_exchange import impersonate_user, impersonate_service_account, OboExchangeError
    from utils.slack_rebac import get_slack_channel_rebac_evaluator
    from utils.user_messages import TEAM_SESSION_UNAVAILABLE_MESSAGE
    from utils.service_account_resolver import get_unlinked_service_account_sub
    from utils.keycloak_admin import user_is_federated, realm_has_enabled_idp_broker

    async def _rbac_enrich_context(body, slack_user_id, context, *, require_mapping: bool = True):
        """Resolve identity and enrich Bolt context.

        Returns 'unlinked', ('deny', message), or 'ok'.
        - 'unlinked': no Keycloak user could be resolved (JIT off/failed/no email),
          OR user resolved but has no live IdP link AND the realm has an enabled
          broker → route as the unlinked SA.
        - ('deny', message): channel has no team mapping (hard reject).
        - 'ok': fully linked user; OBO token minted and stored in context.
        Stores team/workspace context for downstream OpenFGA channel checks.
        Channel→agent routing is now relationship-based: the selected Slack
        agent is authorized later against the channel's ReBAC grants.
        """
        keycloak_user_id = await resolve_slack_user(slack_user_id)
        if keycloak_user_id is None:
            keycloak_user_id = await auto_bootstrap_slack_user(slack_user_id)
            if keycloak_user_id is None:
                return "unlinked"

        context["keycloak_user_id"] = keycloak_user_id

        channel_id = (
            body.get("event", {}).get("channel")
            or body.get("channel", {}).get("id")
            or body.get("channel_id")  # slash command bodies
            or _channel_id_from_view_metadata(body)  # view_submission (modal submit)
        )
        if channel_id:
            context["slack_channel_id"] = channel_id

        slack_team_id = (
            body.get("team_id")
            or body.get("event", {}).get("team")
            or os.environ.get("SLACK_WORKSPACE_ID")
        )
        if slack_team_id:
            context["slack_team_id"] = str(slack_team_id)
        context["slack_workspace_id"] = slack_workspace_ref(str(slack_team_id) if slack_team_id else None)

        # Phase 2 (spec 2026-05-24): OBO is team-agnostic. Channel→team
        # resolution still runs because we want a clear reject when a
        # group channel has no mapping, but the slug is no longer fed
        # into the OBO request. The RAG server / PDP derive team
        # downstream from the channel_id in the chat envelope (FR-016).
        if is_dm_channel(channel_id):
            context["surface_kind"] = "dm"
            logger.info(
                "DM channel=%s for user=%s (OBO team-agnostic)",
                channel_id, keycloak_user_id,
            )
        else:
            team_resolution = await resolve_channel_team(channel_id)
            if not team_resolution.team_slug:
                auto_assign = await asyncio.to_thread(
                    get_slack_channel_auto_assigner().assign_channel,
                    workspace_id=context["slack_workspace_id"],
                    channel_id=channel_id,
                    channel_name=body.get("event", {}).get("channel_name"),
                )
                if auto_assign.assigned:
                    get_slack_agent_route_resolver().invalidate(
                        context["slack_workspace_id"], channel_id
                    )
                    team_resolution = await resolve_channel_team(channel_id)
                elif auto_assign.reason not in {"disabled", "existing_mapping"}:
                    logger.warning(
                        "Slack channel auto-assignment skipped channel={} reason={}",
                        channel_id,
                        auto_assign.reason,
                    )
            if not team_resolution.team_slug:
                if not require_mapping:
                    # Slash commands (FR-036) and @mentions in unmapped
                    # channels still need to run — they're personal
                    # surfaces (commands return ephemeral replies). We
                    # mark the surface so downstream handlers can
                    # decide whether the body of the command requires
                    # a channel mapping (it never does for /{cmd}-help
                    # or /{cmd}-list).
                    context["surface_kind"] = "dm"
                    logger.info(
                        "Channel={} has no team mapping; allowing surface_kind=dm "
                        "(require_mapping=False) for user={}",
                        channel_id, keycloak_user_id,
                    )
                else:
                    # Group channel without a team mapping (or user isn't in the
                    # mapped team). Hard reject — we never want to silently
                    # accept a group channel that has no team RBAC binding.
                    return ("deny", team_resolution.deny_message or
                            "This channel isn't assigned to a CAIPE team yet.")
            else:
                # We still surface team metadata in context for legacy log
                # lines / metrics and for the channel-ReBAC PDP call below;
                # the OBO token itself does not carry it.
                context["team_slug"] = team_resolution.team_slug
                context["team_id"] = team_resolution.team_id
                context["team_name"] = team_resolution.team_name
                context["surface_kind"] = "channel"
                logger.info(
                    "Channel={} mapped to team={} (slug={}) for user={}",
                    channel_id, team_resolution.team_name, team_resolution.team_slug, keycloak_user_id,
                )

        # Unlinked-fallback gate (anonymous-and-obo-routing):
        # A JIT-from-Slack user (empty federatedIdentities) should run as the
        # unlinked SA when the realm has an enabled IdP broker — broker
        # presence means "real users authenticate through SSO; JIT shells are
        # unverified placeholders until they link".  When there is NO broker,
        # JIT-via-Slack IS the legitimate user base and they run as themselves.
        if await realm_has_enabled_idp_broker() and not await user_is_federated(keycloak_user_id):
            logger.info(
                "User %s not IdP-linked (broker active) — routing as unlinked",
                keycloak_user_id,
            )
            return "unlinked"

        try:
            obo = await impersonate_user(keycloak_user_id)
            context["obo_token"] = obo.access_token
            logger.info(
                "OBO impersonation succeeded for user={}", keycloak_user_id,
            )
        except OboExchangeError as e:
            # Phase 2: failing the OBO exchange is still a HARD failure —
            # there is no SA fallback that would preserve the user's
            # identity and OpenFGA relationships, so we reject the
            # request rather than silently downgrading.
            logger.error(
                "OBO impersonation failed for user={}: {}", keycloak_user_id, e,
            )
            return ("deny", TEAM_SESSION_UNAVAILABLE_MESSAGE)

        return "ok"

    async def _mint_unlinked_obo_token() -> str | None:
        """Mint an OBO token for the platform unlinked SA.

        Returns the access token string, or ``None`` if:
        - The unlinked SA hasn't been bootstrapped yet (resolver returns None).
        - The token exchange fails.

        Callers must handle ``None`` by degrading gracefully (nudge + stop).
        """
        unlinked_sub = await asyncio.to_thread(get_unlinked_service_account_sub)
        if unlinked_sub is None:
            logger.warning(
                "_mint_unlinked_obo_token: unlinked SA not found in MongoDB "
                "(is_platform_unlinked=True, status=active) — cannot fall back"
            )
            return None
        try:
            obo = await impersonate_service_account(unlinked_sub)
            return obo.access_token
        except OboExchangeError as exc:
            logger.warning(
                "_mint_unlinked_obo_token: impersonation failed for unlinked SA sub=%s: %s",
                unlinked_sub,
                exc,
            )
            return None

    logger.info("Enterprise RBAC enforcement enabled for Slack bot")
else:
    logger.info("Slack RBAC enforcement disabled (set SLACK_RBAC_ENABLED=true to enable)")


def _slack_agent_channel_grant_check(context, channel_id: str | None, agent_id: str | None) -> str | None:
    """Return a denial message when the channel does not have this agent assigned.

    Only checks the channel→agent grant. User-level ``can_use`` is enforced
    by the API when the conversation is created, so we don't duplicate it here.
    Returns None when the channel grant is present (or RBAC is disabled / DM).
    """
    if not RBAC_ENABLED or context is None or not channel_id or not agent_id:
        return None
    try:
        if is_dm_channel(channel_id):
            return None
        workspace_id = context.get("slack_workspace_id") or slack_workspace_ref()
        obo_token = context.get("obo_token")
    except AttributeError:
        return None

    decision = get_slack_channel_rebac_evaluator().check_channel_grant(
        workspace_id=str(workspace_id),
        channel_id=str(channel_id),
        agent_id=str(agent_id),
        obo_token=obo_token if isinstance(obo_token, str) else None,
    )
    if decision.channel_allowed:
        return None

    logger.info(
        "Slack channel grant denied channel={} agent={} reason={}",
        channel_id,
        agent_id,
        decision.reason,
    )
    return f"Agent *{agent_id}* is not assigned to this channel. Ask an admin to add it in the {APP_NAME} Admin panel."


def _post_ephemeral_for_event(client, event, channel_id, user_id, text) -> None:
    """Post an ephemeral reply placed where the user is looking.

    If the triggering message is a thread reply, place the ephemeral in that
    thread; if it's a top-level message, post it at the channel root. Passing a
    top-level message's own `ts` as `thread_ts` would bury the ephemeral in a
    not-yet-open thread the user has to "know" to click into.

    A message is a genuine thread reply only when `thread_ts` is present AND
    differs from `ts` — a thread's ROOT message also carries `thread_ts` (equal
    to its own `ts`) once it has replies, so presence alone is not reliable.
    """
    thread_ts = event.get("thread_ts") if isinstance(event, dict) else None
    ts = event.get("ts") if isinstance(event, dict) else None
    is_thread_reply = bool(thread_ts) and thread_ts != ts
    kwargs = {"channel": channel_id, "user": user_id, "text": text}
    if is_thread_reply:
        kwargs["thread_ts"] = thread_ts
    client.chat_postEphemeral(**kwargs)


def _agent_access_denied_text(agent_id: str, context, agent_match=None) -> str:
    """Build the 'no access to agent' message.

    Distinguishes the acting identity: when the route runs as a service account
    the denial is about that SA, not the human ("You"). Includes the owning
    team name (when known) so the user knows who to ask for a grant.
    """
    # QUAL-2: getattr(obj, attr, default) never raises AttributeError, so
    # the previous except AttributeError blocks were dead code — removed.
    exec_id = getattr(agent_match, "execution_identity", None)
    sa_name: str | None = None
    if exec_id is not None and getattr(exec_id, "mode", None) == "service_account":
        raw_name = getattr(exec_id, "service_account_name", None)
        sa_name = raw_name if raw_name else None  # keep None; handled below (UX-4)

    if sa_name is not None:
        # Named SA: bold the name.
        subject = f"The service account *{sa_name}*"
        verb = "doesn't"
    elif exec_id is not None and getattr(exec_id, "mode", None) == "service_account":
        # SA route but no name stored — UX-4: don't produce "*the configured service account*".
        subject = "The configured service account"
        verb = "doesn't"
    else:
        subject = "You"
        verb = "don't"

    team_name = context.get("team_name") if context is not None else None

    who = f"an admin on the *{team_name}* team" if team_name else "an admin"
    return (
        f"{subject} {verb} have access to agent *{agent_id}*. "
        f"Ask {who} to grant access in the {APP_NAME} Admin panel."
    )


def _obo_token_from_context(context):
    """Extract OBO JWT from Bolt context (FR-019).

    Returns the user-scoped OBO token set by ``_rbac_enrich_context``,
    or ``None`` when RBAC is disabled or the OBO exchange failed.
    """
    if not RBAC_ENABLED or context is None:
        return None
    try:
        tok = context.get("obo_token")
        return tok if isinstance(tok, str) and tok else None
    except AttributeError:
        return None


def _bind_obo_for_handler(context):
    """Bind the per-request OBO token onto the SSE client's ContextVar.

    Spec 104 Story 3 — every Slack handler that calls into ``sse_client``
    (directly or via ``utils/ai.py``) must call this once at entry. The
    SSE client's ``_get_headers`` then prefers the user-scoped OBO token
    over the bot's service-account token, so downstream services
    (``caipe-ui`` BFF, ``dynamic-agents``) see the real user's
    ``sub`` + ``act.sub`` claims and can apply per-user RBAC.

    No-ops cleanly when:
      - RBAC is disabled (no impersonation step ran)
      - The OBO exchange failed (we DON'T fall back to SA — that would
        defeat the whole point; instead the SSE client falls back to SA
        on its own and we surface a clear "auth degraded" warning).

    The ContextVar is naturally task-scoped so we don't need to reset it
    in a finally block; it disappears when the Bolt handler task exits.
    """
    obo = _obo_token_from_context(context)
    if obo:
        set_obo_token(obo)
    else:
        # Explicitly clear any stale token from a previous handler running
        # on the same thread/event loop slot. Belt-and-braces — Bolt
        # spawns a fresh task per event so this should already be None.
        set_obo_token(None)


AUTH_ENABLED = os.environ.get("SLACK_INTEGRATION_ENABLE_AUTH", "false").lower() == "true"

SLACK_WORKSPACE_URL = os.environ.get("SLACK_WORKSPACE_URL", "")
logger.info("SLACK_WORKSPACE_URL={}", SLACK_WORKSPACE_URL or "(not set)")

auth_client = None
if AUTH_ENABLED:
  from utils.oauth2_client import OAuth2ClientCredentials

  try:
    auth_client = OAuth2ClientCredentials.from_env()
    logger.info("OAuth2 client credentials auth enabled for dynamic agents requests")
  except RuntimeError as e:
    logger.error(f"Failed to initialize OAuth2 auth: {e}")
    raise
else:
  logger.info("Auth disabled (set SLACK_INTEGRATION_ENABLE_AUTH=true to enable)")

# Initialize SSE client - CAIPE_API_URL is required
CAIPE_API_URL = os.environ.get("CAIPE_API_URL")
if not CAIPE_API_URL:
  raise ValueError("CAIPE_API_URL environment variable is required")

sse_client = SSEClient(CAIPE_API_URL, timeout=300, auth_client=auth_client)
logger.info(f"SSE client initialized at {CAIPE_API_URL}")

# Initialize session manager (in-memory only — conversation IDs are deterministic)
session_manager = SessionManager()
logger.info(f"Session store type: {session_manager.get_store_type()}")

hitl_handler = HITLCallbackHandler(sse_client)

max_retries = int(os.environ.get("CAIPE_CONNECT_RETRIES", "10"))
retry_delay = int(os.environ.get("CAIPE_CONNECT_RETRY_DELAY", "6"))

for attempt in range(1, max_retries + 1):
  try:
    logger.info(f"Connecting to {APP_NAME} at {CAIPE_API_URL} (attempt {attempt}/{max_retries})")
    health_resp = _requests.get(f"{CAIPE_API_URL.rstrip('/')}/api/health", timeout=10)
    if health_resp.ok:
      logger.info(f"Connected to {APP_NAME} API (status {health_resp.status_code})")
    else:
      raise Exception(f"Health check returned {health_resp.status_code}: {health_resp.text}")
    break
  except Exception as e:
    if attempt < max_retries:
      logger.warning(f"{APP_NAME} API not ready, retrying in {retry_delay}s...")
      time.sleep(retry_delay)
    else:
      logger.error(f"Failed to connect to {APP_NAME} after {max_retries} attempts: {e}.")
      sys.exit(1)


def _get_agent_id(channel_config=None, mapped_agent_id: str | None = None) -> str:
  """Resolve agent_id: DB mapping > channel config > global default.

  Spec-098 RBAC helper. When the BFF/MongoDB has a per-channel
  agent mapping, `mapped_agent_id` is the slug to use; otherwise
  fall back to the channel's static config and finally to the
  global default. Currently used as a fallback path; most call
  sites prefer `_match_agents()` (main's multi-agent dispatcher)
  with an RBAC override applied separately. Kept here so other
  spec-098 surfaces that import it continue to work.
  """
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


def _agent_listens_to(agent_listen, requested):
  """Check if an agent's listen mode satisfies the requested mode."""
  return agent_listen == "all" or agent_listen == requested


def _match_agents(channel_config, is_bot, bot_username=None, bot_user_id=None, user_id=None, listen=None):
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


def _configured_or_route_backed_channel(channel_id: str | None):
  """Return channel config, allowing DB-backed routes in opt-in modes."""
  if channel_id and utils.is_configured_channel(channel_id):
    return config.channels[channel_id]
  if slack_agent_route_mode() != "config" and channel_id:
    return ChannelConfig(name=channel_id, agents=[])
  return None


def _event_workspace_id(event) -> str:
  team_id = event.get("team")
  return slack_workspace_ref(str(team_id) if team_id else None)


def _match_channel_agents(
  channel_id,
  channel_config,
  is_bot,
  bot_username=None,
  bot_user_id=None,
  user_id=None,
  listen=None,
  workspace_id=None,
):
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
  client,
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


def _resolve_escalation(channel_config, agent_id: str | None = None, channel_id: str | None = None):
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


def _get_agent_id_for_dm() -> str:
  """Resolve agent_id for DMs: dm_agent_id -> default_agent_id -> empty.

  Legacy helper retained as the LAST-RESORT fallback when the new DM
  resolver (FR-023) cannot run (e.g. RBAC disabled, no OBO token).
  When ``SLACK_RBAC_ENABLED=true`` the resolver picked from
  ``dm_thread_overrides`` / saved prefs / env defaults is preferred.
  """
  if config.defaults.dm_agent_id:
    return config.defaults.dm_agent_id
  # Platform default from Admin → Settings → Default Agent (DB) wins over the
  # SLACK_INTEGRATION_DEFAULT_AGENT_ID env/YAML fallback for DMs too.
  default_agent_id = resolve_default_agent_id(config.defaults.default_agent_id)
  if default_agent_id:
    return default_agent_id
  logger.warning("No agent_id configured for DMs — using empty string")
  return ""


# =============================================================================
# Phase 2 (spec 2026-05-24) — personal DM commands + DM agent resolver
# =============================================================================
# These singletons back BOTH the slash-command handlers below and the DM
# resolver wired into `handle_dm_message`. We construct them lazily so unit
# tests that import `app.py` without a full Slack environment don't blow up.
from utils.accessible_agents_client import AccessibleAgentsClient  # noqa: E402
from utils.command_rate_limiter import CommandRateLimiter  # noqa: E402
from utils.dm_agent_resolver import DmAgentResolution, resolve_dm_agent  # noqa: E402
from utils.dm_authz_client import DmAuthzClient  # noqa: E402
from utils.dm_thread_overrides import OverrideKey, get_default_override_store  # noqa: E402
from utils.slash_commands import (  # noqa: E402
    SlashCommandResult,
    handle_help_command,
    handle_list_command,
    handle_use_command,
)
from utils.user_preferences_client import UserPreferencesClient  # noqa: E402

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
        max_per_window=int(os.environ.get("SLACK_COMMAND_RATE_LIMIT", "5")),
        window_seconds=float(os.environ.get("SLACK_COMMAND_RATE_WINDOW", "30")),
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


def _ack_ephemeral(ack, result: SlashCommandResult) -> None:
  """Post a slash-command result as an ephemeral reply (FR-034)."""
  try:
    ack(response_type="ephemeral", text=result.text)
  except Exception as exc:
    logger.warning("Failed to ack slash command (code={}): {}", result.code, exc)


def _register_slash_commands() -> None:
  """Register /{cmd}-help, /{cmd}-list, /{cmd}-use with the Bolt app.

  The command prefix is derived from APP_NAME at startup time so that
  ``APP_NAME=Forge`` registers ``/forge-help`` etc.
  """
  from utils.slash_commands import _cmd_prefix  # local import to avoid circular refs
  cmd = _cmd_prefix()

  @app.command(f"/{cmd}-help")
  def slash_help(ack, body, context=None):
    channel_id = body.get("channel_id") or ""
    is_dm = bool(channel_id) and channel_id.startswith("D")
    user_id = body.get("user_id") or ""
    result = handle_help_command(
        user_key=user_id,
        is_dm=is_dm,
        rate_limiter=_command_rate_limiter(),
    )
    _ack_ephemeral(ack, result)

  @app.command(f"/{cmd}-list")
  def slash_list(ack, body, context=None):
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


  @app.command(f"/{cmd}-use")
  def slash_use(ack, body, context=None):
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


_register_slash_commands()


def _resolve_conversation_id(thread_ts: str, channel_id: str, agent_id: str = "", owner_id: str = "") -> str:
  """Resolve a Slack thread to its server-side conversation_id via idempotency_key lookup.

  Calls create_conversation with the thread_ts as idempotency_key. If the
  conversation already exists the server returns it (created=false); otherwise
  a new one is created. This ensures all handlers in a thread share the same
  conversation_id used by UI and LangGraph checkpoints.
  """
  channel_config = config.channels.get(channel_id)
  channel_name = channel_config.name if channel_config else None
  conv_result = sse_client.create_conversation(
    title="Slack Thread",
    agent_id=agent_id,
    owner_id=owner_id or None,
    idempotency_key=thread_ts,
    metadata={
      "thread_ts": thread_ts,
      "channel_id": channel_id,
      **({"channel_name": channel_name} if channel_name else {}),
      **({"workspace_url": SLACK_WORKSPACE_URL} if SLACK_WORKSPACE_URL else {}),
    },
  )
  return conv_result["conversation_id"]


def _track_interaction(
  conversation_id: str,
  thread_ts: str,
  channel_id: str,
  interaction_type: str,
  user_id: str,
  user_email: str | None = None,
  user_name: str | None = None,
  response_time_ms: int | None = None,
  last_processed_ts: str | None = None,
  thread_owner_agent_id: str | None = None,
) -> None:
  """PATCH conversation metadata with interaction tracking fields.

  Called after each successful AI response to record who interacted,
  how long it took, and what kind of interaction it was.  Also updates
  ``last_processed_ts`` for delta context on follow-ups, and persists
  ``thread_owner_agent_id`` so thread ownership survives bot restarts.
  """
  metadata: dict[str, object] = {
    "interaction_type": interaction_type,
    "user_id": user_id,
  }
  if user_email:
    metadata["user_email"] = user_email
  if user_name:
    metadata["user_name"] = user_name
  if response_time_ms is not None:
    metadata["response_time_ms"] = response_time_ms

  # Build Slack permalink
  workspace = _WORKSPACE_URL
  if workspace and thread_ts:
    metadata["slack_link"] = f"{workspace}/archives/{channel_id}/p{thread_ts.replace('.', '')}"

  if last_processed_ts:
    metadata["last_processed_ts"] = last_processed_ts

  if thread_owner_agent_id:
    metadata["thread_owner_agent_id"] = thread_owner_agent_id

  try:
    sse_client.update_conversation_metadata(conversation_id, metadata)
  except Exception:
    logger.warning(f"[{thread_ts}] Failed to update interaction metadata")


def _record_message_turns(
  conversation_id: str,
  thread_ts: str,
  channel_id: str,
  trigger_ts: str,
  agent_id: str,
  response_time_ms: int | None = None,
  channel_name: str | None = None,
) -> None:
  """Persist per-turn message rows (metadata-only) for a Slack exchange.

  Slack turn content lives in Slack / the LangGraph checkpointer, so we do NOT
  duplicate it here. We write two content-less ``messages`` rows — one ``user``
  turn and one ``assistant`` turn — carrying just the metadata admin stats need
  to count Slack messages the same way as web (source, agent, latency) and to
  deep-link back to the source thread.

  Called ONLY after a genuine, successful Forge response (never on skipped or
  retry/error turns). ``message_id`` is derived from the triggering message ts
  so the upsert is idempotent across Slack event retries.

  ``agent_id`` is sent as-is; the server resolves it to the canonical display
  name so Slack and web message rows share the same ``agent_name`` label. The
  row's ``owner_id`` (the user-attribution key for stats) is inherited from the
  conversation server-side — which the bot set to the Slack user's email — so
  the same person's Slack and web activity aggregate to one bucket.
  """
  # Deep-link back to the Slack thread (same shape as _track_interaction).
  slack_permalink = None
  workspace = _WORKSPACE_URL
  if workspace and thread_ts:
    slack_permalink = f"{workspace}/archives/{channel_id}/p{thread_ts.replace('.', '')}"

  link_meta: dict[str, object] = {
    "source": "slack",
    "agent_id": agent_id,
    "channel_id": channel_id,
    "thread_ts": thread_ts,
  }
  if channel_name:
    link_meta["channel_name"] = channel_name
  if slack_permalink:
    link_meta["slack_permalink"] = slack_permalink

  # Stable per-turn base id from the triggering message ts (dedupe key).
  base_id = f"slack-{conversation_id}-{trigger_ts}"

  try:
    sse_client.add_message(
      conversation_id=conversation_id,
      message_id=f"{base_id}-user",
      role="user",
      metadata={
        **link_meta,
        "turn_id": f"{trigger_ts}-user",
      },
    )
    sse_client.add_message(
      conversation_id=conversation_id,
      message_id=f"{base_id}-assistant",
      role="assistant",
      metadata={
        **link_meta,
        "turn_id": f"{trigger_ts}-assistant",
        "is_final": True,
        **({"latency_ms": response_time_ms} if response_time_ms is not None else {}),
      },
    )
  except Exception:
    # Best-effort telemetry: never let a stats write break the Slack response.
    logger.warning(f"[{thread_ts}] Failed to record Slack message turns")


def _call_ai(
  client,
  channel_id,
  thread_ts,
  message_text,
  user_id,
  team_id,
  agent_id,
  conversation_id,
  triggered_by_user_id=None,
  additional_footer=None,
  overthink_config=None,
  escalation_config=None,
  client_context=None,
  files=None,
):
  """Route to stream_response or invoke_response based on user type."""
  logger.info(f"[{thread_ts}] _call_ai: conv={conversation_id} agent={agent_id} user={user_id} overthink={overthink_config}")
  can_stream = user_id and user_id[0] in ("U", "W")

  if can_stream:
    return ai.stream_response(
      sse_client=sse_client,
      slack_client=client,
      channel_id=channel_id,
      thread_ts=thread_ts,
      message_text=message_text,
      team_id=team_id,
      user_id=user_id,
      agent_id=agent_id,
      conversation_id=conversation_id,
      triggered_by_user_id=triggered_by_user_id,
      additional_footer=additional_footer,
      overthink_config=overthink_config,
      escalation_config=escalation_config,
      client_context=client_context,
      files=files,
    )
  else:
    return ai.invoke_response(
      sse_client=sse_client,
      slack_client=client,
      channel_id=channel_id,
      thread_ts=thread_ts,
      message_text=message_text,
      agent_id=agent_id,
      conversation_id=conversation_id,
      triggered_by_user_id=triggered_by_user_id,
      additional_footer=additional_footer,
      escalation_config=escalation_config,
      client_context=client_context,
      files=files,
    )


# =============================================================================
# 098 RBAC Global Middleware
# =============================================================================
# Deduplicate Slack event retries (Socket Mode delivers retries as new events)
_seen_events: dict[str, float] = {}
_SEEN_TTL = 30.0  # seconds

# Rate-limit "account not linked" prompts — at most once per hour per user
_linking_prompt_sent: dict[str, float] = {}
_LINKING_PROMPT_COOLDOWN = float(os.environ.get("SLACK_LINKING_PROMPT_COOLDOWN", "3600"))

# Returning BoltResponse(200) from the global middleware tells bolt-python
# "the request is handled, skip the rest of the chain", AND signals to Slack
# that the envelope has been acknowledged so Socket Mode does not retry the
# same event 3 more times. This is the maintainer-recommended way to short-
# circuit a global middleware:
#   https://github.com/slackapi/bolt-python/issues/235
#   https://github.com/slackapi/bolt-python/issues/1222
# Without this, every short-circuit branch (dedupe, silence, unlinked, deny)
# logs "skipped calling next()/next_() without providing a response" AND
# Slack retries the event up to 3 more times, generating duplicate work
# and confusing logs.
_HANDLED_200 = BoltResponse(status=200, body="")


@app.middleware
def rbac_global_middleware(body, context, next, logger):
    # Deduplicate retried events
    event_id = body.get("event_id")
    if event_id:
        import time as _time
        now = _time.time()
        # Prune old entries
        stale = [k for k, v in _seen_events.items() if now - v > _SEEN_TTL]
        for k in stale:
            _seen_events.pop(k, None)
        if event_id in _seen_events:
            logger.debug("Ignoring duplicate event_id=%s", event_id)
            return _HANDLED_200
        _seen_events[event_id] = now
    """Enterprise RBAC enforcement checkpoint (098).

    When SLACK_RBAC_ENABLED=true:
    1. Extracts Slack user ID from the event/action payload.
    2. Resolves the Slack user to a Keycloak identity (identity link).
    3. If unlinked, sends an ephemeral message prompting account linking.
    4. If linked, performs OBO token exchange so downstream requests
       carry the user's identity (sub=user, act.sub=bot).
    5. Stores the OBO access token and user_sub on the Bolt context
       for per-handler RBAC checks.
    """
    _log_stage(body.get("event", {}), "middleware_entry")
    if not RBAC_ENABLED:
        next()
        return

    # Skip system messages (joins, leaves, topic changes, etc.). NOTE:
    # "bot_message" is deliberately NOT in this list — bot-authored messages
    # need the event.get("bot_id") branch below to mint the unlinked SA
    # token; skipping them here would return via next() with no obo_token
    # ever set, so _slack_agent_channel_grant_check always denies with
    # reason=pdp_unavailable for bot/workflow senders.
    event = body.get("event", {})
    subtype = event.get("subtype", "")
    if subtype in (
        "channel_join", "channel_leave", "channel_topic", "channel_purpose",
        "channel_name", "message_changed", "message_deleted",
        "group_join", "group_leave",
    ):
        next()
        return

    # Bot messages: skip Keycloak resolution and nudge; mint unlinked SA token
    # directly as a baseline. Bots have no Keycloak account so resolution always
    # fails, and the nudge path tries to DM the bot which also fails noisily.
    #
    # We still need a baseline obo_token in context so that obo_user routes
    # have something to carry (service_account routes will overwrite it in
    # _route_to_agent anyway). The bot's Slack user ID and bot_id are recorded
    # so downstream logging and the allowlist check in _match_agents work as
    # normal.
    if event.get("bot_id"):
        # Resolve the bot's U-prefixed user ID via bots.info (mirrors the
        # pattern in _route_to_agent lines 1518-1519), falling back to the
        # raw bot_id only if the lookup fails.
        _, _bot_user_id = utils.get_bot_info_by_id(event.get("bot_id"))
        bot_slack_user_id = _bot_user_id or event.get("user") or event.get("bot_id")
        slack_team_id = (
            body.get("team_id")
            or event.get("team")
            or os.environ.get("SLACK_WORKSPACE_ID")
        )
        channel = (
            event.get("channel")
            or body.get("channel", {}).get("id")
            or body.get("channel_id")
        )
        context["rbac_enabled"] = True
        context["slack_user_id"] = bot_slack_user_id
        context["is_bot"] = True
        context["slack_workspace_id"] = slack_workspace_ref(str(slack_team_id) if slack_team_id else None)
        context["surface_kind"] = "dm" if is_dm_channel(channel) else "channel"
        bot_loop = None
        try:
            bot_loop = asyncio.new_event_loop()
            unlinked_token = bot_loop.run_until_complete(_mint_unlinked_obo_token())
        except Exception as exc:
            logger.warning(
                "[%s] rbac_global_middleware: unlinked SA mint failed for bot=%s: %s",
                event.get("ts"),
                bot_slack_user_id,
                exc,
            )
            unlinked_token = None
        finally:
            if bot_loop is not None:
                bot_loop.close()
        if unlinked_token is None:
            logger.warning(
                "[%s] rbac_global_middleware: no unlinked SA available, dropping bot message from %s",
                event.get("ts"),
                bot_slack_user_id,
            )
            return _HANDLED_200
        context["obo_token"] = unlinked_token
        context["unlinked_fallback"] = True
        next()
        return

    slack_user_id = (
        event.get("user")
        or body.get("user", {}).get("id")
        or body.get("user_id")
    )

    if not slack_user_id:
        next()
        return

    context["rbac_enabled"] = True
    context["slack_user_id"] = slack_user_id

    # @mentions work in any channel; Q&A messages require a channel-to-team mapping.
    # Slash commands (spec 2026-05-24 FR-036) are personal surfaces that ALWAYS
    # run regardless of channel mapping — the command itself decides whether
    # its semantics require DM context. So we treat both like mentions for the
    # mapping requirement and the command handlers enforce DM-only semantics
    # for `/{cmd}-use <agent>` themselves.
    is_mention = event.get("type") == "app_mention"
    is_command = bool(body.get("command"))

    loop = None
    _rbac_t0 = time.monotonic()
    try:
        loop = asyncio.new_event_loop()
        rbac_status = loop.run_until_complete(
            _rbac_enrich_context(
                body,
                slack_user_id,
                context,
                require_mapping=not (is_mention or is_command),
            )
        )
        logger.debug(
            "[{}] stage=rbac_enrich_context_done duration_ms={} status={}",
            event.get("ts"), int((time.monotonic() - _rbac_t0) * 1000), rbac_status,
        )
    except Exception as exc:
        logger.error("Failed to resolve Slack user %s — denying request: %s", slack_user_id, exc)
        return _HANDLED_200
    finally:
        if loop is not None:
            loop.close()

    channel = (
        body.get("event", {}).get("channel")
        or body.get("channel", {}).get("id")
        or body.get("channel_id")  # slash command bodies
        or _channel_id_from_view_metadata(body)  # view_submission (modal submit)
    )

    if rbac_status == "unlinked":
        import time as _time
        now = _time.time()
        last_sent = _linking_prompt_sent.get(slack_user_id, 0)

        # Decision 5 (anonymous-and-obo-routing): instead of dropping the
        # request, fall back to the platform unlinked SA so the user still
        # gets a baseline response. Logic extracted to apply_unlinked_fallback
        # (unlinked_fallback.py) so it can be unit-tested without importing slack_bolt
        # (TEST-5/6).

        async def _mint_wrapper() -> str | None:
            return await _mint_unlinked_obo_token()

        fallback_loop = None
        try:
            fallback_loop = asyncio.new_event_loop()
            should_proceed = fallback_loop.run_until_complete(
                apply_unlinked_fallback(
                    rbac_status=rbac_status,
                    slack_user_id=slack_user_id,
                    channel=channel,
                    context=context,
                    mint_fn=_mint_wrapper,
                    linking_url_fn=None,
                    last_sent=last_sent,
                    linking_prompt_cooldown=_LINKING_PROMPT_COOLDOWN,
                    is_dm_channel_fn=is_dm_channel,
                    is_explicit_invocation=is_mention or is_command or is_dm_channel(channel),
                )
            )
        except Exception as exc:
            logger.warning(
                "rbac_global_middleware: apply_unlinked_fallback raised for user=%s: %s",
                slack_user_id,
                exc,
            )
            should_proceed = False
        finally:
            if fallback_loop is not None:
                fallback_loop.close()

        if context.get("unlinked_fallback"):
            _linking_prompt_sent[slack_user_id] = now
        elif not should_proceed and now - last_sent >= _LINKING_PROMPT_COOLDOWN:
            _linking_prompt_sent[slack_user_id] = now

        if not should_proceed:
            return _HANDLED_200

    if isinstance(rbac_status, tuple) and rbac_status[0] == "deny":
        msg = rbac_status[1]
        # WARNING-level log instead of posting the denial back to Slack. We
        # deliberately do NOT notify the user in-channel: posting (even
        # ephemerally) is noisy and leaks RBAC config details, so the denial is
        # surfaced only in the slackbot logs for operators to debug "why didn't
        # my user get a response?".
        #
        # NOTE: `logger` here is Bolt's injected stdlib logging.Logger (a
        # function param), NOT the module-level loguru logger — so it uses
        # %-style formatting, not {}. Using {} here raises TypeError at emit.
        logger.warning(
            "RBAC denied request for slack_user=%s channel=%s: %s",
            slack_user_id, channel, msg,
        )
        # Return BoltResponse(200) so Slack does not retry the event 3 more
        # times — without this the same denial fires up to 4× and Bolt logs
        # the "middleware skipped calling next()" warning on every retry.
        return _HANDLED_200

    next()


# =============================================================================
# @mention handler (manually invoke CAIPE)
# =============================================================================
@app.event("app_mention")
def handle_mention(event, say, client, context=None):
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
        # assisted-by Codex codex-gpt-5-5
        # Older route records may not carry execution_identity yet; keep using
        # the request-bound identity instead of failing the mention handler.
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
    # Phase 1: propagate originating channel context so RAG/PDP can derive
    # team_id from channel_id (spec FR-016/FR-017).
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

    # Telemetry: record interaction metadata. _track_interaction also
    # updates `last_processed_ts` (delta-context fast path on follow-ups,
    # spec from commit 706a1994), so this single call replaces what was
    # previously an inline `update_conversation_metadata` POST.
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


def _route_to_agent(event, say, client, channel_config, agent_match, is_bot, bot_username=None, context=None):
  """Unified handler for both user and bot messages.

  Replaces the previous `handle_qanda_message` Q&A-mode handler. The
  spec-098 RBAC commit (02589bdd) collapsed channel→team mapping into
  unified channel→dynamic-agent routing, and main's multi-agent
  dispatcher (`_match_agents`) is the single dispatch point now.

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
    # For service_account routes: mint the SA token synchronously (new event
    # loop, matching the pattern used by _rbac_enrich_context in the middleware)
    # and overwrite context["obo_token"] so _bind_obo_for_handler carries it.
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
    # Phase 1: propagate originating channel context (spec FR-016/FR-017).
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


def handle_dm_message(event, say, client, context=None):
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

    # Phase 2 (spec 2026-05-24 FR-023): pick the DM agent via the
    # override → saved-pref → dm_agent_id → default_agent_id chain.
    # When RBAC is disabled OR we couldn't get an OBO token (auth
    # degraded), fall back to the legacy static resolver so the bot
    # still works in pre-RBAC deployments.
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
    # Phase 1: propagate originating DM context. For DMs there's no
    # channel_team_mappings row — that absence is the DM signal (spec
    # FR-018), so RAG falls back to user-team-union evaluation.
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

    # Telemetry: record interaction metadata. _track_interaction also
    # updates `last_processed_ts` (delta-context fast path on follow-ups),
    # so this single call replaces the older inline metadata POST.
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


@app.event("message")
def handle_message_events(body, say, client, context=None):
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


# =============================================================================
# HITL (Human-in-the-Loop) Form Action Handler
# =============================================================================
@app.action(re.compile(r"hitl_.*"))
def handle_hitl_action(ack, body, client):
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
@app.action("caipe_feedback")
def handle_caipe_feedback(ack, body, client, context=None):
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


@app.action("caipe_feedback_more_detail")
def handle_feedback_more_detail(ack, body, client):
  _open_feedback_modal(ack, body, client, feedback_type="needs_detail")


@app.action("caipe_feedback_less_verbose")
def handle_feedback_less_verbose(ack, body, client):
  _open_feedback_modal(ack, body, client, feedback_type="too_verbose")


@app.action("caipe_retry")
def handle_caipe_retry(ack, body, client, context=None):
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
@app.action("caipe_escalation_get_help")
def handle_escalation_get_help(ack, body, client, context=None):
  ack()
  _bind_obo_for_handler(context)
  try:
    from utils.escalation import execute_escalation

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


@app.action("caipe_delete_message")
def handle_delete_message(ack, body, client, context=None):
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


def _open_feedback_modal(ack, body, client, feedback_type):
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


@app.action("caipe_feedback_wrong_answer")
def handle_feedback_wrong_answer(ack, body, client):
  _open_feedback_modal(ack, body, client, feedback_type="wrong_answer")


@app.action("caipe_feedback_other")
def handle_feedback_other(ack, body, client):
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


@app.view("caipe_feedback_modal")
def handle_feedback_modal_submission(ack, body, client, view, context=None):
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


@app.event("reaction_added")
def handle_reaction_added(event, logger):
  pass


@app.event("reaction_removed")
def handle_reaction_removed(event, logger):
  pass


@app.event("assistant_thread_context_changed")
def handle_assistant_thread_context_changed(event, logger):
  pass


@app.event("assistant_thread_started")
def handle_assistant_thread_started(event, logger):
  pass


@app.event("app_home_opened")
def handle_app_home_opened(event, logger):
  pass


@app.error
def custom_error_handler(error, body, logger):
  logger.exception(f"Error: {error}, Request body: {body}")


if __name__ == "__main__":
  start_slack_admin_api_server(config)
  bot_mode = os.environ.get("SLACK_INTEGRATION_BOT_MODE", os.environ.get("SLACK_BOT_MODE", "socket")).lower()

  if bot_mode == "http":
    logger.info(f"Starting {APP_NAME} Slack Bot in HTTP mode on port 3000")
    app.start(port=int(os.environ.get("PORT", 3000)))
  else:
    logger.info(f"Starting {APP_NAME} Slack Bot in Socket Mode")
    app_token = os.environ.get("SLACK_INTEGRATION_APP_TOKEN", os.environ.get("SLACK_APP_TOKEN", ""))
    handler = SocketModeHandler(app, app_token)
    handler.start()
