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
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, Field, ValidationError
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

from dynamic_agents.models import AppContextPromptConfig, BuiltinToolsConfig, DynamicAgentConfig
from dynamic_agents.services.mcp_client import intersect_allowed_tools
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


class _StoredBinding(BaseModel):
    schema_version: Literal[1]
    agent_id: str
    session_id: str
    native_session_id: str
    runtime_kind: Literal["native"]
    protocol: Literal["acp"]
    effective_config: DynamicAgentConfig
    config_version: str = Field(pattern=r"^[a-f0-9]{64}$")
    revision: int = Field(ge=1)
    persistence: _PersistenceCoordinates
    created_at: datetime
    updated_at: datetime


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
        "runtime_kind": "native",
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
            admitted = agent.model_copy(update={"backend": binding.effective_config.backend}, deep=True)
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
