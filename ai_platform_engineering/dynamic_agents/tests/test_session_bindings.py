"""Contract tests for durable native session admission and checkpoint identity."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from threading import Barrier, Lock
from unittest.mock import MagicMock

import pytest
from pymongo import ASCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError, OperationFailure

from dynamic_agents.config import Settings
from dynamic_agents.models import AgentBackend, AgentBackendConfig, DynamicAgentConfig, ModelConfig
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.session_bindings import (
    SESSION_BINDINGS_COLLECTION,
    SessionBindingError,
    get_native_binding,
    resolve_native_binding,
)


class _AtomicCollection:
    """A shared unique-key collection with atomic Mongo-style conditional updates."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict] = {}
        self.lock = Lock()
        self.barrier: Barrier | None = None

    def find_one_and_update(
        self, query: dict, update: dict, *, upsert: bool = False, return_document: bool,
    ) -> dict | None:
        assert return_document == ReturnDocument.AFTER
        if upsert and self.barrier is not None:
            self.barrier.wait(timeout=5)
        key = (query["agent_id"], query["session_id"])
        with self.lock:
            row = self.rows.get(key)
            if row is None and upsert:
                row = deepcopy(update["$setOnInsert"])
                self.rows[key] = row
            if row is None or any(row.get(field) != value for field, value in query.items()):
                return None
            row.update(deepcopy(update.get("$set", {})))
            for field, increment in update.get("$inc", {}).items():
                row[field] += increment
            return deepcopy(row)

    def find_one(self, query: dict) -> dict | None:
        with self.lock:
            return deepcopy(self.rows.get((query["agent_id"], query["session_id"])))


def _agent(**updates: object) -> DynamicAgentConfig:
    return DynamicAgentConfig(
        _id="primary",
        name="Primary agent",
        owner_id="owner@example.com",
        system_prompt="Help with the request.",
        model=ModelConfig(id="example-model", provider="example-provider"),
        allowed_tools={"example-tool": ["read"]},
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    ).model_copy(update=updates, deep=True)


def _mongo(collection: _AtomicCollection | MagicMock) -> MongoDBService:
    settings = Settings(
        mongodb_database="example",
        checkpoint_collection="conversation_checkpoints",
        checkpoint_writes_collection="conversation_writes",
        default_runtime_backend="store",
        default_fs_ttl_seconds=600,
        gridfs_bucket_name="example_files",
    )
    mongo = MongoDBService(settings)
    mongo._db = {SESSION_BINDINGS_COLLECTION: collection}  # type: ignore[assignment]
    return mongo


def _workflow_backend(namespace: str = "workflow-1") -> AgentBackend:
    return AgentBackend(type="store", config=AgentBackendConfig(
        fs_namespace=["workflow", namespace, "filesystem"],
        checkpoint_collection="workflow_checkpoints",
        checkpoint_ttl=900,
        fs_ttl_seconds=900,
    ))


def test_native_identity_and_default_checkpoint_collections_remain_unchanged() -> None:
    collection = _AtomicCollection()
    mongo = _mongo(collection)
    config = resolve_native_binding(mongo, _agent(), "original-thread")
    row = collection.rows[("primary", "original-thread")]

    assert row["native_session_id"] == "original-thread"
    assert row["runtime_kind"] == "native"
    assert row["protocol"] == "acp"
    assert row["persistence"] == {
        "database": "example",
        "checkpoint_collection": "conversation_checkpoints",
        "checkpoint_writes_collection": "conversation_writes",
        "gridfs_bucket_name": "example_files",
    }
    assert config.backend.type == "store"
    assert config.backend.config.fs_namespace == ["primary", "original-thread", "filesystem"]
    assert config.backend.config.fs_ttl_seconds == 600
    # Materializing this setting would incorrectly rename the writes collection.
    assert config.backend.config.checkpoint_collection is None


@pytest.mark.parametrize("backend, expected", [(None, "state"), (AgentBackend(), "state"), (AgentBackend(type="store"), "store")])
def test_backend_type_uses_server_default_unless_explicit(backend: AgentBackend | None, expected: str) -> None:
    mongo = _mongo(_AtomicCollection())
    mongo.settings.default_runtime_backend = "state"

    admitted = resolve_native_binding(mongo, _agent(backend=backend), "existing-thread")

    assert admitted.backend.type == expected


def test_starts_accept_definition_and_model_edits_but_keep_admitted_storage() -> None:
    collection = _AtomicCollection()
    mongo = _mongo(collection)
    first = resolve_native_binding(mongo, _agent(backend=_workflow_backend()), "step-attempt")
    initial_version = collection.rows[("primary", "step-attempt")]["config_version"]
    edited = _agent(
        system_prompt="Use the updated instructions.",
        model=ModelConfig(id="other-model", provider="example-provider", reasoning_effort="high"),
        backend=_workflow_backend("other-workflow"),
    )

    admitted = resolve_native_binding(mongo, edited, "step-attempt")

    assert admitted.system_prompt == edited.system_prompt
    assert admitted.model == edited.model
    assert admitted.backend == first.backend
    assert admitted.backend.config.checkpoint_collection == "workflow_checkpoints"
    assert admitted.backend.config.checkpoint_ttl == 900
    assert collection.rows[("primary", "step-attempt")]["revision"] == 2
    assert collection.rows[("primary", "step-attempt")]["config_version"] != initial_version
    assert collection.rows[("primary", "step-attempt")]["persistence"]["checkpoint_writes_collection"] == (
        "workflow_checkpoints_writes"
    )


def test_resume_after_repository_recreation_uses_last_admitted_snapshot() -> None:
    collection = _AtomicCollection()
    first = resolve_native_binding(_mongo(collection), _agent(backend=_workflow_backend()), "step-attempt")
    admitted = resolve_native_binding(
        _mongo(collection), _agent(system_prompt="Updated turn.", backend=first.backend), "step-attempt",
    )

    resumed = resolve_native_binding(_mongo(collection), _agent(), "step-attempt", resume=True)

    assert resumed == admitted
    assert resumed.backend.config.fs_namespace == ["workflow", "workflow-1", "filesystem"]
    assert collection.rows[("primary", "step-attempt")]["revision"] == 2


def test_read_binding_preserves_admitted_snapshot_without_changing_it() -> None:
    collection = _AtomicCollection()
    admitted = resolve_native_binding(_mongo(collection), _agent(backend=_workflow_backend()), "step-attempt")
    reader = MagicMock()
    reader.find_one.return_value = deepcopy(collection.rows[("primary", "step-attempt")])

    assert get_native_binding(_mongo(reader), "primary", "step-attempt") == admitted
    reader.find_one.assert_called_once_with({"agent_id": "primary", "session_id": "step-attempt"})
    reader.find_one_and_update.assert_not_called()


def test_read_unknown_session_does_not_admit_a_binding() -> None:
    collection = _AtomicCollection()

    assert get_native_binding(_mongo(collection), "primary", "unknown-thread") is None
    assert collection.rows == {}


def test_read_corrupt_binding_fails_without_modifying_stored_state() -> None:
    collection = _AtomicCollection()
    resolve_native_binding(_mongo(collection), _agent(), "existing-thread")
    collection.rows[("primary", "existing-thread")]["native_session_id"] = "other-thread"
    before = deepcopy(collection.rows)

    with pytest.raises(SessionBindingError, match="identity or configuration digest"):
        get_native_binding(_mongo(collection), "primary", "existing-thread")
    assert collection.rows == before


def test_binding_read_database_failure_is_loud() -> None:
    collection = MagicMock()
    collection.find_one.side_effect = OperationFailure("unavailable")

    with pytest.raises(SessionBindingError, match="persistence is unavailable"):
        get_native_binding(_mongo(collection), "primary", "existing-thread")
    collection.find_one_and_update.assert_not_called()


def test_concurrent_admission_keeps_one_storage_binding() -> None:
    collection = _AtomicCollection()
    collection.barrier = Barrier(2)
    mongo = _mongo(collection)
    agents = [_agent(backend=_workflow_backend("first")), _agent(backend=_workflow_backend("second"))]

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(resolve_native_binding, mongo, agent, "shared-thread") for agent in agents]
        configs = [future.result(timeout=10) for future in futures]

    assert len(collection.rows) == 1
    assert configs[0] == configs[1]
    assert collection.rows[("primary", "shared-thread")]["native_session_id"] == "shared-thread"


def test_duplicate_upsert_reads_winning_binding() -> None:
    collection = _AtomicCollection()
    admitted = resolve_native_binding(_mongo(collection), _agent(backend=_workflow_backend()), "shared-thread")
    racing = MagicMock()
    racing.find_one_and_update.side_effect = DuplicateKeyError("another admission won")
    racing.find_one.return_value = deepcopy(collection.rows[("primary", "shared-thread")])

    assert resolve_native_binding(_mongo(racing), _agent(), "shared-thread", resume=True) == admitted
    racing.find_one.assert_called_once_with({"agent_id": "primary", "session_id": "shared-thread"})


def test_competing_definition_update_is_reported_instead_of_overwriting() -> None:
    collection = _AtomicCollection()
    resolve_native_binding(_mongo(collection), _agent(), "shared-thread")
    racing = MagicMock()
    racing.find_one_and_update.side_effect = [deepcopy(collection.rows[("primary", "shared-thread")]), None]

    with pytest.raises(SessionBindingError, match="admitted concurrently"):
        resolve_native_binding(_mongo(racing), _agent(system_prompt="Edited."), "shared-thread")
    assert racing.find_one_and_update.call_args.args[0]["revision"] == 1


@pytest.mark.parametrize("field", ["checkpoint_collection", "checkpoint_writes_collection", "gridfs_bucket_name"])
def test_changed_default_persistence_coordinates_require_migration(field: str) -> None:
    collection = _AtomicCollection()
    mongo = _mongo(collection)
    resolve_native_binding(mongo, _agent(), "existing-thread")
    setattr(mongo.settings, field, "replacement")

    with pytest.raises(SessionBindingError, match="persistence settings changed"):
        resolve_native_binding(mongo, _agent(), "existing-thread", resume=True)


def test_materialized_filesystem_defaults_survive_settings_changes() -> None:
    collection = _AtomicCollection()
    mongo = _mongo(collection)
    first = resolve_native_binding(mongo, _agent(), "existing-thread")
    mongo.settings.default_runtime_backend = "state"
    mongo.settings.default_fs_ttl_seconds = 1200

    assert resolve_native_binding(mongo, _agent(), "existing-thread", resume=True) == first


@pytest.mark.parametrize("operation", ["admit", "read_winner"])
def test_database_failures_are_not_silently_ignored(operation: str) -> None:
    collection = MagicMock()
    collection.find_one_and_update.side_effect = (
        OperationFailure("unavailable") if operation == "admit" else DuplicateKeyError("race")
    )
    collection.find_one.side_effect = OperationFailure("unavailable")

    with pytest.raises(SessionBindingError, match="persistence is unavailable"):
        resolve_native_binding(_mongo(collection), _agent(), "existing-thread")


@pytest.mark.parametrize("corruption", ["digest", "agent", "native_id", "schema"])
def test_corrupt_bindings_do_not_redirect_native_state(corruption: str) -> None:
    collection = _AtomicCollection()
    mongo = _mongo(collection)
    resolve_native_binding(mongo, _agent(), "existing-thread")
    row = collection.rows[("primary", "existing-thread")]
    if corruption == "digest":
        row["effective_config"]["system_prompt"] = "Unexpected edit."
    elif corruption == "agent":
        row["effective_config"]["_id"] = "other-agent"
    elif corruption == "native_id":
        row["native_session_id"] = "other-thread"
    else:
        row["schema_version"] = 2

    with pytest.raises(SessionBindingError):
        resolve_native_binding(mongo, _agent(), "existing-thread", resume=True)


def test_repository_stores_only_configuration_and_binding_metadata() -> None:
    collection = _AtomicCollection()
    resolve_native_binding(_mongo(collection), _agent(), "existing-thread")
    row = collection.rows[("primary", "existing-thread")]

    assert set(row) == {
        "agent_id", "session_id", "schema_version", "native_session_id", "runtime_kind", "protocol",
        "effective_config", "config_version", "revision", "persistence", "created_at", "updated_at",
    }
    assert set(row["effective_config"]) == set(_agent().model_dump(by_alias=True))
    assert "access_token" not in row["effective_config"]
    assert "user_context" not in row
    assert "mcp_servers" not in row


def test_unique_binding_index_is_created_in_the_existing_database() -> None:
    mongo = MongoDBService(_mongo(_AtomicCollection()).settings)
    collections = {name: MagicMock() for name in (
        "dynamic_agents", "mcp_servers", SESSION_BINDINGS_COLLECTION,
        "native_acp_runs",
        "autonomous_follow_up_chats", "autonomous_follow_up_copy_attempts",
    )}
    db = MagicMock()
    db.__getitem__.side_effect = collections.__getitem__
    mongo._db = db

    mongo._ensure_indexes()

    collections[SESSION_BINDINGS_COLLECTION].create_index.assert_called_once_with(
        [("agent_id", ASCENDING), ("session_id", ASCENDING)],
        unique=True,
        name="native_acp_agent_session_unique",
    )
    collections["native_acp_runs"].create_index.assert_called_once_with(
        [("agent_id", ASCENDING), ("session_id", ASCENDING)],
        unique=True,
        name="native_acp_active_turn_unique",
    )


def test_disconnected_database_cannot_admit_a_session() -> None:
    mongo = _mongo(_AtomicCollection())
    mongo._db = None

    with pytest.raises(RuntimeError, match="MongoDB not connected"):
        resolve_native_binding(mongo, _agent(), "existing-thread")
