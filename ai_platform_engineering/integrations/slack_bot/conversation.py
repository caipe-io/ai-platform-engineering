# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Slack conversation creation, telemetry, and agent invocation."""

from __future__ import annotations

from typing import Any

from loguru import logger

from handler_dependencies import ConversationDependencies
from sse_client import SSEClient
from utils import ai
from utils.config_models import Config
from utils.file_ingest import IngestResult


config: Config
sse_client: SSEClient
_WORKSPACE_URL = ""
SLACK_WORKSPACE_URL = ""


def configure_conversation(dependencies: ConversationDependencies) -> None:
  """Install process-scoped conversation collaborators."""
  global config, sse_client, _WORKSPACE_URL, SLACK_WORKSPACE_URL

  config = dependencies.config
  sse_client = dependencies.sse_client
  _WORKSPACE_URL = dependencies.workspace_url.rstrip("/")
  SLACK_WORKSPACE_URL = dependencies.workspace_url


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
  client: Any,
  channel_id: str,
  thread_ts: str,
  message_text: str,
  user_id: str,
  team_id: str,
  agent_id: str,
  conversation_id: str,
  triggered_by_user_id: str | None = None,
  additional_footer: str | None = None,
  overthink_config: Any = None,
  escalation_config: Any = None,
  client_context: dict[str, Any] | None = None,
  files: list[dict[str, Any]] | None = None,
) -> Any:
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
