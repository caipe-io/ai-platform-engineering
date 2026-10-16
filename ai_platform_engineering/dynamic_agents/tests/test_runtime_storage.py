"""Native construction, admission and maintenance share persistence coordinates."""

from unittest.mock import MagicMock, patch

import pytest

from dynamic_agents.config import Settings
from dynamic_agents.models import AgentBackend, AgentBackendConfig, DynamicAgentConfig
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.runtime_storage import materialize_runtime_config, resolve_runtime_storage


def _agent(backend: AgentBackend | None = None) -> DynamicAgentConfig:
    return DynamicAgentConfig(
        _id="primary", name="Primary", owner_id="owner@example.com", system_prompt="Assist.",
        model={"id": "example-model", "provider": "example-provider"}, backend=backend,
    )


def _settings(**values: object) -> Settings:
    return Settings(
        mongodb_database="example", checkpoint_collection="native_checkpoints",
        checkpoint_writes_collection="native_writes", gridfs_bucket_name="example_files", **values,
    )


def test_legacy_maintenance_defaults_need_no_current_agent_config() -> None:
    storage = resolve_runtime_storage(None, "thread-1", _settings(default_runtime_backend="state"), agent_id="primary")

    assert storage.database == "example"
    assert storage.backend_type == "state"
    assert storage.checkpoint_collection == "native_checkpoints"
    assert storage.checkpoint_writes_collection == "native_writes"
    assert storage.checkpoint_ttl is None
    assert storage.gridfs_bucket_name == "example_files"
    assert storage.fs_namespace == ("primary", "thread-1", "filesystem")


def test_workflow_overrides_are_shared_by_runtime_and_materialized_config() -> None:
    agent = _agent(AgentBackend(type="store", config=AgentBackendConfig(
        fs_namespace=["workflow", "run-1", "filesystem"], fs_ttl_seconds=900,
        checkpoint_collection="workflow_checkpoints", checkpoint_ttl=1800,
    )))
    settings = _settings(default_runtime_backend="state", max_fs_ttl_seconds=600)
    storage = resolve_runtime_storage(agent, "step-attempt", settings)
    admitted = materialize_runtime_config(agent, "step-attempt", settings)

    assert storage.backend_type == "store"
    assert storage.checkpoint_collection == "workflow_checkpoints"
    assert storage.checkpoint_writes_collection == "workflow_checkpoints_writes"
    assert storage.checkpoint_ttl == 1800
    assert storage.fs_namespace == ("workflow", "run-1", "filesystem")
    assert storage.fs_ttl_seconds == 600
    assert resolve_runtime_storage(admitted, "step-attempt", settings) == storage


@pytest.mark.parametrize("requested, maximum, expected", [(None, 600, 600), (900, 600, 600), (0, 600, 0), (900, 0, 900)])
def test_filesystem_ttl_preserves_cap_and_infinite_semantics(requested: int | None, maximum: int, expected: int) -> None:
    agent = _agent(AgentBackend(config=AgentBackendConfig(fs_ttl_seconds=requested)))
    storage = resolve_runtime_storage(agent, "thread-1", _settings(default_fs_ttl_seconds=900, max_fs_ttl_seconds=maximum))
    assert storage.fs_ttl_seconds == expected


def test_admission_preserves_separately_named_default_writes_collection() -> None:
    agent, settings = _agent(), _settings()
    admitted = materialize_runtime_config(agent, "thread-1", settings)

    assert admitted.backend.config.checkpoint_collection is None
    assert resolve_runtime_storage(admitted, "thread-1", settings).checkpoint_writes_collection == "native_writes"
    assert agent.backend is None


@pytest.mark.parametrize("custom", [False, True])
def test_native_constructor_uses_shared_resolved_coordinates(custom: bool) -> None:
    agent = _agent(AgentBackend(config=AgentBackendConfig(
        checkpoint_collection="workflow_checkpoints", checkpoint_ttl=900,
    )) if custom else None)
    settings = _settings(default_fs_ttl_seconds=900, max_fs_ttl_seconds=600)
    storage = resolve_runtime_storage(agent, "thread-1", settings)
    mongo_client = MagicMock()
    with (
        patch("dynamic_agents.services.agent_runtime.MongoDBSaver") as saver,
        patch("dynamic_agents.services.agent_runtime.MongoDBGridFSStore") as store,
        patch("dynamic_agents.services.agent_runtime.TracingManager"),
        patch("dynamic_agents.services.skill_scrubber.install_skill_content_scrubber"),
    ):
        AgentRuntime(agent, [], settings=settings, session_id="thread-1", mongo_client=mongo_client)

    saver.assert_called_once_with(
        mongo_client, db_name=storage.database, checkpoint_collection_name=storage.checkpoint_collection,
        writes_collection_name=storage.checkpoint_writes_collection, ttl=storage.checkpoint_ttl,
    )
    store.assert_called_once_with(
        db=mongo_client[storage.database], bucket_name=storage.gridfs_bucket_name, ttl_seconds=storage.fs_ttl_seconds,
    )
