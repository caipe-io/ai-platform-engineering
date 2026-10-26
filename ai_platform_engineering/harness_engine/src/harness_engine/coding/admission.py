"""Shared fencing for provider IO, human input and run-scoped resources."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from pymongo import timeout
from pymongo.database import Database
from pymongo.errors import PyMongoError

from harness_engine.canonical_context import CanonicalContextError, resolve_canonical_conversation
from harness_engine.models import RunContext


class CodingAdmissionError(RuntimeError):
    """The admitted run no longer authorizes a provider resource operation."""


class RunFence:
    """Read the existing Engine lease; never issue a second execution claim."""

    def __init__(self, database: Database[dict[str, Any]], context: RunContext) -> None:
        self.db, self.context = database, context

    def query(self) -> dict[str, Any]:
        context = self.context
        if not context.producer_token:
            raise CodingAdmissionError("The provider requires an admitted execution owner")
        return {
            "binding_id": context.binding.binding_id,
            "owner_subject": context.binding.owner_subject,
            "agent_id": context.binding.agent_id,
            "conversation_id": context.binding.conversation_id,
            "harness_id": context.binding.harness_id,
            "profile_id": context.binding.profile_id,
            "status": "active",
            "_active_run_id": context.turn.run_id,
            "_producer_id": context.producer_token,
            "_lease_expires_at": {"$gt": datetime.now(timezone.utc)},
        }

    def require_sync(self, *, allow_cancelled: bool = False) -> tuple[dict[str, Any], dict[str, Any]]:
        context = self.context
        run = self.db.harness_runs.find_one(
            {
                "run_id": context.turn.run_id,
                "binding_id": context.binding.binding_id,
                "owner_subject": context.binding.owner_subject,
                "agent_id": context.binding.agent_id,
                "conversation_id": context.binding.conversation_id,
                "harness_id": context.binding.harness_id,
                "_producer_id": context.producer_token,
                "status": {"$in": ["running", "awaiting_input"]},
            }
        )
        session = self.db.harness_sessions.find_one(self.query())
        try:
            conversation = resolve_canonical_conversation(
                self.db,
                owner_subject=context.binding.owner_subject,
                agent_id=context.binding.agent_id,
                conversation_id=context.binding.conversation_id,
                visible_conversation_id=context.turn.visible_conversation_id,
            )
        except CanonicalContextError:
            raise CodingAdmissionError("The provider canonical context is no longer admitted") from None
        agent = self.db.dynamic_agents.find_one({"_id": context.binding.agent_id})
        if (
            not run
            or not session
            or not conversation
            or not agent
            or agent.get("enabled", True) is not True
            or (run.get("cancellation_requested") and not allow_cancelled)
        ):
            raise CodingAdmissionError("The provider execution is no longer admitted")
        gateway = self.db.harness_gateway_bindings.find_one(
            {
                "owner_subject": context.binding.owner_subject,
                "agent_id": context.binding.agent_id,
                "conversation_id": context.binding.conversation_id,
            }
        )
        if not gateway or gateway.get("harness_id") != context.binding.harness_id:
            raise CodingAdmissionError("The canonical gateway no longer admits this provider")
        return run, session

    async def require(self, *, allow_cancelled: bool = False) -> tuple[dict[str, Any], dict[str, Any]]:
        try:
            with timeout(10):
                return await asyncio.to_thread(self.require_sync, allow_cancelled=allow_cancelled)
        except PyMongoError:
            raise CodingAdmissionError("The provider admission could not be verified") from None


@dataclass(frozen=True)
class ConversationCaller:
    owner_subject: str
    agent_id: str
    conversation_id: str
    harness_id: str


@dataclass(frozen=True)
class ConversationAuthorizationContext:
    binding: ConversationCaller


class ConversationFence:
    """Pre-run admission for opaque uploads, without inventing an execution run."""

    def __init__(
        self,
        database: Database[dict[str, Any]],
        *,
        subject: str,
        agent_id: str,
        conversation_id: str,
        harness_id: str,
        visible_conversation_id: str | None = None,
    ) -> None:
        self.db = database
        self.subject, self.agent_id, self.conversation_id = subject, agent_id, conversation_id
        self.harness_id, self.visible_conversation_id = harness_id, visible_conversation_id
        self.context = ConversationAuthorizationContext(
            ConversationCaller(subject, agent_id, conversation_id, harness_id)
        )

    def require_sync(self) -> tuple[dict[str, Any], dict[str, Any]]:
        try:
            conversation = resolve_canonical_conversation(
                self.db,
                owner_subject=self.subject,
                agent_id=self.agent_id,
                conversation_id=self.conversation_id,
                visible_conversation_id=self.visible_conversation_id,
            )
        except CanonicalContextError:
            raise CodingAdmissionError("The canonical upload context is unavailable") from None
        binding = self.db.harness_gateway_bindings.find_one(
            {
                "owner_subject": self.subject,
                "agent_id": self.agent_id,
                "conversation_id": self.conversation_id,
                "harness_id": self.harness_id,
            }
        )
        agent = self.db.dynamic_agents.find_one({"_id": self.agent_id})
        if not conversation or not binding or not agent or agent.get("enabled", True) is not True:
            raise CodingAdmissionError("The upload requires an admitted canonical conversation route")
        return conversation, binding

    async def require(self, *, allow_cancelled: bool = False) -> tuple[dict[str, Any], dict[str, Any]]:
        if allow_cancelled:
            raise CodingAdmissionError("A pre-run upload has no capture authorization")
        try:
            with timeout(10):
                return await asyncio.to_thread(self.require_sync)
        except PyMongoError:
            raise CodingAdmissionError("The canonical upload admission is unavailable") from None


class ClosedBindingFence:
    """Authorize cleanup of an owned, drained, permanently deleted context."""

    def __init__(self, database: Database[dict[str, Any]], binding: Any) -> None:
        self.db, self.binding = database, binding
        self.context = ConversationAuthorizationContext(
            ConversationCaller(binding.owner_subject, binding.agent_id, binding.conversation_id, binding.harness_id)
        )

    def require_sync(self) -> tuple[dict[str, Any], dict[str, Any]]:
        binding = self.db.harness_sessions.find_one(
            {
                "binding_id": self.binding.binding_id,
                "owner_subject": self.binding.owner_subject,
                "agent_id": self.binding.agent_id,
                "conversation_id": self.binding.conversation_id,
                "harness_id": self.binding.harness_id,
                "status": "closed",
            }
        )
        if not binding or not self.db.harness_deleted_contexts.find_one({"_id": self.binding.conversation_id}):
            raise CodingAdmissionError("Permanent cleanup requires an owned closed binding and deletion fence")
        for run in self.db.harness_runs.find({"binding_id": self.binding.binding_id}):
            stopped = run.get("_producer_stopped") and (
                not run.get("_provider_started") or run.get("_provider_drained")
            )
            if not stopped:
                raise CodingAdmissionError("Permanent cleanup is waiting for the admitted provider to stop")
        return binding, {}

    async def require(self, *, allow_cancelled: bool = False) -> tuple[dict[str, Any], dict[str, Any]]:
        del allow_cancelled
        return await asyncio.to_thread(self.require_sync)
