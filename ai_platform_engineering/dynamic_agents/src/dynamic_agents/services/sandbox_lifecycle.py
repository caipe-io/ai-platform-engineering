"""Destructive external-session cleanup under canonical native admission."""

from __future__ import annotations

import asyncio
import hashlib
from datetime import datetime, timezone

from pydantic import ValidationError

from dynamic_agents.auth.authz import current_subject_reference
from dynamic_agents.config import Settings
from dynamic_agents.services.harness_checkpoints import CheckpointIdentity, CheckpointStore
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.sandbox_client import (
    SandboxAllocation,
    SandboxClient,
    SandboxError,
    SandboxIdentityChanged,
    SandboxProfileReference,
)
from dynamic_agents.services.session_bindings import get_sandbox_binding, reset_sandbox_binding
from dynamic_agents.services.session_runs import await_session_operation, current_native_session_lease


async def restart_sandbox_session(mongo: MongoDBService, agent_id: str, session_id: str, settings: Settings) -> bool:
    """Reconnect ACP and MCP next turn while preserving the exact native state.

    Idle sandbox transports are already closed after every turn. Restart has
    the same reconnect meaning as the native cache operation: it never deletes
    the environment, forks history, or resends an uncertain tool invocation.
    A live turn holds the same admission and prevents this operation entirely.
    """
    state = await await_session_operation(get_sandbox_binding, mongo, agent_id, session_id)
    if state is None:
        return False
    lease_id = current_native_session_lease.get()
    if lease_id is None:
        raise SandboxError("Sandbox restart requires its admitted session lease")
    client = SandboxClient(settings)
    if state.get("owner_subject") != current_subject_reference():
        raise SandboxError("Only the sandbox's original caller can restart its runtime")
    if state.get("connection_version") != hashlib.sha256(client.base.encode()).hexdigest():
        raise SandboxError("The sandbox control-plane binding changed; restart requires operator recovery")
    # Retain a pending recovery unchanged. The normal restore path completes
    # its immutable operation before opening the fresh ACP/MCP connection.
    changed = await await_session_operation(
        mongo.get_session_runs_collection().update_one,
        {"agent_id": agent_id, "session_id": session_id, "lease_id": lease_id,
         "lease_expires_at": {"$gt": datetime.now(timezone.utc)}, "cancel_requested": {"$ne": True}},
        {"$set": {"runtime_restart_requested_at": datetime.now(timezone.utc)}, "$inc": {"checkpoint_generation": 1}},
    )
    if not changed.matched_count:
        raise SandboxError("The sandbox runtime restart lost its admitted session lease")
    return True


async def clear_sandbox_session(
    mongo: MongoDBService, agent_id: str, session_id: str, settings: Settings, *, preserve_rewind: bool = False,
) -> bool:
    """Delete the pinned environment before resetting its durable reference.

    Do not require the profile catalog to remain enabled: explicit cleanup must
    still work after profile retirement. The portal independently authorizes the
    same caller and checks the current allocation UID and resource version.
    """
    state = await await_session_operation(get_sandbox_binding, mongo, agent_id, session_id)
    if state is None:
        return False
    lease_id = current_native_session_lease.get()
    if lease_id is None:
        raise SandboxError("Sandbox cleanup requires its admitted session lease")
    client = SandboxClient(settings)
    if state.get("owner_subject") != current_subject_reference():
        raise SandboxError("Only the sandbox's original caller can delete its environment")
    if state.get("connection_version") != hashlib.sha256(client.base.encode()).hexdigest():
        raise SandboxError("The sandbox control-plane binding changed; cleanup requires operator recovery")
    try:
        profile = SandboxProfileReference.model_validate(state["profile"])
        allocation = SandboxAllocation.model_validate(state["allocation"]) if state.get("allocation") is not None else None
    except (KeyError, TypeError, ValidationError):
        raise SandboxError("The saved sandbox cleanup binding is invalid") from None
    if allocation is None:
        # A provision request may have succeeded before its caller lost the
        # response. Lookup is owner-bound and never provisions during cleanup.
        allocation = await client.lookup(agent_id, session_id, profile)
    if allocation is not None and allocation.conversation_id != client.conversation_reference(agent_id, session_id):
        raise SandboxError("The saved sandbox conversation binding changed")
    if allocation is not None and (allocation.profile_id, allocation.revision) != (profile.id, profile.revision):
        raise SandboxError("The saved sandbox profile binding changed")
    store = await asyncio.to_thread(CheckpointStore, mongo)
    if state.get("provider_session_id"):
        identity = CheckpointIdentity(agent_id=agent_id, session_id=session_id, owner_subject=state["owner_subject"],
            profile_id=profile.id, profile_revision=profile.revision, harness=state["profile"]["harness"],
            provider_session_id=state["provider_session_id"], connection_version=state["connection_version"])
        intent = await store.restore_intent_for_cleanup(identity, lease_id)
        if intent is not None:
            pending = (SandboxAllocation.model_validate(intent["allocation"]) if intent.get("allocation") is not None
                       else await client.lookup(agent_id, session_id, profile))
            if pending is not None:
                if allocation is None or any(getattr(pending, key) != getattr(allocation, key)
                        for key in ("id", "namespace", "conversation_id", "profile_id", "revision", "cwd")):
                    raise SandboxError("The pending sandbox cleanup allocation changed")
                try:
                    await client.delete(pending, profile)
                except SandboxIdentityChanged:
                    # A restore's working cache may itself have been replaced.
                    # Owner-bound lookup authorizes cleanup only; never create.
                    replacement = await client.lookup(agent_id, session_id, profile)
                    if replacement is not None:
                        if any(getattr(replacement, key) != getattr(pending, key)
                               for key in ("id", "namespace", "conversation_id", "profile_id", "revision", "cwd")):
                            raise SandboxError("The pending sandbox cleanup allocation changed") from None
                        await client.delete(replacement, profile)
                # A deterministic allocation ID can now refer to this newer
                # generation. Do not ask deletion to adopt a different UID.
                if pending.id == allocation.id:
                    allocation = None
    if allocation is not None:
        await client.delete(allocation, profile)
    await store.cleanup(agent_id, session_id, state["owner_subject"], lease_id, preserve_rewind=preserve_rewind)
    # Cleanup removes the checkpoint allocation/phase overlay. Compare reset
    # against the resulting canonical binding rather than an obsolete overlay.
    current = await await_session_operation(get_sandbox_binding, mongo, agent_id, session_id)
    await await_session_operation(reset_sandbox_binding, mongo, agent_id, session_id, current)
    return True
