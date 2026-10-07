"""Webex thread map -- (Webex messageId) -> (task_id, run_id).

When a scheduled autonomous task posts a message to a Webex space via
the ``post_message`` MCP tool, we record the resulting ``messageId``
here so a later in-thread reply (which Webex's webhook delivers with
``parentId=<that messageId>``) can be routed back to the originating
task as a follow-up run. Without this index the inbound bridge has no
way to know which task a reply belongs to.

The map is intentionally narrow:

* Only ``messageId``, ``room_id``, ``task_id``, ``run_id``, and
  timestamps -- no message body, no operator PII, nothing that needs
  redacting.
* Best-effort writes -- a Mongo blip when the run completes MUST NOT
  fail the run. The scheduler swallows write errors and logs them.
* TTL-indexed -- abandoned threads (e.g. an issue triage that nobody
  ever replies to) age out after ``webex_thread_map_ttl_days``.

This module deliberately ships its own :class:`WebexThreadMap`
``Protocol`` rather than reusing :class:`RunStore` -- the contract is
fundamentally different (random-key lookup vs append-by-task). Tests can
inject protocol-shaped fakes without dragging Mongo into the loop.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Protocol, runtime_checkable

logger = logging.getLogger("autonomous_agents")


# ---------------------------------------------------------------------------
# Domain model
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class WebexThreadEntry:
    """One row in the thread map.

    Frozen + slots so the value can be cheaply hashed / passed around
    between coroutines without accidental mutation.
    """

    message_id: str
    task_id: str
    run_id: str
    room_id: str | None = None
    created_at: datetime | None = None


# ---------------------------------------------------------------------------
# Protocol -- what the scheduler / bridge depend on
# ---------------------------------------------------------------------------


@runtime_checkable
class WebexThreadMap(Protocol):
    """Persisted index from Webex messageId to the run that posted it.

    Implementations MUST be safe to call concurrently from the scheduler
    event loop. :meth:`record` is upsert-by-``message_id`` so retries on
    a flaky write path do not create duplicates.
    """

    async def record(self, entry: WebexThreadEntry) -> None: ...

    async def lookup(self, message_id: str) -> WebexThreadEntry | None: ...


# ---------------------------------------------------------------------------
# Tool-output scanning
# ---------------------------------------------------------------------------


# Matches the descriptor we add to the Webex MCP ``post_message`` tool
# response (see ``mcp_webex/mcp_server.py``):
#
#     "Message sent successfully (messageId=Y2lzY..., roomId=Y2lzY...)."
#
# Webex IDs are URL-safe base64 (alphanumerics + ``-`` + ``_`` + ``=``).
# We anchor on the explicit ``messageId=`` / ``roomId=`` tokens so an
# unrelated tool that happens to include a base64-looking id in free
# text never gets scraped by accident.
_MESSAGE_ID_RE = re.compile(r"messageId=([A-Za-z0-9_\-=+/]+)")
_ROOM_ID_RE = re.compile(r"roomId=([A-Za-z0-9_\-=+/]+)")


def extract_webex_message_ids(
    events: Iterable[dict[str, Any]] | None,
) -> list[tuple[str, str | None]]:
    """Walk run events and return ``(message_id, room_id_or_None)`` pairs.

    The scheduler calls this on completed-run ``events`` so the
    resulting list can be persisted into the thread map. Returns an
    empty list when ``events`` is None / empty / contains no Webex
    post_message tool calls -- the scheduler treats that as the common
    case (most tasks never post to Webex).

    We deliberately scan ``tool_notification_end`` artifact text rather
    than poking at the supervisor's structured tool-call records --
    the textual descriptor is the same shape regardless of whether the
    sub-agent ran inline or via A2A, so this seam survives future
    transport refactors. Duplicates are de-duplicated keeping the
    first-seen ``room_id`` so multi-step posts (e.g. acknowledge ->
    summary) all land in the map.
    """
    if not events:
        return []

    seen: dict[str, str | None] = {}
    for event in events:
        if not isinstance(event, dict):
            continue
        artifact = event.get("artifact")
        if not isinstance(artifact, dict):
            continue
        # Only walk tool-completion artifacts -- the start / streaming
        # variants never include the response body.
        if artifact.get("name") != "tool_notification_end":
            continue
        for part in artifact.get("parts") or []:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if not isinstance(text, str) or "messageId=" not in text:
                continue
            for match in _MESSAGE_ID_RE.finditer(text):
                message_id = match.group(1)
                if message_id in seen:
                    continue
                room_match = _ROOM_ID_RE.search(text, match.end())
                seen[message_id] = (
                    room_match.group(1) if room_match is not None else None
                )

    return list(seen.items())
