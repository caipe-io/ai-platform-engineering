"""Slack chat-envelope augmentation.

Phase 1 of the channel-derived team binding migration (spec
2026-05-24-derive-team-from-channel, FR-016) adds the originating
channel/workspace/thread/surface context to the outbound chat envelope so
the RAG server can derive `team_id` from `channel_id` instead of relying
on a JWT team claim (which no longer exists).

The Dynamic Agents `ClientContext` model uses `extra="allow"`, so adding
these keys is a no-op for any downstream consumer that doesn't know about
them; consumers that DO care (RAG, future PDP) read them directly.
"""

from typing import Literal, Mapping, MutableMapping, Optional

SurfaceKind = Literal["channel", "dm"]
_VALID_SURFACE_KINDS = ("channel", "dm")


def augment_slack_client_context(
    base: Mapping[str, object],
    *,
    channel_id: Optional[str],
    workspace_id: Optional[str],
    thread_ts: Optional[str],
    surface_kind: SurfaceKind,
    message_ts: Optional[str] = None,
) -> MutableMapping[str, object]:
    """Return a new dict that copies ``base`` and adds the four Phase 1 fields.

    Skips falsy ``channel_id`` (caller is expected to only invoke this when
    the message has a channel context; we'd rather omit the keys than send
    half-empty data that downstream consumers might misread).

    Skips falsy ``workspace_id`` and ``thread_ts`` (workspace_id may be
    absent for some legacy Slack events; thread_ts is None for top-level
    DMs).

    The ``base`` mapping is NOT mutated.
    """
    if surface_kind not in _VALID_SURFACE_KINDS:
        raise ValueError(
            f"surface_kind must be one of {_VALID_SURFACE_KINDS!r}, got {surface_kind!r}"
        )

    augmented: MutableMapping[str, object] = dict(base)
    if not channel_id:
        # Without channel context the augmentation is a no-op — preserves
        # backward-compat with calls that may invoke this defensively.
        return augmented

    augmented["channel_id"] = channel_id
    augmented["surface_kind"] = surface_kind
    if workspace_id:
        augmented["workspace_id"] = workspace_id
    if thread_ts:
        augmented["thread_ts"] = thread_ts
    if message_ts:
        augmented["delivery_id"] = f"{workspace_id or ''}:{channel_id}:{message_ts}"
    return augmented
