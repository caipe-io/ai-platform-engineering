"""Webex text-command handlers (FR-031 / FR-029a / FR-033 / FR-034 / FR-035).

Webex doesn't have native slash commands, so we accept plain-text
commands directed at the bot:

* In a 1:1 DM (``space.type == "direct"``): the whole message body
  is the command (e.g. ``list``, ``use github``, ``use default``,
  ``effort high``, ``help``).
* In a group space: the message must begin with the bot mention.
  After stripping the mention, the remaining text is parsed the same
  way (e.g. ``@bot list``, ``@bot use github``).

This module exposes:

* :func:`parse_command_text` — pure parser, returns a
  :class:`ParsedCommand` describing intent and argument.
* :func:`handle_list_command` / :func:`handle_use_command` /
  :func:`handle_effort_command` / :func:`handle_help_command` — handlers parallel to the Slack
  twin. They take their dependencies as kwargs so the Webex
  integration layer can pass already-constructed clients and the
  tests can pass fakes.

We deliberately do not import the Webex SDK here; the responder
layer in ``app.py`` is responsible for posting :class:`TextCommandResult`
back to Webex (as an ephemeral-style direct reply to the issuer).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional, Protocol

from .accessible_agents_client import AccessibleAgentsClient
from .command_rate_limiter import CommandRateLimiter
from .dm_authz_client import DmAuthzClient
from .dm_thread_overrides import OverrideKey
from .reasoning_effort import PendingEffortStore, REASONING_EFFORTS


# --- copy ----------------------------------------------------------------

RATE_LIMITED_MESSAGE = (
    "You're sending commands too fast. Wait a few seconds and try again."
)

LIST_UNAVAILABLE_MESSAGE = (
    "I couldn't load your accessible agents right now. Try again in a moment."
)

LIST_EMPTY_MESSAGE = (
    "You don't have access to any agents yet. Ask your admin to grant you "
    "agent access in CAIPE."
)

LIST_HEADER = (
    "Agents you can use ({count} total). Type `use <agent>` to override for "
    "this space."
)

USE_MISSING_ARG_MESSAGE = (
    "Usage: `use <agent-id>` (or `use default` to return to this bot's "
    "configured default)."
)

USE_DENIED_MESSAGE = (
    "You don't have access to agent `{agent_id}`. Your existing preference "
    "is unchanged. Type `list` to see what you can use."
)

USE_UNKNOWN_AGENT_MESSAGE = (
    "I don't recognize an agent called `{agent_id}`. Type `list` to see "
    "what's available."
)

USE_DM_ONLY_MESSAGE = (
    "`use` only applies in direct messages — it sets a per-space agent "
    "override for your 1:1 conversation with the bot."
)

USE_OK_MESSAGE = (
    "Got it — this space will route to `{agent_id}` until you change it "
    "again or the bot restarts."
)

USE_DEFAULT_OK_MESSAGE = (
    "Cleared the active space override. Future direct messages will use this "
    "bot's configured default."
)

PDP_UNAVAILABLE_MESSAGE = (
    "I can't verify agent access right now. Try again in a moment."
)

HELP_MESSAGE = (
    "**CAIPE bot commands**\n"
    "• `list` — show the agents you can use\n"
    "• `use <agent>` — route this 1:1 space to a specific agent "
    "(type `use default` to clear the room override)\n"
    "• `effort <low|medium|high|max>` — set reasoning effort for your next message\n"
    "• `help` — show this message\n"
    "\n"
    "Direct messages dispatch via: space override → this bot's configured "
    "default."
)


# --- parser --------------------------------------------------------------


class CommandIntent(Enum):
    NONE = "none"  # not a command — fall through to normal chat
    LIST = "list"
    USE = "use"
    HELP = "help"
    EFFORT = "effort"


@dataclass(frozen=True)
class ParsedCommand:
    intent: CommandIntent
    argument: str


# Words that, as the first token, look like the bot-command surface.
# Anything else is treated as a normal chat message.
_COMMAND_HEADS = {"list", "use", "help", "effort"}

# Regex stripping a leading Webex ``@bot`` mention (HTML form is
# stripped earlier in the Webex SDK pipeline; we still strip plain
# ``@bot``-style prefixes here in case the mention arrives raw).
_LEADING_MENTION = re.compile(r"^\s*(?:@\S+\s+)+")


def parse_command_text(text: str) -> ParsedCommand:
    """Parse a raw Webex message body into a :class:`ParsedCommand`.

    Returns :data:`CommandIntent.NONE` for messages that are not
    commands (caller should treat them as normal chat). The match is
    case-insensitive on the command name and trims whitespace.
    """
    if not isinstance(text, str):
        return ParsedCommand(CommandIntent.NONE, "")
    stripped = _LEADING_MENTION.sub("", text).strip()
    if not stripped:
        return ParsedCommand(CommandIntent.NONE, "")
    parts = stripped.split(maxsplit=1)
    head = parts[0].lower()
    if head not in _COMMAND_HEADS:
        return ParsedCommand(CommandIntent.NONE, "")
    argument = parts[1].strip() if len(parts) > 1 else ""
    if head == "list":
        return ParsedCommand(CommandIntent.LIST, argument)
    if head == "use":
        return ParsedCommand(CommandIntent.USE, argument)
    if head == "effort":
        return ParsedCommand(CommandIntent.EFFORT, argument)
    return ParsedCommand(CommandIntent.HELP, argument)


# --- handlers ------------------------------------------------------------


@dataclass(frozen=True)
class TextCommandResult:
    text: str
    code: str


class _OverrideStoreProto(Protocol):  # pragma: no cover - structural typing
    def set(self, key: OverrideKey, agent_id: str) -> None:
        raise NotImplementedError

    def clear(self, key: OverrideKey) -> None:
        raise NotImplementedError


def _rate_limited(
    rate_limiter: Optional[CommandRateLimiter], user_key: str
) -> bool:
    if rate_limiter is None:
        return False
    return not rate_limiter.check_and_consume(user_key)


def handle_help_command(
    *,
    user_key: str,
    rate_limiter: Optional[CommandRateLimiter] = None,
) -> TextCommandResult:
    if _rate_limited(rate_limiter, user_key):
        return TextCommandResult(text=RATE_LIMITED_MESSAGE, code="rate_limited")
    return TextCommandResult(text=HELP_MESSAGE, code="help")


def handle_list_command(
    *,
    user_key: str,
    bearer_token: str,
    accessible_agents_client: AccessibleAgentsClient,
    rate_limiter: Optional[CommandRateLimiter] = None,
) -> TextCommandResult:
    if _rate_limited(rate_limiter, user_key):
        return TextCommandResult(text=RATE_LIMITED_MESSAGE, code="rate_limited")
    result = accessible_agents_client.list_agents(bearer_token=bearer_token)
    if not result.available:
        return TextCommandResult(
            text=LIST_UNAVAILABLE_MESSAGE, code="list_unavailable"
        )
    if not result.agents:
        return TextCommandResult(text=LIST_EMPTY_MESSAGE, code="list_empty")
    lines = [LIST_HEADER.format(count=len(result.agents))]
    for agent in result.agents:
        if agent.description:
            lines.append(f"• `{agent.id}` — {agent.name}: {agent.description}")
        else:
            lines.append(f"• `{agent.id}` — {agent.name}")
    return TextCommandResult(text="\n".join(lines), code="list_ok")


def handle_effort_command(
    *,
    user_key: str,
    raw_text: str,
    is_dm: bool,
    person_id: str,
    space_id: str,
    pending_store: PendingEffortStore,
    rate_limiter: Optional[CommandRateLimiter] = None,
) -> TextCommandResult:
    if not is_dm:
        return TextCommandResult(
            text="`effort` only applies in direct messages.",
            code="effort_dm_only",
        )
    if _rate_limited(rate_limiter, user_key):
        return TextCommandResult(text=RATE_LIMITED_MESSAGE, code="rate_limited")
    effort = (raw_text or "").strip().lower()
    if effort not in REASONING_EFFORTS:
        return TextCommandResult(
            text="Usage: `effort <low|medium|high|max>`.",
            code="effort_invalid",
        )
    pending_store.set(person_id, space_id, effort)
    return TextCommandResult(
        text=f"Reasoning effort changed to `{effort}`. It applies to your next message and that chat.",
        code="effort_ok",
    )


def handle_use_command(
    *,
    user_key: str,
    raw_text: str,
    bearer_token: str,
    is_dm: bool,
    override_key: Optional[OverrideKey],
    override_store: _OverrideStoreProto,
    dm_authz_client: DmAuthzClient,
    accessible_agents_client: Optional[AccessibleAgentsClient] = None,
    rate_limiter: Optional[CommandRateLimiter] = None,
) -> TextCommandResult:
    if _rate_limited(rate_limiter, user_key):
        return TextCommandResult(text=RATE_LIMITED_MESSAGE, code="rate_limited")

    argument = (raw_text or "").strip()
    if not argument:
        return TextCommandResult(
            text=USE_MISSING_ARG_MESSAGE, code="use_missing_arg"
        )

    if argument.lower() == "default":
        return _handle_use_default(
            override_key=override_key,
            override_store=override_store,
        )

    if not is_dm or override_key is None:
        return TextCommandResult(text=USE_DM_ONLY_MESSAGE, code="use_dm_only")

    decision = dm_authz_client.check_agent_access(
        bearer_token=bearer_token, agent_id=argument
    )
    if not decision.available:
        return TextCommandResult(
            text=PDP_UNAVAILABLE_MESSAGE, code="pdp_unavailable"
        )
    if not decision.allowed:
        return _denied_use_response(
            argument, accessible_agents_client, bearer_token
        )

    override_store.set(override_key, argument)
    return TextCommandResult(
        text=USE_OK_MESSAGE.format(agent_id=argument), code="use_ok"
    )


def _handle_use_default(
    *,
    override_key: Optional[OverrideKey],
    override_store: _OverrideStoreProto,
) -> TextCommandResult:
    if override_key is not None:
        override_store.clear(override_key)
    return TextCommandResult(
        text=USE_DEFAULT_OK_MESSAGE, code="use_default_ok"
    )


def _denied_use_response(
    agent_id: str,
    accessible_agents_client: Optional[AccessibleAgentsClient],
    bearer_token: str,
) -> TextCommandResult:
    if accessible_agents_client is None:
        return TextCommandResult(
            text=USE_DENIED_MESSAGE.format(agent_id=agent_id), code="use_denied"
        )
    listing = accessible_agents_client.list_agents(bearer_token=bearer_token)
    if not listing.available:
        return TextCommandResult(
            text=USE_DENIED_MESSAGE.format(agent_id=agent_id), code="use_denied"
        )
    known_ids = {agent.id for agent in listing.agents}
    if agent_id in known_ids:
        return TextCommandResult(
            text=USE_DENIED_MESSAGE.format(agent_id=agent_id), code="use_denied"
        )
    return TextCommandResult(
        text=USE_UNKNOWN_AGENT_MESSAGE.format(agent_id=agent_id),
        code="use_unknown",
    )
