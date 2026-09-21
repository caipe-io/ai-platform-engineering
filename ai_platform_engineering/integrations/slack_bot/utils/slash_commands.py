"""Slack slash-command handlers for list, use, effort, and help.

The command prefix (``cmd``) is derived from the ``APP_NAME`` /
``SLACK_INTEGRATION_APP_NAME`` environment variable at runtime
(default: ``caipe``).  When ``APP_NAME=Forge`` the commands become
``/forge-list``, ``/forge-use``, ``/forge-effort``, and ``/forge-help``.

Agent selection and effort changes are DM-only. Invoking them in a public channel
returns an ephemeral error pointing the user to a DM.  The one
exception is ``/forge-use default``, which clears a saved preference
and is intentionally allowed anywhere.

Design:

* Each public function takes its dependencies as kwargs so the Bolt
  integration layer in ``app.py`` can pass already-constructed
  clients (accessible_agents_client, user_preferences_client,
  dm_authz_client, override_store) and the unit tests can pass
  fakes. We don't import Bolt here.
* Return type is :class:`SlashCommandResult` — a structured value
  with the ephemeral text the bot should post back to Slack.
* User-visible copy that references command names is generated via
  module-level helper functions so the prefix stays consistent with
  the environment-configured app name.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional, Protocol

from .accessible_agents_client import AccessibleAgentsClient
from .command_rate_limiter import CommandRateLimiter
from .dm_authz_client import DmAuthzClient
from .dm_thread_overrides import OverrideKey
from .reasoning_effort import PendingEffortKey, PendingEffortStore, REASONING_EFFORTS
from .user_preferences_client import UserPreferencesClient


def _cmd_prefix() -> str:
    """Return the slash-command prefix derived from APP_NAME (e.g. ``forge``)."""
    name = (
        os.environ.get("SLACK_INTEGRATION_APP_NAME")
        or os.environ.get("APP_NAME")
        or "caipe"
    )
    return name.lower()


# ---------------------------------------------------------------------------
# Static messages (no command-name references)
# ---------------------------------------------------------------------------

RATE_LIMITED_MESSAGE = (
    "You're sending commands too fast. Wait a few seconds and try again."
)

LIST_UNAVAILABLE_MESSAGE = (
    "I couldn't load your accessible agents right now. Try again in a moment."
)

LIST_EMPTY_MESSAGE = (
    "You don't have access to any agents yet. Ask your admin to grant you "
    "agent access."
)

USE_OK_MESSAGE = (
    "Got it — this thread will route to `{agent_id}` until you change it "
    "again or the bot restarts."
)

USE_DEFAULT_OK_MESSAGE = (
    "Cleared your Slack default and any active thread override. Future DM "
    "messages will use the platform default."
)

USE_DEFAULT_PARTIAL_OK_MESSAGE = (
    "Cleared the thread override. I couldn't update your saved preference "
    "right now — try again later, or set it in the Settings UI."
)

PDP_UNAVAILABLE_MESSAGE = (
    "I can't verify agent access right now. Try again in a moment."
)


# ---------------------------------------------------------------------------
# Dynamic messages (reference the command prefix)
# ---------------------------------------------------------------------------

def help_message() -> str:
    cmd = _cmd_prefix()
    return (
        f"*Bot commands*\n"
        f"• `/{cmd}-list` — show the agents you can use\n"
        f"• `/{cmd}-use <agent>` — route this DM thread to a specific agent "
        f"(use `/{cmd}-use default` to clear your saved preference)\n"
        f"• `/{cmd}-effort <low|medium|high|max>` — set reasoning effort for your next DM message\n"
        f"• `/{cmd}-help` — show this message\n"
        "\n"
        "Direct messages dispatch via: thread override → your Slack default "
        "→ the deployment direct-message default → the platform default."
    )


def list_header(count: int) -> str:
    cmd = _cmd_prefix()
    return (
        f"Agents you can use ({count} total). "
        f"Use `/{cmd}-use <agent>` to override for this thread."
    )


def use_missing_arg_message() -> str:
    cmd = _cmd_prefix()
    return (
        f"Usage: `/{cmd}-use <agent-id>` (or `/{cmd}-use default` to clear your "
        "saved preference and revert to the deployment default)."
    )


def use_denied_message(agent_id: str) -> str:
    cmd = _cmd_prefix()
    return (
        f"You don't have access to agent `{agent_id}`. Your existing preference "
        f"is unchanged. Use `/{cmd}-list` to see what you can use."
    )


def use_unknown_agent_message(agent_id: str) -> str:
    cmd = _cmd_prefix()
    return (
        f"I don't recognize an agent called `{agent_id}`. Use `/{cmd}-list` to "
        "see what's available."
    )


def use_dm_only_message() -> str:
    cmd = _cmd_prefix()
    return (
        f"`/{cmd}-use` only applies in direct messages — it sets a per-thread "
        "agent override for your DM with the bot."
    )


def dm_only_message(command: str) -> str:
    """Ephemeral shown when a DM-only command is invoked outside a DM."""
    cmd = _cmd_prefix()
    return (
        f"`/{cmd}-{command}` only works in direct messages with the bot. "
        f"Open a DM and try again."
    )


# ---------------------------------------------------------------------------
# Core types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SlashCommandResult:
    """Structured slash-command response.

    The ``text`` field is what the bot posts back to Slack (always
    ``response_type=ephemeral`` per FR-034). The ``code`` field is
    machine-readable so callers can log/aggregate without scraping
    user-facing copy.
    """

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


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

def handle_help_command(
    *,
    user_key: str,
    is_dm: bool = True,
    rate_limiter: Optional[CommandRateLimiter] = None,
) -> SlashCommandResult:
    """Return the help text (FR-030, FR-037).

    DM-only.  Returns a ``dm_only`` error when invoked in a channel.
    """
    if not is_dm:
        return SlashCommandResult(text=dm_only_message("help"), code="dm_only")
    if _rate_limited(rate_limiter, user_key):
        return SlashCommandResult(text=RATE_LIMITED_MESSAGE, code="rate_limited")
    return SlashCommandResult(text=help_message(), code="help")


def handle_list_command(
    *,
    user_key: str,
    bearer_token: str,
    accessible_agents_client: AccessibleAgentsClient,
    is_dm: bool = True,
    rate_limiter: Optional[CommandRateLimiter] = None,
) -> SlashCommandResult:
    """Return the user's accessible agents (FR-028, FR-036).

    DM-only.  Returns a ``dm_only`` error when invoked in a channel.
    """
    if not is_dm:
        return SlashCommandResult(text=dm_only_message("list"), code="dm_only")
    if _rate_limited(rate_limiter, user_key):
        return SlashCommandResult(text=RATE_LIMITED_MESSAGE, code="rate_limited")

    result = accessible_agents_client.list_agents(bearer_token=bearer_token)
    if not result.available:
        return SlashCommandResult(
            text=LIST_UNAVAILABLE_MESSAGE, code="list_unavailable"
        )
    if not result.agents:
        return SlashCommandResult(text=LIST_EMPTY_MESSAGE, code="list_empty")

    lines = [list_header(len(result.agents))]
    for agent in result.agents:
        if agent.description:
            lines.append(f"• `{agent.id}` — {agent.name}: {agent.description}")
        else:
            lines.append(f"• `{agent.id}` — {agent.name}")
    return SlashCommandResult(text="\n".join(lines), code="list_ok")


def handle_effort_command(
    *,
    user_key: str,
    raw_text: str,
    is_dm: bool,
    pending_key: PendingEffortKey | None,
    pending_store: PendingEffortStore,
    rate_limiter: Optional[CommandRateLimiter] = None,
) -> SlashCommandResult:
    """Stage a portable effort for the next message in this DM."""
    if not is_dm or pending_key is None:
        return SlashCommandResult(text=dm_only_message("effort"), code="dm_only")
    if _rate_limited(rate_limiter, user_key):
        return SlashCommandResult(text=RATE_LIMITED_MESSAGE, code="rate_limited")
    effort = (raw_text or "").strip().lower()
    if effort not in REASONING_EFFORTS:
        cmd = _cmd_prefix()
        return SlashCommandResult(
            text=f"Usage: `/{cmd}-effort <low|medium|high|max>`.",
            code="effort_invalid",
        )
    pending_store.set(pending_key, effort)
    return SlashCommandResult(
        text=f"Reasoning effort changed to `{effort}`. It applies to your next DM message and that chat.",
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
    user_preferences_client: UserPreferencesClient,
    accessible_agents_client: Optional[AccessibleAgentsClient] = None,
    rate_limiter: Optional[CommandRateLimiter] = None,
) -> SlashCommandResult:
    """Apply a thread-scoped override or clear preferences (FR-029/029a/033).

    Args:
        user_key: Per-user key for rate limiting (Slack ``user_id``).
        raw_text: Argument text from the slash command (``"github"``
            or ``"default"`` or ``""``).
        bearer_token: User's OBO/session bearer for downstream PDP +
            preferences calls.
        is_dm: Whether the command was issued in a DM channel.
            The ``<agent>`` form is DM-only (per FR-029 dispatch chain).
            The ``default`` form is allowed anywhere (clears your own
            saved preference).
        override_key: Identity for the override store. ``None`` is
            allowed for the ``default`` argument when ``is_dm`` is
            False (we still clear the saved preference; but for
            ``<agent>`` arguments without an ``override_key`` we
            refuse).
        override_store: In-process override store.
        dm_authz_client: PDP client.
        user_preferences_client: BFF user-preferences client (used
            only for the ``default`` argument).
        accessible_agents_client: Optional. If provided, we use it to
            disambiguate unknown agent IDs into a "did you mean?"
            hint per spec edge-case "User types ``/use github-agent``
            but the agent name has a typo".
        rate_limiter: Optional rate limiter.
    """
    if _rate_limited(rate_limiter, user_key):
        return SlashCommandResult(text=RATE_LIMITED_MESSAGE, code="rate_limited")

    argument = (raw_text or "").strip()
    if not argument:
        return SlashCommandResult(
            text=use_missing_arg_message(), code="use_missing_arg"
        )

    if argument.lower() == "default":
        return _handle_use_default(
            bearer_token=bearer_token,
            override_key=override_key,
            override_store=override_store,
            user_preferences_client=user_preferences_client,
        )

    if not is_dm or override_key is None:
        return SlashCommandResult(
            text=use_dm_only_message(), code="use_dm_only"
        )

    decision = dm_authz_client.check_agent_access(
        bearer_token=bearer_token, agent_id=argument
    )
    if not decision.available:
        return SlashCommandResult(
            text=PDP_UNAVAILABLE_MESSAGE, code="pdp_unavailable"
        )
    if not decision.allowed:
        return _denied_use_response(argument, accessible_agents_client, bearer_token)

    override_store.set(override_key, argument)
    return SlashCommandResult(
        text=USE_OK_MESSAGE.format(agent_id=argument), code="use_ok"
    )


def _handle_use_default(
    *,
    bearer_token: str,
    override_key: Optional[OverrideKey],
    override_store: _OverrideStoreProto,
    user_preferences_client: UserPreferencesClient,
) -> SlashCommandResult:
    """``/{cmd}-use default`` — FR-029a.

    Always succeeds at clearing the user's local state. If clearing
    the saved preference in the BFF fails (network/5xx), we still
    return ``use_default_partial`` rather than failing the whole
    command, because the local override has already been cleared.
    """
    if override_key is not None:
        override_store.clear(override_key)
    pref_cleared = user_preferences_client.clear_dm_default_agent(
        bearer_token=bearer_token
    )
    if pref_cleared:
        return SlashCommandResult(
            text=USE_DEFAULT_OK_MESSAGE, code="use_default_ok"
        )
    return SlashCommandResult(
        text=USE_DEFAULT_PARTIAL_OK_MESSAGE, code="use_default_partial"
    )


def _denied_use_response(
    agent_id: str,
    accessible_agents_client: Optional[AccessibleAgentsClient],
    bearer_token: str,
) -> SlashCommandResult:
    """Translate a deny into either "no access" or "unknown agent".

    Per spec edge-case ("typo in agent name") we look up the user's
    accessible-agents list, and if ``agent_id`` is not in the list
    AND not even a "close enough" suffix of a known ID, we treat it
    as an unknown agent so the user gets a more accurate message.

    This is a best-effort hint. If the accessible-agents lookup is
    unavailable we fall back to the generic "you don't have access"
    message, which is always safe.
    """
    if accessible_agents_client is None:
        return SlashCommandResult(
            text=use_denied_message(agent_id), code="use_denied"
        )
    listing = accessible_agents_client.list_agents(bearer_token=bearer_token)
    if not listing.available:
        return SlashCommandResult(
            text=use_denied_message(agent_id), code="use_denied"
        )
    known_ids = {agent.id for agent in listing.agents}
    if agent_id in known_ids:
        return SlashCommandResult(
            text=use_denied_message(agent_id), code="use_denied"
        )
    return SlashCommandResult(
        text=use_unknown_agent_message(agent_id),
        code="use_unknown",
    )
