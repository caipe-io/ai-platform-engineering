"""Durable native ACP session admission in the canonical Mongo database.

Only effective agent configuration is snapshotted. Caller context, bearer
tokens, MCP server records and resolved credentials must never enter this
repository. Agent configuration can itself contain sensitive prompt or
middleware parameters, so snapshots require the same protection as the
existing ``dynamic_agents`` collection. This is not a secret redaction layer.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Literal
from uuid import NAMESPACE_URL, uuid5

from pydantic import BaseModel, Field, ValidationError
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

from dynamic_agents.models import AgentExecutionConfig, AppContextPromptConfig, BuiltinToolsConfig, DynamicAgentConfig
from dynamic_agents.services.mcp_client import intersect_allowed_tools
from dynamic_agents.services.native_state_protocol import STATE_CONTRACT
from dynamic_agents.services.runtime_storage import materialize_runtime_config, resolve_runtime_storage

if TYPE_CHECKING:
    from dynamic_agents.config import Settings
    from dynamic_agents.services.mongo import MongoDBService

logger = logging.getLogger(__name__)

SESSION_BINDINGS_COLLECTION = "native_acp_sessions"
GATEWAY_BINDINGS_COLLECTION = "harness_gateway_bindings"


class SessionBindingError(RuntimeError):
    """Admission failed; never silently fall back to a different native state."""


class ExecutionOwnerConflictError(SessionBindingError):
    """A request selected a different execution owner or a deleted context."""


class _PersistenceCoordinates(BaseModel):
    database: str
    checkpoint_collection: str
    checkpoint_writes_collection: str
    gridfs_bucket_name: str


class _DelegatedSession(BaseModel):
    agent_id: str = Field(min_length=1, max_length=256)
    session_id: str = Field(min_length=1, max_length=256)


class _StoredBinding(BaseModel):
    schema_version: Literal[1]
    agent_id: str
    session_id: str
    native_session_id: str
    runtime_kind: Literal["native", "sandbox"]
    protocol: Literal["acp"]
    effective_config: DynamicAgentConfig
    config_version: str = Field(pattern=r"^[a-f0-9]{64}$")
    revision: int = Field(ge=1)
    persistence: _PersistenceCoordinates
    created_at: datetime
    updated_at: datetime
    sandbox: dict[str, Any] | None = None
    delegated_sessions: list[_DelegatedSession] = Field(default_factory=list, max_length=64)


def _snapshot_version(configuration: dict) -> str:
    encoded = json.dumps(configuration, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def _config_version(agent: DynamicAgentConfig) -> str:
    return _snapshot_version(agent.model_dump(mode="json", by_alias=True))


def _persistence_coordinates(agent: DynamicAgentConfig, settings: Settings) -> _PersistenceCoordinates:
    storage = resolve_runtime_storage(agent, None, settings)
    return _PersistenceCoordinates(
        database=storage.database,
        checkpoint_collection=storage.checkpoint_collection,
        checkpoint_writes_collection=storage.checkpoint_writes_collection,
        gridfs_bucket_name=storage.gridfs_bucket_name,
    )


def _validate_binding(record: dict, agent_id: str, session_id: str, settings: Settings) -> _StoredBinding:
    try:
        binding = _StoredBinding.model_validate(record)
    except ValidationError:
        # Validation errors can include snapshot values; do not log prompt or
        # middleware content while reporting corrupt stored state.
        raise SessionBindingError("Native ACP session binding is invalid") from None
    if (
        binding.agent_id != agent_id
        or binding.effective_config.id != agent_id
        or binding.session_id != session_id
        or binding.native_session_id != session_id
        or binding.runtime_kind != binding.effective_config.execution.kind
        # Verify the stored bytes' logical JSON, before model defaults are added.
        # New optional fields must not invalidate an earlier admitted snapshot.
        or binding.config_version != _snapshot_version(record["effective_config"])
    ):
        raise SessionBindingError("Native ACP session binding identity or configuration digest does not match")
    if binding.persistence != _persistence_coordinates(binding.effective_config, settings):
        raise SessionBindingError("Native ACP session persistence settings changed; migrate the existing state first")
    return binding


def get_native_binding(mongo: MongoDBService, agent_id: str, session_id: str) -> DynamicAgentConfig | None:
    """Read an already authorized native snapshot without admitting or updating it."""
    try:
        record = mongo.get_session_bindings_collection().find_one({"agent_id": agent_id, "session_id": session_id})
    except PyMongoError as exc:
        logger.exception("Native ACP session binding read failed for agent %s", agent_id)
        raise SessionBindingError("Native ACP session persistence is unavailable") from exc
    if record is None:
        return None
    return _validate_binding(record, agent_id, session_id, mongo.settings).effective_config


def require_native_execution_owner(
    mongo: MongoDBService, agent: DynamicAgentConfig, session_id: str, *, existing_native: bool | None = None,
) -> None:
    """Enforce the same immutable execution-owner reference at direct native entrypoints.

    This is an admission fence, not a second provider router. A caller selecting
    an SDK provider must use the canonical gateway; existing native state stays
    native even after edits to its shared agent definition.
    """
    if mongo._db is None:
        raise SessionBindingError("MongoDB not connected")
    database = mongo._db
    conversation = database["conversations"].find_one({"_id": session_id}, {"app_binding": 1})
    if conversation is not None and "app_binding" in conversation:
        raise ExecutionOwnerConflictError("This execution context belongs to an installed app; use its admitted gateway")
    deleted = database["native_acp_deleted_sessions"]
    if deleted.find_one({"_id": session_id}) is not None:
        raise ExecutionOwnerConflictError("This execution context was permanently deleted")
    if existing_native is None:
        existing_native = mongo.get_session_bindings_collection().find_one({"agent_id": agent.id, "session_id": session_id}) is not None
    if database["harness_sessions"].find_one({"agent_id": agent.id, "conversation_id": session_id}) is not None:
        raise ExecutionOwnerConflictError("This execution context belongs to Harness Engine; use the canonical gateway")
    storage = resolve_runtime_storage(agent, session_id, mongo.settings)
    legacy = database[storage.checkpoint_collection].find_one({"thread_id": session_id}) is not None
    if not existing_native and not legacy and agent.execution_harness_id != "dynamic_agents":
        raise ExecutionOwnerConflictError("The selected SDK provider requires the canonical gateway")
    key = hashlib.sha256(f"{agent.id}\0{session_id}".encode()).hexdigest()
    references = database[GATEWAY_BINDINGS_COLLECTION]
    # Legacy gateways stored owner-keyed references in this collection. They
    # must not be ignored at a direct native endpoint after a definition edit.
    legacy_query = {"agent_id": agent.id, "conversation_id": session_id}
    legacy_reference = references.find_one(legacy_query)
    if legacy_reference is not None:
        owner = legacy_reference.get("owner_subject")
        legacy_key = hashlib.sha256(json.dumps(
            [owner, agent.id, session_id], separators=(",", ":"), ensure_ascii=False,
        ).encode()).hexdigest()
        if (
            not isinstance(owner, str) or not owner.strip() or legacy_reference.get("_id") != legacy_key
            or references.find_one({**legacy_query, "harness_id": {"$nin": [
                "dynamic_agents", "langchain-deepagents", "langchain_deepagents",
            ]}}) is not None
        ):
            raise ExecutionOwnerConflictError("The saved execution owner requires the canonical gateway or an explicit migration")
    query = {"_id": key}
    try:
        reference = references.find_one_and_update(
            query, {"$setOnInsert": {"agent_id": agent.id, "session_id": session_id, "harness_id": "dynamic_agents"}},
            upsert=True, return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        reference = references.find_one(query)
    if reference is None or reference.get("agent_id") != agent.id or reference.get("session_id") != session_id or reference.get("harness_id") != "dynamic_agents":
        raise ExecutionOwnerConflictError("The execution owner changed; use the canonical gateway or create a new conversation")
    if deleted.find_one({"_id": session_id}) is not None:
        raise ExecutionOwnerConflictError("This execution context was permanently deleted")


def _intersect_domains(saved: str, current: str) -> str:
    """Intersect the exact/domain-suffix patterns understood by URL tools."""
    patterns: list[str] = []
    for left in (part.strip().lower() for part in saved.split(",") if part.strip()):
        for right in (part.strip().lower() for part in current.split(",") if part.strip()):
            match = None
            if left == right or right == "*":
                match = left
            elif left == "*":
                match = right
            elif left.startswith("*.") and right.startswith("*."):
                if right[2:].endswith("." + left[2:]):
                    match = right
                elif left[2:].endswith("." + right[2:]):
                    match = left
            elif left.startswith("*.") and (right == left[2:] or right.endswith("." + left[2:])):
                match = right
            elif right.startswith("*.") and (left == right[2:] or left.endswith("." + right[2:])):
                match = left
            if match is not None and match not in patterns:
                patterns.append(match)
    return ",".join(patterns)


def _intersect_builtin_tools(
    saved: BuiltinToolsConfig | None, current: BuiltinToolsConfig | None,
) -> BuiltinToolsConfig | None:
    """Keep an admitted tool only with its current grant and tighter limits."""
    if saved is None or current is None:
        return None
    result = saved.model_copy(deep=True)
    for name in BuiltinToolsConfig.model_fields:
        admitted = getattr(saved, name)
        authorized = getattr(current, name)
        if name == "workflows":
            setattr(result, name, [value for value in admitted if value in (authorized or [])] if admitted else admitted)
        elif admitted is not None and authorized is not None:
            updates: dict[str, object] = {"enabled": admitted.enabled and authorized.enabled}
            if name in {"fetch_url", "curl"}:
                domains = _intersect_domains(admitted.allowed_domains, authorized.allowed_domains)
                updates.update(allowed_domains=domains, enabled=bool(updates["enabled"] and domains))
            if name == "curl":
                updates.update(
                    https_only=admitted.https_only or authorized.https_only,
                    allow_non_public_urls=admitted.allow_non_public_urls and authorized.allow_non_public_urls,
                )
            if name == "wait":
                updates["max_seconds"] = min(admitted.max_seconds, authorized.max_seconds)
            setattr(result, name, admitted.model_copy(update=updates, deep=True))
        else:
            setattr(result, name, None)
    return result


def _intersect_app_context(
    saved: AppContextPromptConfig | None, current: AppContextPromptConfig | None,
) -> AppContextPromptConfig | None:
    """A retained approval cannot restore a revoked app-data projection."""
    if saved is None or current is None:
        return None
    app_ids = [app_id for app_id in saved.app_ids if app_id in current.app_ids]
    fields = [field for field in saved.fields if field in current.fields]
    if not app_ids or not fields:
        return None
    return saved.model_copy(update={"app_ids": app_ids, "fields": fields, "max_bytes": min(saved.max_bytes, current.max_bytes)})


def resolve_native_binding(
    mongo: MongoDBService,
    agent: DynamicAgentConfig,
    session_id: str,
    *,
    resume: bool = False,
) -> DynamicAgentConfig:
    """Resolve an authorized native session while preserving its storage binding.

    Call only after current agent-use authorization. Starts admit current
    definition/model options; resumes reconstruct the last admitted snapshot
    while intersecting its tool grants with the currently authorized definition.
    The first backend, filesystem namespace and checkpoint coordinates stay
    fixed. The caller's active-run guard must precede admission; this repository
    detects competing configuration updates rather than choosing a running turn.
    """
    if not session_id.strip():
        raise ValueError("Native ACP session ID must not be empty")
    collection = mongo.get_session_bindings_collection()
    admitted = materialize_runtime_config(agent, session_id, mongo.settings)
    now = datetime.now(timezone.utc)
    key = {"agent_id": agent.id, "session_id": session_id}
    initial = {
        **key,
        "schema_version": 1,
        "native_session_id": session_id,
        "runtime_kind": admitted.execution.kind,
        "protocol": "acp",
        "effective_config": admitted.model_dump(mode="json", by_alias=True),
        "config_version": _config_version(admitted),
        "revision": 1,
        "persistence": _persistence_coordinates(admitted, mongo.settings).model_dump(),
        "created_at": now,
        "updated_at": now,
    }
    try:
        require_native_execution_owner(mongo, agent, session_id, existing_native=collection.find_one(key) is not None)
        # Legacy conversations may predate ACP bindings. An existing native
        # checkpoint is executable state, never a new sandbox's transcript.
        if admitted.execution.kind == "sandbox" and collection.find_one(key, {"_id": 1}) is None:
            storage = resolve_runtime_storage(admitted, session_id, mongo.settings)
            if mongo._db[storage.checkpoint_collection].find_one({"thread_id": session_id}, {"_id": 1}) is not None:
                admitted = admitted.model_copy(update={"execution": AgentExecutionConfig()}, deep=True)
                if admitted.model is None:
                    raise SessionBindingError("This conversation has native state; retain its model or start a new conversation")
                initial.update(runtime_kind="native", effective_config=admitted.model_dump(mode="json", by_alias=True),
                               config_version=_config_version(admitted))
        try:
            record = collection.find_one_and_update(
                key, {"$setOnInsert": initial}, upsert=True, return_document=ReturnDocument.AFTER,
            )
        except DuplicateKeyError:
            # Concurrent upserts may lose to the unique index. Read the winning
            # admission rather than overwriting its persistence coordinates.
            record = collection.find_one(key)
        if record is None:
            raise SessionBindingError("Native ACP session admission returned no stored binding")
        binding = _validate_binding(record, agent.id, session_id, mongo.settings)
        if resume:
            admitted = binding.effective_config.model_copy(update={
                "allowed_tools": intersect_allowed_tools(binding.effective_config.allowed_tools, agent.allowed_tools),
                "allowed_remote_agents": [
                    agent_id for agent_id in binding.effective_config.allowed_remote_agents
                    if agent_id in agent.allowed_remote_agents
                ],
                "builtin_tools": _intersect_builtin_tools(binding.effective_config.builtin_tools, agent.builtin_tools),
                "app_context_prompt": _intersect_app_context(binding.effective_config.app_context_prompt, agent.app_context_prompt),
                "subagents": [
                    reference for reference in binding.effective_config.subagents
                    if reference.agent_id in {current.agent_id for current in agent.subagents}
                ],
            }, deep=True)
        else:
            admitted = agent.model_copy(update={
                "backend": binding.effective_config.backend,
                "execution": binding.effective_config.execution,
                # A definition may move to a harness whose model is profile-
                # owned. Older native checkpoints retain their admitted model.
                "model": agent.model or binding.effective_config.model,
            }, deep=True)
        version = _config_version(admitted)
        if version == binding.config_version:
            return binding.effective_config
        record = collection.find_one_and_update(
            {**key, "revision": binding.revision},
            {"$set": {
                "effective_config": admitted.model_dump(mode="json", by_alias=True),
                "config_version": version,
                "updated_at": now,
            }, "$inc": {"revision": 1}},
            return_document=ReturnDocument.AFTER,
        )
        if record is None:
            raise SessionBindingError("Native ACP session was admitted concurrently; retry after the active turn")
        return _validate_binding(record, agent.id, session_id, mongo.settings).effective_config
    except PyMongoError as exc:
        logger.exception("Native ACP session persistence failed for agent %s", agent.id)
        raise SessionBindingError("Native ACP session persistence is unavailable") from exc


def get_sandbox_binding(mongo: MongoDBService, agent_id: str, session_id: str) -> dict[str, Any] | None:
    record = mongo.get_session_bindings_collection().find_one({"agent_id": agent_id, "session_id": session_id})
    if record is None:
        raise SessionBindingError("Sandbox execution requires an admitted session")
    binding = _validate_binding(record, agent_id, session_id, mongo.settings)
    return _sandbox_with_checkpoint_allocation(mongo, binding)


def _sandbox_with_checkpoint_allocation(mongo: MongoDBService, binding: _StoredBinding) -> dict[str, Any] | None:
    """Materialize only an allocation authorized by the atomic restore fence.

    The immutable profile, owner and provider-native session still come from
    the original admission. A caller cannot replace these through restoration.
    """
    if binding.sandbox is None:
        return None
    authority = mongo.get_session_runs_collection().find_one({
        "agent_id": binding.agent_id, "session_id": binding.session_id,
    }, {"checkpoint_allocation": 1, "checkpoint_profile": 1, "checkpoint_phase": 1})
    if authority is None:
        return binding.sandbox
    # Importing checkpoint models here would create a repository cycle. Verify
    # the same stable identity directly from its canonical serialized fields.
    state = dict(binding.sandbox)
    if "checkpoint_profile" in authority:
        approved_profile = authority["checkpoint_profile"]
        original_profile = state.get("profile", {})
        if ({key: value for key, value in approved_profile.items() if key != "state_contract"}
                != {key: value for key, value in original_profile.items() if key != "state_contract"}
                or approved_profile.get("state_contract") != STATE_CONTRACT):
            raise SessionBindingError("The native-state profile upgrade changed its original admission")
        state["profile"] = approved_profile
    if "checkpoint_phase" in authority:
        state["checkpoint_phase"] = authority["checkpoint_phase"]
    restored = authority.get("checkpoint_allocation")
    if restored is None:
        return state
    profile = state.get("profile", {})
    identity = {"agent_id": binding.agent_id, "session_id": binding.session_id,
        "owner_subject": state.get("owner_subject"), "profile_id": profile.get("id"),
        "profile_revision": profile.get("revision"), "harness": profile.get("harness"),
        "provider_session_id": state.get("provider_session_id"), "connection_version": state.get("connection_version")}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if restored.get("identity_hash") != digest or restored.get("owner_subject") != state.get("owner_subject"):
        raise SessionBindingError("The restored sandbox allocation does not match its original admission")
    allocation = restored.get("allocation")
    original_allocation = state.get("allocation") or {}
    if (not isinstance(allocation, dict) or allocation.get("conversation_id") != original_allocation.get("conversation_id")
            or allocation.get("profile_id") != profile.get("id") or allocation.get("revision") != profile.get("revision")):
        raise SessionBindingError("The restored sandbox allocation has an invalid identity")
    return {**state, "allocation": allocation}


def adopt_sandbox_checkpoint_profile(
    mongo: MongoDBService, agent_id: str, session_id: str, profile: dict[str, Any], lease_id: str,
) -> dict[str, Any]:
    """Fence a legacy session before importing its existing unchanged runtime.

    Only adding the qualified state contract is permitted. The adopting phase
    is committed in the lease authority before any export; only publishing a
    verified checkpoint can move that authority to the active phase.
    """
    state = get_sandbox_binding(mongo, agent_id, session_id)
    old_profile = state.get("profile", {}) if state else {}
    if (state is None or state.get("checkpoint_phase") not in {None, "adopting"}
            or profile.get("state_contract") != STATE_CONTRACT
            or {key: value for key, value in profile.items() if key != "state_contract"}
            != {key: value for key, value in old_profile.items() if key != "state_contract"}
            or old_profile.get("state_contract") not in (None, STATE_CONTRACT)):
        raise SessionBindingError("This sandbox cannot adopt native checkpoints without explicit migration")
    changed = mongo.get_session_runs_collection().update_one({
        "agent_id": agent_id, "session_id": session_id, "lease_id": lease_id,
        "lease_expires_at": {"$gt": datetime.now(timezone.utc)}, "cancel_requested": {"$ne": True},
        "checkpoint_head": {"$exists": False}, "checkpoint_phase": {"$ne": "active"},
    }, {"$set": {"checkpoint_profile": profile, "checkpoint_phase": "adopting"},
        "$inc": {"checkpoint_generation": 1}, "$unset": {"checkpoint_writer": ""}})
    if not changed.matched_count:
        raise SessionBindingError("Native checkpoint adoption requires the active session lease")
    return {**state, "profile": profile, "checkpoint_phase": "adopting"}


def save_sandbox_binding(mongo: MongoDBService, agent_id: str, session_id: str, state: dict[str, Any]) -> None:
    """Pin the external environment and native reference before any prompt."""
    collection = mongo.get_session_bindings_collection()
    key = {"agent_id": agent_id, "session_id": session_id}
    record = collection.find_one(key)
    if record is None:
        raise SessionBindingError("Sandbox execution requires an admitted session")
    binding = _validate_binding(record, agent_id, session_id, mongo.settings)
    if binding.runtime_kind != "sandbox":
        raise SessionBindingError("This conversation is bound to a native checkpoint")
    if binding.sandbox is not None:
        old = binding.sandbox
        authorized = _sandbox_with_checkpoint_allocation(mongo, binding)
        if (any(old.get(field) != state.get(field) for field in ("owner_subject", "connection_version"))
                or (old.get("profile") != state.get("profile")
                    and (authorized is None or authorized.get("profile") != state.get("profile")))):
            raise SessionBindingError("The admitted sandbox environment changed; explicit migration is required")
        if old.get("allocation") is not None and old["allocation"] != state.get("allocation"):
            if authorized is None or authorized.get("allocation") != state.get("allocation"):
                raise SessionBindingError("The admitted sandbox environment changed; explicit migration is required")
        if old.get("provider_session_id") and old["provider_session_id"] != state.get("provider_session_id"):
            raise SessionBindingError("The admitted ACP session reference changed")
    result = collection.update_one({**key, "revision": binding.revision}, {
        "$set": {"sandbox": state, "updated_at": datetime.now(timezone.utc)}, "$inc": {"revision": 1},
    })
    if not result.matched_count:
        raise SessionBindingError("Sandbox admission changed concurrently")


def reset_sandbox_binding(mongo: MongoDBService, agent_id: str, session_id: str, expected: dict[str, Any]) -> None:
    """Forget a deleted external session only while its native lease is held.

    The caller must first delete the exact pinned allocation. A stale cleanup
    cannot erase a different allocation admitted by another worker.
    """
    collection = mongo.get_session_bindings_collection()
    key = {"agent_id": agent_id, "session_id": session_id}
    record = collection.find_one(key)
    if record is None:
        raise SessionBindingError("Sandbox cleanup requires an admitted session")
    binding = _validate_binding(record, agent_id, session_id, mongo.settings)
    if binding.runtime_kind != "sandbox" or _sandbox_with_checkpoint_allocation(mongo, binding) != expected:
        raise SessionBindingError("The sandbox binding changed during cleanup")
    result = collection.update_one({**key, "revision": binding.revision, "sandbox": binding.sandbox}, {
        "$unset": {"sandbox": ""}, "$set": {"updated_at": datetime.now(timezone.utc)}, "$inc": {"revision": 1},
    })
    if not result.matched_count:
        raise SessionBindingError("Sandbox cleanup changed concurrently")


def _delegated_parent(
    mongo: MongoDBService, agent_id: str, session_id: str, owner_subject: str | None,
) -> _StoredBinding | None:
    record = mongo.get_session_bindings_collection().find_one({"agent_id": agent_id, "session_id": session_id})
    if record is None:
        return None
    binding = _validate_binding(record, agent_id, session_id, mongo.settings)
    if binding.delegated_sessions:
        if (binding.runtime_kind != "sandbox" or not owner_subject or not binding.sandbox
                or binding.sandbox.get("owner_subject") != owner_subject):
            raise SessionBindingError("Only the original sandbox owner can access its delegated sessions")
        seen = set()
        for child in binding.delegated_sessions:
            expected = str(uuid5(NAMESPACE_URL, f"caipe-child:{session_id}:{child.agent_id}"))
            if child.agent_id == agent_id or child.session_id != expected or child.agent_id in seen:
                raise SessionBindingError("The delegated session lifecycle binding is invalid")
            seen.add(child.agent_id)
    return binding


def get_delegated_sessions(
    mongo: MongoDBService, agent_id: str, session_id: str, owner_subject: str | None,
) -> list[dict[str, str]]:
    """Read parent-owned cleanup coordinates, never caller-supplied namespaces."""
    binding = _delegated_parent(mongo, agent_id, session_id, owner_subject)
    return [child.model_dump() for child in binding.delegated_sessions] if binding else []


def link_delegated_session(
    mongo: MongoDBService, agent_id: str, session_id: str, child_agent_id: str, child_session_id: str,
    owner_subject: str,
) -> None:
    """Journal ownership before a native child can create persistent state.

    The sandbox producer already holds its parent lease. Cleanup acquires that
    same lease, so it cannot race a new link or a child invocation.
    """
    binding = _delegated_parent(mongo, agent_id, session_id, owner_subject)
    if (binding is None or binding.runtime_kind != "sandbox" or not binding.sandbox
            or binding.sandbox.get("owner_subject") != owner_subject
            or mongo._db["native_acp_deleted_sessions"].find_one({"_id": session_id}, {"_id": 1}) is not None
            or mongo.get_session_runs_collection().find_one({
                "agent_id": agent_id, "session_id": session_id,
                "lease_id": {"$exists": True}, "lease_expires_at": {"$gt": datetime.now(timezone.utc)},
                "cancel_requested": {"$ne": True},
            }, {"_id": 1}) is None):
        raise SessionBindingError("Delegation requires the original sandbox owner's active parent admission")
    expected = str(uuid5(NAMESPACE_URL, f"caipe-child:{session_id}:{child_agent_id}"))
    if child_agent_id == agent_id or child_session_id != expected:
        raise SessionBindingError("The delegated session does not match its parent")
    children = [child.model_dump() for child in binding.delegated_sessions]
    child = _DelegatedSession(agent_id=child_agent_id, session_id=child_session_id).model_dump()
    if child in children:
        return
    if len(children) >= 64:
        raise SessionBindingError("The delegated session lifecycle limit was reached")
    result = mongo.get_session_bindings_collection().update_one({
        "agent_id": agent_id, "session_id": session_id, "revision": binding.revision,
    }, {"$set": {"delegated_sessions": [*children, child], "updated_at": datetime.now(timezone.utc)},
        "$inc": {"revision": 1}})
    if not result.matched_count:
        raise SessionBindingError("The parent session changed during delegated admission")


def clear_delegated_sessions(
    mongo: MongoDBService, agent_id: str, session_id: str, owner_subject: str | None,
    expected: list[dict[str, str]], *, remove: list[dict[str, str]] | None = None,
) -> None:
    """Remove confirmed links with a CAS over the entire retained child set."""
    binding = _delegated_parent(mongo, agent_id, session_id, owner_subject)
    if binding is None or [child.model_dump() for child in binding.delegated_sessions] != expected:
        raise SessionBindingError("The delegated session lifecycle changed during cleanup")
    if not expected:
        return
    removed = expected if remove is None else remove
    if any(child not in expected for child in removed):
        raise SessionBindingError("The delegated cleanup includes an unrelated session")
    retained = [child for child in expected if child not in removed]
    if retained == expected:
        return
    update: dict[str, Any] = {"$set": {"updated_at": datetime.now(timezone.utc)}, "$inc": {"revision": 1}}
    if retained:
        update["$set"]["delegated_sessions"] = retained
    else:
        update["$unset"] = {"delegated_sessions": ""}
    result = mongo.get_session_bindings_collection().update_one({
        "agent_id": agent_id, "session_id": session_id, "revision": binding.revision,
        "delegated_sessions": expected,
    }, update)
    if not result.matched_count:
        raise SessionBindingError("The delegated session lifecycle changed during cleanup")
