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

from dynamic_agents.models import DynamicAgentConfig
from dynamic_agents.services.mcp_client import intersect_allowed_tools
from dynamic_agents.services.runtime_storage import materialize_runtime_config, resolve_runtime_storage

if TYPE_CHECKING:
    from dynamic_agents.config import Settings
    from dynamic_agents.services.mongo import MongoDBService

logger = logging.getLogger(__name__)

SESSION_BINDINGS_COLLECTION = "native_acp_sessions"


class SessionBindingError(RuntimeError):
    """Admission failed; never silently fall back to a different native state."""


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


def _config_version(agent: DynamicAgentConfig) -> str:
    encoded = json.dumps(agent.model_dump(mode="json", by_alias=True), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


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
        or binding.config_version != _config_version(binding.effective_config)
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
