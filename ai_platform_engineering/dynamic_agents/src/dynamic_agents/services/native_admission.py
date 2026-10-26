"""Prevent an explicitly selected Engine provider from falling back to a graph."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import HTTPException

from dynamic_agents.auth.authz import _subject_from_token
from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.models import DynamicAgentConfig, UserContext

if TYPE_CHECKING:
    from dynamic_agents.services.mongo import MongoDBService


async def require_native_execution(
    mongo: MongoDBService | None, agent: DynamicAgentConfig, session_id: str | None, user: UserContext | None,
) -> None:
    # Private placement metadata comes only from the canonical Mongo read;
    # author-authored config overrides cannot select an execution provider.
    if getattr(agent, "_execution_harness_id", None) != "claude_code_acp":
        return
    token = current_user_token.get()
    verified = _subject_from_token(token) if token else None
    subject = verified[1] if verified else (getattr(user, "sub", None) or getattr(user, "email", None))
    if mongo is not None and mongo._db is not None and session_id and subject:
        binding = await asyncio.to_thread(mongo._db.harness_gateway_bindings.find_one, {
            "owner_subject": subject, "agent_id": agent.id, "conversation_id": session_id, "harness_id": "dynamic_agents",
        }, {"_id": 1})
        if binding is not None:
            return  # A previously admitted native conversation keeps its owner.
    raise HTTPException(409, {"code": "HARNESS_ENGINE_GATEWAY_REQUIRED",
                              "message": "Claude Code execution requires the Harness Engine gateway; direct native targets are unsupported"})
