"""Webex bot runtime gate — identity, OBO, team mapping, ReBAC, route, dispatch."""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, Protocol

from .utils.audit import log_webex_authz_decision
from .utils.dm_authz_client import DmAgentAccessDecision, DmAuthzClient
from .utils.dm_thread_overrides import OverrideKey, get_default_override_store
from .utils.identity_linker import WebexIdentityLinker
from .utils.obo_exchange import OboExchangeError, OboToken, impersonate_user
from .utils.space_team_resolver import SpaceTeamResolution, WebexSpaceTeamResolver
from .utils.user_messages import (
    TEAM_SESSION_UNAVAILABLE_MESSAGE,
    WEBEX_DIRECT_MESSAGE_NOT_ONBOARDED_MESSAGE,
)
from .utils.webex_agent_routes import infer_listen_mode
from .utils.webex_bot_catalog import configured_webex_bot
from .utils.webex_direct_users import (
    WebexDirectUserAccess,
    WebexDirectUserResolver,
)
from .utils.webex_ids import (
    canonicalize_webex_space_id,
    is_valid_webex_person_id,
    is_valid_webex_space_id,
    public_webex_room_id_from_uuid,
)
from .utils.webex_rebac import WebexRebacEvaluator, WebexSpaceRebacDecision

logger = logging.getLogger("caipe.webex_bot")

APP_NAME = (
    os.environ.get("WEBEX_INTEGRATION_APP_NAME")
    or os.environ.get("APP_NAME")
    or "CAIPE"
)

REASON_IGNORED_BOT = "WEBEX_IGNORED_BOT"
REASON_IGNORED_SELF = "WEBEX_IGNORED_SELF"
REASON_IGNORED_MALFORMED = "WEBEX_IGNORED_MALFORMED"
REASON_USER_NOT_LINKED = "WEBEX_USER_NOT_LINKED"
REASON_IDENTITY_UNAVAILABLE = "WEBEX_IDENTITY_UNAVAILABLE"
REASON_WORKSPACE_UNCONFIGURED = "WEBEX_WORKSPACE_UNCONFIGURED"
REASON_SPACE_TEAM_NOT_FOUND = "WEBEX_SPACE_TEAM_NOT_FOUND"
REASON_OBO_FAILED = "WEBEX_OBO_FAILED"
REASON_DISPATCH_ALLOWED = "WEBEX_DISPATCH_ALLOWED"
# Phase 2 (spec 2026-05-24): the text was a personal bot command
# (``list`` / ``use`` / ``help`` / ``use default``). The command
# handler has already replied; we short-circuit BEFORE route +
# ReBAC so a non-mapped space still gets a useful response and
# doesn't trip the "space not mapped" deny.
REASON_COMMAND_HANDLED = "WEBEX_COMMAND_HANDLED"
# Scoped to "the sender is not on this bot's DM allowlist / has no route" —
# distinct from REASON_DM_DISABLED, which covers the bot's DM channel being
# turned off deployment-wide (a per-user allowlist fix can never help there).
REASON_DM_NOT_ONBOARDED = "WEBEX_DM_NOT_ONBOARDED"
REASON_DM_DISABLED = "WEBEX_DM_DISABLED"
REASON_BOT_NOT_ASSIGNED = "WEBEX_BOT_NOT_ASSIGNED"


@dataclass(frozen=True)
class ParsedWebexEvent:
    person_id: str
    space_id: str
    workspace_id: str
    text: str
    is_bot: bool
    is_self: bool
    bot_id: str
    was_bot_mentioned: bool = False
    message_id: Optional[str] = None
    thread_parent_id: Optional[str] = None
    webex_room_id: Optional[str] = None
    # Phase 2 (spec 2026-05-24): True when the originating Webex room is
    # a 1:1 direct conversation (``roomType == "direct"``). The DM
    # dispatch resolver and the ``use <agent>`` command require this
    # signal because they're personal surfaces — they MUST refuse to
    # change behavior in a shared group space.
    is_direct: bool = False
    person_email: Optional[str] = None


@dataclass(frozen=True)
class WebexRouteResolution:
    agent_id: Optional[str]
    deny_message: Optional[str] = None
    team_slug: Optional[str] = None


@dataclass(frozen=True)
class WebexMessageResult:
    allowed: bool
    dispatched: bool
    ignored: bool
    reason_code: str
    linking_url: Optional[str] = None
    deny_message: Optional[str] = None
    rebac_reason: Optional[str] = None
    team_slug: Optional[str] = None
    agent_id: Optional[str] = None
    keycloak_user_id: Optional[str] = None
    explicit_invocation: bool = False


class IdentityLinkerProtocol(Protocol):
    async def resolve(self, webex_user_id: str) -> Optional[str]:
        """Return the Keycloak user id linked to ``webex_user_id`` or ``None``."""
        raise NotImplementedError

    async def linking_url(self, webex_user_id: str) -> Optional[str]:
        """Return a deep-link URL the user can click to link their account."""
        raise NotImplementedError


class TeamResolverProtocol(Protocol):
    async def resolve(self, bot_id: str, space_id: str) -> SpaceTeamResolution:
        """Resolve the active team for ``space_id`` (mapping only)."""
        raise NotImplementedError


class OboExchangerProtocol(Protocol):
    async def impersonate(self, keycloak_user_id: str) -> OboToken:
        """Mint an on-behalf-of token for the given Keycloak user.

        Phase 2 (spec 2026-05-24): OBO is team-agnostic. Team scope is
        derived downstream from space context.
        """
        raise NotImplementedError


class RebacCheckerProtocol(Protocol):
    def check_space_grant(
        self,
        *,
        bot_id: str,
        workspace_id: str,
        space_id: str,
        agent_id: str,
        obo_token: Optional[str],
    ) -> WebexSpaceRebacDecision:
        """Decide whether ``space_id`` has ``agent_id`` assigned."""
        raise NotImplementedError


class RouteResolverProtocol(Protocol):
    async def resolve_route(
        self,
        *,
        bot_id: str,
        workspace_id: str,
        space_id: str,
        person_id: str,
        text: str,
        is_direct: bool = False,
        was_bot_mentioned: bool = False,
        thread_parent_id: Optional[str] = None,
    ) -> WebexRouteResolution:
        """Resolve the agent route to dispatch this message to."""
        raise NotImplementedError


class DirectUserResolverProtocol(Protocol):
    async def resolve(
        self,
        *,
        bot_id: str,
        webex_user_id: str,
        person_email: str | None,
    ) -> WebexDirectUserAccess:
        raise NotImplementedError


class DmAuthzCheckerProtocol(Protocol):
    def check_agent_access(
        self,
        *,
        agent_id: str,
        bearer_token: str,
    ) -> DmAgentAccessDecision:
        raise NotImplementedError


@dataclass(frozen=True)
class WebexCommandHandled:
    """Sentinel result returned by a :class:`CommandHandlerProtocol` when a
    user's message was intercepted as a bot command and already replied to.
    The runtime gate short-circuits dispatch when this is returned.
    """

    code: str
    """Stable machine-readable code (``help``, ``list_ok``, ``use_ok`` …)."""


class CommandHandlerProtocol(Protocol):
    """Protocol for the personal-DM command handler.

    Implementations parse ``parsed.text``, post any reply directly via the
    Webex API, and return :class:`WebexCommandHandled` when the message
    was treated as a command. Returning ``None`` means "not a command,
    fall through to normal route + dispatch".
    """

    async def maybe_handle(
        self,
        *,
        parsed: ParsedWebexEvent,
        keycloak_user_id: str,
        bearer_token: str,
    ) -> Optional[WebexCommandHandled]:
        raise NotImplementedError


DispatchFn = Callable[[dict[str, Any]], Awaitable[None]]


def configured_webex_workspace_ref() -> Optional[str]:
    """Deployment-configured Webex workspace namespace (never from webhook payloads)."""
    alias = os.environ.get("WEBEX_WORKSPACE_ALIAS", "").strip()
    if alias:
        return alias
    workspace_id = os.environ.get("WEBEX_WORKSPACE_ID", "").strip()
    if workspace_id:
        return workspace_id
    return None


def webex_workspace_ref() -> str:
    """Configured workspace ref or empty string when unset (callers should deny)."""
    return configured_webex_workspace_ref() or ""


def parse_event_flag(*values: object) -> bool:
    """Parse Webex boolean flags without treating string ``\"false\"`` as truthy."""
    for value in values:
        if value is None:
            continue
        if isinstance(value, bool):
            if value:
                return True
            continue
        if isinstance(value, (int, float)):
            if value != 0:
                return True
            continue
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in ("true", "1", "yes", "on"):
                return True
            if normalized in ("false", "0", "no", "off", ""):
                continue
    return False


def parse_webex_event(event: dict[str, Any]) -> Optional[ParsedWebexEvent]:
    """Normalize a Webex webhook or test event into gate inputs."""
    data = event.get("data") if isinstance(event.get("data"), dict) else event

    person_id = (
        data.get("personId")
        or data.get("person_id")
        or event.get("personId")
        or event.get("person_id")
    )
    raw_space_id = (
        data.get("roomId")
        or data.get("space_id")
        or data.get("spaceId")
        or event.get("roomId")
        or event.get("space_id")
    )
    message_id = (
        data.get("id")
        or data.get("messageId")
        or data.get("message_id")
        or event.get("messageId")
        or event.get("message_id")
    )
    thread_parent_id = (
        data.get("parentId")
        or data.get("parent_id")
        or data.get("threadParentId")
        or data.get("thread_parent_id")
        or event.get("parentId")
        or event.get("parent_id")
        or event.get("threadParentId")
        or event.get("thread_parent_id")
    )
    webex_room_id = (
        data.get("webexRoomId")
        or data.get("publicRoomId")
        or event.get("webexRoomId")
        or event.get("publicRoomId")
    )
    text = str(data.get("text") or event.get("text") or "").strip()
    is_bot = parse_event_flag(
        data.get("isBot"),
        data.get("is_bot"),
        event.get("isBot"),
        event.get("is_bot"),
        data.get("personIsBot"),
        event.get("personIsBot"),
    )
    is_self = parse_event_flag(
        data.get("is_self"),
        data.get("isSelf"),
        event.get("is_self"),
        event.get("isSelf"),
    )
    was_bot_mentioned = parse_event_flag(
        data.get("botMentioned"),
        data.get("bot_mentioned"),
        event.get("botMentioned"),
        event.get("bot_mentioned"),
    )

    # Webex tells us the room type via ``roomType`` on the webhook
    # payload. ``direct`` means a 1:1 conversation with the bot;
    # anything else (``group``) means a shared space.
    raw_room_type = (
        data.get("roomType")
        or data.get("room_type")
        or event.get("roomType")
        or event.get("room_type")
        or ""
    )
    is_direct = isinstance(raw_room_type, str) and raw_room_type.strip().lower() == "direct"
    person_email_value = (
        data.get("personEmail")
        or data.get("person_email")
        or event.get("personEmail")
        or event.get("person_email")
    )
    bot_id_value = data.get("botId") or event.get("botId")

    if not isinstance(person_id, str) or not person_id.strip():
        return None
    if not isinstance(raw_space_id, str) or not raw_space_id.strip():
        return None
    if not isinstance(bot_id_value, str) or not bot_id_value.strip():
        return None
    space_id = canonicalize_webex_space_id(raw_space_id)
    if not is_valid_webex_person_id(person_id):
        return None
    if not is_valid_webex_space_id(space_id):
        return None

    workspace_id = webex_workspace_ref()
    public_room_id = str(webex_room_id).strip() if isinstance(webex_room_id, str) else None
    if not public_room_id:
        public_room_id = public_webex_room_id_from_uuid(space_id)

    return ParsedWebexEvent(
        person_id=person_id.strip(),
        space_id=space_id.strip(),
        workspace_id=workspace_id,
        text=text,
        is_bot=is_bot,
        is_self=is_self,
        message_id=str(message_id).strip() if isinstance(message_id, str) else None,
        thread_parent_id=(
            str(thread_parent_id).strip() if isinstance(thread_parent_id, str) else None
        ),
        webex_room_id=public_room_id,
        is_direct=is_direct,
        person_email=(
            person_email_value.strip().lower()
            if isinstance(person_email_value, str) and person_email_value.strip()
            else None
        ),
        bot_id=bot_id_value.strip(),
        was_bot_mentioned=was_bot_mentioned,
    )


def _deny(
    reason_code: str,
    *,
    deny_message: Optional[str] = None,
    linking_url: Optional[str] = None,
    rebac_reason: Optional[str] = None,
    keycloak_user_id: Optional[str] = None,
    team_slug: Optional[str] = None,
    explicit_invocation: bool = False,
) -> WebexMessageResult:
    return WebexMessageResult(
        allowed=False,
        dispatched=False,
        ignored=False,
        reason_code=reason_code,
        deny_message=deny_message,
        linking_url=linking_url,
        rebac_reason=rebac_reason,
        keycloak_user_id=keycloak_user_id,
        team_slug=team_slug,
        explicit_invocation=explicit_invocation,
    )


def _ignore(reason_code: str) -> WebexMessageResult:
    return WebexMessageResult(
        allowed=False,
        dispatched=False,
        ignored=True,
        reason_code=reason_code,
    )


class _DefaultOboExchanger:
    async def impersonate(self, keycloak_user_id: str) -> OboToken:
        return await impersonate_user(keycloak_user_id)


async def _resolve_all_users_dm_route(
    *,
    person_id: str,
    space_id: str,
    bearer_token: str,
    authz_client: DmAuthzCheckerProtocol,
    default_agent_id: str | None,
) -> WebexRouteResolution:
    try:
        override_key = OverrideKey(person_id=person_id, room_id=space_id)
    except ValueError:
        return WebexRouteResolution(
            agent_id=None,
            deny_message="This Webex direct-message context is invalid.",
        )

    override_store = get_default_override_store()
    override_agent_id = override_store.get(override_key)
    if override_agent_id:
        decision = await asyncio.to_thread(
            authz_client.check_agent_access,
            agent_id=override_agent_id,
            bearer_token=bearer_token,
        )
        if not decision.available:
            return WebexRouteResolution(
                agent_id=None,
                deny_message=(
                    "I can't verify your agent access right now. "
                    "Please try again in a moment."
                ),
            )
        if decision.allowed:
            return WebexRouteResolution(agent_id=override_agent_id)
        override_store.clear(override_key)

    return WebexRouteResolution(
        agent_id=default_agent_id,
        deny_message=(
            None
            if default_agent_id
            else "No default agent is configured for this Webex bot."
        ),
    )


class _WebexAgentRouteResolver:
    """Resolve routes via OpenFGA + Mongo when DB modes are enabled."""

    async def resolve_route(
        self,
        *,
        bot_id: str,
        workspace_id: str,
        space_id: str,
        person_id: str,
        text: str,
        is_direct: bool = False,
        was_bot_mentioned: bool = False,
        thread_parent_id: Optional[str] = None,
    ) -> WebexRouteResolution:
        from .utils.webex_agent_routes import resolve_webex_agent_route

        agent_id, deny_message = await resolve_webex_agent_route(
            bot_id=bot_id,
            workspace_id=workspace_id,
            space_id=space_id,
            person_id=person_id,
            text=text,
            is_direct=is_direct,
            was_bot_mentioned=was_bot_mentioned,
            thread_parent_id=thread_parent_id,
        )
        return WebexRouteResolution(agent_id=agent_id, deny_message=deny_message)


async def handle_webex_message(
    event: dict[str, Any],
    *,
    identity_linker: IdentityLinkerProtocol | None = None,
    team_resolver: TeamResolverProtocol | None = None,
    obo_exchanger: OboExchangerProtocol | None = None,
    rebac_checker: RebacCheckerProtocol | None = None,
    route_resolver: RouteResolverProtocol | None = None,
    direct_user_resolver: DirectUserResolverProtocol | None = None,
    dm_authz_checker: DmAuthzCheckerProtocol | None = None,
    command_handler: CommandHandlerProtocol | None = None,
    dispatcher: Optional[DispatchFn] = None,
    bot_person_id: Optional[str] = None,
    tenant_id: str = "default",
) -> WebexMessageResult:
    """Run the Webex RBAC runtime gate before agent dispatch.

    Gate order: parse → ignore bot/self/malformed → space team (group spaces)
    → identity link → DM access (direct messages) → OBO → route → ReBAC →
    dispatch. Identity link runs before the DM access-mode check so an
    unlinked user gets the "link your account" flow — except when the bot's
    direct messages are disabled entirely, in which case both an unlinked
    and a linked user are ignored silently rather than being prompted to
    link, or told to ask an admin to enable something a per-user allowlist
    change can never fix; route resolution runs before ReBAC because it
    supplies the ``agent_id`` checked by the access-check endpoint.
    """
    linker = identity_linker or WebexIdentityLinker()
    resolver = team_resolver or WebexSpaceTeamResolver()
    obo = obo_exchanger or _DefaultOboExchanger()
    rebac = rebac_checker or WebexRebacEvaluator()
    routes = route_resolver or _WebexAgentRouteResolver()
    direct_users = direct_user_resolver or WebexDirectUserResolver()
    dm_authz = dm_authz_checker or DmAuthzClient()

    parsed = parse_webex_event(event)
    if parsed is None:
        log_webex_authz_decision(
            tenant_id=tenant_id,
            sub="unknown",
            outcome="deny",
            reason_code="WEBEX_IGNORED_MALFORMED",
        )
        return _ignore(REASON_IGNORED_MALFORMED)

    if parsed.is_bot:
        log_webex_authz_decision(
            tenant_id=tenant_id,
            sub=parsed.person_id,
            outcome="deny",
            reason_code="WEBEX_IGNORED_BOT",
            webex_person_id=parsed.person_id,
            webex_space_id=parsed.space_id,
        )
        return _ignore(REASON_IGNORED_BOT)

    if parsed.is_self or (bot_person_id and parsed.person_id == bot_person_id):
        log_webex_authz_decision(
            tenant_id=tenant_id,
            sub=parsed.person_id,
            outcome="deny",
            reason_code="WEBEX_IGNORED_SELF",
            webex_person_id=parsed.person_id,
            webex_space_id=parsed.space_id,
        )
        return _ignore(REASON_IGNORED_SELF)

    bot_config = configured_webex_bot(parsed.bot_id)
    if bot_config is None:
        return _ignore(REASON_BOT_NOT_ASSIGNED)
    if not parsed.is_direct and bot_config.spaces_access_mode == "disabled":
        return _ignore(REASON_BOT_NOT_ASSIGNED)

    if not parsed.workspace_id:
        log_webex_authz_decision(
            tenant_id=tenant_id,
            sub=parsed.person_id,
            outcome="deny",
            reason_code="WEBEX_WORKSPACE_UNCONFIGURED",
            webex_person_id=parsed.person_id,
            webex_space_id=parsed.space_id,
        )
        return _deny(
            REASON_WORKSPACE_UNCONFIGURED,
            deny_message=(
                "Webex workspace policy namespace is not configured. "
                "Set WEBEX_WORKSPACE_ALIAS or WEBEX_WORKSPACE_ID."
            ),
        )

    explicit_invocation = (
        parsed.is_direct
        or parsed.was_bot_mentioned
        or infer_listen_mode(parsed.text) == "mention"
    )
    team_resolution = SpaceTeamResolution(
        team_slug=None,
        team_id=None,
        team_name=None,
        deny_message=None,
    )
    if not parsed.is_direct:
        team_resolution = await resolver.resolve(parsed.bot_id, parsed.space_id)
        if team_resolution.bot_id and team_resolution.bot_id != parsed.bot_id:
            log_webex_authz_decision(
                tenant_id=tenant_id,
                sub=parsed.person_id,
                outcome="deny",
                reason_code=REASON_BOT_NOT_ASSIGNED,
                webex_person_id=parsed.person_id,
                webex_space_id=parsed.space_id,
            )
            return _ignore(REASON_BOT_NOT_ASSIGNED)
        if (
            not team_resolution.team_slug
            and bot_config.spaces_access_mode == "all_spaces"
        ):
            from .utils.webex_agent_routes import get_webex_agent_route_resolver
            from .utils.webex_space_auto_assign import get_webex_space_auto_assigner

            auto_assign = await asyncio.to_thread(
                get_webex_space_auto_assigner().assign_space,
                bot_id=parsed.bot_id,
                workspace_id=parsed.workspace_id,
                space_id=parsed.space_id,
            )
            if auto_assign.assigned:
                get_webex_agent_route_resolver().invalidate(
                    parsed.bot_id, parsed.workspace_id, parsed.space_id
                )
                invalidate = getattr(resolver, "invalidate", None)
                if callable(invalidate):
                    invalidate(parsed.bot_id, parsed.space_id)
                team_resolution = await resolver.resolve(parsed.bot_id, parsed.space_id)
            elif auto_assign.reason not in {"disabled", "existing_mapping"}:
                logger.warning(
                    "Webex space auto-assignment skipped space=%s reason=%s",
                    parsed.space_id,
                    auto_assign.reason,
                )
        if (
            not team_resolution.team_slug
            or team_resolution.bot_id != parsed.bot_id
        ):
            log_webex_authz_decision(
                tenant_id=tenant_id,
                sub=parsed.person_id,
                outcome="deny",
                reason_code=REASON_SPACE_TEAM_NOT_FOUND,
                webex_person_id=parsed.person_id,
                webex_space_id=parsed.space_id,
            )
            return _ignore(REASON_SPACE_TEAM_NOT_FOUND)

    try:
        keycloak_user_id = await linker.resolve(parsed.person_id)
    except Exception as exc:  # noqa: BLE001 — fail closed on KC/network errors
        logger.error(
            "Webex identity resolution failed (type=%s); denying request",
            type(exc).__name__,
        )
        log_webex_authz_decision(
            tenant_id=tenant_id,
            sub=parsed.person_id,
            outcome="deny",
            reason_code="WEBEX_IDENTITY_UNAVAILABLE",
            pdp="keycloak",
            webex_person_id=parsed.person_id,
            webex_space_id=parsed.space_id,
        )
        return _deny(
            REASON_IDENTITY_UNAVAILABLE,
            deny_message=(
                "Identity verification is temporarily unavailable. Please try again later."
            ),
            explicit_invocation=explicit_invocation,
        )

    if keycloak_user_id is None:
        if parsed.is_direct and bot_config.direct_messages_access_mode == "disabled":
            log_webex_authz_decision(
                tenant_id=tenant_id,
                sub=parsed.person_id,
                outcome="deny",
                reason_code=REASON_DM_DISABLED,
                webex_person_id=parsed.person_id,
                webex_space_id=parsed.space_id,
            )
            return _ignore(REASON_DM_DISABLED)
        linking_url: Optional[str] = None
        try:
            linking_url = await linker.linking_url(parsed.person_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Webex linking URL mint failed (type=%s); continuing without URL",
                type(exc).__name__,
            )
        log_webex_authz_decision(
            tenant_id=tenant_id,
            sub=parsed.person_id,
            outcome="deny",
            reason_code="WEBEX_USER_NOT_LINKED",
            pdp="keycloak",
            webex_person_id=parsed.person_id,
            webex_space_id=parsed.space_id,
        )
        return _deny(
            REASON_USER_NOT_LINKED,
            deny_message=(
                "Your Webex account is not linked to an enterprise identity. "
                "Complete account linking before using this bot."
            ),
            linking_url=linking_url,
            explicit_invocation=explicit_invocation,
        )

    direct_access: WebexDirectUserAccess | None = None
    if parsed.is_direct:
        try:
            direct_access = await direct_users.resolve(
                bot_id=parsed.bot_id,
                webex_user_id=parsed.person_id,
                keycloak_user_id=keycloak_user_id,
            )
        except Exception as exc:  # noqa: BLE001 - direct access fails closed
            logger.warning(
                "Webex direct-user access lookup failed (type=%s)",
                type(exc).__name__,
            )
        if direct_access is not None and direct_access.reason == "disabled":
            # DMs are disabled for this bot deployment-wide — same silent
            # short-circuit as the unlinked-sender case above. An explicit
            # "ask an admin to enable 1:1 messages" reply would be misleading
            # here since no per-user allowlist change can fix this.
            log_webex_authz_decision(
                tenant_id=tenant_id,
                sub=keycloak_user_id,
                outcome="deny",
                reason_code=REASON_DM_DISABLED,
                webex_person_id=parsed.person_id,
                webex_space_id=parsed.space_id,
            )
            return _ignore(REASON_DM_DISABLED)
        if direct_access is None or not direct_access.allowed:
            log_webex_authz_decision(
                tenant_id=tenant_id,
                sub=keycloak_user_id,
                outcome="deny",
                reason_code=REASON_DM_NOT_ONBOARDED,
                webex_person_id=parsed.person_id,
                webex_space_id=parsed.space_id,
            )
            return _deny(
                REASON_DM_NOT_ONBOARDED,
                deny_message=WEBEX_DIRECT_MESSAGE_NOT_ONBOARDED_MESSAGE.format(
                    app_name=APP_NAME
                ),
                keycloak_user_id=keycloak_user_id,
                explicit_invocation=explicit_invocation,
            )
        if keycloak_user_id != direct_access.keycloak_user_id:
            logger.warning(
                "Webex direct-user link did not match the onboarded deployment user"
            )
            return _ignore(REASON_DM_NOT_ONBOARDED)

    team_slug = None if parsed.is_direct else team_resolution.team_slug

    try:
        # OBO is user-scoped. Group-space team context is enforced separately;
        # direct messages let OpenFGA derive any team-mediated agent grant.
        obo_token = await obo.impersonate(keycloak_user_id)
    except (OboExchangeError, ValueError) as exc:
        logger.error(
            "Webex OBO impersonation failed for user=%s (type=%s)",
            keycloak_user_id,
            type(exc).__name__,
        )
        log_webex_authz_decision(
            tenant_id=tenant_id,
            sub=keycloak_user_id,
            outcome="deny",
            reason_code="WEBEX_OBO_FAILED",
            pdp="keycloak",
            webex_person_id=parsed.person_id,
            webex_space_id=parsed.space_id,
        )
        return _deny(
            REASON_OBO_FAILED,
            deny_message=TEAM_SESSION_UNAVAILABLE_MESSAGE,
            keycloak_user_id=keycloak_user_id,
            team_slug=team_slug,
            explicit_invocation=explicit_invocation,
        )

    # Phase 2 (spec 2026-05-24): personal-DM commands intercept BEFORE
    # route resolution so a user in an unmapped 1:1 space can still run
    # ``help`` / ``list`` / ``use``. The handler posts the ephemeral
    # reply itself (Webex has no native ephemeral, so it DMs the user
    # back); we just short-circuit dispatch on the truthy sentinel.
    if command_handler is not None:
        try:
            command_outcome = await command_handler.maybe_handle(
                parsed=parsed,
                keycloak_user_id=keycloak_user_id,
                bearer_token=obo_token.access_token,
            )
        except Exception as exc:  # noqa: BLE001 — never fail the gate on cmd errors
            logger.warning(
                "Webex command handler raised (type=%s); ignoring and falling through",
                type(exc).__name__,
            )
            command_outcome = None
        if command_outcome is not None:
            log_webex_authz_decision(
                tenant_id=tenant_id,
                sub=keycloak_user_id,
                outcome="allow",
                reason_code=REASON_COMMAND_HANDLED,
                webex_person_id=parsed.person_id,
                webex_space_id=parsed.space_id,
            )
            return WebexMessageResult(
                allowed=True,
                dispatched=False,
                ignored=False,
                reason_code=REASON_COMMAND_HANDLED,
                keycloak_user_id=keycloak_user_id,
                team_slug=team_slug,
                agent_id=None,
            )

    all_users_dm = direct_access is not None and direct_access.reason == "all_users"
    if all_users_dm:
        route = await _resolve_all_users_dm_route(
            person_id=parsed.person_id,
            space_id=parsed.space_id,
            bearer_token=obo_token.access_token,
            authz_client=dm_authz,
            default_agent_id=direct_access.agent_id,
        )
    elif direct_access is not None:
        route = WebexRouteResolution(agent_id=direct_access.agent_id)
    else:
        route = await routes.resolve_route(
            bot_id=parsed.bot_id,
            workspace_id=parsed.workspace_id,
            space_id=parsed.space_id,
            person_id=parsed.person_id,
            text=parsed.text,
            is_direct=parsed.is_direct,
            was_bot_mentioned=parsed.was_bot_mentioned,
            thread_parent_id=parsed.thread_parent_id,
        )
    agent_id = route.agent_id
    if not parsed.is_direct and route.team_slug:
        team_slug = route.team_slug
    if not agent_id:
        log_webex_authz_decision(
            tenant_id=tenant_id,
            sub=keycloak_user_id,
            outcome="deny",
            reason_code="WEBEX_ROUTE_DENIED",
            webex_person_id=parsed.person_id,
            webex_space_id=parsed.space_id,
        )
        return _deny(
            "WEBEX_ROUTE_DENIED",
            deny_message=route.deny_message,
            keycloak_user_id=keycloak_user_id,
            team_slug=team_slug,
            explicit_invocation=explicit_invocation,
        )

    if parsed.is_direct:
        dm_decision = dm_authz.check_agent_access(
            agent_id=agent_id,
            bearer_token=obo_token.access_token,
        )
        if not dm_decision.available or not dm_decision.allowed:
            reason = "pdp_unavailable" if not dm_decision.available else dm_decision.reason
            log_webex_authz_decision(
                tenant_id=tenant_id,
                sub=keycloak_user_id,
                outcome="deny",
                reason_code=(
                    "DENY_PDP_UNAVAILABLE"
                    if not dm_decision.available
                    else "WEBEX_DM_AGENT_DENIED"
                ),
                webex_person_id=parsed.person_id,
                webex_space_id=parsed.space_id,
                resource_ref=f"agent:{agent_id}",
            )
            return _deny(
                reason,
                deny_message=(
                    "Agent access is temporarily unavailable. Please try again later."
                    if not dm_decision.available
                    else f"You do not have access to agent *{agent_id}*."
                ),
                rebac_reason=reason,
                keycloak_user_id=keycloak_user_id,
                explicit_invocation=True,
            )
    if parsed.is_direct:
        rebac_decision = None
    else:
        rebac_decision = rebac.check_space_grant(
            bot_id=parsed.bot_id,
            workspace_id=parsed.workspace_id,
            space_id=parsed.space_id,
            agent_id=agent_id,
            obo_token=obo_token.access_token,
        )
    if rebac_decision is not None and not rebac_decision.space_allowed:
        if (
            rebac_decision.reason == "missing_space_grant"
            and bot_config.spaces_access_mode == "all_spaces"
        ):
            from .utils.webex_space_auto_assign import get_webex_space_auto_assigner

            repaired = await asyncio.to_thread(
                get_webex_space_auto_assigner().ensure_space_agent_grant,
                bot_id=parsed.bot_id,
                workspace_id=parsed.workspace_id,
                space_id=parsed.space_id,
                agent_id=agent_id,
                team_slug=team_slug,
            )
            if repaired:
                rebac_decision = WebexSpaceRebacDecision(
                    allowed=True,
                    space_allowed=True,
                    reason="allowed",
                )

    if rebac_decision is not None and not rebac_decision.space_allowed:
        audit_reason = (
            "DENY_PDP_UNAVAILABLE"
            if rebac_decision.reason == "pdp_unavailable"
            else "WEBEX_REBAC_DENIED"
        )
        log_webex_authz_decision(
            tenant_id=tenant_id,
            sub=keycloak_user_id,
            outcome="deny",
            reason_code=audit_reason,
            webex_person_id=parsed.person_id,
            webex_space_id=parsed.space_id,
            resource_ref=f"agent:{agent_id}",
        )
        if not explicit_invocation:
            logger.info(
                "Webex space grant denied for ambient message space=%s agent=%s — silently dropping",
                parsed.space_id,
                agent_id,
            )
        if rebac_decision.reason == "missing_space_grant":
            return _ignore(rebac_decision.reason)
        return _deny(
            rebac_decision.reason,
            deny_message=(
                f"Agent *{agent_id}* is not assigned to this Webex space. "
                f"Ask an admin to add it in the {APP_NAME} Admin panel."
            ),
            rebac_reason=rebac_decision.reason,
            keycloak_user_id=keycloak_user_id,
            team_slug=team_slug,
            explicit_invocation=explicit_invocation,
        )

    if dispatcher is not None:
        await dispatcher(
            {
                "person_id": parsed.person_id,
                "space_id": parsed.space_id,
                "workspace_id": parsed.workspace_id,
                "text": parsed.text,
                "keycloak_user_id": keycloak_user_id,
                "team_slug": team_slug,
                "agent_id": agent_id,
                "obo_token": obo_token.access_token,
                "message_id": parsed.message_id,
                "thread_parent_id": parsed.thread_parent_id,
                "webex_room_id": parsed.webex_room_id,
                "bot_id": parsed.bot_id,
                "person_email": parsed.person_email,
                "is_direct": parsed.is_direct,
            }
        )

    log_webex_authz_decision(
        tenant_id=tenant_id,
        sub=keycloak_user_id,
        outcome="allow",
        reason_code="WEBEX_DISPATCH_ALLOWED",
        webex_person_id=parsed.person_id,
        webex_space_id=parsed.space_id,
        resource_ref=f"agent:{agent_id}",
    )
    return WebexMessageResult(
        allowed=True,
        dispatched=dispatcher is not None,
        ignored=False,
        reason_code=REASON_DISPATCH_ALLOWED,
        keycloak_user_id=keycloak_user_id,
        team_slug=team_slug,
        agent_id=agent_id,
    )
