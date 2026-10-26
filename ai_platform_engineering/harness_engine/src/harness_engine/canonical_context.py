"""Validate server-owned visible and runtime context mappings."""

from __future__ import annotations

import os
from typing import Any

from pymongo import DESCENDING
from pymongo.database import Database


class CanonicalContextError(ValueError):
    """A stored context no longer admits its claimed agent or runtime alias."""


def resolve_canonical_conversation(
    database: Database[Any], *, owner_subject: str, agent_id: str, conversation_id: str,
    visible_conversation_id: str | None = None,
) -> dict[str, Any] | None:
    """Read a canonical mapping; a caller-supplied alias never creates one.

    Absence is permitted for journal-only API runs. Provider state and platform
    effects must require a returned admitted context rather than inventing one.
    """
    visible_id = visible_conversation_id or conversation_id
    conversation = database.conversations.find_one({"_id": visible_id})
    if conversation is None:
        return None
    saved_subject = conversation.get("owner_subject")
    if saved_subject is not None:
        owns = isinstance(saved_subject, str) and bool(saved_subject) and saved_subject == owner_subject
    else:
        owner_id = conversation.get("owner_id")
        owns = isinstance(owner_id, str) and bool(owner_id) and (owner_id == owner_subject or bool(database.users.find_one({
            "email": owner_id, "$or": [{"keycloak_sub": owner_subject}, {"metadata.keycloak_sub": owner_subject}],
        }, {"_id": 1})))
    if not owns:
        raise CanonicalContextError("The canonical conversation owner changed or cannot be verified")
    if (
        conversation.get("deleted_at") is not None or conversation.get("deleted") is True
        or conversation.get("is_archived") is True or "app_binding" in conversation
        or database.harness_deleted_contexts.find_one({"_id": {"$in": [visible_id, conversation_id]}}, {"_id": 1})
    ):
        raise CanonicalContextError("The canonical conversation is unavailable")
    participants = conversation.get("participants") or []
    if {item.get("id") for item in participants if isinstance(item, dict) and item.get("type") == "agent"} != {agent_id}:
        raise CanonicalContextError("The canonical conversation contains another agent")
    pointer = conversation.get("execution_context_id")
    if isinstance(pointer, str) and pointer:
        if pointer == conversation_id:
            return conversation
        raise CanonicalContextError("The canonical runtime pointer changed")
    if conversation_id == visible_id:
        return conversation
    if conversation.get("source") == "autonomous":
        task_id = conversation.get("task_id") or conversation.get("metadata", {}).get("task_id")
        task = database.autonomous_tasks.find_one({
            "_id": task_id, "owner_sub": owner_subject, "owner_id": conversation.get("owner_id"),
        }) if isinstance(task_id, str) else None
        if task is not None:
            collection = os.environ.get("AUTONOMOUS_RUNS_COLLECTION", "autonomous_runs")
            latest = database[collection].find_one(
                {"task_id": task_id, "owner_id": conversation.get("owner_id"), "execution_context_id": {"$ne": None}},
                sort=[("started_at", DESCENDING)],
            )
            if latest and latest.get("execution_context_id") == conversation_id and latest.get("conversation_id") in (None, visible_id):
                return conversation
    raise CanonicalContextError("No canonical visible-to-runtime mapping admits this alias")
