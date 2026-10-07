# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Slack identity enrichment and global authorization middleware."""

from __future__ import annotations

import asyncio
import time
from typing import Any

from loguru import logger

from handler_dependencies import AuthorizationDependencies
from sse_client import set_obo_token
from utils import utils
from utils.channel_team_resolver import is_dm_channel, resolve_channel_team
from utils.identity_linker import auto_bootstrap_slack_user, resolve_slack_user
from utils.keycloak_admin import realm_has_enabled_idp_broker, user_is_federated
from utils.obo_exchange import (
  OboExchangeError,
  impersonate_service_account,
  impersonate_user,
)
from utils.service_account_resolver import get_unlinked_service_account_sub
from utils.slack_agent_routes import get_slack_agent_route_resolver, slack_workspace_ref
from utils.slack_channel_auto_assign import get_slack_channel_auto_assigner
from utils.slack_rebac import get_slack_channel_rebac_evaluator
from utils.unlinked_fallback import apply_unlinked_fallback
from utils.user_messages import TEAM_SESSION_UNAVAILABLE_MESSAGE


APP_NAME = "CAIPE"
RBAC_ENABLED = False
_HANDLED_200: Any = None
_WORKSPACE_ID = ""
_LINKING_PROMPT_COOLDOWN = 3600.0


def configure_authorization(dependencies: AuthorizationDependencies) -> None:
  """Install process-scoped collaborators used by authorization handlers."""
  global APP_NAME, RBAC_ENABLED, _HANDLED_200, _WORKSPACE_ID
  global _LINKING_PROMPT_COOLDOWN

  APP_NAME = dependencies.app_name
  RBAC_ENABLED = dependencies.rbac_enabled
  _HANDLED_200 = dependencies.handled_response
  _WORKSPACE_ID = dependencies.workspace_id
  _LINKING_PROMPT_COOLDOWN = dependencies.linking_prompt_cooldown


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

async def _rbac_enrich_context(
  body: dict[str, Any],
  slack_user_id: str,
  context: Any,
  *,
  require_mapping: bool = True,
) -> str | tuple[str, str]:
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
            or _WORKSPACE_ID
        )
        if slack_team_id:
            context["slack_team_id"] = str(slack_team_id)
        context["slack_workspace_id"] = slack_workspace_ref(str(slack_team_id) if slack_team_id else None)

        # OBO is team-agnostic; channel mapping still rejects unassigned groups.
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
                # Team metadata supports logs, metrics, and channel ReBAC checks.
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
            # OBO failure rejects the request because SA fallback loses user identity.
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

def _slack_agent_channel_grant_check(
  context: Any, channel_id: str | None, agent_id: str | None
) -> str | None:
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


def _post_ephemeral_for_event(
  client: Any,
  event: dict[str, Any],
  channel_id: str,
  user_id: str,
  text: str,
) -> None:
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


def _agent_access_denied_text(
  agent_id: str, context: Any, agent_match: Any = None
) -> str:
    """Build the 'no access to agent' message.

    Distinguishes the acting identity: when the route runs as a service account
    the denial is about that SA, not the human ("You"). Includes the owning
    team name (when known) so the user knows who to ask for a grant.
    """
    # Route records may omit execution identity, so access stays defensive.
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


def _obo_token_from_context(context: Any) -> str | None:
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


def _bind_obo_for_handler(context: Any) -> None:
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
        # Clear tokens that could remain on a reused thread or event-loop slot.
        set_obo_token(None)


_seen_events: dict[str, float] = {}
_SEEN_TTL = 30.0  # seconds

# Rate-limit "account not linked" prompts — at most once per hour per user
_linking_prompt_sent: dict[str, float] = {}

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
def rbac_global_middleware(
  body: dict[str, Any], context: Any, next: Any, logger: Any
) -> Any:
    # Deduplicate retried events
    event_id = body.get("event_id")
    if event_id:
        now = time.time()
        # Prune expired deduplication entries.
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
        return None

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
        return None

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
            or _WORKSPACE_ID
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
        return None

    slack_user_id = (
        event.get("user")
        or body.get("user", {}).get("id")
        or body.get("user_id")
    )

    if not slack_user_id:
        next()
        return None

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
        now = time.time()
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
    return None
