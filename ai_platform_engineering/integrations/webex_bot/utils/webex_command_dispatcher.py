"""Webex command dispatcher — hooks the ``text_commands`` handlers into the
runtime gate (spec 2026-05-24-derive-team-from-channel T153).

This module is the **integration glue** between:

* :func:`text_commands.parse_command_text` — pure parser (no I/O)
* :func:`text_commands.handle_list_command` etc. — pure handlers that
  return a :class:`TextCommandResult`
* :class:`WebexApiProtocol` — the actual Webex REST client used to post
  the reply

The runtime gate in :mod:`webex_bot.app` injects an instance of
:class:`WebexCommandDispatcher` (the default ``CommandHandlerProtocol``
implementation). Tests pass in fakes for each dependency so they can
assert behavior without touching the Webex API.

Design notes:

* For 1:1 (direct) rooms the reply is posted into the same room so the
  user sees the response inline. For group spaces the reply is sent as
  a 1:1 DM to the issuing person so the rest of the channel isn't
  spammed (a Webex equivalent of Slack's ``response_type=ephemeral``).
* The handler swallows exceptions when posting replies — a failed
  Webex reply must never crash the runtime gate.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional, Protocol

from .accessible_agents_client import AccessibleAgentsClient
from .command_rate_limiter import CommandRateLimiter
from .dm_authz_client import DmAuthzClient
from .dm_thread_overrides import OverrideKey, OverrideStore, get_default_override_store
from .text_commands import (
    CommandIntent,
    TextCommandResult,
    handle_help_command,
    handle_effort_command,
    handle_list_command,
    handle_use_command,
    parse_command_text,
)
from .reasoning_effort import PendingEffortStore, get_default_pending_effort_store

logger = logging.getLogger("caipe.webex_bot.command_dispatcher")


class _WebexApiProto(Protocol):  # pragma: no cover - structural typing
    def create_message(
        self,
        *,
        markdown: str,
        room_id: str | None = None,
        parent_id: str | None = None,
        person_id: str | None = None,
    ) -> str:
        raise NotImplementedError


class _ParsedWebexEventProto(Protocol):  # pragma: no cover - structural
    person_id: str
    space_id: str
    workspace_id: str
    text: str
    is_direct: bool
    message_id: Optional[str]
    thread_parent_id: Optional[str]


def _override_key(person_id: str, space_id: str) -> Optional[OverrideKey]:
    """Build the Webex-style override key, or ``None`` on bad inputs."""
    try:
        return OverrideKey(person_id=person_id, room_id=space_id)
    except ValueError as exc:
        logger.warning("Invalid Webex OverrideKey components: %s", exc)
        return None


class WebexCommandDispatcher:
    """Default :class:`CommandHandlerProtocol` implementation for Webex.

    The dispatcher is constructed with optional dependencies so unit
    tests can pass in fakes. Production code uses the lazy module-level
    singleton accessor :func:`get_default_command_dispatcher`.
    """

    def __init__(
        self,
        *,
        webex_api: _WebexApiProto,
        accessible_agents_client: AccessibleAgentsClient | None = None,
        dm_authz_client: DmAuthzClient | None = None,
        override_store: OverrideStore | None = None,
        rate_limiter: CommandRateLimiter | None = None,
        pending_effort_store: PendingEffortStore | None = None,
    ) -> None:
        self._webex_api = webex_api
        self._accessible = accessible_agents_client or AccessibleAgentsClient()
        self._authz = dm_authz_client or DmAuthzClient()
        self._overrides = override_store or get_default_override_store()
        self._rate_limiter = rate_limiter or CommandRateLimiter()
        self._pending_efforts = pending_effort_store or get_default_pending_effort_store()

    async def maybe_handle(
        self,
        *,
        parsed: _ParsedWebexEventProto,
        keycloak_user_id: str,
        bearer_token: str,
    ) -> Optional["WebexCommandHandledLike"]:
        """Treat ``parsed.text`` as a possible command.

        Returns a truthy sentinel when the message was a command and
        was handled (regardless of allow/deny outcome). Returns
        ``None`` to indicate "not a command — fall through to normal
        dispatch".
        """
        cmd = parse_command_text(parsed.text or "")
        if cmd.intent == CommandIntent.NONE:
            return None

        user_key = parsed.person_id or keycloak_user_id

        if cmd.intent == CommandIntent.HELP:
            result = handle_help_command(
                user_key=user_key,
                rate_limiter=self._rate_limiter,
            )
            await self._post_reply(parsed, result)
            return _CommandHandled(result.code)

        if cmd.intent == CommandIntent.LIST:
            result = handle_list_command(
                user_key=user_key,
                bearer_token=bearer_token,
                accessible_agents_client=self._accessible,
                rate_limiter=self._rate_limiter,
            )
            await self._post_reply(parsed, result)
            return _CommandHandled(result.code)

        if cmd.intent == CommandIntent.EFFORT:
            result = handle_effort_command(
                user_key=user_key,
                raw_text=cmd.argument,
                is_dm=parsed.is_direct,
                person_id=parsed.person_id,
                space_id=parsed.space_id,
                pending_store=self._pending_efforts,
                rate_limiter=self._rate_limiter,
            )
            await self._post_reply(parsed, result)
            return _CommandHandled(result.code)

        # CommandIntent.USE
        override_key = (
            _override_key(parsed.person_id, parsed.space_id)
            if parsed.is_direct
            else None
        )
        result = handle_use_command(
            user_key=user_key,
            raw_text=cmd.argument,
            bearer_token=bearer_token,
            is_dm=parsed.is_direct,
            override_key=override_key,
            override_store=self._overrides,
            dm_authz_client=self._authz,
            accessible_agents_client=self._accessible,
            rate_limiter=self._rate_limiter,
        )
        await self._post_reply(parsed, result)
        return _CommandHandled(result.code)

    async def _post_reply(
        self,
        parsed: _ParsedWebexEventProto,
        result: TextCommandResult,
    ) -> None:
        """Post the command response to Webex.

        * In a direct (1:1) space → reply inline in the same room.
        * In a group space → DM the user (toPersonId=...) so we don't
          leak per-user state into the channel.
        """
        try:
            if parsed.is_direct:
                await asyncio.to_thread(
                    self._webex_api.create_message,
                    markdown=result.text,
                    room_id=parsed.space_id,
                )
            else:
                await asyncio.to_thread(
                    self._webex_api.create_message,
                    markdown=result.text,
                    person_id=parsed.person_id,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Webex command reply failed (code=%s type=%s)",
                result.code,
                type(exc).__name__,
            )


class WebexCommandHandledLike(Protocol):  # pragma: no cover - structural
    code: str


class _CommandHandled:
    """Concrete sentinel — implements :class:`WebexCommandHandled` shape.

    We mirror the shape of :class:`webex_bot.app.WebexCommandHandled`
    locally to avoid importing ``app.py`` (which has heavier
    transitive imports).
    """

    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        self.code = code


_default_dispatcher: Optional[WebexCommandDispatcher] = None


def get_default_command_dispatcher(
    *,
    webex_api: _WebexApiProto,
) -> WebexCommandDispatcher:
    """Lazily build the process-wide :class:`WebexCommandDispatcher`.

    ``webex_api`` is required because we don't want to construct a
    ``WebexRestApi`` at import time — the Webex bot token is loaded
    via env and may not be present in some test/CI environments.
    """
    global _default_dispatcher
    if _default_dispatcher is None:
        _default_dispatcher = WebexCommandDispatcher(webex_api=webex_api)
    return _default_dispatcher
