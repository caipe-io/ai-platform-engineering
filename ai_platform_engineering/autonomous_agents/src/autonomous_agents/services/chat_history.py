"""Chat history publisher -- surfaces autonomous runs in the UI's chat history.

IMP-13 + spec #099. Operations folks live in the chat sidebar; autonomous
task runs that never appear there are effectively invisible. The Mongo
implementation writes each task's lifecycle events as a tagged
conversation (``source: "autonomous"``) into the existing
``conversations`` + ``messages`` collections used by the Next.js UI, so
a single ``?source=autonomous`` filter shows "what did the autonomous
agent do today?" alongside human chats.

This module defines the Protocol + no-op fallback only; the Mongo
implementation lives on
:class:`autonomous_agents.services.mongo.MongoService` and is exposed to
callers via :class:`~autonomous_agents.services.mongo.MongoChatHistoryPublisherAdapter`.
Keeping the Protocol here means scheduler / routes / tests depend on a
driver-free module, and the Mongo path is opt-in at lifespan wiring
time (``CHAT_HISTORY_PUBLISH_ENABLED`` must be True *and* the Mongo
connection must succeed).

Design
------
* **Opt-in.** ``CHAT_HISTORY_PUBLISH_ENABLED`` defaults to ``False``.
  We never touch UI collections unless an operator explicitly enables
  the feature, because the UI Mongo schema is owned by another package.
* **Same Mongo cluster, optionally different database.** Defaults to
  the same ``MONGODB_URI`` / ``MONGODB_DATABASE`` used by the run
  store; ``CHAT_HISTORY_DATABASE`` overrides only the database name
  when CAIPE puts chat data on a separate logical DB. Both databases
  are served from the *same* ``AsyncIOMotorClient`` that ``MongoService``
  owns -- no second connection pool.
* **Deterministic ids.** Conversation ``_id`` is
  ``uuid5(_AUTONOMOUS_NS, f"task:{task_id}")`` -- one conversation per
  task, stable across runs. Messages are keyed on ``message_id`` with
  per-run prefixes (``run:<run_id>:request`` / ``:response``) so
  multiple runs append rather than overwriting.
* **Best-effort.** The publisher is observability, not source of truth:
  a flaky chat database must never abort a scheduled task. Callers
  wrap every publish call in ``task_runner._publish_safely`` or the
  route-level equivalent so failures are logged and swallowed.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Literal, Protocol, runtime_checkable

from autonomous_agents.models import TaskDefinition, TaskRun

logger = logging.getLogger("autonomous_agents")

# Module-level UUID5 namespace for deriving conversation ids.
#
# Random-but-fixed bytes generated once: the value is opaque -- what
# matters is that it never changes, otherwise an old run record's
# conversation_id would no longer match the document we'd write today.
_AUTONOMOUS_NS = uuid.UUID("4b2c0d6e-5b71-4f4a-9b4d-7c1e9f0a2b8e")


# Spec #099 FR-007 -- enumerated message kinds. Each chat message we
# write carries one of these in ``metadata.kind`` so the UI can render
# a typed affordance (status icon, contextual menu) without re-parsing
# the body. Kept open ("str") so future kinds can land without a
# co-deploy of the UI.
MessageKind = Literal[
    "creation_intent",   # initial human-authored intent + form values
    "preflight_ack",     # supervisor's pre-flight acknowledgement payload
    "next_run_marker",   # informational: "next run at HH:MM" -- Phase 2
    "run_request",       # the prompt actually sent to the supervisor
    "run_response",      # successful supervisor response
    "run_error",         # failed supervisor response (with error detail)
    "task_updated",      # task fields changed (post-Phase-1)
    "task_disabled",     # operator disabled the task (post-Phase-1)
    "task_deleted",      # operator deleted the task (post-Phase-1)
    "task_reauthored",   # task author bot rewrote the task (Phase 3)
]


def conversation_id_for_task(task_id: str) -> str:
    """Derive a stable UUIDv4-shaped conversation id from ``task_id``.

    Spec #099 FR-006 / AD-002. Every autonomous task owns exactly one
    chat conversation. The deterministic UUIDv5 derivation matches the
    contextId derivation used by ``services/a2a_client.py`` so the chat
    conversation, the LangGraph checkpointer thread, and the
    supervisor's run history all key off the same identifier.

    The UI's chat routes ``validateUUID`` the path segment, so the id
    must match the canonical 8-4-4-4-12 hex pattern. ``uuid5`` returns
    a UUID with version bits set to 5 -- the regex doesn't care about
    version bits, only shape, so this is safe.
    """
    return str(uuid.uuid5(_AUTONOMOUS_NS, f"task:{task_id}"))


def conversation_id_for_webhook_run(task_id: str, root_run_id: str) -> str:
    """Derive an isolated Dynamic Agents context for one webhook delivery.

    The UI groups all deliveries for a webhook task into one task timeline, but
    independent deliveries must not share model/checkpointer state. Follow-ups
    to a delivery reuse the id derived from its root run; a new delivery gets a
    different id even when it belongs to the same task.
    """
    return str(uuid.uuid5(_AUTONOMOUS_NS, f"webhook:{task_id}:{root_run_id}"))


def _conversation_id_for_run(run_id: str) -> str:
    """Deprecated per-run conversation id; prefer :func:`conversation_id_for_task`.

    Retained for backwards compatibility with integration harnesses
    that were built against the pre-spec-#099 per-run namespace. New
    callers MUST use :func:`conversation_id_for_task` so the
    conversation, checkpointer, and run history all share a key.
    """
    return str(uuid.uuid5(_AUTONOMOUS_NS, run_id))


@runtime_checkable
class ChatHistoryPublisher(Protocol):
    """Async publisher contract -- one conversation per task, many messages.

    Spec #099 FR-006..009: a task owns a single conversation
    (deterministic UUIDv5 from the task id) and every lifecycle event
    for that task appends a typed message (``metadata.kind``) to the
    same thread.

    Implementations MUST be safe to call concurrently from the
    scheduler and from the FastAPI request handlers. They MAY raise on
    transient store failures; callers wrap every call in
    ``task_runner._publish_safely`` or ``task_lifecycle`` helpers
    so a raising implementation never aborts task execution or 500s a
    CRUD route.
    """

    enabled: bool

    async def publish_run(
        self,
        run: TaskRun,
        *,
        prompt: str,
        response: str | None,
        error: str | None,
        agent: str | None,
        task_id: str | None = None,
        conversation_id: str | None = None,
    ) -> None:
        """Append a (run_request, run_response|run_error) message pair."""
        pass

    async def publish_creation_intent(
        self,
        task: TaskDefinition,
    ) -> None:
        """Append a creation_intent message describing the operator's request."""
        pass

    async def publish_preflight_ack(
        self,
        task: TaskDefinition,
        ack_payload: dict[str, Any],
    ) -> None:
        """Append a preflight_ack message with the supervisor's ack payload."""
        pass


class NoopChatHistoryPublisher:
    """No-op implementation used when chat-history publishing is disabled.

    Selected by the lifespan when ``CHAT_HISTORY_PUBLISH_ENABLED`` is
    False, or when MongoDB isn't reachable and the service fell back to
    ephemeral in-memory stores. Keeping the happy-path / disabled-path
    interfaces identical means the callers don't need any "is
    publishing on?" branches.
    """

    enabled = False

    async def publish_run(
        self,
        run: TaskRun,
        *,
        prompt: str,
        response: str | None,
        error: str | None,
        agent: str | None,
        task_id: str | None = None,
        conversation_id: str | None = None,
    ) -> None:
        return None

    async def publish_creation_intent(
        self,
        task: TaskDefinition,
    ) -> None:
        return None

    async def publish_preflight_ack(
        self,
        task: TaskDefinition,
        ack_payload: dict[str, Any],
    ) -> None:
        return None
